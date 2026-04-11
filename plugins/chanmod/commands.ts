// chanmod — IRC commands: !op !deop !halfop !dehalfop !voice !devoice !kick !ban !unban !kickban !bans
import type { ChannelHandlerContext, PluginAPI } from '../../src/types';
import {
  botCanHalfop,
  botHasOps,
  buildBanMask,
  formatExpiry,
  isValidNick,
  markIntentional,
} from './helpers';
import type { ChanmodConfig, SharedState } from './state';

// ---------------------------------------------------------------------------
// Mode command factory — !op / !deop / !voice / !devoice / !halfop / !dehalfop
// ---------------------------------------------------------------------------

interface ModeCommandOptions {
  /** Log verb, e.g. "opped", "devoiced". */
  verb: string;
  /** Returns true if the bot has the capability needed to apply this mode. */
  canApply: (api: PluginAPI, channel: string) => boolean;
  /** Reply sent when `canApply` returns false. */
  capabilityError: string;
  /** Apply the mode to `target` in `channel`. */
  execute: (api: PluginAPI, channel: string, target: string) => void;
  /**
   * Reply sent when the user targets the bot itself with a mode-removal command
   * (e.g. !deop hexbot). Setting this enables the bot-self guard.
   */
  selfRejectReply?: string;
  /** Mark the change as intentional so mode-enforce skips revenge/cycle. */
  markIntent?: boolean;
}

/**
 * Build a handler for a mode command that targets a nick.
 * Each handler follows the same 8-step shape; the options pick which steps run.
 */
function createModeCommandHandler(
  api: PluginAPI,
  state: SharedState,
  opts: ModeCommandOptions,
): (ctx: ChannelHandlerContext) => void {
  return (ctx: ChannelHandlerContext): void => {
    const { channel } = ctx;
    if (!opts.canApply(api, channel)) {
      ctx.reply(opts.capabilityError);
      return;
    }
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (opts.selfRejectReply && api.isBotNick(target)) {
      ctx.reply(opts.selfRejectReply);
      return;
    }
    if (opts.markIntent) {
      markIntentional(state, api, channel, target);
    }
    opts.execute(api, channel, target);
    api.log(`${ctx.nick} ${opts.verb} ${target} in ${channel}`);
  };
}

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

  const OPS_REQUIRED_ERROR = 'I am not opped in this channel.';
  const HALFOP_REQUIRED_ERROR = 'I do not have +h or +o in this channel.';

  api.bind(
    'pub',
    '+o',
    '!op',
    createModeCommandHandler(api, state, {
      verb: 'opped',
      canApply: botHasOps,
      capabilityError: OPS_REQUIRED_ERROR,
      execute: (a, c, t) => a.op(c, t),
    }),
  );

  api.bind(
    'pub',
    '+o',
    '!deop',
    createModeCommandHandler(api, state, {
      verb: 'deopped',
      canApply: botHasOps,
      capabilityError: OPS_REQUIRED_ERROR,
      execute: (a, c, t) => a.deop(c, t),
      selfRejectReply: 'I cannot deop myself.',
      markIntent: true,
    }),
  );

  api.bind(
    'pub',
    '+o',
    '!voice',
    createModeCommandHandler(api, state, {
      verb: 'voiced',
      canApply: botHasOps,
      capabilityError: OPS_REQUIRED_ERROR,
      execute: (a, c, t) => a.voice(c, t),
    }),
  );

  api.bind(
    'pub',
    '+o',
    '!devoice',
    createModeCommandHandler(api, state, {
      verb: 'devoiced',
      canApply: botHasOps,
      capabilityError: OPS_REQUIRED_ERROR,
      execute: (a, c, t) => a.devoice(c, t),
      markIntent: true,
    }),
  );

  api.bind(
    'pub',
    '+o',
    '!halfop',
    createModeCommandHandler(api, state, {
      verb: 'halfopped',
      canApply: botCanHalfop,
      capabilityError: HALFOP_REQUIRED_ERROR,
      execute: (a, c, t) => a.halfop(c, t),
    }),
  );

  api.bind(
    'pub',
    '+o',
    '!dehalfop',
    createModeCommandHandler(api, state, {
      verb: 'dehalfopped',
      canApply: botCanHalfop,
      capabilityError: HALFOP_REQUIRED_ERROR,
      execute: (a, c, t) => a.dehalfop(c, t),
      selfRejectReply: 'I cannot dehalfop myself.',
      markIntent: true,
    }),
  );

  // ---------------------------------------------------------------------------
  // !kick
  // ---------------------------------------------------------------------------

  api.bind('pub', '+o', '!kick', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) {
      ctx.reply('Usage: !kick <nick> [reason]');
      return;
    }
    if (api.isBotNick(target)) {
      ctx.reply('I cannot kick myself.');
      return;
    }
    const reason = parts.slice(1).join(' ') || config.default_kick_reason;
    api.kick(channel, target, reason);
    api.log(`${ctx.nick} kicked ${target} from ${channel} (${reason})`);
  });

  // ---------------------------------------------------------------------------
  // !ban / !unban / !kickban / !bans
  // ---------------------------------------------------------------------------

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

  return () => {};
}
