import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler.js';
import {
  type AdminBotInfo,
  type AdminIRCClient,
  registerIRCAdminCommands,
} from '../../../src/core/commands/irc-commands-admin.js';

/** Helper: create a minimal CommandContext. */
function makeCtx(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    source: 'repl',
    nick: 'admin',
    channel: null,
    reply: vi.fn(),
    ...overrides,
  };
}

describe('irc-commands-admin', () => {
  let handler: CommandHandler;
  let mockClient: AdminIRCClient;
  let mockBotInfo: AdminBotInfo;

  beforeEach(() => {
    handler = new CommandHandler();
    mockClient = {
      say: vi.fn(),
      join: vi.fn(),
      part: vi.fn(),
      connected: true,
      user: { nick: 'testbot' },
    };
    mockBotInfo = {
      getUptime: () => 3661_000, // 1h 1m 1s
      getChannels: () => ['#test', '#dev'],
      getBindCount: () => 5,
      getUserCount: () => 2,
    };
    registerIRCAdminCommands(handler, mockClient, mockBotInfo);
  });

  describe('.say', () => {
    it('should send a message to the specified target', async () => {
      const ctx = makeCtx();
      await handler.execute('.say #test Hello, world!', ctx);

      expect(mockClient.say).toHaveBeenCalledWith('#test', 'Hello, world!');
      expect(ctx.reply).toHaveBeenCalledWith('Message sent to #test');
    });

    it('should show usage when no args provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.say', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .say <target> <message>');
    });

    it('should show usage when only target provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.say #test', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
    });

    it('should strip newlines from messages', async () => {
      const ctx = makeCtx();
      await handler.execute('.say #test evil\r\nPRIVMSG #other :pwned', ctx);

      expect(mockClient.say).toHaveBeenCalledWith('#test', 'evilPRIVMSG #other :pwned');
    });
  });

  describe('.join', () => {
    it('should join the specified channel', async () => {
      const ctx = makeCtx();
      await handler.execute('.join #newchan', ctx);

      expect(mockClient.join).toHaveBeenCalledWith('#newchan');
      expect(ctx.reply).toHaveBeenCalledWith('Joining #newchan');
    });

    it('should reject non-channel targets', async () => {
      const ctx = makeCtx();
      await handler.execute('.join notachannel', ctx);

      expect(mockClient.join).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .join <#channel>');
    });

    it('should show usage when no args', async () => {
      const ctx = makeCtx();
      await handler.execute('.join', ctx);

      expect(mockClient.join).not.toHaveBeenCalled();
    });
  });

  describe('.part', () => {
    it('should part the specified channel', async () => {
      const ctx = makeCtx();
      await handler.execute('.part #oldchan', ctx);

      expect(mockClient.part).toHaveBeenCalledWith('#oldchan', undefined);
      expect(ctx.reply).toHaveBeenCalledWith('Leaving #oldchan');
    });

    it('should pass a part message if provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.part #oldchan Goodbye everyone', ctx);

      expect(mockClient.part).toHaveBeenCalledWith('#oldchan', 'Goodbye everyone');
    });

    it('should reject non-channel targets', async () => {
      const ctx = makeCtx();
      await handler.execute('.part notachannel', ctx);

      expect(mockClient.part).not.toHaveBeenCalled();
    });
  });

  describe('.status', () => {
    it('should display bot status', async () => {
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Status: connected as testbot');
      expect(output).toContain('Uptime: 1h 1m 1s');
      expect(output).toContain('#test, #dev');
      expect(output).toContain('Binds: 5');
      expect(output).toContain('Users: 2');
    });

    it('should show disconnected when not connected', async () => {
      mockClient.connected = false;
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Status: disconnected');
    });

    it('should show (none) when no channels', async () => {
      mockBotInfo.getChannels = () => [];
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('(none)');
    });
  });
});
