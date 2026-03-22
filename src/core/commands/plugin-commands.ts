// n0xb0t — Plugin management commands
// .plugins, .load, .unload, .reload
import type { CommandHandler } from '../../command-handler.js';
import type { PluginLoader } from '../../plugin-loader.js';

export function registerPluginCommands(
  handler: CommandHandler,
  pluginLoader: PluginLoader,
  pluginDir: string,
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

      // Validate plugin name to prevent path traversal
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
        ctx.reply(
          'Invalid plugin name. Use alphanumeric characters, hyphens, and underscores only.',
        );
        return;
      }

      const pluginPath = `${pluginDir}/${name}/index.ts`;
      const result = await pluginLoader.load(pluginPath);

      if (result.status === 'ok') {
        ctx.reply(`Plugin "${name}" loaded successfully.`);
      } else {
        ctx.reply(`Failed to load "${name}": ${result.error}`);
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

      try {
        await pluginLoader.unload(name);
        ctx.reply(`Plugin "${name}" unloaded.`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.reply(`Failed to unload "${name}": ${message}`);
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

      try {
        const result = await pluginLoader.reload(name);
        if (result.status === 'ok') {
          ctx.reply(`Plugin "${name}" reloaded successfully.`);
        } else {
          ctx.reply(`Failed to reload "${name}": ${result.error}`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.reply(`Failed to reload "${name}": ${message}`);
      }
    },
  );
}
