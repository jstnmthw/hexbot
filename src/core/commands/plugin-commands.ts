// HexBot — Plugin management commands
//
// `.plugins` is the only plugin-lifecycle command exposed to operators.
// Enable / disable / reload happen via `core.plugins.<id>.enabled` —
// `.set core plugins.<id>.enabled true/false` is the canonical path, and
// `.restart` covers picking up code edits. The pre-refactor `.load` /
// `.unload` / `.reload` commands were deleted in lockstep with the
// removal of the cache-busting import path (audit CRITICAL 2026-04-25).
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import type { PluginLoader } from '../../plugin-loader';

export interface PluginCommandsDeps {
  handler: CommandHandler;
  pluginLoader: PluginLoader;
  pluginDir: string;
  db: BotDatabase | null;
}

/**
 * Register the read-only `.plugins` listing. Lifecycle mutations live
 * on `.set core plugins.<id>.enabled` — see `settings-commands.ts` and
 * the plugin-loader's `core.plugins.*` registrations.
 */
export function registerPluginCommands(deps: PluginCommandsDeps): void {
  const { handler, pluginLoader } = deps;
  void deps.pluginDir;
  void deps.db;
  handler.registerCommand(
    'plugins',
    {
      flags: '-',
      description: 'List loaded plugins',
      usage: '.plugins',
      category: 'plugins',
    },
    (_args, ctx) => {
      const plugins = pluginLoader.list();
      if (plugins.length === 0) {
        ctx.reply('No plugins loaded.');
        return;
      }
      const lines = plugins.map(
        (p) => `  ${p.name} v${p.version}${p.description ? ' — ' + p.description : ''}`,
      );
      ctx.reply(`Loaded plugins (${plugins.length}):\n${lines.join('\n')}`);
    },
  );
}
