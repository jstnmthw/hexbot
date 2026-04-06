// HexBot — Bot Link Leaf Client
// Connects to a hub, handles handshake, command relay, party line,
// protection requests, and reconnects with exponential backoff.
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import type { CommandContext } from '../command-handler';
import type { Logger } from '../logger';
import type { BotlinkConfig } from '../types';
import {
  BotLinkProtocol,
  type CommandRelay,
  type LinkFrame,
  type LinkPermissions,
  type PartyLineUser,
  type SocketFactory,
  executeCmdFrame,
  hashPassword,
} from './botlink-protocol';

// ---------------------------------------------------------------------------
// BotLinkLeaf
// ---------------------------------------------------------------------------

export class BotLinkLeaf {
  private config: BotlinkConfig;
  private version: string;
  private logger: Logger | null;
  private socketFactory: SocketFactory;
  private protocol: BotLinkProtocol | null = null;
  private connected = false;
  private connecting = false;
  private disconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageAt = 0;
  private hubBotname = '';
  private pingSeq = 0;
  private pingIntervalMs: number;
  private linkTimeoutMs: number;
  private reconnectDelayMs: number;
  private reconnectMaxDelayMs: number;
  private pendingCmds: Map<string, { resolve: (output: string[]) => void }> = new Map();
  private pendingWhom: Map<string, { resolve: (users: PartyLineUser[]) => void }> = new Map();
  private pendingProtect: Map<string, { resolve: (success: boolean) => void }> = new Map();
  private cmdRefCounter = 0;
  private cmdHandler: CommandRelay | null = null;
  private cmdPermissions: LinkPermissions | null = null;

  /** Fired when handshake completes. */
  onConnected: ((hubBotname: string) => void) | null = null;
  /** Fired when connection is lost (not on explicit disconnect). */
  onDisconnected: ((reason: string) => void) | null = null;
  /** Fired for every non-heartbeat frame from the hub. */
  onFrame: ((frame: LinkFrame) => void) | null = null;

  constructor(
    config: BotlinkConfig,
    version: string,
    logger?: Logger | null,
    socketFactory?: SocketFactory,
  ) {
    this.config = config;
    this.version = version;
    this.logger = logger?.child('botlink:leaf') ?? null;
    this.socketFactory = socketFactory ?? ((p, h) => connect(p, h));
    this.reconnectDelayMs = config.reconnect_delay_ms ?? 5_000;
    this.reconnectMaxDelayMs = config.reconnect_max_delay_ms ?? 60_000;
    this.reconnectDelay = this.reconnectDelayMs;
    this.pingIntervalMs = config.ping_interval_ms;
    this.linkTimeoutMs = config.link_timeout_ms;
  }

  /** Connect to the hub via TCP. */
  connect(): void {
    if (this.connected || this.connecting || this.disconnecting) return;

    const hubHost = this.config.hub?.host;
    const hubPort = this.config.hub?.port;
    if (!hubHost || !hubPort) {
      this.logger?.error('Hub host/port not configured');
      return;
    }

    this.connecting = true;
    this.logger?.info(`Connecting to hub at ${hubHost}:${hubPort}`);

    const socket = this.socketFactory(hubPort, hubHost);

    const onConnect = () => {
      socket.removeListener('error', onError);
      this.connecting = false;
      this.initProtocol(socket);
    };
    const onError = (err: Error) => {
      socket.removeListener('connect', onConnect);
      this.connecting = false;
      socket.destroy();
      this.logger?.warn(`Connection failed: ${err.message}`);
      this.scheduleReconnect();
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);
  }

  /** Connect using an existing socket (for testing without TCP). */
  connectWithSocket(socket: Socket): void {
    this.initProtocol(socket);
  }

  /** Send a raw frame to the hub. Returns false if not connected. */
  send(frame: LinkFrame): boolean {
    if (!this.protocol || !this.connected) return false;
    return this.protocol.send(frame);
  }

  /** Send a command relay frame to the hub (Phase 5). */
  sendCommand(command: string, args: string, fromHandle: string, channel: string | null): boolean {
    return this.send({
      type: 'CMD',
      command,
      args,
      fromHandle,
      fromBot: this.config.botname,
      channel,
    });
  }

  /**
   * Send a protection request and wait for an ACK from any peer.
   * Returns true if a peer successfully acted, false on timeout or failure.
   */
  async sendProtect(
    protectType: string,
    channel: string,
    nick: string,
    timeoutMs = 5_000,
  ): Promise<boolean> {
    if (!this.isConnected) return false;
    const ref = `protect:${++this.cmdRefCounter}`;

    this.send({
      type: protectType,
      channel,
      nick,
      requestedBy: this.config.botname,
      ref,
    });

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingProtect.delete(ref);
        resolve(false);
      }, timeoutMs);

      this.pendingProtect.set(ref, {
        resolve: (success: boolean) => {
          clearTimeout(timer);
          resolve(success);
        },
      });
    });
  }

  // -----------------------------------------------------------------------
  // Command relay wiring (Phase 5)
  // -----------------------------------------------------------------------

  /** Wire command relay: relayToHub commands are sent to hub instead of executing locally. */
  setCommandRelay(commandHandler: CommandRelay, permissions: LinkPermissions): void {
    this.cmdHandler = commandHandler;
    this.cmdPermissions = permissions;
    commandHandler.setPreExecuteHook(async (entry, args, ctx) => {
      if (!entry.options.relayToHub || !this.isConnected || ctx.source === 'botlink') return false;
      const hostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
      const user = permissions.findByHostmask(hostmask);
      if (!user) return false;
      return this.relayCommand(entry.name, args, user.handle, ctx);
    });
  }

  /** Relay a command to the hub and display the result. Returns true when handled. */
  async relayCommand(
    name: string,
    args: string,
    handle: string,
    ctx: CommandContext,
    toBot?: string,
  ): Promise<boolean> {
    const ref = String(++this.cmdRefCounter);

    this.send({
      type: 'CMD',
      command: name,
      args,
      fromHandle: handle,
      fromBot: this.config.botname,
      channel: ctx.channel,
      ref,
      ...(toBot ? { toBot } : {}),
    });

    const CMD_TIMEOUT_MS = 10_000;
    const output = await new Promise<string[]>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCmds.delete(ref);
        resolve(['Command relay timed out.']);
      }, CMD_TIMEOUT_MS);

      this.pendingCmds.set(ref, {
        resolve: (lines: string[]) => {
          clearTimeout(timer);
          resolve(lines);
        },
      });
    });

    for (const line of output) {
      ctx.reply(line);
    }
    return true;
  }

  /** Request the full party line user list from the hub. */
  async requestWhom(): Promise<PartyLineUser[]> {
    if (!this.isConnected) return [];
    const ref = String(++this.cmdRefCounter);
    this.send({ type: 'PARTY_WHOM', ref });

    const WHOM_TIMEOUT_MS = 10_000;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingWhom.delete(ref);
        resolve([]);
      }, WHOM_TIMEOUT_MS);

      this.pendingWhom.set(ref, {
        resolve: (users) => {
          clearTimeout(timer);
          resolve(users);
        },
      });
    });
  }

  /** Disconnect from the hub and stop reconnecting. */
  disconnect(): void {
    this.disconnecting = true;
    this.connecting = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.connected = false;
    if (this.protocol) {
      this.protocol.close();
      this.protocol = null;
    }
  }

  /** Force a reconnect to the hub. */
  reconnect(): void {
    this.disconnecting = false;
    this.connecting = false;
    this.stopHeartbeat();
    this.connected = false;
    if (this.protocol) {
      this.protocol.close();
      this.protocol = null;
    }
    this.reconnectDelay = this.reconnectDelayMs;
    this.connect();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get hubName(): string {
    return this.hubBotname;
  }

  // -----------------------------------------------------------------------
  // Protocol init
  // -----------------------------------------------------------------------

  private initProtocol(socket: Socket): void {
    this.protocol = new BotLinkProtocol(socket, this.logger);

    // Send HELLO — password hash, NEVER plaintext
    this.protocol.send({
      type: 'HELLO',
      botname: this.config.botname,
      password: hashPassword(this.config.password),
      version: this.version,
    });

    // Handshake phase — wait for WELCOME or ERROR
    this.protocol.onFrame = (frame) => {
      if (frame.type === 'WELCOME') {
        this.hubBotname = String(frame.botname ?? '');
        this.connected = true;
        this.reconnectDelay = this.reconnectDelayMs; // Reset backoff
        this.lastMessageAt = Date.now();

        // Switch to steady state
        if (this.protocol) this.protocol.onFrame = (f) => this.onSteadyState(f);
        this.startHeartbeat();

        this.logger?.info(`Connected to hub "${this.hubBotname}"`);
        this.onConnected?.(this.hubBotname);
      } else if (frame.type === 'ERROR') {
        this.logger?.error(`Hub rejected: [${frame.code}] ${frame.message}`);
        this.protocol?.close();
        this.protocol = null;
        // Don't auto-reconnect on auth failure
        if (frame.code === 'AUTH_FAILED') return;
        this.scheduleReconnect();
      }
    };

    this.protocol.onClose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      this.protocol = null;

      if (wasConnected) {
        this.logger?.warn('Connection to hub lost');
        this.onDisconnected?.('Connection lost');
      }

      if (!this.disconnecting) {
        this.scheduleReconnect();
      }
    };

    /* v8 ignore next 3 -- socket error callback; only fires on real TCP errors */
    this.protocol.onError = (err) => {
      this.logger?.debug(`Socket error: ${err.message}`);
    };
  }

  // -----------------------------------------------------------------------
  // Steady state
  // -----------------------------------------------------------------------

  private onSteadyState(frame: LinkFrame): void {
    this.lastMessageAt = Date.now();

    if (frame.type === 'PING') {
      this.protocol?.send({ type: 'PONG', seq: frame.seq });
      return;
    }
    if (frame.type === 'PONG') return;

    // Resolve pending command relays
    if (frame.type === 'CMD_RESULT') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingCmds.get(ref);
      if (pending) {
        this.pendingCmds.delete(ref);
        pending.resolve(
          Array.isArray(frame.output)
            ? frame.output.filter((s): s is string => typeof s === 'string')
            : [],
        );
        return;
      }
    }

    // Resolve pending PARTY_WHOM requests
    if (frame.type === 'PARTY_WHOM_REPLY') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingWhom.get(ref);
      if (pending) {
        this.pendingWhom.delete(ref);
        pending.resolve(
          Array.isArray(frame.users)
            ? frame.users.filter(
                (u): u is PartyLineUser =>
                  typeof u === 'object' &&
                  u !== null &&
                  typeof (u as PartyLineUser).handle === 'string' &&
                  typeof (u as PartyLineUser).botname === 'string',
              )
            : [],
        );
        return;
      }
    }

    // Resolve pending PROTECT_ACK
    if (frame.type === 'PROTECT_ACK') {
      const ref = String(frame.ref ?? '');
      const pending = this.pendingProtect.get(ref);
      if (pending) {
        this.pendingProtect.delete(ref);
        pending.resolve(frame.success === true);
        return;
      }
    }

    // Execute incoming CMD frames locally (from .bot command routed via hub)
    if (frame.type === 'CMD' && this.cmdHandler) {
      executeCmdFrame(frame, this.cmdHandler, this.cmdPermissions!, (ref, output) => {
        this.send({ type: 'CMD_RESULT', ref, output });
      });
      return;
    }

    this.onFrame?.(frame);
  }

  // -----------------------------------------------------------------------
  // Reconnect with exponential backoff
  // -----------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (this.disconnecting || this.reconnectTimer || this.connecting) return;

    this.logger?.info(`Reconnecting in ${this.reconnectDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxDelayMs);
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.linkTimeoutMs) {
        this.logger?.warn('Hub timed out');
        this.protocol?.close();
        return;
      }
      this.pingSeq++;
      this.protocol?.send({ type: 'PING', seq: this.pingSeq });
    }, this.pingIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
