// chanmod — IRC commands: !op !deop !halfop !dehalfop !voice !devoice !kick !ban !unban !kickban !bans
import type { HandlerContext, PluginAPI } from '../../src/types';
import { getChannelBanRecords, removeBanRecord, storeBan } from './bans';
import {
  botCanHalfop,
  botHasOps,
  buildBanMask,
  formatExpiry,
  isBotNick,
  isValidNick,
  markIntentional,
} from './helpers';
import type { ChanmodConfig, SharedState } from './state';

export function setupCommands(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
): () => void {
  api.registerHelp([
    {
      command: '!op',
      flags: 'o',
      usage: '!op [nick]',
      description: 'Op a nick (or yourself if omitted)',
      category: 'moderation',
    },
    {
      command: '!deop',
      flags: 'o',
      usage: '!deop [nick]',
      description: 'Deop a nick (or yourself if omitted)',
      category: 'moderation',
    },
    {
      command: '!halfop',
      flags: 'o',
      usage: '!halfop [nick]',
      description: 'Halfop a nick (or yourself if omitted)',
      category: 'moderation',
    },
    {
      command: '!dehalfop',
      flags: 'o',
      usage: '!dehalfop [nick]',
      description: 'Dehalfop a nick (or yourself if omitted)',
      category: 'moderation',
    },
    {
      command: '!voice',
      flags: 'o',
      usage: '!voice [nick]',
      description: 'Voice a nick (or yourself if omitted)',
      category: 'moderation',
    },
    {
      command: '!devoice',
      flags: 'o',
      usage: '!devoice [nick]',
      description: 'Devoice a nick (or yourself if omitted)',
      category: 'moderation',
    },
    {
      command: '!kick',
      flags: 'o',
      usage: '!kick <nick> [reason]',
      description: 'Kick a nick with an optional reason',
      category: 'moderation',
    },
    {
      command: '!ban',
      flags: 'o',
      usage: '!ban <nick|mask> [minutes]',
      description: 'Ban a nick or mask; optionally timed',
      category: 'moderation',
    },
    {
      command: '!unban',
      flags: 'o',
      usage: '!unban <nick|mask>',
      description: 'Remove a ban by nick or mask',
      category: 'moderation',
    },
    {
      command: '!kickban',
      flags: 'o',
      usage: '!kickban <nick> [reason]',
      description: 'Ban and kick in one step',
      category: 'moderation',
    },
    {
      command: '!bans',
      flags: 'o',
      usage: '!bans [channel]',
      description: 'List tracked bans and expiry times',
      category: 'moderation',
    },
  ]);

  // ---------------------------------------------------------------------------
  // !op / !deop / !voice / !devoice / !halfop / !dehalfop
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!op', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(api, ctx.channel)) {
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
    if (!botHasOps(api, ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(api, target)) {
      ctx.reply('I cannot deop myself.');
      return;
    }
    markIntentional(state, api, ctx.channel, target);
    api.deop(ctx.channel, target);
    api.log(`${ctx.nick} deopped ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!voice', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(api, ctx.channel)) {
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
    if (!botHasOps(api, ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    markIntentional(state, api, ctx.channel, target);
    api.devoice(ctx.channel, target);
    api.log(`${ctx.nick} devoiced ${target} in ${ctx.channel}`);
  });

  api.bind('pub', '+o', '!halfop', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botCanHalfop(api, ctx.channel)) {
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
    if (!botCanHalfop(api, ctx.channel)) {
      ctx.reply('I do not have +h or +o in this channel.');
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(api, target)) {
      ctx.reply('I cannot dehalfop myself.');
      return;
    }
    markIntentional(state, api, ctx.channel, target);
    api.dehalfop(ctx.channel, target);
    api.log(`${ctx.nick} dehalfopped ${target} in ${ctx.channel}`);
  });

  // ---------------------------------------------------------------------------
  // !kick
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!kick', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(api, ctx.channel)) {
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
    if (isBotNick(api, target)) {
      ctx.reply('I cannot kick myself.');
      return;
    }
    const reason = parts.slice(1).join(' ') || config.default_kick_reason;
    api.kick(ctx.channel, target, reason);
    api.log(`${ctx.nick} kicked ${target} from ${ctx.channel} (${reason})`);
  });

  // ---------------------------------------------------------------------------
  // !ban / !unban / !kickban / !bans
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!ban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(api, ctx.channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    if (!parts[0]) {
      ctx.reply('Usage: !ban <nick|mask> [duration_minutes]');
      return;
    }

    const lastArg = parts[parts.length - 1];
    const hasDuration = parts.length > 1 && /^\d+$/.test(lastArg);
    const durationMinutes = hasDuration ? parseInt(lastArg, 10) : config.default_ban_duration;
    const target = hasDuration ? parts.slice(0, -1).join(' ') : parts.join(' ');

    if (target.includes('!') || target.includes('@')) {
      if (/[\r\n]/.test(target)) {
        ctx.reply('Invalid ban mask.');
        return;
      }
      api.ban(ctx.channel, target);
      storeBan(api, ctx.channel, target, ctx.nick, durationMinutes);
      const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
      api.log(`${ctx.nick} banned ${target} in ${ctx.channel} (${durStr})`);
      return;
    }

    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (isBotNick(api, target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const hostmask = api.getUserHostmask(ctx.channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Provide an explicit mask: !ban *!*@host`);
      return;
    }

    const fullHostmask = hostmask.includes('!') ? hostmask : `${target}!${hostmask}`;
    const banMask = buildBanMask(fullHostmask, config.default_ban_type);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(ctx.channel, banMask);
    storeBan(api, ctx.channel, banMask, ctx.nick, durationMinutes);
    const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
    api.log(`${ctx.nick} banned ${target} (${banMask}) in ${ctx.channel} (${durStr})`);
  });

  api.bind('pub', '+o', '!unban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(api, ctx.channel)) {
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

    if (arg.includes('!') || arg.includes('@')) {
      api.mode(ctx.channel, '-b', arg);
      removeBanRecord(api, ctx.channel, arg);
      api.log(`${ctx.nick} unbanned ${arg} in ${ctx.channel}`);
      return;
    }

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
    const candidates = [1, 2, 3]
      .map((t) => buildBanMask(fullHostmask, t))
      .filter((m): m is string => m !== null);
    const records = getChannelBanRecords(api, ctx.channel);
    const storedMasks = new Set(records.map((r) => r.mask));
    const match = candidates.find((m) => storedMasks.has(m));
    if (match) {
      api.mode(ctx.channel, '-b', match);
      removeBanRecord(api, ctx.channel, match);
      api.log(`${ctx.nick} unbanned ${arg} (${match}) in ${ctx.channel}`);
    } else {
      for (const m of candidates) {
        api.mode(ctx.channel, '-b', m);
      }
      api.log(`${ctx.nick} unbanned ${arg} (no stored record) in ${ctx.channel}`);
    }
  });

  api.bind('pub', '+o', '!kickban', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    if (!botHasOps(api, ctx.channel)) {
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
    if (isBotNick(api, target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const reason = parts.slice(1).join(' ') || config.default_kick_reason;

    const hostmask = api.getUserHostmask(ctx.channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Use !ban <mask> then !kick <nick>.`);
      return;
    }

    const fullHostmask = hostmask.includes('!') ? hostmask : `${target}!${hostmask}`;
    const banMask = buildBanMask(fullHostmask, config.default_ban_type);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(ctx.channel, banMask);
    storeBan(api, ctx.channel, banMask, ctx.nick, config.default_ban_duration);
    api.kick(ctx.channel, target, reason);
    api.log(`${ctx.nick} kickbanned ${target} (${banMask}) from ${ctx.channel} (${reason})`);
  });

  api.bind('pub', '+o', '!bans', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const targetChannel = ctx.args.trim() || ctx.channel;
    const bans = getChannelBanRecords(api, targetChannel);
    if (bans.length === 0) {
      ctx.reply(`No tracked bans for ${targetChannel}.`);
      return;
    }
    for (const ban of bans) {
      ctx.reply(`${ban.mask} — set by ${ban.by}, ${formatExpiry(ban.expires)}`);
    }
  });

  return () => {};
}
