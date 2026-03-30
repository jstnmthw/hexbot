// help — IRC help system plugin
// Responds to !help [command|category] with a permission-filtered list of available commands.
import type { HandlerContext, HelpEntry, PluginAPI } from '../../src/types';

export const name = 'help';
export const version = '1.0.0';
export const description = 'Provides !help command listing available bot commands';

/** Track last !help (list view) invocation time per nick for flood protection. */
const cooldowns = new Map<string, number>();

/** Bold the trigger (first word) of a usage string, leaving args unbolded. */
function boldTrigger(usage: string): string {
  const spaceIdx = usage.indexOf(' ');
  if (spaceIdx === -1) return `\x02${usage}\x02`;
  return `\x02${usage.slice(0, spaceIdx)}\x02${usage.slice(spaceIdx)}`;
}

export function init(api: PluginAPI): void {
  const cooldownMs = (api.config.cooldown_ms as number | undefined) ?? 30000;
  const replyType = (api.config.reply_type as string | undefined) ?? 'notice';
  const compactIndex = (api.config.compact_index as boolean | undefined) ?? true;
  const header = (api.config.header as string | undefined) ?? 'HexBot Commands';
  const footer = (api.config.footer as string | undefined) ?? '*** End of Help ***';

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

  function handler(ctx: HandlerContext): void {
    const arg = ctx.args.trim();

    if (arg) {
      const normalized = arg.replace(/^!/, '');

      // Priority 1: match as a command name
      const entry = api
        .getHelpEntries()
        .find((e) => e.command.replace(/^!/, '').toLowerCase() === normalized.toLowerCase());

      if (entry) {
        // Detail view — always private to nick
        api.notice(ctx.nick, `${boldTrigger(entry.usage)} — ${entry.description}`);
        api.notice(
          ctx.nick,
          entry.flags === '-' ? 'No flags required' : `Requires: ${entry.flags}`,
        );
        if (entry.detail) {
          for (const line of entry.detail) {
            api.notice(ctx.nick, line);
          }
        }
        return;
      }

      // Priority 2: match as a category name (permission-filtered)
      const allEntries = api.getHelpEntries();
      const visible = allEntries.filter(
        (e) => e.flags === '-' || api.permissions.checkFlags(e.flags, ctx),
      );
      const categoryEntries = visible.filter(
        (e) => (e.category ?? e.pluginId!).toLowerCase() === normalized.toLowerCase(),
      );

      if (categoryEntries.length > 0) {
        // Category view — always private to nick
        const actualCategory = categoryEntries[0].category ?? categoryEntries[0].pluginId!;
        api.notice(ctx.nick, `\x02[${actualCategory}]\x02`);
        for (const e of categoryEntries) {
          api.notice(ctx.nick, `  ${boldTrigger(e.usage)} — ${e.description}`);
        }
        return;
      }

      // Nothing matched
      api.notice(ctx.nick, `No help for "${arg}" — try !help for a list`);
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
      const cat = entry.category ?? entry.pluginId!;
      const list = groups.get(cat) ?? [];
      list.push(entry);
      groups.set(cat, list);
    }

    if (compactIndex) {
      // Compact index: one intro line + one line per category
      send(ctx, `\x02${header}\x02 — !help <category> or !help <command>`);
      for (const [category, entries] of groups) {
        const commands = entries.map((e) => e.command.replace(/^!/, '')).join('  ');
        send(ctx, `  \x02${category}\x02: ${commands}`);
      }
    } else {
      // Verbose full list with bold formatting
      send(ctx, `\x02${header}\x02`);
      for (const [category, entries] of groups) {
        send(ctx, `\x02[${category}]\x02`);
        for (const entry of entries) {
          send(ctx, `  ${boldTrigger(entry.usage)} — ${entry.description}`);
        }
      }
      send(ctx, footer);
    }
  }

  api.bind('pub', '-', '!help', handler);
  api.bind('msg', '-', '!help', handler);
}

export function teardown(): void {
  cooldowns.clear();
}
