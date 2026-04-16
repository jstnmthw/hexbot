// HexBot — Plugin management commands
// .plugins, .load, .unload, .reload
import type { CommandContext, CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import type { PluginLoader } from '../../plugin-loader';
import { replyFailure } from '../../utils/command-helpers';
import { tryAudit } from '../audit';

const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Validate a plugin name from a command argument and reply with a usage
 * message on failure. Returns true if the name is safe to dispatch.
 * Shared by `.load`, `.unload`, and `.reload` so all three apply the
 * same SAFE_NAME_RE the loader enforces internally.
 */
function validatePluginName(ctx: CommandContext, name: string): boolean {
  if (!PLUGIN_NAME_RE.test(name)) {
    ctx.reply('Invalid plugin name. Use alphanumeric characters, hyphens, and underscores only.');
    return false;
  }
  return true;
}

export function registerPluginCommands(
  handler: CommandHandler,
  pluginLoader: PluginLoader,
  pluginDir: string,
  db: BotDatabase | null,
): void {
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

  handler.registerCommand(
    'load',
    {
      flags: 'n',
      description: 'Load a plugin',
      usage: '.load <plugin-name>',
      category: 'plugins',
    },
    async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.reply('Usage: .load <plugin-name>');
        return;
      }
      if (!validatePluginName(ctx, name)) return;

      const pluginPath = `${pluginDir}/${name}/dist/index.js`;
      const result = await pluginLoader.load(pluginPath);

      if (result.status === 'ok') {
        ctx.reply(`Plugin "${name}" loaded successfully.`);
        tryAudit(db, ctx, { action: 'plugin-load', target: name });
      } else {
        replyFailure(db, ctx, 'load', name, result.error ?? 'unknown error', 'plugin-load');
      }
    },
  );

  handler.registerCommand(
    'unload',
    {
      flags: 'n',
      description: 'Unload a plugin',
      usage: '.unload <plugin-name>',
      category: 'plugins',
    },
    async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.reply('Usage: .unload <plugin-name>');
        return;
      }
      if (!validatePluginName(ctx, name)) return;

      try {
        await pluginLoader.unload(name);
        ctx.reply(`Plugin "${name}" unloaded.`);
        tryAudit(db, ctx, { action: 'plugin-unload', target: name });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        replyFailure(db, ctx, 'unload', name, message, 'plugin-unload');
      }
    },
  );

  handler.registerCommand(
    'reload',
    {
      flags: 'n',
      description: 'Reload a plugin',
      usage: '.reload <plugin-name>',
      category: 'plugins',
    },
    async (args, ctx) => {
      const name = args.trim();
      if (!name) {
        ctx.reply('Usage: .reload <plugin-name>');
        return;
      }
      if (!validatePluginName(ctx, name)) return;

      try {
        const result = await pluginLoader.reload(name);
        if (result.status === 'ok') {
          ctx.reply(`Plugin "${name}" reloaded successfully.`);
          tryAudit(db, ctx, { action: 'plugin-reload', target: name });
        } else {
          replyFailure(db, ctx, 'reload', name, result.error ?? 'unknown error', 'plugin-reload');
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        replyFailure(db, ctx, 'reload', name, message, 'plugin-reload');
      }
    },
  );
}
