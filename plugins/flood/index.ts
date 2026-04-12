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
import { SlidingWindowCounter } from '../../src/utils/sliding-window';

export const name = 'flood';
export const version = '1.0.0';
export const description =
  'Inbound flood protection: message rate, join/part spam, nick-change spam, channel lockdown';

let api: PluginAPI;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OffenceEntry {
  count: number;
  lastSeen: number;
}

interface BanRecord {
  mask: string;
  channel: string;
  ts: number;
  expires: number;
}

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

let msgTracker: SlidingWindowCounter;
let joinTracker: SlidingWindowCounter;
let partTracker: SlidingWindowCounter;
let nickTracker: SlidingWindowCounter;
let offenceTracker: Map<string, OffenceEntry>; // `${nick}@${channel}` or `${hostmask}`
let cfg: FloodConfig;

// Channel lockdown state: tracks distinct flooders per channel and active locks.
let lockFlooders: Map<string, Set<string>>; // channel → set of hostmasks that tripped join/part flood
let lockFloderTimestamps: Map<string, number[]>; // channel → timestamps of flooder detections
let activeLocks: Map<string, ReturnType<typeof setTimeout>>; // channel → unlock timer

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Shared error handler for fire-and-forget flood actions. */
function logFloodError(err: unknown): void {
  api.error('Flood action error:', err);
}

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

/** Returns true if the tracker has seen more than `threshold` events in `windowMs`. */
function isFloodTriggered(
  tracker: SlidingWindowCounter,
  key: string,
  windowMs: number,
  threshold: number,
): boolean {
  return tracker.check(key, windowMs, threshold);
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
 */
function isPrivileged(
  nick: string,
  channel: string,
  ignoreOps: boolean,
  knownHostmask?: string,
): boolean {
  if (!ignoreOps) return false;
  const hostmask = knownHostmask ?? api.getUserHostmask(channel, nick);
  if (!hostmask) return false;
  const user = api.permissions.findByHostmask(hostmask);
  if (!user) return false;
  const flags = user.global + (user.channels[channel] ?? '');
  return /[nmo]/.test(flags);
}

/**
 * Build a simple *!*@host ban mask from a hostmask.
 * For cloaked hosts (containing '/'), use exact cloak.
 */
function buildFloodBanMask(hostmask: string): string | null {
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;
  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;
  return `*!*@${host}`;
}

// ---------------------------------------------------------------------------
// Channel lockdown helpers
// ---------------------------------------------------------------------------

/** Determine the lock mode for a channel (chanset with registered default handles fallback). */
function getLockMode(channel: string): string {
  return api.channelSettings.getString(channel, 'flood_lock_mode');
}

/**
 * Record that a distinct flooder (by hostmask) tripped join/part flood in a channel.
 * When enough distinct flooders accumulate within the window, trigger lockdown.
 */
function recordFloodForLockdown(channel: string, hostmask: string): void {
  if (cfg.lockCount <= 0) return; // lockdown disabled

  const lowerChannel = api.ircLower(channel);
  const lowerMask = api.ircLower(hostmask);

  // Get or create the set of distinct flooders for this channel
  if (!lockFlooders.has(lowerChannel)) {
    lockFlooders.set(lowerChannel, new Set());
    lockFloderTimestamps.set(lowerChannel, []);
  }
  const flooders = lockFlooders.get(lowerChannel)!;
  const timestamps = lockFloderTimestamps.get(lowerChannel)!;

  // Only count each hostmask once
  if (flooders.has(lowerMask)) return;

  const now = Date.now();
  flooders.add(lowerMask);
  timestamps.push(now);

  // Prune timestamps outside the window
  const cutoff = now - cfg.lockWindowMs;
  while (timestamps.length > 0 && timestamps[0] < cutoff) {
    timestamps.shift();
  }

  // If enough distinct flooders in window, trigger lockdown
  if (timestamps.length >= cfg.lockCount && !activeLocks.has(lowerChannel)) {
    triggerLockdown(channel);
  }
}

function triggerLockdown(channel: string): void {
  if (!botHasOps(channel)) return;

  const lowerChannel = api.ircLower(channel);
  const mode = getLockMode(channel);

  api.mode(channel, `+${mode}`);
  api.log(`Channel lockdown: set +${mode} on ${channel} (flood detected)`);

  // Schedule auto-unlock
  const timer = setTimeout(() => {
    liftLockdown(channel, mode);
  }, cfg.lockDurationMs);
  activeLocks.set(lowerChannel, timer);
}

function liftLockdown(channel: string, mode: string): void {
  const lowerChannel = api.ircLower(channel);
  activeLocks.delete(lowerChannel);
  lockFlooders.delete(lowerChannel);
  lockFloderTimestamps.delete(lowerChannel);

  if (botHasOps(channel)) {
    api.mode(channel, `-${mode}`);
    api.log(`Channel lockdown lifted: -${mode} on ${channel}`);
  }
}

// ---------------------------------------------------------------------------
// Timed ban helpers (self-contained in flood plugin namespace)
// ---------------------------------------------------------------------------

function banDbKey(channel: string, mask: string): string {
  return `ban:${api.ircLower(channel)}:${mask}`;
}

function storeFloodBan(channel: string, mask: string, durationMinutes: number): void {
  const now = Date.now();
  const expires = durationMinutes === 0 ? 0 : now + durationMinutes * 60_000;
  const record: BanRecord = { mask, channel: api.ircLower(channel), ts: now, expires };
  api.db.set(banDbKey(channel, mask), JSON.stringify(record));
}

function liftExpiredFloodBans(): void {
  const now = Date.now();
  for (const { key, value } of api.db.list('ban:')) {
    const record = JSON.parse(value) as BanRecord;
    if (record.expires > 0 && record.expires <= now) {
      if (botHasOps(record.channel)) {
        api.mode(record.channel, '-b', record.mask);
        api.db.del(key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Offence tracking
// ---------------------------------------------------------------------------

function getAction(actions: string[], offenceCount: number): string {
  if (actions.length === 0) return 'warn';
  return actions[Math.min(offenceCount, actions.length - 1)];
}

function recordOffence(actions: string[], offenceWindowMs: number, key: string): string {
  const now = Date.now();
  const entry = offenceTracker.get(key);
  if (entry && now - entry.lastSeen < offenceWindowMs) {
    entry.count++;
    entry.lastSeen = now;
    return getAction(actions, entry.count - 1);
  }
  offenceTracker.set(key, { count: 1, lastSeen: now });
  return getAction(actions, 0);
}

// ---------------------------------------------------------------------------
// Flood actions
// ---------------------------------------------------------------------------

async function applyAction(
  banDurationMinutes: number,
  action: string,
  channel: string,
  nick: string,
  reason: string,
): Promise<void> {
  if (!botHasOps(channel)) return;

  if (action === 'warn') {
    api.notice(nick, `[flood] ${reason}`);
    api.log(`Warned ${nick} in ${channel}: ${reason}`);
  } else if (action === 'kick') {
    api.kick(channel, nick, `[flood] ${reason}`);
    api.log(`Kicked ${nick} from ${channel}: ${reason}`);
  } else {
    // action is 'tempban' — last valid action after 'warn' and 'kick'
    const hostmask = api.getUserHostmask(channel, nick);
    if (!hostmask) {
      api.kick(channel, nick, `[flood] ${reason}`);
      return;
    }
    const banMask = buildFloodBanMask(hostmask);
    if (!banMask) {
      api.kick(channel, nick, `[flood] ${reason}`);
      return;
    }
    api.ban(channel, banMask);
    storeFloodBan(channel, banMask, banDurationMinutes);
    api.kick(channel, nick, `[flood] ${reason}`);
    api.log(`Tempbanned ${nick} (${banMask}) from ${channel}: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Bind handlers (module-level so init() stays thin)
// ---------------------------------------------------------------------------

async function handleMsgFlood(ctx: ChannelHandlerContext): Promise<void> {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  if (isPrivileged(ctx.nick, channel, cfg.ignoreOps)) return;
  const key = `${api.ircLower(ctx.nick)}@${api.ircLower(channel)}`;
  if (!isFloodTriggered(msgTracker, key, cfg.msgWindowMs, cfg.msgThreshold)) return;
  const action = recordOffence(cfg.actions, cfg.offenceWindowMs, key);
  await applyAction(
    cfg.banDurationMinutes,
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
  const key = `join:${api.ircLower(hostmask)}`;
  if (!isFloodTriggered(joinTracker, key, cfg.joinWindowMs, cfg.joinThreshold)) return;
  if (isPrivileged(ctx.nick, channel, cfg.ignoreOps)) return;
  const action = recordOffence(cfg.actions, cfg.offenceWindowMs, key);
  recordFloodForLockdown(channel, hostmask);
  applyAction(
    cfg.banDurationMinutes,
    action,
    channel,
    ctx.nick,
    `join flood (${cfg.joinThreshold}+ joins/${cfg.joinWindowSecs}s)`,
  ).catch(logFloodError);
}

function handlePartFlood(ctx: PartContext): void {
  const { channel } = ctx;
  if (api.isBotNick(ctx.nick)) return;
  const hostmask = api.buildHostmask(ctx);
  const key = `part:${api.ircLower(hostmask)}`;
  if (!isFloodTriggered(partTracker, key, cfg.partWindowMs, cfg.partThreshold)) return;
  // Pass hostmask directly — user has already left channel state by the time the part bind fires
  if (isPrivileged(ctx.nick, channel, cfg.ignoreOps, hostmask)) return;
  const action = recordOffence(cfg.actions, cfg.offenceWindowMs, key);
  recordFloodForLockdown(channel, hostmask);
  applyAction(
    cfg.banDurationMinutes,
    action,
    channel,
    ctx.nick,
    `part flood (${cfg.partThreshold}+ parts/${cfg.partWindowSecs}s)`,
  ).catch(logFloodError);
}

function handleNickFlood(ctx: NickContext): void {
  const { ident, hostname } = ctx;
  if (!ident && !hostname) return; // Incomplete hostmask data — skip
  const hostmask = api.buildHostmask(ctx);
  const key = `nick:${api.ircLower(hostmask)}`;
  if (!isFloodTriggered(nickTracker, key, cfg.nickWindowMs, cfg.nickThreshold)) return;
  // Use the new nick (ctx.args) for channel lookup and punishment — the old nick is gone
  const newNick = ctx.args;
  // Nick changes are global — punish in the first channel where we have ops
  for (const channel of api.botConfig.irc.channels) {
    if (isPrivileged(newNick, channel, cfg.ignoreOps)) return;
    if (!botHasOps(channel)) continue;
    const action = recordOffence(cfg.actions, cfg.offenceWindowMs, key);
    applyAction(
      cfg.banDurationMinutes,
      action,
      channel,
      newNick,
      `nick-change spam (${cfg.nickThreshold}+ changes/${cfg.nickWindowSecs}s)`,
    ).catch(logFloodError);
    break;
  }
}

// ---------------------------------------------------------------------------
// Periodic state cleanup
// ---------------------------------------------------------------------------

/** Prune stale entries from rate-limit counters and offence tracker. */
function sweepStaleState(): void {
  const now = Date.now();
  // Sweep SlidingWindowCounter stale keys
  msgTracker.sweep(cfg.msgWindowMs);
  joinTracker.sweep(cfg.joinWindowMs);
  partTracker.sweep(cfg.partWindowMs);
  nickTracker.sweep(cfg.nickWindowMs);
  // Sweep expired offence entries
  for (const [key, entry] of offenceTracker) {
    if (now - entry.lastSeen > cfg.offenceWindowMs) {
      offenceTracker.delete(key);
    }
  }
  // Sweep lockFlooders/lockFloderTimestamps for channels without active locks
  for (const [ch] of lockFlooders) {
    if (!activeLocks.has(ch)) {
      lockFlooders.delete(ch);
      lockFloderTimestamps.delete(ch);
    }
  }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  // Fresh state on each load/reload
  msgTracker = new SlidingWindowCounter();
  joinTracker = new SlidingWindowCounter();
  partTracker = new SlidingWindowCounter();
  nickTracker = new SlidingWindowCounter();
  offenceTracker = new Map();
  lockFlooders = new Map();
  lockFloderTimestamps = new Map();
  activeLocks = new Map();

  const msgWindowSecs = cfgNum('msg_window_secs', 3);
  const joinWindowSecs = cfgNum('join_window_secs', 60);
  const partWindowSecs = cfgNum('part_window_secs', 60);
  const nickWindowSecs = cfgNum('nick_window_secs', 60);
  const lockWindowSecs = cfgNum('flood_lock_window', 60);
  const lockDurationSecs = cfgNum('flood_lock_duration', 60);
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
    actions: (api.config.actions as string[] | undefined) ?? ['warn', 'kick', 'tempban'],
    offenceWindowMs: cfgNum('offence_window_ms', 300_000),
    lockCount: cfgNum('flood_lock_count', 3),
    lockWindowMs: lockWindowSecs * 1000,
    lockDurationMs: lockDurationSecs * 1000,
    defaultLockMode: cfgStr('flood_lock_mode', 'R'),
  };

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
  api.bind('time', '-', '60', () => {
    liftExpiredFloodBans();
    sweepStaleState();
  });
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  msgTracker.reset();
  joinTracker.reset();
  partTracker.reset();
  nickTracker.reset();
  offenceTracker.clear();
  lockFlooders.clear();
  lockFloderTimestamps.clear();
  for (const timer of activeLocks.values()) clearTimeout(timer);
  activeLocks.clear();
}
