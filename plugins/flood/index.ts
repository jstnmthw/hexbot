// flood — Inbound flood protection plugin.
// Detects message floods, join/part spam, and nick-change spam.
// Escalating responses: warn → kick → tempban (configurable).
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'flood';
export const version = '1.0.0';
export const description = 'Inbound flood protection: message rate, join spam, nick-change spam';

let api: PluginAPI;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WindowEntry {
  count: number;
  windowStart: number;
}

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

// ---------------------------------------------------------------------------
// State (reset on each init)
// ---------------------------------------------------------------------------

let msgTracker: Map<string, WindowEntry>; // `${nick}@${channel}`
let joinTracker: Map<string, WindowEntry>; // `${hostmask}`
let nickTracker: Map<string, WindowEntry>; // `${hostmask}`
let offenceTracker: Map<string, OffenceEntry>; // `${nick}@${channel}` or `${hostmask}`

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getBotNick(): string {
  const irc = api.botConfig.irc as Record<string, unknown> | undefined;
  return (irc?.nick as string | undefined) ?? '';
}

function isBotNick(nick: string): boolean {
  return nick.toLowerCase() === getBotNick().toLowerCase();
}

function botHasOps(channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = getBotNick().toLowerCase();
  const botUser = ch.users.get(botNick);
  return botUser?.modes?.includes('o') ?? false;
}

/** Return true if the nick has any privileged flag (n/m/o) in the channel. */
function isPrivileged(nick: string, channel: string, ignoreOps: boolean): boolean {
  if (!ignoreOps) return false;
  const hostmask = api.getUserHostmask(channel, nick);
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

/** Check a sliding window counter and return true if threshold is exceeded. */
function checkWindow(
  tracker: Map<string, WindowEntry>,
  key: string,
  windowMs: number,
  threshold: number,
): boolean {
  const now = Date.now();
  const entry = tracker.get(key);
  if (!entry || now - entry.windowStart > windowMs) {
    tracker.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > threshold;
}

// ---------------------------------------------------------------------------
// Timed ban helpers (self-contained in flood plugin namespace)
// ---------------------------------------------------------------------------

function banDbKey(channel: string, mask: string): string {
  return `ban:${channel.toLowerCase()}:${mask}`;
}

function storeFloodBan(channel: string, mask: string, durationMinutes: number): void {
  const now = Date.now();
  const expires = durationMinutes === 0 ? 0 : now + durationMinutes * 60_000;
  const record: BanRecord = { mask, channel: channel.toLowerCase(), ts: now, expires };
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
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  // Fresh state on each load/reload
  msgTracker = new Map();
  joinTracker = new Map();
  nickTracker = new Map();
  offenceTracker = new Map();

  const msgThreshold = (api.config.msg_threshold as number | undefined) ?? 5;
  const msgWindowSecs = (api.config.msg_window_secs as number | undefined) ?? 3;
  const joinThreshold = (api.config.join_threshold as number | undefined) ?? 3;
  const joinWindowSecs = (api.config.join_window_secs as number | undefined) ?? 60;
  const nickThreshold = (api.config.nick_threshold as number | undefined) ?? 3;
  const nickWindowSecs = (api.config.nick_window_secs as number | undefined) ?? 60;
  const banDurationMinutes = (api.config.ban_duration_minutes as number | undefined) ?? 10;
  const ignoreOps = (api.config.ignore_ops as boolean | undefined) ?? true;
  const actions = (api.config.actions as string[] | undefined) ?? ['warn', 'kick', 'tempban'];
  const offenceWindowMs = (api.config.offence_window_ms as number | undefined) ?? 300_000; // 5 min

  const msgWindowMs = msgWindowSecs * 1000;
  const joinWindowMs = joinWindowSecs * 1000;
  const nickWindowMs = nickWindowSecs * 1000;

  /** Pick the action for the current offence count (0-indexed). */
  function getAction(offenceCount: number): string {
    if (actions.length === 0) return 'warn';
    return actions[Math.min(offenceCount, actions.length - 1)];
  }

  /** Record an offence and return the action to take. */
  function recordOffence(key: string): string {
    const now = Date.now();
    const entry = offenceTracker.get(key);
    if (entry && now - entry.lastSeen < offenceWindowMs) {
      entry.count++;
      entry.lastSeen = now;
      return getAction(entry.count - 1);
    }
    offenceTracker.set(key, { count: 1, lastSeen: now });
    return getAction(0);
  }

  /** Apply a flood action to a user. */
  async function applyAction(
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
    } else if (action === 'tempban') {
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
  // Message flood detection
  // ---------------------------------------------------------------------------

  api.bind('pubm', '-', '*', async (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (isBotNick(ctx.nick)) return;
    if (isPrivileged(ctx.nick, ctx.channel, ignoreOps)) return;

    const key = `${ctx.nick.toLowerCase()}@${ctx.channel.toLowerCase()}`;
    const flooded = checkWindow(msgTracker, key, msgWindowMs, msgThreshold);
    if (!flooded) return;

    const action = recordOffence(key);
    await applyAction(
      action,
      ctx.channel,
      ctx.nick,
      `message flood (${msgThreshold}+ msgs/${msgWindowSecs}s)`,
    );
  });

  // ---------------------------------------------------------------------------
  // Join flood detection
  // ---------------------------------------------------------------------------

  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (isBotNick(ctx.nick)) return;

    const { ident, hostname } = ctx;
    const hostmask = `${ctx.nick}!${ident}@${hostname}`;
    const key = `join:${hostmask.toLowerCase()}`;

    const flooded = checkWindow(joinTracker, key, joinWindowMs, joinThreshold);
    if (!flooded) return;
    if (isPrivileged(ctx.nick, ctx.channel, ignoreOps)) return;

    const offenceKey = `join:${hostmask.toLowerCase()}`;
    const action = recordOffence(offenceKey);
    applyAction(
      action,
      ctx.channel,
      ctx.nick,
      `join flood (${joinThreshold}+ joins/${joinWindowSecs}s)`,
    ).catch((err) => api.error('Join flood action error:', err));
  });

  // ---------------------------------------------------------------------------
  // Nick-change spam detection
  // ---------------------------------------------------------------------------

  api.bind('nick', '-', '*', (ctx: HandlerContext) => {
    const { ident, hostname } = ctx;
    if (!ident && !hostname) return; // Incomplete hostmask data — skip

    const hostmask = `${ctx.nick}!${ident}@${hostname}`;
    const key = `nick:${hostmask.toLowerCase()}`;

    const flooded = checkWindow(nickTracker, key, nickWindowMs, nickThreshold);
    if (!flooded) return;

    // Nick changes are global — find channels the user is in
    // Punish in the first channel where we have ops
    const botConfig = api.botConfig.irc as Record<string, unknown> | undefined;
    const channels = (botConfig?.channels as string[] | undefined) ?? [];
    for (const channel of channels) {
      if (isPrivileged(ctx.nick, channel, ignoreOps)) return;
      if (!botHasOps(channel)) continue;

      const offenceKey = `nick:${hostmask.toLowerCase()}`;
      const action = recordOffence(offenceKey);
      applyAction(
        action,
        channel,
        ctx.nick,
        `nick-change spam (${nickThreshold}+ changes/${nickWindowSecs}s)`,
      ).catch((err) => api.error('Nick flood action error:', err));
      break;
    }
  });

  // ---------------------------------------------------------------------------
  // Timed ban cleanup (every 60 seconds)
  // ---------------------------------------------------------------------------

  api.bind('time', '-', '60', () => {
    liftExpiredFloodBans();
  });

  api.log('Loaded');
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  msgTracker.clear();
  joinTracker.clear();
  nickTracker.clear();
  offenceTracker.clear();
}
