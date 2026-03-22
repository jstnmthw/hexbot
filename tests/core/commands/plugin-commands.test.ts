import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../../src/command-handler.js';
import { type MockBot, createMockBot } from '../../helpers/mock-bot.js';

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
});
