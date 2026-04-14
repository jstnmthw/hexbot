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

export const name = 'flood';
export const version = '1.0.0';
export const description =
  'Inbound flood protection: message rate, join/part spam, nick-change spam, channel lockdown';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  actions: string[];
  offenceWindowMs: number;
  lockCount: number;
  lockWindowMs: number;
  lockDurationMs: number;
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

/** Read a numeric config value with fallback. */
function cfgNum(key: string, fallback: number): number {
  const v = api.config[key];
  return typeof v === 'number' ? v : fallback;
}

/** Read a boolean config value with fallback. */
function cfgBool(key: string, fallback: boolean): boolean {
  const v = api.config[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** Read a string config value with fallback. */
function cfgStr(key: string, fallback: string): string {
  const v = api.config[key];
  return typeof v === 'string' ? v : fallback;
}

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
 *  recognised as privileged and skip the flood kick.
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

async function handleMsgFlood(ctx: ChannelHandlerContext): Promise<void> {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  if (isPrivileged(ctx.nick, channel, undefined, ctx.account)) return;
  // Key by hostmask, not nick: otherwise a nick-rotation botnet mints a
  // fresh tracker entry per nick change and escapes escalation. See audit
  // finding C2 (2026-04-14).
  const hostmask = api.buildHostmask(ctx);
  const key = `msg:${api.ircLower(hostmask)}@${api.ircLower(channel)}`;
  if (!rateLimits.check('msg', key)) return;
  const action = enforcement.recordOffence(key);
  enforcement.apply(
    action,
    channel,
    ctx.nick,
    `message flood (${cfg.msgThreshold}+ msgs/${cfg.msgWindowSecs}s)`,
  );
}

function handleJoinFlood(ctx: JoinContext): void {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  const hostmask = api.buildHostmask(ctx);
  // Check privilege BEFORE rate-limiting so exempt users don't populate the
  // counter — otherwise a flapping op would delay lockdown decisions for
  // real offenders.
  if (isPrivileged(ctx.nick, channel, hostmask, ctx.account)) return;
  const key = `join:${api.ircLower(hostmask)}`;
  if (!rateLimits.check('join', key)) return;
  const action = enforcement.recordOffence(key);
  lockdown.record(channel, hostmask);
  enforcement.apply(
    action,
    channel,
    ctx.nick,
    `join flood (${cfg.joinThreshold}+ joins/${cfg.joinWindowSecs}s)`,
  );
}

function handlePartFlood(ctx: PartContext): void {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  const hostmask = api.buildHostmask(ctx);
  // Check privilege BEFORE rate-limiting so exempt users don't populate the
  // counter. Pass hostmask directly — user has already left channel state by
  // the time the part bind fires.
  if (isPrivileged(ctx.nick, channel, hostmask, ctx.account)) return;
  const key = `part:${api.ircLower(hostmask)}`;
  if (!rateLimits.check('part', key)) return;
  const action = enforcement.recordOffence(key);
  lockdown.record(channel, hostmask);
  enforcement.apply(
    action,
    channel,
    ctx.nick,
    `part flood (${cfg.partThreshold}+ parts/${cfg.partWindowSecs}s)`,
  );
}

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

  const key = `nick:${api.ircLower(hostmask)}`;
  if (!rateLimits.check('nick', key)) return;
  // Use the new nick (ctx.args) for channel lookup and punishment — the old nick is gone
  const newNick = ctx.args;

  for (const channel of api.botConfig.irc.channels) {
    if (!botHasOps(channel)) continue;
    const action = enforcement.recordOffence(key);
    enforcement.apply(
      action,
      channel,
      newNick,
      `nick-change spam (${cfg.nickThreshold}+ changes/${cfg.nickWindowSecs}s)`,
    );
    break;
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

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
    actions: (() => {
      const a = api.config.actions;
      return Array.isArray(a) && a.every((x): x is string => typeof x === 'string')
        ? a
        : /* v8 ignore next -- defensive fallback, tests always pass valid actions */ [
            'warn',
            'kick',
            'tempban',
          ];
    })(),
    offenceWindowMs: cfgNum('offence_window_ms', 300_000),
    lockCount: cfgNum('flood_lock_count', 3),
    lockWindowMs: lockWindowSecs * 1000,
    lockDurationMs: lockDurationSecs * 1000,
    defaultLockMode: cfgStr('flood_lock_mode', 'R'),
  };

  // Capture `api` into a closure here rather than reading the module-level
  // `api` binding inside the error handler — a retained closure from a
  // prior load would otherwise fall through to the old (now-disposed) api.
  // See audit finding W-FL5 (2026-04-14).
  const capturedApi = api;
  const logFloodError = (err: unknown): void => {
    capturedApi.error('Flood action error:', err);
  };

  rateLimits = new RateLimitTracker(cfg);
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
  api.bind('part', '-', '*', handlePartFlood);
  api.bind('nick', '-', '*', handleNickFlood);
  // Drop lockdown state when the bot itself leaves a channel, otherwise
  // the scheduled unlock timer fires against a channel we're not in and
  // the entry lingers until then. See audit finding W-FL2 (2026-04-14).
  api.bind('part', '-', '*', (ctx) => {
    if (api.isBotNick(ctx.nick)) lockdown.dropChannel(ctx.channel);
  });
  api.bind('kick', '-', '*', (ctx) => {
    if (api.isBotNick(ctx.nick)) lockdown.dropChannel(ctx.channel);
  });
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
  // See audit finding W-FL5 (2026-04-14).
  await enforcement.drainPending();
  rateLimits.reset();
  enforcement.clear();
  lockdown.clear();
}
