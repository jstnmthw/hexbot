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
});
