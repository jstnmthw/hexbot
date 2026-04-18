// chanmod — !ban / !unban / !kickban / !bans
//
// Split out of commands.ts so the mode-command factory and the ban-command
// bodies (each with their own mask validation and ban-store bookkeeping) can
// be read in isolation.
import type { PluginAPI } from '../../src/types';
import { botHasOps, buildBanMask, formatExpiry, isValidNick } from './helpers';
import type { ChanmodConfig } from './state';

/**
 * Register `!ban`, `!unban`, `!kickban`, `!bans` command binds with the core
 * help registry and the dispatcher. All require the caller to hold `+o` and
 * the bot to be opped. Ban durations are persisted via `api.banStore`; the
 * periodic expiry sweep lives in `bans.ts`.
 */
export function registerBanCommands(api: PluginAPI, config: ChanmodConfig): void {
  api.registerHelp([
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

  api.bind('pub', '+o', '!ban', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
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
    const durationMs = durationMinutes === 0 ? 0 : durationMinutes * 60_000;
    const target = hasDuration ? parts.slice(0, -1).join(' ') : parts.join(' ');

    if (target.includes('!') || target.includes('@')) {
      // Validate the mask shape: `nick!ident@host` with no whitespace and
      // each segment non-empty (wildcards allowed). A garbage string like
      // `!@` would otherwise hit `mode +b` and let an attacker poison the
      // ban list with unenforceable entries.
      if (!/^[^\s!@]*![^\s@]*@\S+$/.test(target)) {
        ctx.reply('Invalid ban mask. Expected nick!ident@host.');
        return;
      }
      api.ban(channel, target);
      api.banStore.storeBan(channel, target, ctx.nick, durationMs);
      const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
      api.log(`${ctx.nick} banned ${target} in ${channel} (${durStr})`);
      return;
    }

    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (api.isBotNick(target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const hostmask = api.getUserHostmask(channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Provide an explicit mask: !ban *!*@host`);
      return;
    }

    const banMask = buildBanMask(hostmask, config.default_ban_type);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(channel, banMask);
    api.banStore.storeBan(channel, banMask, ctx.nick, durationMs);
    const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
    api.log(`${ctx.nick} banned ${target} (${banMask}) in ${channel} (${durStr})`);
  });

  api.bind('pub', '+o', '!unban', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const arg = ctx.args.trim().split(/\s+/)[0];
    if (!arg) {
      ctx.reply('Usage: !unban <nick|mask>');
      return;
    }
    if (arg.includes('!') || arg.includes('@')) {
      api.mode(channel, '-b', arg);
      api.banStore.removeBan(channel, arg);
      api.log(`${ctx.nick} unbanned ${arg} in ${channel}`);
      return;
    }

    const hostmask = api.getUserHostmask(channel, arg);
    if (!hostmask) {
      ctx.reply(
        `${arg} is not in the channel. Provide an explicit mask: !unban *!*@host — use !bans to list stored masks.`,
      );
      return;
    }
    const candidates = [1, 2, 3]
      .map((t) => buildBanMask(hostmask, t))
      .filter((m): m is string => m !== null);
    const records = api.banStore.getChannelBans(channel);
    const storedMasks = new Set(records.map((r) => r.mask));
    const match = candidates.find((m) => storedMasks.has(m));
    if (match) {
      api.mode(channel, '-b', match);
      api.banStore.removeBan(channel, match);
      api.log(`${ctx.nick} unbanned ${arg} (${match}) in ${channel}`);
    } else {
      for (const m of candidates) {
        api.mode(channel, '-b', m);
      }
      api.log(`${ctx.nick} unbanned ${arg} (no stored record) in ${channel}`);
    }
  });

  api.bind('pub', '+o', '!kickban', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) {
      ctx.reply('Usage: !kickban <nick> [reason]');
      return;
    }
    if (api.isBotNick(target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const reason = parts.slice(1).join(' ') || config.default_kick_reason;

    const hostmask = api.getUserHostmask(channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Use !ban <mask> then !kick <nick>.`);
      return;
    }

    const banMask = buildBanMask(hostmask, config.default_ban_type);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    api.ban(channel, banMask);
    const kickbanDurationMs =
      config.default_ban_duration === 0 ? 0 : config.default_ban_duration * 60_000;
    api.banStore.storeBan(channel, banMask, ctx.nick, kickbanDurationMs);
    api.kick(channel, target, reason);
    api.log(`${ctx.nick} kickbanned ${target} (${banMask}) from ${channel} (${reason})`);
  });

  api.bind('pub', '+o', '!bans', (ctx) => {
    const { channel } = ctx;
    const targetChannel = ctx.args.trim() || channel;
    const bans = api.banStore.getChannelBans(targetChannel);
    if (bans.length === 0) {
      ctx.reply(`No tracked bans for ${targetChannel}.`);
      return;
    }
    for (const ban of bans) {
      ctx.reply(`${ban.mask} — set by ${ban.by}, ${formatExpiry(ban.expires)}`);
    }
  });
}
