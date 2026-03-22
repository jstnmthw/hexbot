// chanmod — Channel protection plugin.
// Provides auto-op/halfop/voice on join, mode enforcement, timed bans, cycle recovery,
// and manual moderation commands: !op, !deop, !halfop, !dehalfop, !voice, !devoice,
// !kick, !ban, !unban, !kickban, !bans.
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = 'chanmod';
export const version = '2.1.0';
export const description =
  'Channel operator tools: auto-op/halfop/voice, mode enforcement, timed bans, kick/ban, cycle';

let api: PluginAPI;

// Mutable state — re-created on each init() so hot-reload gets a clean slate.
let intentionalModeChanges: Map<string, number>;
let enforcementTimers: ReturnType<typeof setTimeout>[];
let enforcementCooldown: Map<string, { count: number; expiresAt: number }>;
let cycleTimers: ReturnType<typeof setTimeout>[];
let cycleScheduled: Set<string>;
let startupTimer: ReturnType<typeof setTimeout> | null;

const INTENTIONAL_TTL_MS = 5000;
const COOLDOWN_WINDOW_MS = 10_000;
const MAX_ENFORCEMENTS = 3;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BanRecord {
  mask: string;
  channel: string;
  by: string;
  ts: number;
  expires: number; // 0 = permanent, otherwise unix timestamp ms
}

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

/** Check whether the bot has +o in the given channel. */
function botHasOps(channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = getBotNick().toLowerCase();
  const botUser = ch.users.get(botNick);
  return botUser?.modes?.includes('o') ?? false;
}

/** Check whether the bot has +h or +o in the given channel (can set +h). */
function botCanHalfop(channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = getBotNick().toLowerCase();
  const botUser = ch.users.get(botNick);
  const modes = botUser?.modes ?? '';
  return modes.includes('o') || modes.includes('h');
}

/** Validate a nick argument — no newlines, no spaces. */
function isValidNick(nick: string): boolean {
  return nick.length > 0 && !/[\r\n\s]/.test(nick);
}

/** Mark a mode change as intentional (from a !deop/!devoice command). */
function markIntentional(channel: string, nick: string): void {
  const key = `${channel.toLowerCase()}:${nick.toLowerCase()}`;
  intentionalModeChanges.set(key, Date.now() + INTENTIONAL_TTL_MS);
}

/** Check if a mode change was intentional (and consume it). */
function wasIntentional(channel: string, nick: string): boolean {
  const key = `${channel.toLowerCase()}:${nick.toLowerCase()}`;
  const expiry = intentionalModeChanges.get(key);
  if (expiry && Date.now() < expiry) {
    intentionalModeChanges.delete(key);
    return true;
  }
  intentionalModeChanges.delete(key);
  return false;
}

/**
 * Build a ban mask from a full hostmask (nick!ident@host).
 *   Type 1: *!*@host
 *   Type 2: *!*ident@host
 *   Type 3: *!*ident@*.domain  (wildcard first component; falls back if < 3 parts)
 * Cloaked hosts (containing '/') always use exact host: *!*@host
 */
function buildBanMask(hostmask: string, banType: number): string | null {
  const bangIdx = hostmask.indexOf('!');
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;

  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;

  // Cloaked hostmask (e.g. user/foo, gateway/web/foo) — exact match regardless of type
  if (host.includes('/')) {
    return `*!*@${host}`;
  }

  if (banType === 1) {
    return `*!*@${host}`;
  }

  const ident = bangIdx !== -1 && bangIdx < atIdx ? hostmask.substring(bangIdx + 1, atIdx) : '*';

  if (banType === 2) {
    return `*!*${ident}@${host}`;
  }

  // Type 3: wildcard first hostname component (bar.baz.net → *.baz.net)
  const parts = host.split('.');
  if (parts.length > 2) {
    return `*!*${ident}@*.${parts.slice(1).join('.')}`;
  }
  // Fewer than 3 parts — fall back to exact host
  return `*!*${ident}@${host}`;
}

/** Get effective flags for a nick in a channel by looking up their hostmask. */
function getUserFlags(channel: string, nick: string): string | null {
  const hostmask = api.getUserHostmask(channel, nick);
  if (!hostmask) return null;

  const fullHostmask = hostmask.includes('!') ? hostmask : `${nick}!${hostmask}`;
  const user = api.permissions.findByHostmask(fullHostmask);
  if (!user) return null;

  const globalFlags = user.global;
  const channelFlags = user.channels[channel] ?? '';
  return globalFlags + channelFlags;
}

// ---------------------------------------------------------------------------
// Timed ban helpers
// ---------------------------------------------------------------------------

function banDbKey(channel: string, mask: string): string {
  return `ban:${channel.toLowerCase()}:${mask}`;
}

function storeBan(channel: string, mask: string, by: string, durationMinutes: number): void {
  const now = Date.now();
  const expires = durationMinutes === 0 ? 0 : now + durationMinutes * 60_000;
  const record: BanRecord = { mask, channel: channel.toLowerCase(), by, ts: now, expires };
  api.db.set(banDbKey(channel, mask), JSON.stringify(record));
}

function removeBanRecord(channel: string, mask: string): void {
  api.db.del(banDbKey(channel, mask));
}

function getAllBanRecords(): BanRecord[] {
  return api.db.list('ban:').map(({ value }) => JSON.parse(value) as BanRecord);
}

function getChannelBanRecords(channel: string): BanRecord[] {
  return api.db
    .list(`ban:${channel.toLowerCase()}:`)
    .map(({ value }) => JSON.parse(value) as BanRecord);
}

/** Lift expired bans in channels where the bot has ops. Returns count lifted. */
function liftExpiredBans(): number {
  const now = Date.now();
  let lifted = 0;
  for (const record of getAllBanRecords()) {
    if (record.expires > 0 && record.expires <= now) {
      if (botHasOps(record.channel)) {
        api.mode(record.channel, '-b', record.mask);
        removeBanRecord(record.channel, record.mask);
        api.log(`Auto-lifted expired ban ${record.mask} from ${record.channel}`);
        lifted++;
      }
    }
  }
  return lifted;
}

// ---------------------------------------------------------------------------
// Channel mode helpers
// ---------------------------------------------------------------------------

/** Parse a mode string like "+nt" into a Set of mode chars. */
function parseModesSet(modeStr: string): Set<string> {
  const set = new Set<string>();
  for (const ch of modeStr) {
    if (ch !== '+' && ch !== '-') set.add(ch);
  }
  return set;
}

/** Format a ban expiry for display. */
function formatExpiry(expires: number): string {
  if (expires === 0) return 'permanent';
  const diff = expires - Date.now();
  if (diff <= 0) return 'expired';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `expires in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `expires in ${hrs}h ${rem}m` : `expires in ${hrs}h`;
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  // Fresh state on each load/reload
  intentionalModeChanges = new Map();
  enforcementTimers = [];
  enforcementCooldown = new Map();
  cycleTimers = [];
  cycleScheduled = new Set();
  startupTimer = null;

  const opFlags = (api.config.op_flags as string[] | undefined) ?? ['n', 'm', 'o'];
  const halfopFlags = (api.config.halfop_flags as string[] | undefined) ?? [];
  const voiceFlags = (api.config.voice_flags as string[] | undefined) ?? ['v'];
  const autoOpEnabled = (api.config.auto_op as boolean | undefined) ?? true;
  const enforceModes = (api.config.enforce_modes as boolean | undefined) ?? false;
  const notifyOnFail = (api.config.notify_on_fail as boolean | undefined) ?? false;
  const defaultKickReason = (api.config.default_kick_reason as string | undefined) ?? 'Requested';
  const enforceDelayMs = (api.config.enforce_delay_ms as number | undefined) ?? 500;
  const defaultBanDuration = (api.config.default_ban_duration as number | undefined) ?? 120;
  const defaultBanType = (api.config.default_ban_type as number | undefined) ?? 3;
  const enforceChannelModes = (api.config.enforce_channel_modes as string | undefined) ?? '';
  const nodesynchNicks = (api.config.nodesynch_nicks as string[] | undefined) ?? ['ChanServ'];
  const cycleOnDeop = (api.config.cycle_on_deop as boolean | undefined) ?? false;
  const cycleDelayMs = (api.config.cycle_delay_ms as number | undefined) ?? 5000;

  const enforceChannelModeSet = parseModesSet(enforceChannelModes);

  // ---------------------------------------------------------------------------
  // Startup: lift bans that expired during downtime (after a short delay to
  // allow the bot to join channels and receive ops from ChanServ)
  // ---------------------------------------------------------------------------

  startupTimer = setTimeout(() => {
    startupTimer = null;
    const lifted = liftExpiredBans();
    if (lifted > 0) {
      api.log(`Lifted ${lifted} expired ban${lifted === 1 ? '' : 's'} after downtime`);
    }
  }, 5000);

  // ---------------------------------------------------------------------------
  // Timed ban cleanup (every 60 seconds)
  // ---------------------------------------------------------------------------

  api.bind('time', '-', '60', () => {
    liftExpiredBans();
  });

  // ---------------------------------------------------------------------------
  // Auto-op / bot-join mode check
  // ---------------------------------------------------------------------------

  api.bind('join', '-', '*', async (ctx: HandlerContext) => {
    const { nick, channel } = ctx;
    if (!channel) return;

    // Bot joined — check if channel needs enforce_channel_modes applied
    if (isBotNick(nick)) {
      if (enforceChannelModeSet.size > 0) {
        const timer = setTimeout(() => {
          if (!botHasOps(channel)) return;
          const ch = api.getChannel(channel);
          if (!ch) return;
          const missing = [...enforceChannelModeSet].filter((m) => !ch.modes.includes(m));
          if (missing.length > 0) {
            const modeString = '+' + missing.join('');
            api.mode(channel, modeString);
            api.log(`Set channel modes ${modeString} on ${channel} (enforce_channel_modes)`);
          }
        }, enforceDelayMs);
        enforcementTimers.push(timer);
      }
      return;
    }

    if (!autoOpEnabled) return;

    const { ident, hostname } = ctx;
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[channel] ?? '';
    const allFlags = globalFlags + channelFlags;

    const shouldOp = opFlags.some((f) => allFlags.includes(f));
    const shouldHalfop =
      !shouldOp && halfopFlags.length > 0 && halfopFlags.some((f) => allFlags.includes(f));
    const shouldVoice = !shouldOp && !shouldHalfop && voiceFlags.some((f) => allFlags.includes(f));

    if (!shouldOp && !shouldHalfop && !shouldVoice) return;

    // NickServ verification if required
    const identityConfig = api.botConfig.identity as Record<string, unknown> | undefined;
    const requireAccFor = (identityConfig?.require_acc_for as string[] | undefined) ?? [];
    const flagToApply = shouldOp ? '+o' : shouldHalfop ? '+h' : '+v';
    const needsVerification = requireAccFor.includes(flagToApply) && api.services.isAvailable();

    if (needsVerification) {
      api.log(`Verifying ${nick} via NickServ before applying ${flagToApply} in ${channel}`);
      const result = await api.services.verifyUser(nick);
      if (!result.verified) {
        api.log(`Verification failed for ${nick} in ${channel} — not applying ${flagToApply}`);
        if (notifyOnFail) {
          api.notice(nick, 'Auto-op: NickServ verification failed. Please identify and rejoin.');
        }
        return;
      }
      api.log(
        `Verified ${nick} (account: ${result.account}) — applying ${flagToApply} in ${channel}`,
      );
    }

    if (shouldOp) {
      if (!botHasOps(channel)) {
        api.log(`Cannot auto-op ${nick} in ${channel} — I am not opped`);
        return;
      }
      api.op(channel, nick);
      api.log(`Auto-opped ${nick} in ${channel}`);
    } else if (shouldHalfop) {
      if (!botCanHalfop(channel)) {
        api.log(`Cannot auto-halfop ${nick} in ${channel} — I do not have +h or +o`);
        return;
      }
      api.halfop(channel, nick);
      api.log(`Auto-halfopped ${nick} in ${channel}`);
    } else if (shouldVoice) {
      if (!botHasOps(channel)) {
        api.log(`Cannot auto-voice ${nick} in ${channel} — I am not opped`);
        return;
      }
      api.voice(channel, nick);
      api.log(`Auto-voiced ${nick} in ${channel}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Mode enforcement — user ops/voice + channel modes + cycle
  // ---------------------------------------------------------------------------

  api.bind('mode', '-', '*', (ctx: HandlerContext) => {
    const { nick: setter, channel, command: modeStr, args: target } = ctx;
    if (!channel) return;

    // --- Channel mode enforcement (e.g. +nt) ---
    if (enforceChannelModeSet.size > 0 && modeStr.startsWith('-') && modeStr.length === 2) {
      const modeChar = modeStr[1];
      if (enforceChannelModeSet.has(modeChar)) {
        const isNodesynch = nodesynchNicks.some((n) => n.toLowerCase() === setter.toLowerCase());
        if (!isNodesynch && !isBotNick(setter) && botHasOps(channel)) {
          api.log(`Re-enforcing +${modeChar} on ${channel} (removed by ${setter})`);
          const timer = setTimeout(() => {
            api.mode(channel, '+' + modeChar);
          }, enforceDelayMs);
          enforcementTimers.push(timer);
        }
      }
    }

    // --- Bot self-deop → cycle ---
    if (modeStr === '-o' && isBotNick(target)) {
      if (cycleOnDeop && !cycleScheduled.has(channel.toLowerCase())) {
        const cooldownKey = `${channel.toLowerCase()}:cycle`;
        const now = Date.now();
        const cooldown = enforcementCooldown.get(cooldownKey);
        if (cooldown && now < cooldown.expiresAt) {
          cooldown.count++;
          if (cooldown.count >= MAX_ENFORCEMENTS) {
            const ch = api.getChannel(channel);
            const isInviteOnly = ch?.modes.includes('i') ?? false;
            if (!isInviteOnly) {
              api.log(`Cycling ${channel} to regain ops`);
              cycleScheduled.add(channel.toLowerCase());
              const timer = setTimeout(() => {
                api.part(channel, 'Cycling to regain ops');
                const rejoinTimer = setTimeout(() => {
                  api.join(channel);
                  cycleScheduled.delete(channel.toLowerCase());
                  enforcementCooldown.delete(cooldownKey);
                }, 2000);
                cycleTimers.push(rejoinTimer);
              }, cycleDelayMs);
              cycleTimers.push(timer);
            }
          }
        } else {
          enforcementCooldown.set(cooldownKey, { count: 1, expiresAt: now + COOLDOWN_WINDOW_MS });
        }
      }
      return; // Don't apply user-flag enforcement for bot self-deop
    }

    // --- User op/halfop/voice enforcement ---
    if (!enforceModes) return;
    if (modeStr !== '-o' && modeStr !== '-h' && modeStr !== '-v') return;
    if (!target) return;

    // Don't re-enforce if the bot set this mode
    if (isBotNick(setter)) return;

    // Don't re-enforce intentional deops from !deop/!dehalfop/!devoice commands
    if (wasIntentional(channel, target)) return;

    // Look up the affected user's flags
    const flags = getUserFlags(channel, target);
    if (!flags) return;

    // Rate limit: prevent mode wars by capping enforcement frequency per user
    const cooldownKey = `${channel.toLowerCase()}:${target.toLowerCase()}`;
    const now = Date.now();
    const cooldown = enforcementCooldown.get(cooldownKey);
    if (cooldown && now < cooldown.expiresAt) {
      if (cooldown.count >= MAX_ENFORCEMENTS) {
        api.warn(`Suppressing mode enforcement for ${target} in ${channel} — possible mode war`);
        return;
      }
      cooldown.count++;
    } else {
      enforcementCooldown.set(cooldownKey, { count: 1, expiresAt: now + COOLDOWN_WINDOW_MS });
    }

    if (modeStr === '-o') {
      if (!botHasOps(channel)) return;
      const shouldBeOpped = opFlags.some((f) => flags.includes(f));
      if (shouldBeOpped) {
        api.log(`Re-enforcing +o on ${target} in ${channel} (deopped by ${setter})`);
        const timer = setTimeout(() => {
          api.op(channel, target);
        }, enforceDelayMs);
        enforcementTimers.push(timer);
      }
    } else if (modeStr === '-h') {
      if (!botCanHalfop(channel)) return;
      const shouldBeHalfopped =
        halfopFlags.length > 0 && halfopFlags.some((f) => flags.includes(f));
      if (shouldBeHalfopped) {
        api.log(`Re-enforcing +h on ${target} in ${channel} (dehalfopped by ${setter})`);
        const timer = setTimeout(() => {
          api.halfop(channel, target);
        }, enforceDelayMs);
        enforcementTimers.push(timer);
      }
    } else if (modeStr === '-v') {
      if (!botHasOps(channel)) return;
      const shouldBeVoiced = voiceFlags.some((f) => flags.includes(f));
      if (shouldBeVoiced) {
        api.log(`Re-enforcing +v on ${target} in ${channel} (devoiced by ${setter})`);
        const timer = setTimeout(() => {
          api.voice(channel, target);
        }, enforceDelayMs);
        enforcementTimers.push(timer);
      }
    }
  });

  // ---------------------------------------------------------------------------
  // !op / !deop / !voice / !devoice
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!op', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    api.op(ctx.channel, target);
    api.log(`${ctx.nick} opped ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!deop', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(target)) {
      ctx.reply('I cannot deop myself.');
      return;
    }
    markIntentional(ctx.channel, target);
    api.deop(ctx.channel, target);
    api.log(`${ctx.nick} deopped ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!voice', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    api.voice(ctx.channel, target);
    api.log(`${ctx.nick} voiced ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!devoice', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    markIntentional(ctx.channel, target);
    api.devoice(ctx.channel, target);
    api.log(`${ctx.nick} devoiced ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!halfop', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botCanHalfop(ctx.channel)) {
      ctx.reply('I do not have +h or +o in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    api.halfop(ctx.channel, target);
    api.log(`${ctx.nick} halfopped ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!dehalfop', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botCanHalfop(ctx.channel)) {
      ctx.reply('I do not have +h or +o in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(target)) {
      ctx.reply('I cannot dehalfop myself.');
      return;
    }
    markIntentional(ctx.channel, target);
    api.dehalfop(ctx.channel, target);
    api.log(`${ctx.nick} dehalfopped ${target} in ${ctx.channel}`);
  });

  // ---------------------------------------------------------------------------
  // !kick
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!kick', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) {
      ctx.reply('Usage: !kick <nick> [reason]');
      return;
    }
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(target)) {
      ctx.reply('I cannot kick myself.');
      return;
    }
    const reason = parts.slice(1).join(' ') || defaultKickReason;
    api.kick(ctx.channel, target, reason);
    api.log(`${ctx.nick} kicked ${target} from ${ctx.channel} (${reason})`);
  });

  // ---------------------------------------------------------------------------
  // !ban / !unban / !kickban / !bans
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!ban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    if (!parts[0]) {
      ctx.reply('Usage: !ban <nick|mask> [duration_minutes]');
      return;
    }

    // Check if last arg is a duration (pure integer)
    const lastArg = parts[parts.length - 1];
    const hasDuration = parts.length > 1 && /^\d+$/.test(lastArg);
    const durationMinutes = hasDuration ? parseInt(lastArg, 10) : defaultBanDuration;
    const target = hasDuration ? parts.slice(0, -1).join(' ') : parts.join(' ');

    // Explicit mask
    if (target.includes('!') || target.includes('@')) {
      if (/[\r\n]/.test(target)) {
        ctx.reply('Invalid ban mask.');
        return;
      }
      api.ban(ctx.channel, target);
      storeBan(ctx.channel, target, ctx.nick, durationMinutes);
      const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
      api.log(`${ctx.nick} banned ${target} in ${ctx.channel} (${durStr})`);
      return;
    }

    // Nick → resolve hostmask → build mask
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const hostmask = api.getUserHostmask(ctx.channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Provide an explicit mask: !ban *!*@host`);
      return;
    }

    const fullHostmask = hostmask.includes('!') ? hostmask : `${target}!${hostmask}`;
    const banMask = buildBanMask(fullHostmask, defaultBanType);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(ctx.channel, banMask);
    storeBan(ctx.channel, banMask, ctx.nick, durationMinutes);
    const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
    api.log(`${ctx.nick} banned ${target} (${banMask}) in ${ctx.channel} (${durStr})`);
  });

  api.bind('pub', '+o', '!unban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const arg = ctx.args.trim().split(/\s+/)[0];
    if (!arg) {
      ctx.reply('Usage: !unban <nick|mask>');
      return;
    }
    if (/[\r\n]/.test(arg)) {
      ctx.reply('Invalid argument.');
      return;
    }

    // If it looks like an explicit mask, use it directly.
    if (arg.includes('!') || arg.includes('@')) {
      api.mode(ctx.channel, '-b', arg);
      removeBanRecord(ctx.channel, arg);
      api.log(`${ctx.nick} unbanned ${arg} in ${ctx.channel}`);
      return;
    }

    // Nick given — resolve their hostmask and find the stored ban record.
    if (!isValidNick(arg)) {
      ctx.reply('Invalid nick.');
      return;
    }
    const hostmask = api.getUserHostmask(ctx.channel, arg);
    if (!hostmask) {
      ctx.reply(
        `${arg} is not in the channel. Provide an explicit mask: !unban *!*@host — use !bans to list stored masks.`,
      );
      return;
    }
    const fullHostmask = hostmask.includes('!') ? hostmask : `${arg}!${hostmask}`;
    // Try all three mask types and find the first one with a stored record.
    const candidates = [1, 2, 3]
      .map((t) => buildBanMask(fullHostmask, t))
      .filter((m): m is string => m !== null);
    const records = getChannelBanRecords(ctx.channel);
    const storedMasks = new Set(records.map((r) => r.mask));
    const match = candidates.find((m) => storedMasks.has(m));
    if (match) {
      api.mode(ctx.channel, '-b', match);
      removeBanRecord(ctx.channel, match);
      api.log(`${ctx.nick} unbanned ${arg} (${match}) in ${ctx.channel}`);
    } else {
      // No stored record — apply -b for each candidate so the server picks the
      // right one, and clean up whatever record matches.
      for (const m of candidates) {
        api.mode(ctx.channel, '-b', m);
      }
      api.log(`${ctx.nick} unbanned ${arg} (no stored record) in ${ctx.channel}`);
    }
  });

  api.bind('pub', '+o', '!kickban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) {
      ctx.reply('Usage: !kickban <nick> [reason]');
      return;
    }
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const reason = parts.slice(1).join(' ') || defaultKickReason;

    const hostmask = api.getUserHostmask(ctx.channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Use !ban <mask> then !kick <nick>.`);
      return;
    }

    const fullHostmask = hostmask.includes('!') ? hostmask : `${target}!${hostmask}`;
    const banMask = buildBanMask(fullHostmask, defaultBanType);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(ctx.channel, banMask);
    storeBan(ctx.channel, banMask, ctx.nick, defaultBanDuration);
    api.kick(ctx.channel, target, reason);
    api.log(`${ctx.nick} kickbanned ${target} (${banMask}) from ${ctx.channel} (${reason})`);
  });

  api.bind('pub', '+o', '!bans', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const targetChannel = ctx.args.trim() || ctx.channel;
    const bans = getChannelBanRecords(targetChannel);
    if (bans.length === 0) {
      ctx.reply(`No tracked bans for ${targetChannel}.`);
      return;
    }
    for (const ban of bans) {
      ctx.reply(`${ban.mask} — set by ${ban.by}, ${formatExpiry(ban.expires)}`);
    }
  });

  api.log('Loaded');
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  if (startupTimer !== null) {
    clearTimeout(startupTimer);
    startupTimer = null;
  }
  for (const timer of enforcementTimers) {
    clearTimeout(timer);
  }
  for (const timer of cycleTimers) {
    clearTimeout(timer);
  }
  enforcementTimers.length = 0;
  cycleTimers.length = 0;
  intentionalModeChanges.clear();
  enforcementCooldown.clear();
  cycleScheduled.clear();
}
