// HexBot — Connection lifecycle
// Handles the IRC connection events: registered, close, socket error. All
// reconnect scheduling is delegated to the ReconnectDriver — this module
// only classifies the disconnect reason and tells the driver about it.
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import type { BotConfig, Casemapping } from '../types';
import type { BindHandler, BindType } from '../types';
import { toEventObject } from '../utils/irc-event';
import { ListenerGroup } from '../utils/listener-group';
import { ircLower } from '../utils/wildcard';
import {
  type PermanentFailureEntry,
  startChannelPresenceCheck as startPresenceCheck,
} from './channel-presence-checker';
import { type ReconnectPolicy, classifyCloseReason } from './close-reason-classifier';
import { type ServerCapabilities, parseISupport } from './isupport';
import type { ReconnectDriver } from './reconnect-driver';
import { type STSDirective, type STSStore, parseSTSDirective } from './sts';

// Re-export so external callers (reconnect-driver, tests) keep importing from
// connection-lifecycle — the classifier is now the source of truth but the
// public surface is unchanged.
export { type ReconnectPolicy, classifyCloseReason };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed for connection lifecycle. */
export interface LifecycleIRCClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  join(channel: string, key?: string): void;
  quit(message?: string): void;
  /** The bot's current nick as seen by the server. Used to detect nick collisions after registration. */
  user?: { nick?: string };
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
   * Read the currently-active casemapping. Defaults to `'rfc1459'` until the
   * server's 005 ISUPPORT lands. Needed by the INVITE re-join handler so it
   * folds channel names under the live mapping instead of assuming rfc1459
   * — on a network announcing `CASEMAPPING=strict-rfc1459` or `ascii`, the
   * `~`/`^` folding would otherwise differ from the rest of the bot.
   */
  getCasemapping?: () => Casemapping;
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
  /**
   * Read-only view of the STS store, consulted before mutating on a
   * plaintext ingestion. Lets `ingestSTSDirective` short-circuit when a
   * policy already exists and the session is plaintext — defence in depth
   * on top of `enforceSTS`, in case an attacker somehow gets us onto a
   * plaintext socket mid-policy and tries to extend or replace the stored
   * directive from the same host.
   */
  stsStore?: STSStore;
  messageQueue: { clear(): void; flushWithDeadline?(maxMs: number): number };
  dispatcher: {
    bind(type: BindType, flags: string, mask: string, handler: BindHandler, owner?: string): void;
  };
  logger: LoggerLike;
  /** Channel state tracker — required for periodic presence check. */
  channelState?: PresenceCheckChannelState;
  /**
   * Optional NickServ identify hook. When the bot is registered but not
   * using SASL, this runs before `joinConfiguredChannels()` so the IDENTIFY
   * line reaches NickServ before the first JOIN. On SASL networks the bot
   * is already authenticated at registration time, so this is a no-op.
   * Safe to omit in tests that don't exercise services.
   */
  identifyWithServices?: () => void;
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

// If the server accepts a connection but doesn't send the IRC greeting within
// this window, abort and let the reconnect driver retry. Without this,
// stalled connections wait for TCP timeout (~2.5 min) before retrying.
const REGISTRATION_TIMEOUT_MS = 30_000;

// `client.quit()` just queues a QUIT line — if the socket is already half-open
// (SYN-ACK received but RST never arrives) the 'close' event never fires.
// After this grace period we forcibly destroy the underlying socket so our
// 'close' listener runs and the reconnect driver picks up. See stability
// audit 2026-04-14.
const SOCKET_DESTROY_GRACE_MS = 5_000;

// Wall-clock budget for draining queued mode/kick commands into the
// irc-framework send buffer when a disconnect is in progress. Most queued
// messages will evaporate with the socket, but a brief flush expresses
// operator intent rather than silently dropping it. See stability audit
// 2026-04-14.
const DISCONNECT_FLUSH_DEADLINE_MS = 100;

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
  let registrationTimer: ReturnType<typeof setTimeout> | null = null;

  const listeners = new ListenerGroup(client);

  // Channels that have failed JOIN with a permanent-error numeric
  // (+i/+b/+k/+r). The presence-check timer consults this map so it
  // applies the bounded retry schedule (default 5/15/45 min) instead of
  // retrying every tick. Cleared implicitly on the next reconnect because
  // this whole closure is re-created. See bounded-retry design 2026-04-19.
  const permanentFailureChannels = new Map<string, PermanentFailureEntry>();

  // One-time listeners — registered before any connection events fire so they
  // are never stacked by reconnects.
  const retrySchedule = deps.config.channel_retry_schedule_ms ?? [300_000, 900_000, 2_700_000];
  registerJoinErrorListeners(logger, listeners, permanentFailureChannels, retrySchedule);
  bindCoreInviteHandler(deps);

  const onConnecting = (): void => {
    // Connecting event fires when client.connect() is called, even if the
    // socket fails to open or registration times out. Start a registration
    // timeout that will fire even if socket-level events don't arrive.
    if (registrationTimer !== null) {
      clearTimeout(registrationTimer);
    }
    registrationTimer = setTimeout(() => {
      registrationTimer = null;
      lastCloseReason = 'registration timeout';
      logger.warn(
        `IRC registration timeout — no greeting received within ${REGISTRATION_TIMEOUT_MS / 1000}s`,
      );
      // Close the socket so 'close' event fires and reconnect logic runs.
      client.quit('Registration timeout');
      setTimeout(() => {
        const socket = getInternalTlsSocket(client);
        if (socket && typeof (socket as { destroy?: unknown }).destroy === 'function') {
          try {
            (socket as { destroy: (err?: Error) => void }).destroy(
              new Error('registration timeout: forcing socket destroy'),
            );
            logger.warn('Forced socket destroy after registration-timeout QUIT');
          } catch (err) {
            logger.error('Failed to destroy stalled socket:', err);
          }
        }
      }, SOCKET_DESTROY_GRACE_MS).unref();
    }, REGISTRATION_TIMEOUT_MS);
  };

  const onRegistered = async (): Promise<void> => {
    lastCloseReason = null;
    // Registration succeeded, cancel the stall timeout.
    if (registrationTimer !== null) {
      clearTimeout(registrationTimer);
      registrationTimer = null;
    }
    reconnectDriver.onConnected();

    // C-4: detect nick collision — the server may have assigned a different
    // nick (e.g. HEX_) when the configured nick (HEX) was taken.
    const actualNick = String(deps.client.user?.nick ?? cfg.nick);
    const nickCollision = actualNick.toLowerCase() !== cfg.nick.toLowerCase();
    if (nickCollision) {
      logger.warn(`Registered as ${actualNick} (expected ${cfg.nick}) — nick collision detected`);
    } else {
      logger.info(`Connected to ${cfg.host}:${cfg.port} as ${cfg.nick}`);
    }

    if (cfg.tls) {
      logTlsCipher(client, logger);
    }

    // Emit bot:connected first, then nick-collision so subscribers that
    // update channelState/bridge run before joinConfiguredChannels.
    deps.eventBus.emit('bot:connected');
    if (nickCollision) {
      deps.eventBus.emit('bot:nick-collision', actualNick);
    }
    applyCasemapping(deps);
    applyServerCapabilities(deps);
    ingestSTSDirective(deps);

    // Send NickServ IDENTIFY before JOIN on non-SASL networks so the
    // account-bind / cloak has a chance to be applied before the bot hits
    // a +r channel or ChanServ auto-op check. The two messages still race
    // over the wire (they're separate server-routed commands), but in
    // practice NickServ processes IDENTIFY fast enough that the bind
    // lands first. See docs/services-identify-before-join.md.
    deps.identifyWithServices?.();

    // W-1: gate JOINs on identity when configured. Waits for bot:identified,
    // `bot:disconnected`, or the timeout — whichever fires first. Without
    // the disconnect arm, a session that dropped mid-wait would keep the
    // promise hanging until the timeout elapsed, delaying the next
    // connection attempt by up to `timeoutMs`. Clamp `timeoutMs` to 60 s so
    // a misconfig can't park a JOIN pass indefinitely. See stability audit
    // 2026-04-21 and follow-up 2026-04-24.
    const svcCfg = deps.config.services;
    if (svcCfg.identify_before_join) {
      const rawTimeout = svcCfg.identify_before_join_timeout_ms ?? 10_000;
      const timeoutMs = Math.min(Math.max(rawTimeout, 0), 60_000);
      await new Promise<void>((resolve) => {
        const onIdentified = (): void => {
          clearTimeout(timer);
          deps.eventBus.off('bot:disconnected', onDisconnect);
          resolve();
        };
        const onDisconnect = (): void => {
          clearTimeout(timer);
          deps.eventBus.off('bot:identified', onIdentified);
          resolve();
        };
        const timer = setTimeout(() => {
          deps.eventBus.off('bot:identified', onIdentified);
          deps.eventBus.off('bot:disconnected', onDisconnect);
          resolve();
        }, timeoutMs).unref();
        deps.eventBus.once('bot:identified', onIdentified);
        deps.eventBus.once('bot:disconnected', onDisconnect);
      });
    }

    joinConfiguredChannels(deps);

    // (Re)start the periodic channel presence check.
    // Cleared and restarted on each registration so reconnects get a fresh timer.
    // Reset the permanent-failure set on registration — a freshly
    // reconnected session might have different K-lines / +i state.
    permanentFailureChannels.clear();
    if (presenceTimer !== null) clearInterval(presenceTimer);
    presenceTimer = startChannelPresenceCheck(deps, permanentFailureChannels, retrySchedule);

    if (firstConnect) {
      firstConnect = false;
      resolve();
    }
  };

  // Capture the server's IRC ERROR message (e.g. "Closing Link: ... (Throttled)")
  // which fires just before the socket closes. irc-framework emits this as 'irc error'
  // with error === 'irc' and reason containing the server message.
  const onIrcError = (event: unknown): void => {
    const e = toEventObject(event);
    if (String(e.error ?? '') === 'irc') {
      const reason = String(e.reason ?? '');
      lastCloseReason = reason;
      logger.warn(`Server ERROR: ${reason}`);
    }
  };

  const onClose = (): void => {
    const reason = lastCloseReason ?? 'connection closed';
    const policy = classifyCloseReason(lastCloseReason);
    lastCloseReason = null;

    // Cancel any pending registration timeout — the socket is closed so the timer is moot.
    if (registrationTimer !== null) {
      clearTimeout(registrationTimer);
      registrationTimer = null;
    }

    // Clear the per-channel presence check interval too. Without this the
    // interval keeps firing "Not in configured channel X" during long
    // rate-limited backoffs. See audit finding W-CL1 (2026-04-14).
    if (presenceTimer !== null) {
      clearInterval(presenceTimer);
      presenceTimer = null;
    }

    logger.info(`Connection closed: ${reason}`);
    deps.eventBus.emit('bot:disconnected', reason);

    // Drop per-session identity caches and the outgoing message queue on
    // every disconnect. The hook was previously tied to 'reconnecting',
    // but with auto_reconnect:false that event is never emitted.
    if (deps.messageQueue.flushWithDeadline) {
      const drained = deps.messageQueue.flushWithDeadline(DISCONNECT_FLUSH_DEADLINE_MS);
      if (drained > 0) {
        logger.debug(`Flushed ${drained} queued message(s) during disconnect`);
      }
    }
    deps.messageQueue.clear();
    deps.onReconnecting?.();

    // Driver owns backoff, tier escalation, fatal exit, and status state.
    reconnectDriver.onDisconnect(policy);
  };

  const onSocketError = (err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    lastCloseReason = error.message;
    logger.error('Socket error:', error.message);
    deps.eventBus.emit('bot:error', error);
    // Note: no reject() — the driver will retry on the subsequent 'close'.
  };

  listeners.on('registered', onRegistered);
  listeners.on('connecting', onConnecting);
  listeners.on('irc error', onIrcError);
  listeners.on('close', onClose);
  listeners.on('socket error', onSocketError);

  return {
    stopPresenceCheck(): void {
      if (presenceTimer !== null) {
        clearInterval(presenceTimer);
        presenceTimer = null;
      }
    },
    removeListeners(): void {
      listeners.removeAll();
      // Also clear any pending registration timeout
      if (registrationTimer !== null) {
        clearTimeout(registrationTimer);
        registrationTimer = null;
      }
    },
    cancelReconnect(): void {
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
  // Defence in depth on top of `enforceSTS`: if we're on plaintext and a
  // policy already exists for this host, never let the plaintext session
  // mutate the stored directive. `enforceSTS` already refuses to run on
  // plaintext under an active policy, so reaching this code path means
  // something upstream went wrong — bail out loudly rather than quietly
  // extending the expiry or swapping the recorded port from the attacker-
  // controlled session.
  if (deps.config.irc.tls === false && deps.stsStore?.get(deps.config.irc.host)) {
    deps.logger.warn(
      `Refusing to ingest STS directive from plaintext session for ${deps.config.irc.host} — a policy already exists`,
    );
    return;
  }
  // First-contact defence: a MITM-served CAP LS over TLS with
  // `tls_verify=false` could pin a fake STS policy against a host the bot
  // has never spoken to before. With verification disabled, the cert the
  // bot trusted isn't authoritative — neither is the CAP list it returned.
  // Refuse to ingest under that shape and warn loudly. Operators on
  // networks without a stable CA chain are already warned at startup;
  // this closes the policy-pin channel on top of that.
  const tlsVerifyDisabled = deps.config.irc.tls_verify === false;
  if (tlsVerifyDisabled && !deps.stsStore?.get(deps.config.irc.host)) {
    deps.logger.warn(
      `Refusing to ingest first-contact STS directive for ${deps.config.irc.host} with tls_verify=false — ` +
        `untrusted TLS session cannot authoritatively pin a policy. Set tls_verify=true to enable STS pinning.`,
    );
    return;
  }
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
function logTlsCipher(client: LifecycleIRCClient, logger: LoggerLike): void {
  const tlsSocket = getInternalTlsSocket(client);
  if (hasGetCipher(tlsSocket)) {
    const cipher = tlsSocket.getCipher();
    if (
      cipher &&
      typeof cipher === 'object' &&
      typeof (cipher as { name?: unknown }).name === 'string' &&
      typeof (cipher as { version?: unknown }).version === 'string'
    ) {
      logger.info(
        `TLS connected — ${(cipher as { name: string }).name} (${(cipher as { version: string }).version})`,
      );
      return;
    }
  }
  logger.info('TLS connected');
}

/**
 * irc-framework does not expose the underlying socket in its public types, so
 * we walk the private connection/transport chain via `unknown`. The intermediate
 * `as unknown as InternalClient` is load-bearing: `LifecycleIRCClient` and
 * `InternalClient` are structurally unrelated, and routing through `unknown`
 * documents that we deliberately discarded the public type.
 */
function getInternalTlsSocket(client: LifecycleIRCClient): unknown {
  interface InternalClient {
    connection?: { transport?: { socket?: unknown } };
  }
  return (client as unknown as InternalClient).connection?.transport?.socket;
}

/** Type guard: does the value quack like a `tls.TLSSocket` with `getCipher`? */
function hasGetCipher(value: unknown): value is { getCipher(): unknown } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'getCipher' in value &&
    typeof (value as { getCipher: unknown }).getCipher === 'function'
  );
}

/**
 * Register listeners for IRC join-error numerics (irc error + unknown command).
 *
 * When a JOIN fails with a permanent-failure numeric, the channel is
 * added to `permanentFailureChannels` so the periodic presence check
 * stops retrying it until the next reconnect (when state resets).
 * Without this, a K-lined or invite-only channel floods the server
 * with JOINs every 30s and risks a collateral K-line for the bot
 * itself. See stability audit 2026-04-14.
 */
function registerJoinErrorListeners(
  logger: LoggerLike,
  listeners: ListenerGroup,
  permanentFailureChannels: Map<string, PermanentFailureEntry>,
  retrySchedule: readonly number[],
): void {
  const JOIN_ERROR_NAMES: Record<string, string> = {
    channel_is_full: 'channel is full (+l)',
    invite_only_channel: 'invite only (+i)',
    banned_from_channel: 'banned from channel (+b)',
    bad_channel_key: 'bad channel key (+k)',
  };
  // Of the above, only `channel_is_full` (471) is transient-ish — the
  // +l limit can drop. The rest require operator action (unban, invite,
  // correct key) and the presence checker applies a bounded retry
  // schedule so time-limited bans (e.g. flood kicks) auto-recover.
  const PERMANENT_FAILURE_NAMES: ReadonlySet<string> = new Set([
    'invite_only_channel',
    'banned_from_channel',
    'bad_channel_key',
  ]);

  /**
   * Register a channel for bounded retry. If it already has an entry,
   * leave it alone — a repeated failure during retry must not reset the
   * tier back to zero or the backoff is meaningless.
   */
  const markPermanentFailure = (channel: string): void => {
    const key = ircLower(channel, 'rfc1459');
    if (permanentFailureChannels.has(key)) return;
    const firstDelay = retrySchedule[0] ?? 0;
    permanentFailureChannels.set(key, { tier: 0, nextRetryAt: Date.now() + firstDelay });
    if (retrySchedule.length === 0) {
      logger.warn(
        `${channel} marked as permanent-failure — retries are disabled by config. ` +
          `Fix the underlying cause and use .join ${channel} to retry.`,
      );
    } else {
      logger.warn(
        `${channel} marked as permanent-failure — next retry in ${Math.round(firstDelay / 1000)}s ` +
          `(${retrySchedule.length} attempt${retrySchedule.length === 1 ? '' : 's'} scheduled). ` +
          `Use .join ${channel} to retry immediately.`,
      );
    }
  };

  listeners.on('irc error', (...args: unknown[]) => {
    const e = toEventObject(args[0]);
    const errName = String(e.error ?? '');
    const reason = JOIN_ERROR_NAMES[errName];
    const channel = String(e.channel ?? '');
    if (reason) {
      logger.warn(`Cannot join ${channel}: ${reason}`);
      if (channel && PERMANENT_FAILURE_NAMES.has(errName)) {
        markPermanentFailure(channel);
      }
    }
  });

  // 477 (need to register nick) is unknown to irc-framework — catch it
  // via raw numeric. Permanent until the bot identifies with services.
  listeners.on('unknown command', (...args: unknown[]) => {
    const e = toEventObject(args[0]);
    if (String(e.command ?? '') === '477') {
      const params = Array.isArray(e.params) ? (e.params as unknown[]) : [];
      const channel = String(params[1] ?? '');
      logger.warn(`Cannot join ${channel}: need to register nick (+r)`);
      if (channel) {
        markPermanentFailure(channel);
      }
    }
  });
}

/**
 * Bind the core INVITE handler — auto-re-joins configured channels on invite.
 * No permission check: this is a bot-level feature, not user-triggered.
 * Plugins may add their own 'invite' binds with flag checking.
 */
function bindCoreInviteHandler(deps: ConnectionLifecycleDeps): void {
  const { client, configuredChannels, dispatcher, logger, getCasemapping } = deps;
  dispatcher.bind(
    'invite',
    '-',
    '*',
    (ctx) => {
      const channel = ctx.channel;
      if (!channel) return;
      // Fold under the live casemapping — fallback to rfc1459 (the safest
      // superset) only when the lifecycle deps pre-date this field.
      const cm = getCasemapping ? getCasemapping() : 'rfc1459';
      const ch = configuredChannels.find((c) => ircLower(c.name, cm) === ircLower(channel, cm));
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
 * Thin adapter that hands the connection-lifecycle deps off to the shared
 * {@link startPresenceCheck} helper in `channel-presence-checker.ts`. Keeps
 * the call site in {@link registerConnectionEvents} unchanged while the
 * policy lives in its own file.
 */
function startChannelPresenceCheck(
  deps: ConnectionLifecycleDeps,
  permanentFailureChannels: Map<string, PermanentFailureEntry>,
  retrySchedule: readonly number[],
): ReturnType<typeof setInterval> | null {
  return startPresenceCheck(
    {
      client: deps.client,
      channelState: deps.channelState ?? null,
      configuredChannels: deps.configuredChannels,
      logger: deps.logger,
      intervalMs: deps.config.channel_rejoin_interval_ms ?? 30_000,
      retrySchedule,
    },
    permanentFailureChannels,
  );
}
