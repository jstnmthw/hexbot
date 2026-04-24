import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import {
  type AdminBotInfo,
  type AdminIRCClient,
  formatReconnectState,
  formatUptimeColored,
  registerIRCAdminCommands,
} from '../../../src/core/commands/irc-commands-admin';
import type { ReconnectState } from '../../../src/core/reconnect-driver';
import { BotDatabase } from '../../../src/database';

/** Helper: create a minimal CommandContext with a typed reply mock. */
function makeCtx(
  overrides: Partial<CommandContext> = {},
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply, ...overrides };
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
}

describe('irc-commands-admin', () => {
  let handler: CommandHandler;
  let mockClient: AdminIRCClient;
  let mockBotInfo: AdminBotInfo;
  let db: BotDatabase;

  beforeEach(() => {
    handler = new CommandHandler();
    mockClient = {
      say: vi.fn(),
      join: vi.fn(),
      part: vi.fn(),
      raw: vi.fn(),
      connected: true,
      user: { nick: 'testbot' },
    };
    mockBotInfo = {
      getUptime: () => 3661_000, // 1h 1m 1s
      getChannels: () => ['#test', '#dev'],
      getBindCount: () => 5,
      getUserCount: () => 2,
      getReconnectState: () => null,
    };
    db = new BotDatabase(':memory:');
    db.open();
    registerIRCAdminCommands({ handler, client: mockClient, botInfo: mockBotInfo, db });
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

    it('should reject target with embedded control characters', async () => {
      const ctx = makeCtx();
      await handler.execute('.say foo\rbar message', ctx);

      // parseTargetMessage sanitizes at the parse boundary and returns null
      // when the target contained control characters, so the usage error
      // fires before isValidCommandTarget sees the mangled value.
      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .say <target> <message>');
    });

    it('should show usage when message is empty after trim (space-only arg)', async () => {
      const ctx = makeCtx();
      // "#test " — has a space so spaceIdx != -1, but message after split is empty
      await handler.execute('.say #test ', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .say <target> <message>');
    });

    it('should show usage when target is empty before the space', async () => {
      const ctx = makeCtx();
      // " hello" — space at index 0 so target.trim() is empty
      await handler.execute('.say  hello', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .say <target> <message>');
    });
  });

  describe('.msg', () => {
    it('should send a PRIVMSG to a nick', async () => {
      const ctx = makeCtx();
      await handler.execute('.msg SomeNick Hello there', ctx);

      expect(mockClient.say).toHaveBeenCalledWith('SomeNick', 'Hello there');
      expect(ctx.reply).toHaveBeenCalledWith('Message sent to SomeNick');
    });

    it('should show usage when no args provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.msg', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .msg <target> <message>');
    });

    it('should show usage when only target provided (no space)', async () => {
      const ctx = makeCtx();
      await handler.execute('.msg SomeNick', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
    });

    it('should show usage when message is empty after trim', async () => {
      const ctx = makeCtx();
      await handler.execute('.msg SomeNick ', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .msg <target> <message>');
    });

    it('should strip newlines from messages', async () => {
      const ctx = makeCtx();
      await handler.execute('.msg SomeNick evil\r\nPRIVMSG #other :pwned', ctx);

      expect(mockClient.say).toHaveBeenCalledWith('SomeNick', 'evilPRIVMSG #other :pwned');
    });

    it('should reject target containing control characters', async () => {
      const ctx = makeCtx();
      // parseTargetMessage sanitizes the target — a `\r` in the token causes
      // the parser to return null and the handler shows the usage message
      // rather than forwarding a mangled target to the IRC client.
      await handler.execute('.msg nick\r hello', ctx);

      expect(mockClient.say).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .msg <target> <message>');
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

  describe('.invite', () => {
    it('should send INVITE to the specified channel and nick', async () => {
      const ctx = makeCtx();
      await handler.execute('.invite #test Alice', ctx);

      expect(mockClient.raw).toHaveBeenCalledWith('INVITE Alice #test');
      expect(ctx.reply).toHaveBeenCalledWith('Invited Alice to #test');
    });

    it('should show usage when no args provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.invite', ctx);

      expect(mockClient.raw).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .invite <#channel> <nick>');
    });

    it('should show usage when only channel provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.invite #test', ctx);

      expect(mockClient.raw).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .invite <#channel> <nick>');
    });

    it('should show usage when channel does not start with #', async () => {
      const ctx = makeCtx();
      await handler.execute('.invite notachannel Alice', ctx);

      expect(mockClient.raw).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Usage: .invite <#channel> <nick>');
    });

    it('should ignore extra arguments beyond channel and nick', async () => {
      const ctx = makeCtx();
      await handler.execute('.invite #test Alice extra stuff', ctx);

      expect(mockClient.raw).toHaveBeenCalledWith('INVITE Alice #test');
      expect(ctx.reply).toHaveBeenCalledWith('Invited Alice to #test');
    });

    it('should reject args containing control characters', async () => {
      const ctx = makeCtx();
      await handler.execute('.invite #test evil\rnick', ctx);

      expect(mockClient.raw).not.toHaveBeenCalled();
      expect(ctx.reply).toHaveBeenCalledWith('Invalid nick.');
    });
  });

  describe('.status', () => {
    it('should display bot status', async () => {
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = ctx.reply.mock.calls[0][0];
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

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Status: disconnected');
    });

    it('should show (none) when no channels', async () => {
      mockBotInfo.getChannels = () => [];
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('(none)');
    });

    it('should include days in uptime when >= 1 day', async () => {
      mockBotInfo.getUptime = () => 172_800_000 + 3_661_000; // 2d 1h 1m 1s
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('2d');
      expect(output).toContain('1h');
    });

    it('should omit minutes and hours when uptime is under a minute', async () => {
      mockBotInfo.getUptime = () => 45_000; // 45s
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('45s');
      expect(output).not.toContain('m ');
      expect(output).not.toContain('h ');
    });

    it('should show unknown nick when user object is absent', async () => {
      (mockClient as AdminIRCClient & { user: unknown }).user = undefined;
      const ctx = makeCtx();
      await handler.execute('.status', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('unknown');
    });

    it('should include Connection line when reconnect state is connected', async () => {
      mockBotInfo.getReconnectState = () => ({
        status: 'connected',
        lastError: null,
        lastErrorTier: null,
        consecutiveFailures: 0,
        nextAttemptAt: null,
        attemptCount: 0,
      });
      const ctx = makeCtx();
      await handler.execute('.status', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Connection: connected');
    });

    it('should show reconnecting details when in reconnecting state', async () => {
      mockBotInfo.getReconnectState = () => ({
        status: 'reconnecting',
        lastError: 'ping timeout',
        lastErrorTier: 'transient',
        consecutiveFailures: 1,
        nextAttemptAt: Date.now() + 4_000,
        attemptCount: 1,
      });
      const ctx = makeCtx();
      await handler.execute('.status', ctx);
      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Connection: reconnecting');
      expect(output).toContain('ping timeout');
      expect(output).toMatch(/next retry in \ds/);
    });

    it('should show degraded state with consecutive failure count', async () => {
      mockBotInfo.getReconnectState = () => ({
        status: 'degraded',
        lastError: 'K-Lined',
        lastErrorTier: 'rate-limited',
        consecutiveFailures: 4,
        nextAttemptAt: Date.now() + 18 * 60_000,
        attemptCount: 4,
      });
      const ctx = makeCtx();
      await handler.execute('.status', ctx);
      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Connection: degraded');
      expect(output).toContain('K-Lined');
      expect(output).toContain('4 consecutive failures');
      expect(output).toMatch(/next retry in \d+m/);
    });
  });

  describe('.uptime', () => {
    it('should reply with a colored uptime one-liner', async () => {
      const ctx = makeCtx();
      await handler.execute('.uptime', ctx);

      expect(ctx.reply).toHaveBeenCalledTimes(1);
      const output = ctx.reply.mock.calls[0][0];
      // One line, not stacked like .status
      expect(output).not.toContain('\n');
      expect(output).toMatch(/^Uptime: /);
      // Numbers are wrapped in bold+red (\x02\x0304...\x0F)
      expect(output).toContain('\x02\x03041\x0Fh');
      expect(output).toContain('\x02\x03041\x0Fm');
      expect(output).toContain('\x02\x03041\x0Fs');
      // Stripping mIRC formatting codes leaves the plain "1h 1m 1s" text
      // eslint-disable-next-line no-control-regex
      const stripped = output.replace(/\x02|\x0F|\x03\d{2}/g, '');
      expect(stripped).toBe('Uptime: 1h 1m 1s');
    });

    it('should include days when uptime >= 1 day', async () => {
      mockBotInfo.getUptime = () => 172_800_000 + 3_661_000; // 2d 1h 1m 1s
      const ctx = makeCtx();
      await handler.execute('.uptime', ctx);

      const output = ctx.reply.mock.calls[0][0];
      // eslint-disable-next-line no-control-regex
      const stripped = output.replace(/\x02|\x0F|\x03\d{2}/g, '');
      expect(stripped).toBe('Uptime: 2d 1h 1m 1s');
    });
  });

  // ---------------------------------------------------------------------------
  // Phase 4 — audit coverage for every privileged admin command
  // ---------------------------------------------------------------------------

  describe('audit coverage', () => {
    it('.say writes a row with target and message metadata', async () => {
      await handler.execute('.say #test Hello, world!', makeCtx());
      const [row] = db.getModLog({ action: 'say' });
      expect(row).toBeDefined();
      expect(row.target).toBe('#test');
      expect(row.metadata).toEqual({ message: 'Hello, world!' });
      expect(row.by).toBe('admin');
      expect(row.source).toBe('repl');
    });

    it('.msg writes a row carrying the message body', async () => {
      await handler.execute('.msg NickServ identify hunter2', makeCtx());
      const [row] = db.getModLog({ action: 'msg' });
      expect(row.target).toBe('NickServ');
      expect(row.metadata).toEqual({ message: 'identify hunter2' });
    });

    it('.join writes a row for the joined channel', async () => {
      await handler.execute('.join #newchan', makeCtx());
      const [row] = db.getModLog({ action: 'join' });
      expect(row.channel).toBe('#newchan');
    });

    it('.part writes a row with the part message in reason', async () => {
      await handler.execute('.part #oldchan goodbye for now', makeCtx());
      const [row] = db.getModLog({ action: 'part' });
      expect(row.channel).toBe('#oldchan');
      expect(row.reason).toBe('goodbye for now');
    });

    it('.part writes a row with null reason when no part message', async () => {
      await handler.execute('.part #silent', makeCtx());
      const [row] = db.getModLog({ action: 'part' });
      expect(row.reason).toBeNull();
    });

    it('.invite writes a row with channel + target nick', async () => {
      await handler.execute('.invite #vip alice', makeCtx());
      const [row] = db.getModLog({ action: 'invite' });
      expect(row.channel).toBe('#vip');
      expect(row.target).toBe('alice');
    });

    it('.say does not write a row on usage error', async () => {
      await handler.execute('.say', makeCtx());
      expect(db.getModLog({ action: 'say' })).toHaveLength(0);
    });

    it('.invite does not write a row when args are invalid', async () => {
      await handler.execute('.invite', makeCtx());
      expect(db.getModLog({ action: 'invite' })).toHaveLength(0);
    });
  });

  describe('formatUptimeColored', () => {
    // eslint-disable-next-line no-control-regex
    const strip = (s: string) => s.replace(/\x02|\x0F|\x03\d{2}/g, '');

    it('formats sub-minute uptime as just seconds', () => {
      expect(strip(formatUptimeColored(45_000))).toBe('45s');
    });

    it('wraps each numeric component in bold+red (\\x02\\x0304..\\x0F)', () => {
      // 2d 1h 1m 1s — check that each digit run has formatting around it.
      const out = formatUptimeColored(172_800_000 + 3_661_000);
      expect(out).toBe('\x02\x03042\x0Fd \x02\x03041\x0Fh \x02\x03041\x0Fm \x02\x03041\x0Fs');
    });

    it('uses two-digit color code so digits after it do not merge', () => {
      // With the one-digit form "\x034", uptime "4h" would emit "\x0344h"
      // which irc clients parse as foreground 4, background 4. Guard against
      // that regression by checking the raw bytes.
      const out = formatUptimeColored(4 * 3600 * 1000);
      expect(out).toContain('\x0304');
      // eslint-disable-next-line no-control-regex
      expect(out).not.toMatch(/\x03\d(?!\d)/);
    });
  });

  describe('formatReconnectState', () => {
    const connected: ReconnectState = {
      status: 'connected',
      lastError: null,
      lastErrorTier: null,
      consecutiveFailures: 0,
      nextAttemptAt: null,
      attemptCount: 0,
    };

    it('renders connected as a single word', () => {
      expect(formatReconnectState(connected)).toBe('connected');
    });

    it('renders stopped as a single word', () => {
      expect(formatReconnectState({ ...connected, status: 'stopped' })).toBe('stopped');
    });

    it('omits failure count when only one failure', () => {
      const state: ReconnectState = {
        status: 'reconnecting',
        lastError: 'ping timeout',
        lastErrorTier: 'transient',
        consecutiveFailures: 1,
        nextAttemptAt: Date.now() + 3_000,
        attemptCount: 1,
      };
      const output = formatReconnectState(state);
      expect(output).not.toContain('consecutive failures');
      expect(output).toContain('ping timeout');
    });

    it('omits the error label when lastError is null', () => {
      const state: ReconnectState = {
        status: 'reconnecting',
        lastError: null,
        lastErrorTier: 'transient',
        consecutiveFailures: 1,
        nextAttemptAt: Date.now() + 2_000,
        attemptCount: 1,
      };
      const output = formatReconnectState(state);
      expect(output).toMatch(/^reconnecting \(next retry in /);
    });

    it('says "retry pending" when nextAttemptAt is null', () => {
      const state: ReconnectState = {
        status: 'reconnecting',
        lastError: 'ping timeout',
        lastErrorTier: 'transient',
        consecutiveFailures: 1,
        nextAttemptAt: null,
        attemptCount: 1,
      };
      expect(formatReconnectState(state)).toContain('retry pending');
    });

    it('clamps a negative delay to 0s', () => {
      const state: ReconnectState = {
        status: 'reconnecting',
        lastError: 'ping timeout',
        lastErrorTier: 'transient',
        consecutiveFailures: 1,
        nextAttemptAt: Date.now() - 5_000,
        attemptCount: 1,
      };
      expect(formatReconnectState(state)).toContain('next retry in 0s');
    });

    it('formats delay in hours for long waits', () => {
      const state: ReconnectState = {
        status: 'degraded',
        lastError: 'K-Lined',
        lastErrorTier: 'rate-limited',
        consecutiveFailures: 5,
        nextAttemptAt: Date.now() + 2 * 60 * 60 * 1000,
        attemptCount: 5,
      };
      const output = formatReconnectState(state);
      expect(output).toMatch(/next retry in \dh/);
    });
  });
});
