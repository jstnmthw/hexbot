// chanop — Channel protection plugin.
// Provides auto-op/voice on join, mode enforcement, and manual moderation
// commands: !op, !deop, !voice, !devoice, !kick, !ban, !unban, !kickban.

import type { PluginAPI, HandlerContext } from '../../src/types.js';

export const name = 'chanop';
export const version = '1.0.0';
export const description = 'Channel operator tools: auto-op, mode enforcement, kick/ban commands';

let api: PluginAPI;

// Mutable state — re-created on each init() so hot-reload gets a clean slate.
let intentionalModeChanges: Map<string, number>;
let enforcementTimers: ReturnType<typeof setTimeout>[];
let enforcementCooldown: Map<string, { count: number; expiresAt: number }>;

const INTENTIONAL_TTL_MS = 5000;
const COOLDOWN_WINDOW_MS = 10_000;
const MAX_ENFORCEMENTS = 3;

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

/** Build a ban mask from a full hostmask: nick!ident@host → *!*@host */
function buildBanMask(hostmask: string): string | null {
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;
  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;
  return `*!*@${host}`;
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
// Init
// ---------------------------------------------------------------------------

export function init(pluginApi: PluginAPI): void {
  api = pluginApi;

  // Fresh state on each load/reload
  intentionalModeChanges = new Map();
  enforcementTimers = [];
  enforcementCooldown = new Map();

  const opFlags = (api.config.op_flags as string[] | undefined) ?? ['n', 'm', 'o'];
  const voiceFlags = (api.config.voice_flags as string[] | undefined) ?? ['v'];
  const autoOpEnabled = (api.config.auto_op as boolean | undefined) ?? true;
  const enforceModes = (api.config.enforce_modes as boolean | undefined) ?? false;
  const notifyOnFail = (api.config.notify_on_fail as boolean | undefined) ?? false;
  const defaultKickReason = (api.config.default_kick_reason as string | undefined) ?? 'Requested';
  const enforceDelayMs = (api.config.enforce_delay_ms as number | undefined) ?? 500;

  // ---------------------------------------------------------------------------
  // Auto-op on join
  // ---------------------------------------------------------------------------

  api.bind('join', '-', '*', async (ctx: HandlerContext) => {
    if (!autoOpEnabled) return;

    const { nick, ident, hostname, channel } = ctx;
    if (!channel) return;
    if (isBotNick(nick)) return;

    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[channel] ?? '';
    const allFlags = globalFlags + channelFlags;

    const shouldOp = opFlags.some((f) => allFlags.includes(f));
    const shouldVoice = !shouldOp && voiceFlags.some((f) => allFlags.includes(f));

    if (!shouldOp && !shouldVoice) return;

    // NickServ verification if required
    const identityConfig = api.botConfig.identity as Record<string, unknown> | undefined;
    const requireAccFor = (identityConfig?.require_acc_for as string[] | undefined) ?? [];
    const flagToApply = shouldOp ? '+o' : '+v';
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
      api.log(`Verified ${nick} (account: ${result.account}) — applying ${flagToApply} in ${channel}`);
    }

    if (shouldOp) {
      api.op(channel, nick);
      api.log(`Auto-opped ${nick} in ${channel}`);
    } else if (shouldVoice) {
      api.voice(channel, nick);
      api.log(`Auto-voiced ${nick} in ${channel}`);
    }
  });

  // ---------------------------------------------------------------------------
  // Mode enforcement
  // ---------------------------------------------------------------------------

  api.bind('mode', '-', '*', (ctx: HandlerContext) => {
    if (!enforceModes) return;

    const { nick: setter, channel, command: modeStr, args: target } = ctx;
    if (!channel || !target) return;

    // Only care about -o and -v
    if (modeStr !== '-o' && modeStr !== '-v') return;

    // Don't re-enforce if the bot set this mode
    if (isBotNick(setter)) return;

    // Don't re-enforce intentional deops from !deop/!devoice commands
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
      const shouldBeOpped = opFlags.some((f) => flags.includes(f));
      if (shouldBeOpped) {
        api.log(`Re-enforcing +o on ${target} in ${channel} (deopped by ${setter})`);
        const timer = setTimeout(() => {
          api.op(channel, target);
        }, enforceDelayMs);
        enforcementTimers.push(timer);
      }
    } else if (modeStr === '-v') {
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
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    api.op(ctx.channel, target);
    api.log(`${ctx.nick} opped ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!deop', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    if (isBotNick(target)) { ctx.reply('I cannot deop myself.'); return; }
    markIntentional(ctx.channel, target);
    api.deop(ctx.channel, target);
    api.log(`${ctx.nick} deopped ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!voice', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    api.voice(ctx.channel, target);
    api.log(`${ctx.nick} voiced ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!devoice', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    markIntentional(ctx.channel, target);
    api.devoice(ctx.channel, target);
    api.log(`${ctx.nick} devoiced ${target} in ${ctx.channel}`);
  });

  // ---------------------------------------------------------------------------
  // !kick
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!kick', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) { ctx.reply('Usage: !kick <nick> [reason]'); return; }
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    if (isBotNick(target)) { ctx.reply('I cannot kick myself.'); return; }
    const reason = parts.slice(1).join(' ') || defaultKickReason;
    api.kick(ctx.channel, target, reason);
    api.log(`${ctx.nick} kicked ${target} from ${ctx.channel} (${reason})`);
  });

  // ---------------------------------------------------------------------------
  // !ban / !unban / !kickban
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!ban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const target = ctx.args.trim().split(/\s+/)[0];
    if (!target) { ctx.reply('Usage: !ban <nick|mask>'); return; }

    // If it looks like an explicit mask, use it directly
    if (target.includes('!') || target.includes('@')) {
      if (/[\r\n]/.test(target)) { ctx.reply('Invalid ban mask.'); return; }
      api.ban(ctx.channel, target);
      api.log(`${ctx.nick} banned ${target} in ${ctx.channel}`);
      return;
    }

    // Otherwise resolve nick → hostmask → ban mask
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    if (isBotNick(target)) { ctx.reply('I cannot ban myself.'); return; }

    const hostmask = api.getUserHostmask(ctx.channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Provide an explicit mask: !ban *!*@host`);
      return;
    }

    const banMask = buildBanMask(hostmask);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(ctx.channel, banMask);
    api.log(`${ctx.nick} banned ${target} (${banMask}) in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!unban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const mask = ctx.args.trim().split(/\s+/)[0];
    if (!mask) { ctx.reply('Usage: !unban <mask>'); return; }
    if (/[\r\n]/.test(mask)) { ctx.reply('Invalid ban mask.'); return; }
    api.mode(ctx.channel, '-b', mask);
    api.log(`${ctx.nick} unbanned ${mask} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!kickban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) { ctx.reply('Usage: !kickban <nick> [reason]'); return; }
    if (!isValidNick(target)) { ctx.reply('Invalid nick.'); return; }
    if (isBotNick(target)) { ctx.reply('I cannot ban myself.'); return; }

    const reason = parts.slice(1).join(' ') || defaultKickReason;

    const hostmask = api.getUserHostmask(ctx.channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Use !ban <mask> then !kick <nick>.`);
      return;
    }

    const banMask = buildBanMask(hostmask);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(ctx.channel, banMask);
    api.kick(ctx.channel, target, reason);
    api.log(`${ctx.nick} kickbanned ${target} (${banMask}) from ${ctx.channel} (${reason})`);
  });

  api.log('Loaded');
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

export function teardown(): void {
  // Clear enforcement timers
  for (const timer of enforcementTimers) {
    clearTimeout(timer);
  }
  enforcementTimers.length = 0;
  intentionalModeChanges.clear();
  enforcementCooldown.clear();
}
