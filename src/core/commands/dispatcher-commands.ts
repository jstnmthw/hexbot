// HexBot — Dispatcher inspection commands
// Registers .binds with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { EventDispatcher } from '../../dispatcher';
import { stripFormatting } from '../../utils/strip-formatting';
import { formatTable } from '../../utils/table';

/**
 * Register dispatcher inspection commands on the given command handler.
 */
export function registerDispatcherCommands(
  handler: CommandHandler,
  dispatcher: EventDispatcher,
): void {
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
      const rows = binds.map((b) => [
        stripFormatting(b.type),
        stripFormatting(b.flags),
        `"${stripFormatting(b.mask)}"`,
        `→ ${stripFormatting(b.pluginId)}`,
        `(hits: ${b.hits})`,
      ]);
      const header = pluginId ? `Binds for "${pluginId}"` : 'All binds';
      ctx.reply(`${header} (${binds.length}):\n${formatTable(rows)}`);
    },
  );
}
