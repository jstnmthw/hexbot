// help — IRC help system plugin
// Responds to !help [command|category] with a permission-filtered list of available commands.
// All rendering / lookup logic lives in `src/core/help-render` so the IRC
// transport here and the core `.help` built-in stay in lockstep.
import {
  lookup,
  renderCategory,
  renderCommand,
  renderIndex,
  renderScope,
} from '../../src/core/help-render';
import type { HandlerContext, PluginAPI } from '../../src/types';

export const name = 'help';
export const version = '1.0.0';
export const description = 'Provides !help command listing available bot commands';

/** Valid `reply_type` config values. */
type ReplyType = 'notice' | 'privmsg' | 'channel_notice';

const DEFAULT_COOLDOWN_MS = 30_000;

// Triggers an inline sweep when the cooldown map grows past this size. Set
// well above any realistic concurrent-user count so the sweep almost never
// runs in normal operation.
const COOLDOWN_MAP_SWEEP_THRESHOLD = 1000;

/**
 * Plugin entry point. Registers `cooldown_ms`, `reply_type`,
 * `compact_index`, `header`, and `footer` via `api.settings`, then binds
 * `pub`/`msg` handlers for `!help` plus a periodic `time` bind for
 * cooldown-map sweeps. All mutable state (the cooldown map) is scoped
 * inside this function so a plugin reload doesn't leak the previous
 * module's map.
 */
export function init(api: PluginAPI): void {
  // Per-nick cooldown map scoped inside `init()`. A module-level Map
  // gets pinned by the stale closure on reload; this scope bound
  // ensures GC collects it.
  const cooldowns = new Map<string, number>();

  api.settings.register([
    {
      key: 'cooldown_ms',
      type: 'int',
      default: DEFAULT_COOLDOWN_MS,
      description: 'Per-user cooldown between !help index requests (ms)',
    },
    {
      key: 'reply_type',
      type: 'string',
      default: 'notice',
      description: 'Where to send replies: notice (PM), privmsg (PM), channel_notice (in-channel)',
      allowedValues: ['notice', 'privmsg', 'channel_notice'],
    },
    {
      key: 'compact_index',
      type: 'flag',
      default: true,
      description: 'Compact one-line-per-category index (false = verbose listing)',
    },
    {
      key: 'header',
      type: 'string',
      default: 'HexBot Commands',
      description: 'Header line for the help index',
    },
    {
      key: 'footer',
      type: 'string',
      default: '*** End of Help ***',
      description: 'Footer line for the verbose help index',
    },
  ]);

  // Snapshot the cooldown / reply mode at init so the cooldown map and
  // sweep tick agree on the same window for the life of this load. The
  // `header` / `footer` / `compact_index` reads happen per-request so a
  // `.set help compact_index false` takes effect on the next !help.
  // `cooldown_ms` honours an explicit `0` (cooldown disabled) — `||` would
  // collapse 0 onto the default and silently re-enable the gate.
  const cooldownMs = api.settings.isSet('cooldown_ms')
    ? api.settings.getInt('cooldown_ms')
    : DEFAULT_COOLDOWN_MS;
  const rawReplyType = api.settings.getString('reply_type');
  const replyType: ReplyType =
    rawReplyType === 'privmsg' || rawReplyType === 'channel_notice' ? rawReplyType : 'notice';

  /**
   * Send a message to the appropriate target based on reply_type.
   * For channel_notice: sends NOTICE to channel if available, else to nick.
   * Detail and category views always call api.notice(ctx.nick, ...) directly.
   */
  function send(ctx: HandlerContext, text: string): void {
    if (replyType === 'privmsg') {
      api.say(ctx.nick, text);
    } else if (replyType === 'channel_notice' && ctx.channel) {
      api.notice(ctx.channel, text);
    } else {
      api.notice(ctx.nick, text);
    }
  }

  /** Reply privately for sub-views (detail / category / scope). */
  function privateReply(ctx: HandlerContext, lines: string[]): void {
    for (const line of lines) {
      api.notice(ctx.nick, line);
    }
  }

  function handler(ctx: HandlerContext): void {
    const arg = ctx.args.trim();
    const helpRegistry = api.getHelpRegistry();

    if (arg) {
      const result = lookup(helpRegistry, arg, ctx, api.permissions);
      switch (result.kind) {
        case 'command':
          privateReply(ctx, renderCommand(result.entry));
          return;
        case 'category':
          privateReply(ctx, renderCategory(result.category, result.entries));
          return;
        case 'scope':
          privateReply(ctx, renderScope(result.scope, result.header, result.entries, '!'));
          return;
        case 'denied':
        case 'none':
          api.notice(ctx.nick, `No help for "${arg}" — try !help for a list`);
          return;
      }
    }

    // List view: !help with no args — enforce per-user cooldown.
    //
    // Keyed on `ident@host` (case-folded host), not nick: a user on a stable
    // cloak can otherwise trivially bypass the cooldown by cycling nicks
    // (/nick a → !help → /nick b → !help). Ident+host is the closest stable
    // identity the bot sees without a services lookup; a determined attacker
    // can spoof ident on non-identd networks, but on an identd network or
    // against a services cloak this is effectively per-user.
    const now = Date.now();
    const cooldownKey = `${ctx.ident}@${api.ircLower(ctx.hostname)}`;
    const last = cooldowns.get(cooldownKey);
    if (last !== undefined && now - last < cooldownMs) {
      return; // silently drop — still in cooldown
    }
    // Inline sweep: cap map size and drop any entries past their cooldown
    // window so the set is bounded by recent activity, not all-time !help
    // users.
    if (cooldowns.size > COOLDOWN_MAP_SWEEP_THRESHOLD) {
      for (const [k, t] of cooldowns) {
        if (now - t >= cooldownMs) cooldowns.delete(k);
      }
    }
    cooldowns.set(cooldownKey, now);

    const visible = helpRegistry
      .getAll()
      .filter((e) => e.flags === '-' || api.permissions.checkFlags(e.flags, ctx));
    const lines = renderIndex(visible, {
      compact: api.settings.getFlag('compact_index'),
      header: api.settings.getString('header') || 'HexBot Commands',
      footer: api.settings.getString('footer') || '*** End of Help ***',
      prefix: '!',
    });
    for (const line of lines) {
      send(ctx, line);
    }
  }

  api.bind('pub', '-', '!help', handler);
  api.bind('msg', '-', '!help', handler);

  // Time-based sweep (every 5 minutes) to complement the size-threshold
  // sweep. On a rarely-used bot the map can accumulate entries for years
  // without ever crossing the 1000-entry threshold — this keeps it tidy
  // regardless of volume.
  api.bind('time', '-', '300', () => {
    const now = Date.now();
    for (const [k, t] of cooldowns) {
      if (now - t >= cooldownMs) cooldowns.delete(k);
    }
  });
}

// `cooldowns` now lives inside `init()` so teardown has nothing to do;
// the GC drops the old module's closure graph once nothing references it.
export function teardown(): void {}
