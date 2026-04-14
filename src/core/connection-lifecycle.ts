// HexBot — Connection lifecycle
// Handles the IRC connection events: registered, close, socket error. All
// reconnect scheduling is delegated to the ReconnectDriver — this module
// only classifies the disconnect reason and tells the driver about it.
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotConfig, Casemapping } from '../types';
import type { BindHandler, BindType } from '../types';
import { toEventObject } from '../utils/irc-event';
import { ircLower } from '../utils/wildcard';
import { type ServerCapabilities, parseISupport } from './isupport';
import type { ReconnectDriver } from './reconnect-driver';
import { type STSDirective, parseSTSDirective } from './sts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed for connection lifecycle. */
export interface LifecycleIRCClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  join(channel: string, key?: string): void;
  quit(message?: string): void;
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
   * Called on every disconnect — used to drop identity caches that can't
   * survive across sessions (specifically networkAccounts, where a stale
   * entry could let an imposter who took a known user's nick inherit
   * permissions on the new session). Fresh account data will arrive via
   * extended-join / account-notify / account-tag on rejoin.
   */
  onReconnecting?: () => void;
  /**
   * Reconnect driver — owns backoff state and schedules the next retry.
   * Required for the bot to recover from any disconnect; if absent, a
   * single disconnect leaves the process idle.
   */
  reconnectDriver: ReconnectDriver;
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
}

/** Handle returned by registerConnectionEvents for cleanup on shutdown. */
export interface ConnectionLifecycleHandle {
  /** Stop the periodic channel presence check timer. */
  stopPresenceCheck(): void;
  /** Remove all IRC client listeners registered by connection lifecycle. */
  removeListeners(): void;
  /** Cancel any pending reconnect attempt scheduled on the driver. */
  cancelReconnect(): void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Register all IRC connection lifecycle event listeners on the client.
 * The returned promise resolves on the first successful registration so
 * Bot.start() can proceed past `connect()`. After that, every disconnect
 * is routed to the injected ReconnectDriver, which schedules the next
 * `client.connect()` call — we never reject after the initial resolve.
 *
 * The `reject` callback is only used if listeners throw synchronously
 * while being wired up (an internal error — retained for safety).
 */
export function registerConnectionEvents(
  deps: ConnectionLifecycleDeps,
  resolve: () => void,
  _reject: (err: Error) => void,
): ConnectionLifecycleHandle {
  const { client, config, logger, reconnectDriver } = deps;
  const cfg = config.irc;
  // `firstConnect` exists only so Bot.start()'s await completes on the first
  // successful registration. Every subsequent reconnect cycle is handled
  // by the driver — we just notify it via onDisconnect/onConnected.
  let firstConnect = true;
  let presenceTimer: ReturnType<typeof setInterval> | null = null;
  // Captures the last IRC ERROR reason or socket error so we can classify
  // it when 'close' fires — irc-framework's 'close' event only passes a boolean.
  let lastCloseReason: string | null = null;
  // If the server accepts a connection but doesn't send the IRC greeting
  // within 30s, abort and let the reconnect driver retry. Without this,
  // stalled connections wait for TCP timeout (~2.5 min) before retrying.
  let registrationTimer: ReturnType<typeof setTimeout> | null = null;

  const listeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  function listen(event: string, fn: (...args: unknown[]) => void): void {
    client.on(event, fn);
    listeners.push({ event, fn });
  }

  // One-time listeners — registered before any connection events fire so they
  // are never stacked by reconnects.
  registerJoinErrorListeners(client, logger, listeners);
  bindCoreInviteHandler(deps);

  const onConnecting = () => {
    // Connecting event fires when client.connect() is called, even if the
    // socket fails to open or registration times out. Start a 30s registration
    // timeout that will fire even if socket-level events don't arrive.
    if (registrationTimer !== null) {
      clearTimeout(registrationTimer);
    }
    registrationTimer = setTimeout(() => {
      registrationTimer = null;
      lastCloseReason = 'registration timeout';
      logger.warn('IRC registration timeout — no greeting received within 30s');
      // Close the socket so 'close' event fires and reconnect logic runs.
      client.quit('Registration timeout');
    }, 30_000);
  };

  const onRegistered = () => {
    lastCloseReason = null;
    // Registration succeeded, cancel the stall timeout.
    if (registrationTimer !== null) {
      clearTimeout(registrationTimer);
      registrationTimer = null;
    }
    reconnectDriver.onConnected();
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

    if (firstConnect) {
      firstConnect = false;
      resolve();
    }
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
    const reason = lastCloseReason ?? 'connection closed';
    const policy = classifyCloseReason(lastCloseReason);
    lastCloseReason = null;

    // Cancel any pending registration timeout — the socket is closed so the timer is moot.
    if (registrationTimer !== null) {
      clearTimeout(registrationTimer);
      registrationTimer = null;
    }

    logger.info(`Connection closed: ${reason}`);
    deps.eventBus.emit('bot:disconnected', reason);

    // Drop per-session identity caches and the outgoing message queue on
    // every disconnect. The hook was previously tied to 'reconnecting',
    // but with auto_reconnect:false that event is never emitted.
    deps.messageQueue.clear();
    deps.onReconnecting?.();

    // Driver owns backoff, tier escalation, fatal exit, and status state.
    reconnectDriver.onDisconnect(policy);
  };

  const onSocketError = (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    lastCloseReason = error.message;
    logger.error('Socket error:', error.message);
    deps.eventBus.emit('bot:error', error);
    // Note: no reject() — the driver will retry on the subsequent 'close'.
  };

  listen('registered', onRegistered);
  listen('connecting', onConnecting);
  listen('irc error', onIrcError);
  listen('close', onClose);
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
      // Also clear any pending registration timeout
      if (registrationTimer !== null) {
        clearTimeout(registrationTimer);
        registrationTimer = null;
      }
    },
    cancelReconnect() {
      reconnectDriver.cancel();
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
 * A retry tier plus the human-readable label that should appear in logs and
 * the `.status` command. The driver in `reconnect-driver.ts` picks the
 * backoff curve from the tier; connection-lifecycle only classifies.
 *
 * - `transient`    — TCP hiccup, ping timeout, server restart, unknown reason.
 *                    Short exponential backoff (1s → 30s cap).
 * - `rate-limited` — K-line, DNSBL, throttled. Long backoff (5min → 30min cap);
 *                    the bot keeps retrying indefinitely, since these expire.
 * - `fatal`        — bad SASL, unsupported mech, cert mismatch. Process exits
 *                    so a supervisor can page someone instead of the bot
 *                    silently locking an account in a retry loop.
 */
export type ReconnectPolicy =
  | { tier: 'transient'; label?: string }
  | { tier: 'rate-limited'; label: string }
  | { tier: 'fatal'; label: string; exitCode: number };

// Exit code 2 = fatal config error. A single code keeps supervisor wrappers
// simple; the log line carries the actual cause.
const FATAL_EXIT_CODE = 2;

const FATAL_PATTERNS: Array<[RegExp, string]> = [
  // SASL 904 — "SASL authentication failed". Must fire on first hit, before
  // the account-lockout counter on services ticks past its threshold.
  [/SASL.*(authentication\s+failed|failed)/i, 'SASL authentication failed'],
  // SASL 908 — server advertises no acceptable mechanism for us. Config
  // error, retrying won't fix it.
  [/mechanism(?:s)?\s+not\s+supported/i, 'SASL mechanism not supported'],
  [/no\s+such\s+mechanism/i, 'SASL mechanism not supported'],
  // TLS cert verification failures surfaced by node's tls module. If the
  // operator set tls_verify=true, these are permanent until config change.
  [/Hostname\/IP\s+does\s+not\s+match/i, 'TLS hostname mismatch'],
  [/unable\s+to\s+verify\s+the\s+first\s+certificate/i, 'TLS certificate untrusted'],
  [/self[-\s]signed\s+certificate/i, 'TLS self-signed certificate'],
  [/CERT_HAS_EXPIRED/i, 'TLS certificate expired'],
];

const RATE_LIMITED_PATTERNS: Array<[RegExp, string]> = [
  // Ban-class responses — operators lift these, auto-klines expire, DNSBLs
  // drain. Long backoff lets the bot recover automatically.
  [/K[\s-]?Line/i, 'K-Lined'],
  [/G[\s-]?Line/i, 'G-Lined'],
  [/Z[\s-]?Line/i, 'Z-Lined'],
  [/Banned\s+from\s+server/i, 'banned from server'],
  [/You are banned/i, 'banned from server'],
  [/You are not welcome/i, 'banned from server'],
  [/DNSBL/i, 'blocked by DNSBL'],
  [/Your\s+(host|IP)\s+is\s+listed/i, 'IP listed in DNSBL'],
  // Throttle-class responses — transient but we need to slow down hard.
  [/Throttled/i, 'throttled'],
  [/Reconnect(?:ing)?\s+too\s+fast/i, 'reconnecting too fast'],
  [/Too\s+many\s+connections/i, 'too many connections'],
  [/Connection\s+limit/i, 'connection limit reached'],
  [/Excess\s+Flood/i, 'excess flood'],
];

const TRANSIENT_LABEL_PATTERNS: Array<[RegExp, string]> = [
  // These still classify as `transient` — the label just makes the log
  // line name the cause instead of saying "unknown reason".
  [/ping\s+timeout/i, 'ping timeout'],
  [/registration\s+(?:tim(?:e|ed)\s*)?out/i, 'registration timeout'],
  [/server\s+shutting\s+down/i, 'server shutting down'],
  [/restart\s+in\s+progress/i, 'server restart'],
  [/closing\s+link/i, 'closing link'],
];

/**
 * Inspect an IRC `ERROR :...` reason (from `irc error` / socket error /
 * TLS failure) and assign a retry tier. Unknown reasons fall through to
 * `'transient'` with no label — the common case on a flaky network.
 *
 * Exported so unit tests can exercise the pattern matrix directly.
 */
export function classifyCloseReason(reason: string | null): ReconnectPolicy {
  if (!reason) return { tier: 'transient' };
  for (const [re, label] of FATAL_PATTERNS) {
    if (re.test(reason)) return { tier: 'fatal', label, exitCode: FATAL_EXIT_CODE };
  }
  for (const [re, label] of RATE_LIMITED_PATTERNS) {
    if (re.test(reason)) return { tier: 'rate-limited', label };
  }
  for (const [re, label] of TRANSIENT_LABEL_PATTERNS) {
    if (re.test(reason)) return { tier: 'transient', label };
  }
  return { tier: 'transient' };
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
