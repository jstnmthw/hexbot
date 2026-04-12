// HexBot — Connection lifecycle
// Handles the IRC connection events: registered, close, reconnecting, socket error.
// Extracted from Bot to keep bot.ts a thin orchestrator.
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotConfig, Casemapping } from '../types';
import type { BindHandler, BindType } from '../types';
import { toEventObject } from '../utils/irc-event';
import { ircLower } from '../utils/wildcard';
import { type ServerCapabilities, parseISupport } from './isupport';
import { type STSDirective, parseSTSDirective } from './sts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed for connection lifecycle. */
export interface LifecycleIRCClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  join(channel: string, key?: string): void;
  /**
   * irc-framework's `network.supports()` returns a string for most tokens, a
   * boolean for flag-only tokens, and parsed arrays for a handful of special
   * cases (`PREFIX`, `CHANMODES`, `CHANTYPES`). The widest honest type is
   * `unknown` — callers that care narrow from there.
   */
  network: {
    supports(feature: string): unknown;
    /**
     * Cap metadata from irc-framework. `available` is a `Map<cap, value>`
     * populated during CAP LS; `enabled` is the array of caps that survived
     * the CAP REQ/ACK round-trip. Both are needed to ingest the `sts=` cap.
     */
    cap?: {
      available?: Map<string, string>;
      enabled?: string[];
    };
  };
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
  /**
   * Callback to propagate a parsed ISUPPORT snapshot to the Bot and all
   * capability-aware modules (channel-state, irc-commands, irc-bridge, …).
   * Fires on every successful registration so reconnecting to a different
   * IRCd with different PREFIX/CHANMODES/MODES re-seeds downstream state.
   */
  applyServerCapabilities: (caps: ServerCapabilities) => void;
  /**
   * Called when irc-framework signals a reconnect attempt is starting.
   * Consumers use this hook to drop identity caches that can't survive
   * across sessions — specifically networkAccounts, where a stale entry
   * could let an imposter who took a known user's nick inherit permissions
   * on the new session.
   */
  onReconnecting?: () => void;
  /**
   * Called when a parsed IRCv3 STS directive is received on the connection.
   * Consumers persist the policy and, when the directive arrived on a
   * plaintext connection and contains a port, trigger a reconnect so the
   * policy is satisfied. `currentTls` is the session's current transport
   * so the caller can tell plaintext ingestion from TLS refresh.
   */
  onSTSDirective?: (directive: STSDirective, currentTls: boolean) => void;
  messageQueue: { clear(): void };
  dispatcher: {
    bind(type: BindType, flags: string, mask: string, handler: BindHandler, owner?: string): void;
  };
  logger: Logger;
  /** Channel state tracker — required for periodic presence check. */
  channelState?: PresenceCheckChannelState;
  /** Callback to re-attempt the IRC connection (for startup retry with backoff).
   *  irc-framework does not auto-reconnect on initial connection failure, so we
   *  handle retries ourselves. If not provided, initial failure is immediately fatal. */
  reconnect?: () => void;
}

/** Handle returned by registerConnectionEvents for cleanup on shutdown. */
export interface ConnectionLifecycleHandle {
  /** Stop the periodic channel presence check timer. */
  stopPresenceCheck(): void;
  /** Remove all IRC client listeners registered by connection lifecycle. */
  removeListeners(): void;
  /** Cancel any pending startup retry timer. */
  cancelStartupRetry(): void;
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
  // Tracks whether irc-framework signalled another reconnect attempt is coming.
  // Set to true by 'reconnecting', cleared by 'close'. If 'close' fires after
  // registration without a preceding 'reconnecting', retries are exhausted.
  let expectingReconnect = false;
  // Captures the last IRC ERROR reason or socket error so we can include it
  // in the 'close' log — irc-framework's 'close' event only passes a boolean.
  let lastCloseReason: string | null = null;

  // Startup retry state — irc-framework does not auto-reconnect on initial
  // connection failure (only after a successful registration), so we handle
  // retries ourselves with exponential backoff.
  const maxStartupRetries = 10;
  const maxRetryWait = 30_000;
  let startupAttempt = 0;

  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];
  let startupRetryTimer: ReturnType<typeof setTimeout> | null = null;

  function listen(event: string, fn: (...args: unknown[]) => void): void {
    client.on(event, fn);
    listeners.push({ event, fn });
  }

  // One-time listeners — registered before any connection events fire so they
  // are never stacked by reconnects.
  registerJoinErrorListeners(client, logger, listeners);
  bindCoreInviteHandler(deps);

  const onRegistered = () => {
    registered = true;
    expectingReconnect = false;
    lastCloseReason = null;
    startupAttempt = 0;
    logger.info(`Connected to ${cfg.host}:${cfg.port} as ${cfg.nick}`);

    if (cfg.tls) {
      logTlsCipher(client, logger);
    }

    deps.eventBus.emit('bot:connected');
    applyCasemapping(deps);
    applyServerCapabilities(deps);
    ingestSTSDirective(deps);

    joinConfiguredChannels(deps);

    // (Re)start the periodic channel presence check.
    // Cleared and restarted on each registration so reconnects get a fresh timer.
    if (presenceTimer !== null) clearInterval(presenceTimer);
    presenceTimer = startChannelPresenceCheck(deps);

    resolve();
  };

  // Capture the server's IRC ERROR message (e.g. "Closing Link: ... (Throttled)")
  // which fires just before the socket closes. irc-framework emits this as 'irc error'
  // with error === 'irc' and reason containing the server message.
  const onIrcError = (event: unknown) => {
    const e = toEventObject(event);
    if (String(e.error ?? '') === 'irc') {
      const reason = String(e.reason ?? '');
      lastCloseReason = reason;
      logger.warn(`Server ERROR: ${reason}`);
    }
  };

  const onClose = () => {
    if (registered && !expectingReconnect) {
      // irc-framework exhausted all reconnect attempts — the bot is a zombie.
      // If the ERROR reason says we were K/G-lined, exit non-zero immediately
      // instead of exiting after the usual exhaustion path (supervisord
      // should surface the reason in the restart log).
      const detail = lastCloseReason ? ` (${lastCloseReason})` : '';
      const policy = classifyCloseReason(lastCloseReason);
      if (policy.kind === 'banned') {
        logger.error(
          `FATAL: ${policy.label} on ${cfg.host} — refusing to reconnect. ` +
            `Resolve the ban before restarting the bot.`,
        );
      } else {
        logger.error(`Reconnect attempts exhausted${detail} — exiting`);
      }
      deps.eventBus.emit('bot:disconnected', 'reconnect attempts exhausted');
      // Exit non-zero so supervisord / docker know this is a fault and log
      // it appropriately. See docs/audits/irc-logic-2026-04-11.md §9 on the
      // exit-on-exhaustion contract.
      process.exit(1);
    }
    if (!registered) {
      // Connection failed before registration — log the reason so the user
      // can diagnose throttling, bans, TLS rejection, etc.
      const reason = lastCloseReason ?? 'no error detail from server';
      logger.error(`Connection failed: ${reason}`);
      deps.eventBus.emit('bot:disconnected', `connection failed: ${reason}`);

      // Interpret the server's ERROR reason (if any) and apply a retry
      // policy. K/G-line / banned-IP responses abort startup with a fatal
      // non-zero exit so we stop hammering a server that won't take us.
      // Throttle-class responses use a longer backoff multiplier than the
      // default exponential curve.
      const policy = classifyCloseReason(lastCloseReason);
      if (policy.kind === 'banned') {
        logger.error(
          `FATAL: ${policy.label} on ${cfg.host} — refusing to retry. ` +
            `Resolve the ban before restarting the bot.`,
        );
        deps.eventBus.emit('bot:disconnected', `banned: ${policy.label}`);
        // Exit to prevent hammering a banned server. supervisord will see
        // the non-zero exit and decide whether to keep restarting us.
        process.exit(1);
      }

      // irc-framework does not auto-reconnect on initial connection failure.
      // Retry with exponential backoff if the caller provided a reconnect callback.
      if (deps.reconnect && startupAttempt < maxStartupRetries) {
        startupAttempt++;
        const jitter = Math.floor(Math.random() * 5000);
        const baseDelay = Math.min(1000 * 2 ** startupAttempt, maxRetryWait);
        const delay = Math.floor(baseDelay * policy.backoffMultiplier) + jitter;
        logger.info(
          `Retrying connection in ${Math.round(delay / 1000)}s ` +
            `(attempt ${startupAttempt + 1}/${maxStartupRetries + 1})` +
            (policy.kind === 'throttled' ? ` — server asked us to slow down` : '') +
            `...`,
        );
        lastCloseReason = null;
        startupRetryTimer = setTimeout(() => deps.reconnect!(), delay);
      } else {
        reject(new Error(`Connection failed: ${reason}`));
      }
      return;
    }
    expectingReconnect = false;
    logger.info('Connection closed');
    deps.eventBus.emit('bot:disconnected', 'connection closed');
  };

  const onReconnecting = () => {
    expectingReconnect = true;
    lastCloseReason = null;
    deps.messageQueue.clear();
    deps.onReconnecting?.();
    logger.info('Reconnecting...');
  };

  const onSocketError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    lastCloseReason = error.message;
    logger.error('Socket error:', error.message);
    deps.eventBus.emit('bot:error', error);
    if (!registered) {
      reject(error);
    }
  };

  listen('registered', onRegistered);
  listen('irc error', onIrcError);
  listen('close', onClose);
  listen('reconnecting', onReconnecting);
  listen('socket error', onSocketError);

  return {
    stopPresenceCheck() {
      if (presenceTimer !== null) {
        clearInterval(presenceTimer);
        presenceTimer = null;
      }
    },
    removeListeners() {
      for (const { event, fn } of listeners) {
        client.removeListener(event, fn);
      }
      listeners.length = 0;
    },
    cancelStartupRetry() {
      if (startupRetryTimer !== null) {
        clearTimeout(startupRetryTimer);
        startupRetryTimer = null;
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
  let cm: Casemapping;
  if (raw === 'ascii' || raw === 'strict-rfc1459' || raw === 'rfc1459') {
    cm = raw;
  } else {
    cm = 'rfc1459';
    if (typeof raw === 'string' && raw.length > 0) {
      // Explicit warn so operators can track down a network advertising
      // something like `rfc7613` (Atheme unicode case folding) — we fall
      // through to rfc1459 but the behaviour is wrong for that network.
      deps.logger.warn(
        `Unknown CASEMAPPING "${raw}" advertised by server — falling back to rfc1459. ` +
          `Nick/channel case folding may be wrong on this network.`,
      );
    }
  }
  deps.logger.info(`CASEMAPPING: ${cm}`);
  deps.applyCasemapping(cm);
}

/** Parse the server's ISUPPORT snapshot and propagate it to all modules. */
function applyServerCapabilities(deps: ConnectionLifecycleDeps): void {
  const caps = parseISupport(deps.client);
  deps.logger.info(
    `ISUPPORT: PREFIX=${caps.prefixModes.map((m) => `${caps.prefixToSymbol[m]}${m}`).join('')} ` +
      `CHANTYPES=${caps.chantypes} MODES=${caps.modesPerLine}`,
  );
  deps.applyServerCapabilities(caps);
}

// ---------------------------------------------------------------------------
// IRC ERROR reason classification
// ---------------------------------------------------------------------------

/**
 * Outcome of classifying an `ERROR :Closing Link (...)` string:
 *
 * - `'normal'`    — no recognised pattern; use the default backoff
 * - `'throttled'` — transient overload; pause longer before retry
 * - `'banned'`    — K/G-line or DNSBL block; abort reconnect entirely
 */
type CloseReasonPolicy =
  | { kind: 'normal'; backoffMultiplier: 1 }
  | { kind: 'throttled'; label: string; backoffMultiplier: number }
  | { kind: 'banned'; label: string; backoffMultiplier: 1 };

const BANNED_PATTERNS: Array<[RegExp, string]> = [
  [/K[\s-]?Line/i, 'K-Lined'],
  [/G[\s-]?Line/i, 'G-Lined'],
  [/Z[\s-]?Line/i, 'Z-Lined'],
  [/Banned\s+from\s+server/i, 'banned from server'],
  [/You are banned/i, 'banned from server'],
  [/DNSBL/i, 'blocked by DNSBL'],
  [/You are not welcome/i, 'banned from server'],
];

const THROTTLED_PATTERNS: Array<[RegExp, string]> = [
  [/Throttled/i, 'throttled'],
  [/Reconnect(?:ing)?\s+too\s+fast/i, 'reconnecting too fast'],
  [/Too\s+many\s+connections/i, 'too many connections'],
  [/Connection\s+limit/i, 'connection limit reached'],
  [/Excess\s+Flood/i, 'excess flood'],
];

/**
 * Inspect an IRC `ERROR :...` reason (as captured on `irc error`/`close`)
 * and return a retry policy. Unknown reasons fall through to `'normal'`
 * so legacy code paths continue to work unchanged.
 */
function classifyCloseReason(reason: string | null): CloseReasonPolicy {
  if (!reason) return { kind: 'normal', backoffMultiplier: 1 };
  for (const [re, label] of BANNED_PATTERNS) {
    if (re.test(reason)) return { kind: 'banned', label, backoffMultiplier: 1 };
  }
  for (const [re, label] of THROTTLED_PATTERNS) {
    // 4× the default exponential delay keeps us off a shared server while
    // the throttle window drains, without turning every retry into an hour
    // of dead time.
    if (re.test(reason)) return { kind: 'throttled', label, backoffMultiplier: 4 };
  }
  return { kind: 'normal', backoffMultiplier: 1 };
}

/**
 * Read the `sts` cap from the irc-framework cap.available map and, if
 * present, parse and forward it to the STS store. irc-framework exposes
 * every CAP LS entry on `network.cap.available` regardless of whether we
 * requested it, so STS is readable even though we don't CAP REQ for it.
 *
 * A plaintext ingestion with a port directive triggers a reconnect in the
 * Bot callback — the caller is responsible for disconnecting and reopening
 * the session on the TLS port. The lifecycle layer just surfaces the
 * directive; it does not decide the reconnect policy.
 */
function ingestSTSDirective(deps: ConnectionLifecycleDeps): void {
  const callback = deps.onSTSDirective;
  if (!callback) return;
  const rawValue = deps.client.network.cap?.available?.get('sts');
  if (!rawValue) return;
  const directive = parseSTSDirective(rawValue);
  if (!directive) {
    deps.logger.warn(`Ignoring malformed STS directive "${rawValue}"`);
    return;
  }
  deps.logger.info(
    `IRCv3 STS received: duration=${directive.duration}` +
      (directive.port !== undefined ? ` port=${directive.port}` : ''),
  );
  callback(directive, deps.config.irc.tls);
}

/** Log TLS cipher info from the underlying socket. */
function logTlsCipher(client: LifecycleIRCClient, logger: Logger): void {
  // irc-framework does not expose the underlying socket in its public types, so
  // we walk the private connection/transport chain via `unknown`. Double-cast
  // would be needed because `LifecycleIRCClient` and `InternalClient` are
  // structurally unrelated; going through `unknown` keeps it honest.
  interface TlsCipherSocket {
    getCipher(): { name: string; version: string };
  }
  interface InternalClient {
    connection?: { transport?: { socket?: unknown } };
  }
  const tlsSocket = (client as unknown as InternalClient).connection?.transport?.socket;
  if (
    tlsSocket !== null &&
    typeof tlsSocket === 'object' &&
    'getCipher' in tlsSocket &&
    typeof (tlsSocket as TlsCipherSocket).getCipher === 'function'
  ) {
    const cipher = (tlsSocket as TlsCipherSocket).getCipher();
    logger.info(`TLS connected — ${cipher.name} (${cipher.version})`);
  } else {
    logger.info('TLS connected');
  }
}

/** Register listeners for IRC join-error numerics (irc error + unknown command). */
function registerJoinErrorListeners(
  client: LifecycleIRCClient,
  logger: Logger,
  listeners: Array<{ event: string; fn: (...args: unknown[]) => void }>,
): void {
  const JOIN_ERROR_NAMES: Record<string, string> = {
    channel_is_full: 'channel is full (+l)',
    invite_only_channel: 'invite only (+i)',
    banned_from_channel: 'banned from channel (+b)',
    bad_channel_key: 'bad channel key (+k)',
  };
  const onJoinIrcError = (event: unknown) => {
    const e = toEventObject(event);
    const reason = JOIN_ERROR_NAMES[String(e.error ?? '')];
    if (reason) {
      logger.warn(`Cannot join ${String(e.channel ?? '')}: ${reason}`);
    }
  };
  client.on('irc error', onJoinIrcError);
  listeners.push({ event: 'irc error', fn: onJoinIrcError });

  // 477 (need to register nick) is unknown to irc-framework — catch it via raw numeric.
  const onUnknownCommand = (event: unknown) => {
    const e = toEventObject(event);
    if (String(e.command ?? '') === '477') {
      const params = Array.isArray(e.params) ? (e.params as unknown[]) : [];
      logger.warn(`Cannot join ${String(params[1] ?? '')}: need to register nick (+r)`);
    }
  };
  client.on('unknown command', onUnknownCommand);
  listeners.push({ event: 'unknown command', fn: onUnknownCommand });
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
      // Use IRC-aware casemapping (rfc1459 as safe default — superset of all mappings)
      const ch = configuredChannels.find(
        (c) => ircLower(c.name, 'rfc1459') === ircLower(channel, 'rfc1459'),
      );
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
