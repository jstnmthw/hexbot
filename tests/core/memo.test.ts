import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CommandContext } from '../../src/command-handler';
import { MemoManager } from '../../src/core/memo';
import type { MemoDCCManager } from '../../src/core/memo';
import { type MockBot, createMockBot } from '../helpers/mock-bot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupMemo(bot: MockBot, config?: Record<string, unknown>): MemoManager {
  const memo = new MemoManager({
    config: config as never,
    dispatcher: bot.dispatcher,
    commandHandler: bot.commandHandler,
    permissions: bot.permissions,
    channelState: bot.channelState,
    client: bot.client,
    logger: bot.logger,
  });
  memo.attach();
  return memo;
}

/** Create an admin user record in the permissions DB. */
function addAdmin(bot: MockBot, handle: string, flags: string, hostmask = `${handle}!user@host`) {
  bot.permissions.addUser(handle, hostmask, flags);
}

/** Put a user in a channel (for channel state lookups). */
function joinChannel(
  bot: MockBot,
  nick: string,
  channel: string,
  ident = 'user',
  hostname = 'host',
) {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel, account: undefined });
}

/** Create a command context for DCC/REPL testing. */
function dccCtx(nick: string, replies: string[]): CommandContext {
  return {
    source: 'repl',
    nick,
    channel: null,
    reply(msg: string) {
      replies.push(msg);
    },
  };
}

/** Simulate a private notice from a specific nick (e.g. MemoServ). */
function sendNotice(bot: MockBot, nick: string, message: string) {
  bot.client.simulateEvent('notice', {
    nick,
    ident: 'services',
    hostname: 'services.host',
    target: 'testbot',
    message,
  });
}

/** Simulate a user joining a channel (triggers dispatcher join bind). */
function triggerJoin(
  bot: MockBot,
  nick: string,
  channel: string,
  ident = 'user',
  hostname = 'host',
) {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel, account: undefined });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoManager', () => {
  let bot: MockBot;
  let memo: MemoManager;

  beforeEach(() => {
    vi.useFakeTimers();
    bot = createMockBot();
    addAdmin(bot, 'admin', 'n', 'admin!user@host');
    addAdmin(bot, 'master', 'm', 'master!user@host');
  });

  afterEach(() => {
    memo?.detach();
    bot.cleanup();
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // MemoServ relay
  // -------------------------------------------------------------------------

  describe('MemoServ relay', () => {
    it('relays unsolicited notices to online admins via NOTICE', () => {
      memo = setupMemo(bot);
      joinChannel(bot, 'admin', '#test');
      bot.client.messages.length = 0;

      sendNotice(bot, 'MemoServ', 'You have 1 new memo.');

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].target).toBe('admin');
      expect(notices[0].message).toContain('[MemoServ] You have 1 new memo.');
    });

    it('does not duplicate MemoServ notices to DCC console (generic mirror handles it)', () => {
      memo = setupMemo(bot);
      const announced: string[] = [];
      memo.setDCCManager({
        announce: (msg) => announced.push(msg),
        getSessionList: () => [],
        getSession: () => undefined,
      });

      sendNotice(bot, 'MemoServ', 'You have 2 new memos.');

      expect(announced).toHaveLength(0);
    });

    it('ignores notices from non-MemoServ nicks', () => {
      memo = setupMemo(bot);
      joinChannel(bot, 'admin', '#test');
      bot.client.messages.length = 0;

      sendNotice(bot, 'NickServ', 'Some message');

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(0);
    });

    it('parses "You have N new memo(s)" to update pendingMemoCount', () => {
      memo = setupMemo(bot);

      sendNotice(bot, 'MemoServ', 'You have 3 new memos.');
      expect(memo.pendingMemoCount).toBe(3);

      sendNotice(bot, 'MemoServ', 'You have 1 new memo.');
      expect(memo.pendingMemoCount).toBe(1);
    });

    it('does not update pendingMemoCount for non-count messages', () => {
      memo = setupMemo(bot);

      sendNotice(bot, 'MemoServ', 'Type /msg MemoServ READ LAST to read it.');
      expect(memo.pendingMemoCount).toBe(0);
    });

    it('ignores channel notices', () => {
      memo = setupMemo(bot);
      joinChannel(bot, 'admin', '#test');
      bot.client.messages.length = 0;

      bot.client.simulateEvent('notice', {
        nick: 'MemoServ',
        ident: 'services',
        hostname: 'services.host',
        target: '#test',
        message: 'You have 1 new memo.',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(0);
    });

    it('can be disabled via config', () => {
      memo = setupMemo(bot, { memoserv_relay: false });
      joinChannel(bot, 'admin', '#test');
      bot.client.messages.length = 0;

      sendNotice(bot, 'MemoServ', 'You have 1 new memo.');

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // .memo command
  // -------------------------------------------------------------------------

  describe('.memo command', () => {
    it('no args with pending memos → shows count', async () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 5;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo', dccCtx('admin', replies));

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('5 unread memo(s)');
    });

    it('no args with zero pending → shows no memos', async () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo', dccCtx('admin', replies));

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('No pending memos');
    });

    it('help → shows subcommand list', async () => {
      memo = setupMemo(bot);

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo help', dccCtx('admin', replies));

      expect(replies.length).toBeGreaterThan(1);
      expect(replies[0]).toContain('MemoServ proxy commands');
      expect(replies.some((r) => r.includes('.memo read'))).toBe(true);
      expect(replies.some((r) => r.includes('.memo send'))).toBe(true);
      expect(replies.some((r) => r.includes('.memo list'))).toBe(true);
      expect(replies.some((r) => r.includes('.memo del'))).toBe(true);
    });

    it('read (no arg) → sends /msg MemoServ READ LAST', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo read', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].target).toBe('MemoServ');
      expect(says[0].message).toBe('READ LAST');
    });

    it('read new → sends /msg MemoServ READ NEW', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo read new', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].message).toBe('READ NEW');
    });

    it('read <id> → sends /msg MemoServ READ <ID>', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo read 3', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].message).toBe('READ 3');
    });

    it('read resets pendingMemoCount', async () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 5;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo read', dccCtx('admin', replies));

      expect(memo.pendingMemoCount).toBe(0);
    });

    it('list → sends /msg MemoServ LIST', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo list', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].target).toBe('MemoServ');
      expect(says[0].message).toBe('LIST');
    });

    it('list resets pendingMemoCount', async () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 3;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo list', dccCtx('admin', replies));

      expect(memo.pendingMemoCount).toBe(0);
    });

    it('del <id> → sends /msg MemoServ DEL <ID>', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo del 2', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].message).toBe('DEL 2');
    });

    it('del all → sends /msg MemoServ DEL ALL', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo del all', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].message).toBe('DEL ALL');
    });

    it('del with no arg → shows usage', async () => {
      memo = setupMemo(bot);

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo del', dccCtx('admin', replies));

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Usage');
    });

    it('send <nick> <message> → sends /msg MemoServ SEND', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo send d3m0n hello there', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].target).toBe('MemoServ');
      expect(says[0].message).toBe('SEND d3m0n hello there');
    });

    it('send with missing args → shows usage', async () => {
      memo = setupMemo(bot);

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo send d3m0n', dccCtx('admin', replies));

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Usage');
    });

    it('info → sends /msg MemoServ INFO', async () => {
      memo = setupMemo(bot);
      bot.client.messages.length = 0;

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo info', dccCtx('admin', replies));

      const says = bot.client.messages.filter((m) => m.type === 'say');
      expect(says).toHaveLength(1);
      expect(says[0].message).toBe('INFO');
    });

    it('unknown subcommand → shows error', async () => {
      memo = setupMemo(bot);

      const replies: string[] = [];
      await bot.commandHandler.execute('.memo bogus', dccCtx('admin', replies));

      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Unknown memo subcommand');
    });
  });

  // -------------------------------------------------------------------------
  // Join delivery
  // -------------------------------------------------------------------------

  describe('Join delivery', () => {
    it('notifies admin with pending memos on join', () => {
      memo = setupMemo(bot);
      joinChannel(bot, 'admin', '#test'); // seed channel state
      memo.pendingMemoCount = 2;
      bot.client.messages.length = 0;

      triggerJoin(bot, 'admin', '#other');

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(1);
      expect(notices[0].target).toBe('admin');
      expect(notices[0].message).toContain('2 unread memo(s)');
    });

    it('does not notify when pendingMemoCount is 0', () => {
      memo = setupMemo(bot);
      joinChannel(bot, 'admin', '#test');
      memo.pendingMemoCount = 0;
      bot.client.messages.length = 0;

      triggerJoin(bot, 'admin', '#other');

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(0);
    });

    it('does not notify non-admin users', () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 5;
      bot.permissions.addUser('regular', 'regular!user@host', 'o');
      joinChannel(bot, 'regular', '#test');
      bot.client.messages.length = 0;

      triggerJoin(bot, 'regular', '#other');

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices).toHaveLength(0);
    });

    it('respects cooldown between join notifications', () => {
      memo = setupMemo(bot, { delivery_cooldown_seconds: 60 });
      joinChannel(bot, 'admin', '#test');
      memo.pendingMemoCount = 2;
      bot.client.messages.length = 0;

      triggerJoin(bot, 'admin', '#chan1');

      const first = bot.client.messages.filter((m) => m.type === 'notice');
      expect(first).toHaveLength(1);
      bot.client.messages.length = 0;

      // Within cooldown
      vi.advanceTimersByTime(10_000);
      triggerJoin(bot, 'admin', '#chan2');

      const second = bot.client.messages.filter((m) => m.type === 'notice');
      expect(second).toHaveLength(0);

      // After cooldown
      vi.advanceTimersByTime(60_000);
      triggerJoin(bot, 'admin', '#chan3');

      const third = bot.client.messages.filter((m) => m.type === 'notice');
      expect(third).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // DCC connect notification
  // -------------------------------------------------------------------------

  describe('DCC connect notification', () => {
    it('shows pending count on connect', () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 3;

      const lines: string[] = [];
      const dcc: MemoDCCManager = {
        announce: () => {},
        getSessionList: () => [],
        getSession: (nick) =>
          nick === 'admin' ? { writeLine: (l: string) => lines.push(l) } : undefined,
      };
      memo.setDCCManager(dcc);

      memo.notifyOnDCCConnect('admin', 'admin');

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('3 unread memo(s)');
      expect(lines[0]).toContain('.memo');
    });

    it('no message if pendingMemoCount is 0', () => {
      memo = setupMemo(bot);
      memo.pendingMemoCount = 0;

      const lines: string[] = [];
      const dcc: MemoDCCManager = {
        announce: () => {},
        getSessionList: () => [],
        getSession: () => ({ writeLine: (l: string) => lines.push(l) }),
      };
      memo.setDCCManager(dcc);

      memo.notifyOnDCCConnect('admin', 'admin');

      expect(lines).toHaveLength(0);
    });
  });
});
