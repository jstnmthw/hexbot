// HexBot — Connection lifecycle
// Handles the IRC connection events: registered, close, reconnecting, socket error.
// Extracted from Bot to keep bot.ts a thin orchestrator.
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotConfig, Casemapping } from '../types';
import type { BindHandler, BindType } from '../types';
import { toEventObject } from '../utils/irc-event';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed for connection lifecycle. */
export interface LifecycleIRCClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  join(channel: string, key?: string): void;
  network: { supports(feature: string): string | boolean };
}

/** Minimal channel-state interface for presence checks (avoids importing the full class). */
export interface PresenceCheckChannelState {
  getChannel(name: string): unknown | undefined;
}

export interface ConnectionLifecycleDeps {
  client: LifecycleIRCClient;
  config: BotConfig;
  configuredChannels: Array<{ name: string; key?: string }>;
  eventBus: BotEventBus;
  /** Callback to propagate the server's casemapping to the Bot and all modules. */
  applyCasemapping: (cm: Casemapping) => void;
  messageQueue: { clear(): void };
  dispatcher: {
    bind(type: BindType, flags: string, mask: string, handler: BindHandler, owner?: string): void;
  };
  logger: Logger;
  /** Channel state tracker — required for periodic presence check. */
  channelState?: PresenceCheckChannelState;
}

/** Handle returned by registerConnectionEvents for cleanup on shutdown. */
export interface ConnectionLifecycleHandle {
  /** Stop the periodic channel presence check timer. */
  stopPresenceCheck(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Register all IRC connection lifecycle event listeners on the client.
 * The returned promise resolves when the bot successfully registers,
 * and rejects on a socket error before registration.
 *
 * Returns a handle with a `stopPresenceCheck()` method for cleanup on shutdown.
 */
export function registerConnectionEvents(
  deps: ConnectionLifecycleDeps,
  resolve: () => void,
  reject: (err: Error) => void,
): ConnectionLifecycleHandle {
  const { client, config, logger } = deps;
  const cfg = config.irc;
  let registered = false;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;
  let listenersRegistered = false;
  // Tracks whether irc-framework signalled another reconnect attempt is coming.
  // Set to true by 'reconnecting', cleared by 'close'. If 'close' fires after
  // registration without a preceding 'reconnecting', retries are exhausted.
  let expectingReconnect = false;
  // Captures the last IRC ERROR reason or socket error so we can include it
  // in the 'close' log — irc-framework's 'close' event only passes a boolean.
  let lastCloseReason: string | null = null;

  client.on('registered', () => {
    registered = true;
    expectingReconnect = false;
    lastCloseReason = null;
    logger.info(`Connected to ${cfg.host}:${cfg.port} as ${cfg.nick}`);

    if (cfg.tls) {
      logTlsCipher(client, logger);
    }

    deps.eventBus.emit('bot:connected');
    applyCasemapping(deps);

    // Register IRC error and invite listeners once — they don't depend on
    // connection state and stacking duplicates on every reconnect leaks
    // memory and causes duplicate joins/warnings.
    if (!listenersRegistered) {
      registerJoinErrorListeners(client, logger);
      bindCoreInviteHandler(deps);
      listenersRegistered = true;
    }

    joinConfiguredChannels(deps);

    // (Re)start the periodic channel presence check.
    // Cleared and restarted on each registration so reconnects get a fresh timer.
    if (presenceTimer !== null) clearInterval(presenceTimer);
    presenceTimer = startChannelPresenceCheck(deps);

    resolve();
  });

  // Capture the server's IRC ERROR message (e.g. "Closing Link: ... (Throttled)")
  // which fires just before the socket closes. irc-framework emits this as 'irc error'
  // with error === 'irc' and reason containing the server message.
  client.on('irc error', (event: unknown) => {
    const e = toEventObject(event);
    if (String(e.error ?? '') === 'irc') {
      const reason = String(e.reason ?? '');
      lastCloseReason = reason;
      logger.warn(`Server ERROR: ${reason}`);
    }
  });

  client.on('close', () => {
    if (registered && !expectingReconnect) {
      // irc-framework exhausted all reconnect attempts — the bot is a zombie.
      const detail = lastCloseReason ? ` (${lastCloseReason})` : '';
      logger.error(`Reconnect attempts exhausted${detail} — exiting`);
      deps.eventBus.emit('bot:disconnected', 'reconnect attempts exhausted');
      process.exit(1);
    }
    if (!registered) {
      // Connection failed before registration — log the reason so the user
      // can diagnose throttling, bans, TLS rejection, etc.
      const reason = lastCloseReason ?? 'no error detail from server';
      logger.error(`Connection failed: ${reason}`);
      deps.eventBus.emit('bot:disconnected', `connection failed: ${reason}`);
      reject(new Error(`Connection failed: ${reason}`));
      return;
    }
    expectingReconnect = false;
    logger.info('Connection closed');
    deps.eventBus.emit('bot:disconnected', 'connection closed');
  });

  client.on('reconnecting', () => {
    expectingReconnect = true;
    lastCloseReason = null;
    deps.messageQueue.clear();
    logger.info('Reconnecting...');
  });

  client.on('socket error', (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    lastCloseReason = error.message;
    logger.error('Socket error:', error.message);
    deps.eventBus.emit('bot:error', error);
    if (!registered) {
      reject(error);
    }
  });

  return {
    stopPresenceCheck() {
      if (presenceTimer !== null) {
        clearInterval(presenceTimer);
        presenceTimer = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Startup helpers (called from the 'registered' handler)
// ---------------------------------------------------------------------------

/** Read CASEMAPPING from ISUPPORT and propagate it to all modules. */
function applyCasemapping(deps: ConnectionLifecycleDeps): void {
  const raw = deps.client.network.supports('CASEMAPPING');
  const cm: Casemapping =
    raw === 'ascii' || raw === 'strict-rfc1459' || raw === 'rfc1459' ? raw : 'rfc1459'; // safe fallback for unknown values
  deps.logger.info(`CASEMAPPING: ${cm}`);
  deps.applyCasemapping(cm);
}

/** Log TLS cipher info from the underlying socket. */
function logTlsCipher(client: LifecycleIRCClient, logger: Logger): void {
  // Access the TLS socket through irc-framework's internal connection/transport chain.
  // Using optional chaining throughout since this is private API.
  type InternalClient = { connection?: { transport?: { socket?: unknown } } };
  const tlsSocket = (client as unknown as InternalClient).connection?.transport?.socket;
  if (tlsSocket && typeof (tlsSocket as Record<string, unknown>).getCipher === 'function') {
    const cipher = (tlsSocket as { getCipher(): { name: string; version: string } }).getCipher();
    logger.info(`TLS connected — ${cipher.name} (${cipher.version})`);
  } else {
    logger.info('TLS connected');
  }
}

/** Register listeners for IRC join-error numerics (irc error + unknown command). */
function registerJoinErrorListeners(client: LifecycleIRCClient, logger: Logger): void {
  const JOIN_ERROR_NAMES: Record<string, string> = {
    channel_is_full: 'channel is full (+l)',
    invite_only_channel: 'invite only (+i)',
    banned_from_channel: 'banned from channel (+b)',
    bad_channel_key: 'bad channel key (+k)',
  };
  client.on('irc error', (event: unknown) => {
    const e = toEventObject(event);
    const reason = JOIN_ERROR_NAMES[String(e.error ?? '')];
    if (reason) {
      logger.warn(`Cannot join ${String(e.channel ?? '')}: ${reason}`);
    }
  });
  // 477 (need to register nick) is unknown to irc-framework — catch it via raw numeric.
  client.on('unknown command', (event: unknown) => {
    const e = toEventObject(event);
    if (String(e.command ?? '') === '477') {
      const params = Array.isArray(e.params) ? (e.params as unknown[]) : [];
      logger.warn(`Cannot join ${String(params[1] ?? '')}: need to register nick (+r)`);
    }
  });
}

/**
 * Bind the core INVITE handler — auto-re-joins configured channels on invite.
 * No permission check: this is a bot-level feature, not user-triggered.
 * Plugins may add their own 'invite' binds with flag checking.
 */
function bindCoreInviteHandler(deps: ConnectionLifecycleDeps): void {
  const { client, configuredChannels, dispatcher, logger } = deps;
  dispatcher.bind(
    'invite',
    '-',
    '*',
    (ctx) => {
      const channel = ctx.channel;
      if (!channel) return;
      const ch = configuredChannels.find((c) => c.name.toLowerCase() === channel.toLowerCase());
      if (!ch) return;
      client.join(ch.name, ch.key);
      logger.info(`INVITE from ${ctx.nick}: re-joining configured channel ${ch.name}`);
    },
    'core',
  );
}

/** Send JOIN for every channel in the configured list. */
function joinConfiguredChannels(deps: ConnectionLifecycleDeps): void {
  for (const ch of deps.configuredChannels) {
    deps.client.join(ch.name, ch.key);
    deps.logger.info(`Joining ${ch.name}`);
  }
}

/**
 * Periodically check that the bot is in all configured channels.
 * If missing from any, attempt to rejoin (with key if configured).
 *
 * Returns the interval handle, or null if disabled (interval = 0 or no channelState).
 */
function startChannelPresenceCheck(
  deps: ConnectionLifecycleDeps,
): ReturnType<typeof setInterval> | null {
  const intervalMs = deps.config.channel_rejoin_interval_ms ?? 30_000;
  if (intervalMs <= 0 || !deps.channelState) return null;

  const { client, configuredChannels, channelState, logger } = deps;
  const warnedChannels = new Set<string>();

  return setInterval(() => {
    for (const ch of configuredChannels) {
      const inChannel = channelState.getChannel(ch.name) !== undefined;
      if (inChannel) {
        warnedChannels.delete(ch.name);
        continue;
      }
      if (!warnedChannels.has(ch.name)) {
        logger.warn(`Not in configured channel ${ch.name} — attempting rejoin`);
        warnedChannels.add(ch.name);
      } else {
        logger.debug(`Retrying join for ${ch.name}`);
      }
      client.join(ch.name, ch.key);
    }
  }, intervalMs);
}
