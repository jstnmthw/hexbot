// help — IRC help system plugin
// Responds to !help [command] with a permission-filtered list of available commands.
import type { HandlerContext, HelpEntry, PluginAPI } from '../../src/types';

export const name = 'help';
export const version = '1.0.0';
export const description = 'Provides !help command listing available bot commands';

/** Track last !help (list view) invocation time per nick for flood protection. */
const cooldowns = new Map<string, number>();

export function init(api: PluginAPI): void {
  const cooldownMs = (api.config.cooldown_ms as number | undefined) ?? 30000;
  const replyType = (api.config.reply_type as string | undefined) ?? 'notice';
  const header = (api.config.header as string | undefined) ?? '*** Help ***';
  const footer = (api.config.footer as string | undefined) ?? '*** End of Help ***';

  /**
   * Send a message to the appropriate target.
   * For list view `channel_notice`: sends NOTICE to channel if available, else to nick.
   * For detail view: always sends to nick.
   */
  function send(ctx: HandlerContext, text: string, forcePrivate = false): void {
    if (replyType === 'privmsg') {
      api.say(ctx.nick, text);
    } else if (replyType === 'channel_notice' && !forcePrivate && ctx.channel) {
      api.notice(ctx.channel, text);
    } else {
      api.notice(ctx.nick, text);
    }
  }

  function handler(ctx: HandlerContext): void {
    const arg = ctx.args.trim();

    if (arg) {
      // Detail view: !help <command>
      const normalized = arg.replace(/^!/, '');
      const entry = api
        .getHelpEntries()
        .find((e) => e.command.replace(/^!/, '').toLowerCase() === normalized.toLowerCase());

      if (!entry) {
        api.notice(ctx.nick, `No help available for !${normalized}`);
        return;
      }

      // Always send detail to nick (private)
      api.notice(ctx.nick, `Usage: ${entry.usage}`);
      api.notice(ctx.nick, `Flags: ${entry.flags}`);
      api.notice(ctx.nick, entry.description);
      if (entry.detail) {
        for (const line of entry.detail) {
          api.notice(ctx.nick, line);
        }
      }
      return;
    }

    // List view: !help with no args — enforce per-user cooldown
    const now = Date.now();
    const last = cooldowns.get(ctx.nick);
    if (last !== undefined && now - last < cooldownMs) {
      return; // silently drop — still in cooldown
    }
    cooldowns.set(ctx.nick, now);

    // Filter entries by permission
    const allEntries = api.getHelpEntries();
    const visible = allEntries.filter(
      (e) => e.flags === '-' || api.permissions.checkFlags(e.flags, ctx),
    );

    if (visible.length === 0) {
      send(ctx, 'No commands available.');
      return;
    }

    // Group by category
    const groups = new Map<string, HelpEntry[]>();
    for (const entry of visible) {
      const cat = entry.category ?? api.pluginId;
      const list = groups.get(cat) ?? [];
      list.push(entry);
      groups.set(cat, list);
    }

    send(ctx, header);
    for (const [category, entries] of groups) {
      send(ctx, `[${category}]`);
      for (const entry of entries) {
        send(ctx, `  ${entry.usage} — ${entry.description}`);
      }
    }
    send(ctx, footer);
  }

  api.bind('pub', '-', '!help', handler);
  api.bind('msg', '-', '!help', handler);

  api.log('Loaded');
}

export function teardown(): void {
  cooldowns.clear();
}
