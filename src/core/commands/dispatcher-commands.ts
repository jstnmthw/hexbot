// HexBot — Dispatcher inspection commands
// Registers .binds with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { EventDispatcher } from '../../dispatcher';
import { stripFormatting } from '../../utils/strip-formatting';
import { formatTable } from '../../utils/table';

export interface DispatcherCommandsDeps {
  handler: CommandHandler;
  dispatcher: EventDispatcher;
}

/**
 * Register dispatcher inspection commands (`.binds`) on the given command
 * handler. `+o` is sufficient because the command is read-only; output
 * is sanitized with `stripFormatting` since plugin IDs and bind masks
 * originate from plugin code and could otherwise smuggle IRC control
 * codes into an operator's console.
 */
export function registerDispatcherCommands(deps: DispatcherCommandsDeps): void {
  const { handler, dispatcher } = deps;
  handler.registerCommand(
    'binds',
    {
      flags: '+o',
      description: 'List active binds (optionally filtered by plugin)',
      usage: '.binds [pluginId]',
      category: 'dispatcher',
    },
    (_args, ctx) => {
      const pluginId = _args.trim() || undefined;
      const filter = pluginId ? { pluginId } : undefined;
      const binds = dispatcher.listBinds(filter);

      if (binds.length === 0) {
        const suffix = pluginId ? ` for plugin "${pluginId}"` : '';
        ctx.reply(`No active binds${suffix}.`);
        return;
      }

      // stripFormatting on every user-influenced column — plugin IDs and
      // bind masks originate from plugin code, so a compromised plugin
      // could otherwise inject IRC control codes into an operator's
      // console via the `.binds` output.

      // Group binds by plugin for readability
      const groups = new Map<string, typeof binds>();
      for (const b of binds) {
        const id = stripFormatting(b.pluginId);
        let group = groups.get(id);
        if (!group) {
          group = [];
          groups.set(id, group);
        }
        group.push(b);
      }

      const lines: string[] = [];
      const title = pluginId ? `Binds for "${pluginId}"` : 'All binds';
      lines.push(`${title} (${binds.length}):`);

      for (const [id, group] of groups) {
        const s = group.length === 1 ? 'bind' : 'binds';
        lines.push(`[${id}] ${group.length} ${s}`);
        const rows = group.map((b) => [
          stripFormatting(b.type),
          stripFormatting(b.flags),
          `"${stripFormatting(b.mask)}"`,
          `(hits: ${b.hits})`,
        ]);
        lines.push(formatTable(rows));
      }

      ctx.reply(lines.join('\n'));
    },
  );
}
