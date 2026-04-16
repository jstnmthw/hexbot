// chanmod — IRC commands: !op !deop !halfop !dehalfop !voice !devoice !kick
// (Ban-related commands live in ./ban-commands.ts.)
import type { ChannelHandlerContext, PluginAPI } from '../../src/types';
import { registerBanCommands } from './ban-commands';
import { botCanHalfop, botHasOps, isValidNick, markIntentional } from './helpers';
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
  /** Silently ignore the command when the target is the bot itself. */
  silentSelfIgnore?: boolean;
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
    const target = ctx.args.trim() || ctx.nick;
    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (opts.silentSelfIgnore && api.isBotNick(target)) {
      return;
    }
    if (!opts.canApply(api, channel)) {
      ctx.reply(opts.capabilityError);
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
      silentSelfIgnore: true,
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
      silentSelfIgnore: true,
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
      silentSelfIgnore: true,
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

  registerBanCommands(api, config);

  return () => {};
}
