// HexBot — Bot Link Leaf Client
// Connects to a hub, handles handshake, command relay, party line,
// protection requests, and reconnects with exponential backoff.
import { connect } from 'node:net';
import type { Socket } from 'node:net';

import type { CommandContext } from '../../command-handler';
import type { LoggerLike } from '../../logger';
import type { BotlinkConfig } from '../../types';
import { executeCmdFrame } from './cmd-exec.js';
import { Heartbeat } from './heartbeat';
import { PendingRequestMap } from './pending';
import { BotLinkProtocol, computeHelloHmac, deriveLinkKey } from './protocol';
import { RateCounter } from './rate-counter.js';
import type {
  CommandRelay,
  LinkFrame,
  LinkPermissions,
  PartyLineUser,
  SocketFactory,
} from './types.js';

// ---------------------------------------------------------------------------
// BotLinkLeaf
// ---------------------------------------------------------------------------

export class BotLinkLeaf {
  private config: BotlinkConfig;
  private version: string;
  private logger: LoggerLike | null;
  private socketFactory: SocketFactory;
  private protocol: BotLinkProtocol | null = null;
  private connected = false;
  private connecting = false;
  private disconnecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number;
  /**
   * Shared PING/timeout driver. Lazily installed in {@link startHeartbeat}
   * once steady-state is reached and torn down on every disconnect path.
   */
  private heartbeat: Heartbeat | null = null;
  private lastHeartbeatAt = 0;
  private hubBotname = '';
  private pingIntervalMs: number;
  private linkTimeoutMs: number;
  private reconnectDelayMs: number;
  private reconnectMaxDelayMs: number;
  private pendingCmds = new PendingRequestMap<string[]>();
  private pendingWhom = new PendingRequestMap<PartyLineUser[]>();
  private pendingProtect = new PendingRequestMap<boolean>();
  private cmdRefCounter = 0;
  private cmdHandler: CommandRelay | null = null;
  private cmdPermissions: LinkPermissions | null = null;
  /**
   * Soft rate cap on hub→leaf CMD frames. The documented trust model puts
   * the hub on the authenticated side, but a compromised hub would
   * otherwise get unbounded command execution on every leaf — a CPU-level
   * blast radius far beyond what any single hub operation should incur.
   * Default 50/s matches the audit's suggested ceiling; operators that run
   * batched admin scripts can raise it via `botlink.cmd_inbound_rate`.
   */
  private cmdInboundRate: RateCounter;
  /**
   * Cached HMAC key derived from (password, link_salt). Computed once at
   * construct; zeroed on disconnect/reconnect so a future key-rotation
   * story is straightforward. Never logged.
   */
  private linkKey: Buffer | null;

  /** Fired when handshake completes. */
  onConnected: ((hubBotname: string) => void) | null = null;
  /** Fired when connection is lost (not on explicit disconnect). */
  onDisconnected: ((reason: string) => void) | null = null;
  /** Fired for every non-heartbeat frame from the hub. */
  onFrame: ((frame: LinkFrame) => void) | null = null;

  constructor(
    config: BotlinkConfig,
    version: string,
    logger?: LoggerLike | null,
    socketFactory?: SocketFactory,
  ) {
    this.config = config;
    this.version = version;
    this.logger = logger?.child('botlink:leaf') ?? null;
    this.socketFactory = socketFactory ?? ((p, h) => connect(p, h));
    // Reconnect cadence: 5s base + exponential doubling with jitter,
    // capped at 60s. Long enough for a brief hub blip to pass without
    // hammering, short enough that recovery from a real outage is sub-
    // minute. Heartbeat is 30s with a 90s link-loss threshold, matching
    // the hub side.
    this.reconnectDelayMs = config.reconnect_delay_ms ?? 5_000;
    this.reconnectMaxDelayMs = config.reconnect_max_delay_ms ?? 60_000;
    this.reconnectDelay = this.reconnectDelayMs;
    this.pingIntervalMs = config.ping_interval_ms ?? 30_000;
    this.linkTimeoutMs = config.link_timeout_ms ?? 90_000;
    // `Math.max(1, …)` ensures a misconfigured zero or negative rate
    // doesn't permanently block CMDs — at least one per second always
    // gets through, so a typo can't lock the leaf out of admin commands.
    const cmdLimit = Math.max(1, config.cmd_inbound_rate ?? 50);
    this.cmdInboundRate = new RateCounter(cmdLimit, 1_000);
    // `config.link_salt` and `config.password` are validated upstream in
    // validateResolvedSecrets; the non-null assertion reflects that
    // contract. A bad config would throw at startup, not here.
    this.linkKey = deriveLinkKey(config.password, config.link_salt!);
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

    // Exactly one of these handlers fires per connect attempt. Whichever
    // runs must explicitly remove its twin, because the `once` wrapper only
    // detaches the firing listener — the other closure would remain
    // attached for the lifetime of the socket, pinning `this` and a hub
    // reference even after a successful transition to the protocol layer.
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
   *
   * @param timeoutMs Defaults to 5s — protection actions (op/deop/kick) are
   *   inherently latency-sensitive (the attacker is mid-event); waiting longer
   *   than this means the takeover already happened. Callers can raise it for
   *   non-urgent flows like UNBAN.
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

    return this.pendingProtect.create(ref, timeoutMs, false);
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

    // 10s — same ceiling as hub-originated `.bot` CMDs (see hub.ts).
    // Covers a slow remote handler without leaving the IRC user's command
    // hanging when the hub or the target leaf is wedged.
    const CMD_TIMEOUT_MS = 10_000;
    const output = await this.pendingCmds.create(ref, CMD_TIMEOUT_MS, ['Command relay timed out.']);

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

    // 10s — generous enough for the hub to enumerate every leaf's local
    // party-line set and merge them, but bounded so `.online` always
    // returns within an interactive timeframe.
    const WHOM_TIMEOUT_MS = 10_000;
    return this.pendingWhom.create(ref, WHOM_TIMEOUT_MS, []);
  }

  /** Resolve and clear all pending request maps. */
  private flushPendingRequests(): void {
    this.pendingCmds.drain(['Disconnected from hub.']);
    this.pendingWhom.drain([]);
    this.pendingProtect.drain(false);
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
    this.flushPendingRequests();
    if (this.protocol) {
      this.protocol.close();
      this.protocol = null;
    }
    // Zero the cached key — Node's GC is not zeroing, but dropping the
    // reference ties key lifetime to the current connection lifecycle
    // and keeps a future key-rotation story straightforward.
    this.linkKey = null;
  }

  /** Force a reconnect to the hub. */
  reconnect(): void {
    this.disconnecting = false;
    this.connecting = false;
    this.stopHeartbeat();
    this.connected = false;
    this.flushPendingRequests();
    if (this.protocol) {
      this.protocol.close();
      this.protocol = null;
    }
    // Re-derive the link key — the previous one was zeroed on
    // disconnect, and reconnect() is the canonical path to reset
    // any post-v2 key-rotation state.
    this.linkKey = deriveLinkKey(this.config.password, this.config.link_salt!);
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

    // Handshake deadline — covers "no CHALLENGE", "no WELCOME", and the
    // hub-crashes-mid-handshake cases. Without this, a hub that dies
    // between accept() and HELLO_CHALLENGE leaves the leaf waiting for
    // the kernel TCP timeout (~2.5 min).
    const handshakeTimeoutMs = 15_000;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      handshakeTimer = null;
      if (this.connected) return; // WELCOME already arrived — no-op
      this.logger?.warn(
        `Handshake timeout — no WELCOME within ${handshakeTimeoutMs}ms, closing socket and reconnecting`,
      );
      this.protocol?.close();
      this.protocol = null;
      this.onDisconnected?.('handshake timeout');
      this.scheduleReconnect();
    }, handshakeTimeoutMs);
    const clearHandshakeTimer = (): void => {
      if (handshakeTimer !== null) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };

    // Handshake phase — HELLO_CHALLENGE must arrive before WELCOME.
    // `challengeAnswered` guards against a duplicate CHALLENGE from a
    // malicious or buggy hub: first one wins, second is a PROTOCOL error.
    let challengeAnswered = false;

    this.protocol.onFrame = (frame) => {
      if (frame.type === 'HELLO_CHALLENGE') {
        if (challengeAnswered) {
          this.logger?.warn('Received second HELLO_CHALLENGE — closing');
          this.protocol?.send({ type: 'ERROR', code: 'PROTOCOL', message: 'Duplicate CHALLENGE' });
          this.protocol?.close();
          return;
        }
        // The hub generates the nonce via `crypto.randomBytes(32)` (see
        // hub.ts), which always produces 64 hex chars. Tightening the
        // regex from `[0-9a-fA-F]+` to exactly 64 chars closes a
        // hypothetical attack where a compromised hub could downgrade
        // entropy to a short / fixed value the leaf would still accept.
        const nonceHex = typeof frame.nonce === 'string' ? frame.nonce : '';
        if (!/^[0-9a-fA-F]{64}$/.test(nonceHex)) {
          this.logger?.warn('Malformed HELLO_CHALLENGE nonce — closing');
          this.protocol?.close();
          return;
        }
        const nonce = Buffer.from(nonceHex, 'hex');
        if (!this.linkKey) {
          // Should not happen — linkKey is set in the constructor and only
          // zeroed in disconnect()/reconnect(). Fail closed.
          this.logger?.error('linkKey missing when responding to CHALLENGE');
          this.protocol?.close();
          return;
        }
        const hmac = computeHelloHmac(this.linkKey, nonce);
        challengeAnswered = true;
        this.protocol?.send({
          type: 'HELLO',
          botname: this.config.botname,
          hmac,
          version: this.version,
        });
        return;
      }
      if (frame.type === 'WELCOME') {
        if (!challengeAnswered) {
          this.logger?.warn('WELCOME before CHALLENGE — closing');
          this.protocol?.close();
          return;
        }
        clearHandshakeTimer();
        this.hubBotname = String(frame.botname ?? '');
        this.connected = true;
        this.reconnectDelay = this.reconnectDelayMs; // Reset backoff
        this.lastHeartbeatAt = Date.now();

        // Switch to steady state
        if (this.protocol) this.protocol.onFrame = (f) => this.onSteadyState(f);
        this.startHeartbeat();

        this.logger?.info(`Connected to hub "${this.hubBotname}"`);
        this.onConnected?.(this.hubBotname);
      } else if (frame.type === 'ERROR') {
        clearHandshakeTimer();
        this.logger?.error(`Hub rejected: [${frame.code}] ${frame.message}`);
        this.protocol?.close();
        this.protocol = null;
        // Always notify disconnect watchers — watchdogs and DCC sync
        // tracking depend on seeing this transition even on AUTH_FAILED.
        this.onDisconnected?.(`handshake rejected: ${String(frame.code ?? 'unknown')}`);
        // Don't auto-reconnect on auth failure
        if (frame.code === 'AUTH_FAILED') return;
        this.scheduleReconnect();
      } else {
        this.logger?.warn(`Unexpected frame type "${frame.type}" during handshake — closing`);
        this.protocol?.send({
          type: 'ERROR',
          code: 'PROTOCOL',
          message: `Unexpected ${frame.type} during handshake`,
        });
        this.protocol?.close();
      }
    };

    this.protocol.onClose = () => {
      clearHandshakeTimer();
      const wasConnected = this.connected;
      this.connected = false;
      this.stopHeartbeat();
      this.flushPendingRequests();
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
    this.lastHeartbeatAt = Date.now();

    if (frame.type === 'PING') {
      this.protocol?.send({ type: 'PONG', seq: frame.seq });
      return;
    }
    if (frame.type === 'PONG') return;

    // Resolve pending command relays
    if (frame.type === 'CMD_RESULT') {
      const output = Array.isArray(frame.output)
        ? frame.output.filter((s): s is string => typeof s === 'string')
        : [];
      if (this.pendingCmds.resolve(String(frame.ref ?? ''), output)) return;
    }

    // Resolve pending PARTY_WHOM requests
    if (frame.type === 'PARTY_WHOM_REPLY') {
      const users = Array.isArray(frame.users)
        ? frame.users.filter((u): u is PartyLineUser => {
            if (typeof u !== 'object' || u === null) return false;
            const rec = u as Record<string, unknown>;
            return typeof rec.handle === 'string' && typeof rec.botname === 'string';
          })
        : [];
      if (this.pendingWhom.resolve(String(frame.ref ?? ''), users)) return;
    }

    // Resolve pending PROTECT_ACK
    if (frame.type === 'PROTECT_ACK') {
      if (this.pendingProtect.resolve(String(frame.ref ?? ''), frame.success === true)) return;
    }

    // Execute incoming CMD frames locally (from .bot command routed via hub).
    // `cmdHandler` and `cmdPermissions` are wired together by `setCommandRelay`,
    // so checking both here keeps the non-null narrowing local and explicit.
    if (frame.type === 'CMD' && this.cmdHandler && this.cmdPermissions) {
      if (!this.cmdInboundRate.check()) {
        // Reply with an empty CMD_RESULT so the hub's pending handler
        // resolves rather than timing out. Log a warning so a compromised
        // or misbehaving hub surfaces in the leaf log.
        this.logger?.warn(
          '[security] leaf CMD rate limit exceeded — refusing hub CMD frame until next second',
        );
        const ref = typeof frame.ref === 'string' ? frame.ref : '';
        if (ref) {
          this.send({ type: 'CMD_RESULT', ref, output: ['Rate limit exceeded'] });
        }
        return;
      }
      executeCmdFrame(frame, this.cmdHandler, this.cmdPermissions, (ref, output) => {
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

    // Full jitter (0.5–1.0 × delay) to avoid thundering-herd reconnects
    // when many leaves disconnect simultaneously (e.g. hub restart).
    // Without jitter, 20 leaves all fire a reconnect at exactly the same
    // base delay and the hub's own max_pending_handshakes guard auth-bans
    // them.
    const jitteredDelay = Math.max(
      1,
      Math.floor(this.reconnectDelay * (0.5 + 0.5 * Math.random())),
    );

    this.logger?.info(`Reconnecting in ${jitteredDelay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, jitteredDelay);
    // Defense in depth: a graceful shutdown that bypasses `disconnect()`
    // shouldn't be blocked by a pending reconnect attempt. `disconnect()`
    // already clears this timer; `unref()` is the safety net.
    this.reconnectTimer.unref();

    // Exponential backoff — based on the un-jittered delay so every leaf
    // converges toward the cap at the same rate.
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxDelayMs);
  }

  // -----------------------------------------------------------------------
  // Heartbeat
  // -----------------------------------------------------------------------

  private startHeartbeat(): void {
    // Heartbeat.stop() fires before onTimeout, so double-dispatch from a
    // concurrent socket error cannot re-enter the timeout branch. We
    // still call `stopHeartbeat()` anyway to drop the reference —
    // keeping the semantics explicit for the reconnect path.
    this.heartbeat = new Heartbeat({
      intervalMs: this.pingIntervalMs,
      timeoutMs: this.linkTimeoutMs,
      getLastMessageAt: () => this.lastHeartbeatAt,
      sendPing: (seq) => this.protocol?.send({ type: 'PING', seq }),
      onTimeout: () => {
        this.logger?.warn('Hub timed out');
        this.stopHeartbeat();
        this.protocol?.close();
      },
    });
    this.heartbeat.start();
  }

  private stopHeartbeat(): void {
    this.heartbeat?.stop();
    this.heartbeat = null;
  }
}
