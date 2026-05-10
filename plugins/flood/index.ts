// flood — Inbound flood protection plugin.
// Detects message floods, join spam, part spam, and nick-change spam.
// Escalating responses: warn → kick → tempban (configurable).
// Channel lockdown: sets +R (or +i fallback) when multiple distinct users
// trip the join/part flood detector within a window.
import type {
  ChannelHandlerContext,
  JoinContext,
  NickContext,
  PartContext,
  PluginAPI,
} from '../../src/types';
import { EnforcementExecutor } from './enforcement-executor';
import { LockdownController } from './lockdown';
import { RateLimitTracker } from './rate-limit-tracker';

/**
 * Stable rfc1459 case-fold used for rate-limit keys. We can't use
 * `api.ircLower` because it tracks the live CASEMAPPING — if the server
 * updates CASEMAPPING mid-session (rare but possible on a migration),
 * existing entries live under one fold while new lookups use another,
 * effectively resetting the counter. Pinning to `rfc1459` (the historical
 * default) keeps keys stable for the entire plugin lifetime regardless of
 * what the server later advertises.
 *
 * The four bracket/tilde substitutions implement the rfc1459 (vs ascii)
 * fold: `[]\^` are the uppercase forms of `{}|~`.
 */
function stableKeyLower(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '[') out += '{';
    else if (ch === ']') out += '}';
    else if (ch === '\\') out += '|';
    else if (ch === '~') out += '^';
    else out += ch.toLowerCase();
  }
  return out;
}

export const name = 'flood';
export const version = '1.0.0';
export const description =
  'Inbound flood protection: message rate, join/part spam, nick-change spam, channel lockdown';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Plugin-internal config shape after defaults are applied. Each event class
 * carries both the user-facing seconds value (for log/notice text) and the
 * pre-multiplied milliseconds value (for arithmetic on `Date.now()`).
 */
interface FloodConfig {
  msgThreshold: number;
  msgWindowSecs: number;
  msgWindowMs: number;
  joinThreshold: number;
  joinWindowSecs: number;
  joinWindowMs: number;
  partThreshold: number;
  partWindowSecs: number;
  partWindowMs: number;
  nickThreshold: number;
  nickWindowSecs: number;
  nickWindowMs: number;
  banDurationMinutes: number;
  ignoreOps: boolean;
  /** Escalation ladder; see {@link EnforcementConfig.actions}. */
  actions: string[];
  offenceWindowMs: number;
  /** Distinct-flooder threshold for channel-wide lockdown; 0 disables. */
  lockCount: number;
  lockWindowMs: number;
  lockDurationMs: number;
  /** Default channel mode for lockdown (`R` or `i`); per-channel override via channelSettings. */
  defaultLockMode: string;
}

// ---------------------------------------------------------------------------
// State (reset on each init)
// Intentional module-level mutable state: plugin is single-instance per process;
// state lives at module scope for performance (avoids per-call allocations).
// ---------------------------------------------------------------------------

let api: PluginAPI;
let cfg: FloodConfig;
let rateLimits: RateLimitTracker;
let enforcement: EnforcementExecutor;
let lockdown: LockdownController;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Read a numeric setting with fallback. Live (re-read on every init); the
 *  cfg snapshot below is what handlers consume so windowed math stays stable. */
function cfgNum(key: string, fallback: number): number {
  const v = api.settings.getInt(key);
  return v === 0 && !api.settings.isSet(key) ? fallback : v;
}

/** Read a boolean setting with fallback. */
function cfgBool(key: string, fallback: boolean): boolean {
  if (!api.settings.isSet(key)) return fallback;
  return api.settings.getFlag(key);
}

/** Read a string setting with fallback. */
function cfgStr(key: string, fallback: string): string {
  const v = api.settings.getString(key);
  return v ? v : fallback;
}

/**
 * Parse the comma-separated `actions` ladder from the plugin scope. Empty
 * tokens are dropped; operators can write `.set flood actions warn,kick,tempban`.
 */
function cfgActions(): string[] {
  const raw = api.settings.getString('actions') || 'warn,kick,tempban';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * True if the bot currently holds `+o` in `channel`. Enforcement actions
 * (kick/ban/mode) require ops — without this guard the bot would emit
 * MODE/KICK lines that the server rejects as "you're not channel
 * operator", noisily logging on every flood hit during a takeover where
 * the bot has been deopped.
 */
function botHasOps(channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = api.ircLower(api.botConfig.irc.nick);
  const botUser = ch.users.get(botNick);
  return botUser?.modes.includes('o') ?? false;
}

/** Return true if the nick has any privileged flag (n/m/o) in the channel.
 *  When `knownHostmask` is provided (e.g. from ctx for part events where the
 *  user has already left channel state), it skips the channel-state lookup.
 *  `account` is the IRCv3 account tag (or null for "server says not
 *  identified") from the triggering event — threading it through means users
 *  whose only permission record is a `$a:<account>` pattern are still
 *  recognized as privileged and skip the flood kick.
 */
function isPrivileged(
  nick: string,
  channel: string,
  knownHostmask?: string,
  account?: string | null,
): boolean {
  if (!cfg.ignoreOps) return false;
  const hostmask = knownHostmask ?? api.getUserHostmask(channel, nick);
  if (!hostmask) return false;
  const user = api.permissions.findByHostmask(hostmask, account);
  if (!user) return false;
  const flags = user.global + (user.channels[channel] ?? '');
  return /[nmo]/.test(flags);
}

// ---------------------------------------------------------------------------
// Bind handlers (module-level so init() stays thin)
// ---------------------------------------------------------------------------

/** Pubmsg flood handler — keys per (hostmask, channel) so the same user
 *  flooding two channels produces two separate escalation ladders. */
async function handleMsgFlood(ctx: ChannelHandlerContext): Promise<void> {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  if (isPrivileged(ctx.nick, channel, undefined, ctx.account)) return;
  // Key by hostmask, not nick: otherwise a nick-rotation botnet mints a
  // fresh tracker entry per nick change and escapes escalation.
  const hostmask = api.buildHostmask(ctx);
  const key = `msg:${stableKeyLower(hostmask)}@${stableKeyLower(channel)}`;
  if (!rateLimits.check('msg', key)) return;
  const action = enforcement.recordOffence(key);
  // null = same-burst dedup swallowed this hit; one flood = one strike.
  if (action === null) return;
  enforcement.apply(
    action,
    channel,
    ctx.nick,
    `message flood (${cfg.msgThreshold}+ msgs/${cfg.msgWindowSecs}s)`,
  );
}

/** Join-flood handler. Also feeds the channel-wide lockdown counter so a
 *  multi-user join wave can trigger `+R`/`+i` even when no individual user
 *  has been kicked yet. */
function handleJoinFlood(ctx: JoinContext): void {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  const hostmask = api.buildHostmask(ctx);
  // Check privilege BEFORE rate-limiting so exempt users don't populate the
  // counter — otherwise a flapping op would delay lockdown decisions for
  // real offenders.
  if (isPrivileged(ctx.nick, channel, hostmask, ctx.account)) return;
  const key = `join:${stableKeyLower(hostmask)}`;
  if (!rateLimits.check('join', key)) return;
  const action = enforcement.recordOffence(key);
  // Record the lockdown signal even when dedup suppresses the per-user
  // action — lockdown tracks distinct hostmasks hitting the channel, not
  // per-user escalation, and the same-burst rule shouldn't mask a real
  // join-spam wave.
  lockdown.record(channel, hostmask);
  if (action === null) return;
  enforcement.apply(
    action,
    channel,
    ctx.nick,
    `join flood (${cfg.joinThreshold}+ joins/${cfg.joinWindowSecs}s)`,
  );
}

/** Part-flood handler. Like {@link handleJoinFlood}, contributes to the
 *  lockdown counter so leave-spam waves can trigger `+R`/`+i`. */
function handlePartFlood(ctx: PartContext): void {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  const hostmask = api.buildHostmask(ctx);
  // Check privilege BEFORE rate-limiting so exempt users don't populate the
  // counter. Pass hostmask directly — user has already left channel state by
  // the time the part bind fires.
  if (isPrivileged(ctx.nick, channel, hostmask, ctx.account)) return;
  const key = `part:${stableKeyLower(hostmask)}`;
  if (!rateLimits.check('part', key)) return;
  const action = enforcement.recordOffence(key);
  // Same rationale as handleJoinFlood: lockdown is a channel-wide signal
  // and shouldn't be gated by the per-user burst dedup.
  lockdown.record(channel, hostmask);
  if (action === null) return;
  enforcement.apply(
    action,
    channel,
    ctx.nick,
    `part flood (${cfg.partThreshold}+ parts/${cfg.partWindowSecs}s)`,
  );
}

/** Nick-change flood handler. Tracked network-wide rather than per-channel —
 *  the user's permission record doesn't vary by channel. */
function handleNickFlood(ctx: NickContext): void {
  const { ident, hostname } = ctx;
  if (!ident && !hostname) return; // Incomplete hostmask data — skip
  const hostmask = api.buildHostmask(ctx);

  // Resolve privilege once globally BEFORE the rate-limit check so exempt
  // users don't populate the counter. Nick changes are a network-wide event
  // and the user's permission record does not vary channel-to-channel. The
  // old code rescanned per channel, which cost the bot a permissions lookup
  // for every configured channel on every nick change and would let an
  // ignoreOps-protected user still get enforced in channels ordered before
  // their first privileged match.
  if (cfg.ignoreOps) {
    const user = api.permissions.findByHostmask(hostmask, ctx.account);
    if (user && /[nmo]/.test(user.global)) return;
  }

  const key = `nick:${stableKeyLower(hostmask)}`;
  if (!rateLimits.check('nick', key)) return;
  // Use the new nick (ctx.args) for channel lookup and punishment — the old nick is gone
  const newNick = ctx.args;

  // Record the offence once (keyed on the user's persistent hostmask) so
  // the escalation ladder advances on the event, not per-channel. Then
  // apply the same action to every channel where the bot has ops — prior
  // behavior broke after the first hit and left the spammer unopposed
  // elsewhere.
  //
  // Three-state: `undefined` = not resolved yet (skip if no ops anywhere),
  // `null` = same-burst dedup swallowed the hit (skip apply in every
  // channel), `string` = the action to apply.
  //
  // Iterate `api.getJoinedChannels()` (live channel state) rather than
  // `botConfig.irc.channels` (startup config) so dynamically-joined
  // channels — `.join #other`, INVITE rejoin, botlink-pushed joins — get
  // enforcement too. Before this fix a spammer could pick a channel the
  // bot had joined at runtime and escape nick-flood enforcement entirely.
  let action: string | null | undefined;
  for (const channel of api.getJoinedChannels()) {
    if (!botHasOps(channel)) continue;
    if (action === undefined) action = enforcement.recordOffence(key);
    if (action === null) return;
    enforcement.apply(
      action,
      channel,
      newNick,
      `nick-change spam (${cfg.nickThreshold}+ changes/${cfg.nickWindowSecs}s)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  api.settings.register([
    {
      key: 'msg_threshold',
      type: 'int',
      default: 5,
      description: 'Messages from one user within msg_window_secs that trips a flood',
    },
    {
      key: 'msg_window_secs',
      type: 'int',
      default: 3,
      description: 'Window size for the per-user message-flood detector (seconds)',
    },
    {
      key: 'join_threshold',
      type: 'int',
      default: 3,
      description: 'Join events from one user within join_window_secs that trips a flood',
    },
    {
      key: 'join_window_secs',
      type: 'int',
      default: 60,
      description: 'Window size for the per-user join-flood detector (seconds)',
    },
    {
      key: 'part_threshold',
      type: 'int',
      default: 3,
      description: 'Part events from one user within part_window_secs that trips a flood',
    },
    {
      key: 'part_window_secs',
      type: 'int',
      default: 60,
      description: 'Window size for the per-user part-flood detector (seconds)',
    },
    {
      key: 'nick_threshold',
      type: 'int',
      default: 3,
      description: 'Nick changes from one user within nick_window_secs that trips a flood',
    },
    {
      key: 'nick_window_secs',
      type: 'int',
      default: 60,
      description: 'Window size for the per-user nick-flood detector (seconds)',
    },
    {
      key: 'ban_duration_minutes',
      type: 'int',
      default: 10,
      description: 'Tempban duration applied at the tempban escalation step (minutes)',
    },
    {
      key: 'ignore_ops',
      type: 'flag',
      default: true,
      description: 'Skip enforcement against users with privileged flags (n/m/o)',
    },
    {
      key: 'actions',
      type: 'string',
      default: 'warn,kick,tempban',
      description: 'Comma-separated escalation ladder (e.g. "warn,kick,tempban")',
    },
    {
      key: 'offence_window_ms',
      type: 'int',
      default: 300_000,
      description: 'Window for tracking repeat offences before the ladder resets (ms)',
    },
    {
      key: 'flood_lock_count',
      type: 'int',
      default: 3,
      description: 'Distinct flooders within flood_lock_window that trigger channel lockdown',
    },
    {
      key: 'flood_lock_window',
      type: 'int',
      default: 60,
      description: 'Window for the channel-lockdown distinct-flooder counter (seconds)',
    },
    {
      key: 'flood_lock_duration',
      type: 'int',
      default: 60,
      description: 'How long a channel stays in lockdown before unlock (seconds)',
    },
    {
      key: 'flood_lock_mode',
      type: 'string',
      default: 'R',
      description: 'Default channel mode for lockdown (R = registered-only, i = invite-only)',
      allowedValues: ['R', 'i'],
    },
  ]);

  // Window must be > 0 — a zero-window sweep is a silent no-op (see audit
  // W-FL1). Warn and clamp to the documented default instead of crashing
  // the plugin load.
  const windowSecs = (key: string, fallback: number): number => {
    const v = cfgNum(key, fallback);
    if (v <= 0) {
      api.warn(`${key}=${v} is invalid (must be > 0); using default ${fallback}s`);
      return fallback;
    }
    return v;
  };

  const msgWindowSecs = windowSecs('msg_window_secs', 3);
  const joinWindowSecs = windowSecs('join_window_secs', 60);
  const partWindowSecs = windowSecs('part_window_secs', 60);
  const nickWindowSecs = windowSecs('nick_window_secs', 60);
  const lockWindowSecs = windowSecs('flood_lock_window', 60);
  const lockDurationSecs = windowSecs('flood_lock_duration', 60);
  cfg = {
    msgThreshold: cfgNum('msg_threshold', 5),
    msgWindowSecs,
    msgWindowMs: msgWindowSecs * 1000,
    joinThreshold: cfgNum('join_threshold', 3),
    joinWindowSecs,
    joinWindowMs: joinWindowSecs * 1000,
    partThreshold: cfgNum('part_threshold', 3),
    partWindowSecs,
    partWindowMs: partWindowSecs * 1000,
    nickThreshold: cfgNum('nick_threshold', 3),
    nickWindowSecs,
    nickWindowMs: nickWindowSecs * 1000,
    banDurationMinutes: cfgNum('ban_duration_minutes', 10),
    ignoreOps: cfgBool('ignore_ops', true),
    actions: cfgActions(),
    offenceWindowMs: cfgNum('offence_window_ms', 300_000),
    lockCount: cfgNum('flood_lock_count', 3),
    lockWindowMs: lockWindowSecs * 1000,
    lockDurationMs: lockDurationSecs * 1000,
    defaultLockMode: cfgStr('flood_lock_mode', 'R'),
  };

  // Capture `api` into a closure here rather than reading the module-level
  // `api` binding inside the error handler — a retained closure from a
  // prior load would otherwise fall through to the old (now-disposed) api.
  const capturedApi = api;
  const logFloodError = (err: unknown): void => {
    capturedApi.error('Flood action error:', err);
  };

  rateLimits = new RateLimitTracker(cfg, api.util.createSlidingWindowCounter);
  enforcement = new EnforcementExecutor(api, cfg, botHasOps, logFloodError);
  lockdown = new LockdownController(api, cfg, botHasOps);

  // Register per-channel lockdown settings
  api.channelSettings.register([
    {
      key: 'flood_lock_mode',
      type: 'string',
      default: cfg.defaultLockMode,
      description: 'Channel mode to set on flood lockdown (R = registered-only, i = invite-only)',
      allowedValues: ['R', 'i'],
    },
  ]);

  api.bind('pubm', '-', '*', handleMsgFlood);
  api.bind('join', '-', '*', handleJoinFlood);
  // Single part bind: the user-flood path runs first; if the leaver is the
  // bot itself, additionally drop lockdown + per-channel enforcement state
  // so the scheduled unlock timer doesn't fire against a channel we're not
  // in. Two binds previously did the same work.
  api.bind('part', '-', '*', (ctx) => {
    handlePartFlood(ctx);
    if (api.isBotNick(ctx.nick)) {
      lockdown.dropChannel(ctx.channel);
      enforcement.dropChannel(ctx.channel);
    }
  });
  api.bind('nick', '-', '*', handleNickFlood);
  api.bind('kick', '-', '*', (ctx) => {
    if (api.isBotNick(ctx.nick)) {
      lockdown.dropChannel(ctx.channel);
      enforcement.dropChannel(ctx.channel);
    }
  });
  // Periodic sweep — pruning rate-limit and offence state inline on every
  // event would be cheaper per-call but would walk the maps every message;
  // a 60s tick lets a sustained-but-modest flood drift through cleanly
  // while still bounding worst-case memory.
  api.bind('time', '-', '60', () => {
    enforcement.liftExpiredBans();
    rateLimits.sweep();
    enforcement.sweep();
    lockdown.sweep();
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export async function teardown(): Promise<void> {
  // Drain any in-flight enforcement promises before nulling state so a
  // late-resolving ban/kick can't touch the disposed api. Bounded by
  // `enforcement.apply()`'s fire-and-forget surface; usually empty.
  await enforcement.drainPending();
  // Lift any tempbans that have already expired — otherwise the 60s
  // time-bind we just canceled was the only thing that would have
  // unbanned them, and the bans become effectively permanent until the
  // plugin is reloaded.
  try {
    enforcement.liftExpiredBans();
  } catch (err) {
    api?.error?.('flood teardown: liftExpiredBans threw:', err);
  }
  rateLimits.reset();
  enforcement.clear();
  lockdown.clear();
}
