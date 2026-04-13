import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../../src/command-handler';
import { type MockBot, createMockBot } from '../../helpers/mock-bot';

/** Helper: create a REPL CommandContext with a spy on reply. */
function makeReplCtx(): CommandContext {
  return {
    source: 'repl',
    nick: 'REPL',
    channel: null,
    reply: vi.fn(),
  };
}

describe('plugin-commands', () => {
  let bot: MockBot;

  beforeEach(() => {
    bot = createMockBot();
  });

  afterEach(() => {
    bot.cleanup();
  });

  // -------------------------------------------------------------------------
  // .plugins
  // -------------------------------------------------------------------------
  describe('.plugins', () => {
    it('should show "No plugins loaded" when list is empty', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'list').mockReturnValue([]);

      await bot.commandHandler.execute('.plugins', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('No plugins loaded.');
    });

    it('should list loaded plugins with name and version', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'list').mockReturnValue([
        {
          name: 'seen',
          version: '1.0.0',
          description: 'Tracks last seen',
          filePath: '/plugins/seen/index.ts',
        },
        { name: 'help', version: '1.1.0', description: '', filePath: '/plugins/help/index.ts' },
      ]);

      await bot.commandHandler.execute('.plugins', ctx);

      const output = vi.mocked(ctx.reply).mock.calls[0][0];
      expect(output).toContain('Loaded plugins (2)');
      expect(output).toContain('seen v1.0.0 — Tracks last seen');
      expect(output).toContain('help v1.1.0');
    });
  });

  // -------------------------------------------------------------------------
  // .load
  // -------------------------------------------------------------------------
  describe('.load', () => {
    it('should load a valid plugin and report success', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'load').mockResolvedValue({
        name: 'my-plugin',
        status: 'ok',
      });

      await bot.commandHandler.execute('.load my-plugin', ctx);

      expect(bot.pluginLoader.load).toHaveBeenCalledWith('./plugins/my-plugin/index.ts');
      expect(ctx.reply).toHaveBeenCalledWith('Plugin "my-plugin" loaded successfully.');
    });

    it('should show usage when no args provided', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.load', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Usage: .load <plugin-name>');
    });

    it('should show usage when only whitespace provided', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.load   ', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Usage: .load <plugin-name>');
    });

    it('should reject plugin names with path traversal characters', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.load ../escape', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Invalid plugin name. Use alphanumeric characters, hyphens, and underscores only.',
      );
    });

    it('should reject plugin names with slashes', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.load foo/bar', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Invalid plugin name. Use alphanumeric characters, hyphens, and underscores only.',
      );
    });

    it('should reject plugin names starting with a hyphen', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.load -badname', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Invalid plugin name. Use alphanumeric characters, hyphens, and underscores only.',
      );
    });

    it('should report failure when plugin loader returns an error', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'load').mockResolvedValue({
        name: 'bad-plugin',
        status: 'error',
        error: 'Plugin file not found',
      });

      await bot.commandHandler.execute('.load bad-plugin', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Failed to load "bad-plugin": Plugin file not found');
    });
  });

  // -------------------------------------------------------------------------
  // .unload
  // -------------------------------------------------------------------------
  describe('.unload', () => {
    it('should unload a loaded plugin and report success', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'unload').mockResolvedValue(undefined);

      await bot.commandHandler.execute('.unload my-plugin', ctx);

      expect(bot.pluginLoader.unload).toHaveBeenCalledWith('my-plugin');
      expect(ctx.reply).toHaveBeenCalledWith('Plugin "my-plugin" unloaded.');
    });

    it('should show usage when no args provided', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.unload', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Usage: .unload <plugin-name>');
    });

    it('should report failure when unloading an unknown plugin', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'unload').mockRejectedValue(
        new Error('Plugin "nonexistent" is not loaded'),
      );

      await bot.commandHandler.execute('.unload nonexistent', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Failed to unload "nonexistent": Plugin "nonexistent" is not loaded',
      );
    });

    it('should handle non-Error throw from unload', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'unload').mockRejectedValue('string error');

      await bot.commandHandler.execute('.unload broken', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Failed to unload "broken": string error');
    });
  });

  // -------------------------------------------------------------------------
  // .reload
  // -------------------------------------------------------------------------
  describe('.reload', () => {
    it('should reload a loaded plugin and report success', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'reload').mockResolvedValue({
        name: 'my-plugin',
        status: 'ok',
      });

      await bot.commandHandler.execute('.reload my-plugin', ctx);

      expect(bot.pluginLoader.reload).toHaveBeenCalledWith('my-plugin');
      expect(ctx.reply).toHaveBeenCalledWith('Plugin "my-plugin" reloaded successfully.');
    });

    it('should show usage when no args provided', async () => {
      const ctx = makeReplCtx();

      await bot.commandHandler.execute('.reload', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Usage: .reload <plugin-name>');
    });

    it('should report failure when reload returns an error result', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'reload').mockResolvedValue({
        name: 'broken-plugin',
        status: 'error',
        error: 'init() threw: boom',
      });

      await bot.commandHandler.execute('.reload broken-plugin', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Failed to reload "broken-plugin": init() threw: boom',
      );
    });

    it('should report failure when reload throws (plugin not loaded)', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'reload').mockRejectedValue(
        new Error('Plugin "ghost" is not loaded'),
      );

      await bot.commandHandler.execute('.reload ghost', ctx);

      expect(ctx.reply).toHaveBeenCalledWith(
        'Failed to reload "ghost": Plugin "ghost" is not loaded',
      );
    });

    it('should handle non-Error throw from reload', async () => {
      const ctx = makeReplCtx();
      vi.spyOn(bot.pluginLoader, 'reload').mockRejectedValue('unexpected');

      await bot.commandHandler.execute('.reload borked', ctx);

      expect(ctx.reply).toHaveBeenCalledWith('Failed to reload "borked": unexpected');
    });
  });

  // -------------------------------------------------------------------------
  // Phase 4 — audit coverage
  // -------------------------------------------------------------------------
  describe('audit coverage', () => {
    it('writes plugin-load success row', async () => {
      vi.spyOn(bot.pluginLoader, 'load').mockResolvedValue({ name: 'good', status: 'ok' });
      await bot.commandHandler.execute('.load good', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-load' });
      expect(row.target).toBe('good');
      expect(row.outcome).toBe('success');
      expect(row.source).toBe('repl');
    });

    it('writes plugin-load failure row with the error in reason', async () => {
      vi.spyOn(bot.pluginLoader, 'load').mockResolvedValue({
        name: 'bad',
        status: 'error',
        error: 'syntax error',
      });
      await bot.commandHandler.execute('.load bad', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-load', outcome: 'failure' });
      expect(row).toBeDefined();
      expect(row.reason).toBe('syntax error');
    });

    it('writes plugin-unload success row', async () => {
      vi.spyOn(bot.pluginLoader, 'unload').mockResolvedValue(undefined);
      await bot.commandHandler.execute('.unload removeme', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-unload' });
      expect(row.target).toBe('removeme');
      expect(row.outcome).toBe('success');
    });

    it('writes plugin-unload failure row when teardown throws', async () => {
      vi.spyOn(bot.pluginLoader, 'unload').mockRejectedValue(new Error('teardown crashed'));
      await bot.commandHandler.execute('.unload broken', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-unload', outcome: 'failure' });
      expect(row).toBeDefined();
      expect(row.reason).toBe('teardown crashed');
    });

    it('writes plugin-reload success row', async () => {
      vi.spyOn(bot.pluginLoader, 'reload').mockResolvedValue({ name: 'r', status: 'ok' });
      await bot.commandHandler.execute('.reload r', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-reload' });
      expect(row.outcome).toBe('success');
    });

    it('writes plugin-reload failure row from result', async () => {
      vi.spyOn(bot.pluginLoader, 'reload').mockResolvedValue({
        name: 'r',
        status: 'error',
        error: 'init failed',
      });
      await bot.commandHandler.execute('.reload r', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-reload', outcome: 'failure' });
      expect(row.reason).toBe('init failed');
    });

    it('writes plugin-reload failure row from thrown exception', async () => {
      vi.spyOn(bot.pluginLoader, 'reload').mockRejectedValue(new Error('not loaded'));
      await bot.commandHandler.execute('.reload missing', makeReplCtx());
      const [row] = bot.db.getModLog({ action: 'plugin-reload', outcome: 'failure' });
      expect(row.reason).toBe('not loaded');
    });
  });
});
