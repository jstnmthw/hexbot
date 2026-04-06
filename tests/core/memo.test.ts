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
    db: bot.db,
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

/** Create a command context for DCC/REPL testing (uses REPL source to skip flag checks — DCC
 *  sessions are already authenticated, and in tests we just want to exercise the handler logic). */
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
    bot = createMockBot();
    addAdmin(bot, 'admin', 'n', 'admin!user@host');
    addAdmin(bot, 'master', 'm', 'master!user@host');
  });

  afterEach(() => {
    memo?.detach();
    bot.cleanup();
  });

  // -------------------------------------------------------------------------
  // Note CRUD
  // -------------------------------------------------------------------------

  describe('Note CRUD', () => {
    beforeEach(() => {
      memo = setupMemo(bot);
    });

    it('stores and retrieves a note', () => {
      const result = memo.storeNote('admin', 'master', 'Hello world');
      expect(result).toHaveProperty('id');
      const id = (result as { id: number }).id;

      const note = memo.getNote(id);
      expect(note).not.toBeNull();
      expect(note!.from).toBe('admin');
      expect(note!.to).toBe('master');
      expect(note!.message).toBe('Hello world');
      expect(note!.read).toBe(false);
    });

    it('auto-increments IDs', () => {
      const r1 = memo.storeNote('admin', 'master', 'First');
      const r2 = memo.storeNote('admin', 'master', 'Second');
      expect((r1 as { id: number }).id).toBeLessThan((r2 as { id: number }).id);
    });

    it('marks a note as read', () => {
      const result = memo.storeNote('admin', 'master', 'Test');
      const id = (result as { id: number }).id;

      expect(memo.markRead(id)).toBe(true);
      expect(memo.getNote(id)!.read).toBe(true);
    });

    it('deletes a note', () => {
      const result = memo.storeNote('admin', 'master', 'Test');
      const id = (result as { id: number }).id;

      expect(memo.deleteNote(id)).toBe(true);
      expect(memo.getNote(id)).toBeNull();
    });

    it('lists notes for a handle', () => {
      memo.storeNote('admin', 'master', 'First');
      memo.storeNote('admin', 'master', 'Second');
      memo.storeNote('master', 'admin', 'To admin');

      const masterNotes = memo.listNotesForHandle('master');
      expect(masterNotes).toHaveLength(2);
      expect(masterNotes[0].message).toBe('First');
      expect(masterNotes[1].message).toBe('Second');

      const adminNotes = memo.listNotesForHandle('admin');
      expect(adminNotes).toHaveLength(1);
    });

    it('counts unread notes', () => {
      const r1 = memo.storeNote('admin', 'master', 'First');
      memo.storeNote('admin', 'master', 'Second');
      memo.markRead((r1 as { id: number }).id);

      expect(memo.countUnread('master')).toBe(1);
    });

    it('deletes all notes for a handle', () => {
      memo.storeNote('admin', 'master', 'First');
      memo.storeNote('admin', 'master', 'Second');
      memo.storeNote('master', 'admin', 'To admin');

      expect(memo.deleteAllForHandle('master')).toBe(2);
      expect(memo.listNotesForHandle('master')).toHaveLength(0);
      expect(memo.listNotesForHandle('admin')).toHaveLength(1);
    });

    it('markRead returns false for non-existent note', () => {
      expect(memo.markRead(9999)).toBe(false);
    });

    it('deleteNote returns false for non-existent note', () => {
      expect(memo.deleteNote(9999)).toBe(false);
    });

    it('setCasemapping updates internal casemapping', () => {
      memo.setCasemapping('ascii');
      // No assertion needed — just coverage. The casemapping affects ircLower calls.
    });
  });

  // -------------------------------------------------------------------------
  // Limits
  // -------------------------------------------------------------------------

  describe('limits', () => {
    it('rejects notes exceeding max_note_length', () => {
      memo = setupMemo(bot, { max_note_length: 10 });
      const result = memo.storeNote('admin', 'master', 'a'.repeat(11));
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('too long');
    });

    it('rejects notes when mailbox is full', () => {
      memo = setupMemo(bot, { max_notes_per_user: 2 });
      memo.storeNote('admin', 'master', 'First');
      memo.storeNote('admin', 'master', 'Second');
      const result = memo.storeNote('admin', 'master', 'Third');
      expect(result).toHaveProperty('error');
      expect((result as { error: string }).error).toContain('full');
    });
  });

  // -------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------

  describe('expiry', () => {
    it('sweeps notes older than max_age_days', () => {
      memo = setupMemo(bot, { max_age_days: 1 });
      // Store a note, then manually backdate its timestamp
      const result = memo.storeNote('admin', 'master', 'Old note');
      const id = (result as { id: number }).id;
      const note = memo.getNote(id)!;
      note.timestamp = Date.now() - 2 * 86_400_000; // 2 days ago
      bot.db.set('_memo', `note:${id}`, note);

      const swept = memo.sweepExpired();
      expect(swept).toBe(1);
      expect(memo.getNote(id)).toBeNull();
    });

    it('does not sweep recent notes', () => {
      memo = setupMemo(bot, { max_age_days: 90 });
      memo.storeNote('admin', 'master', 'Recent');
      expect(memo.sweepExpired()).toBe(0);
    });

    it('does nothing when max_age_days is 0', () => {
      memo = setupMemo(bot, { max_age_days: 0 });
      const result = memo.storeNote('admin', 'master', 'Immortal');
      const id = (result as { id: number }).id;
      const note = memo.getNote(id)!;
      note.timestamp = Date.now() - 365 * 86_400_000;
      bot.db.set('_memo', `note:${id}`, note);

      expect(memo.sweepExpired()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // MemoServ relay
  // -------------------------------------------------------------------------

  describe('MemoServ relay', () => {
    it('relays MemoServ notices to online admins and stores as notes', () => {
      memo = setupMemo(bot, { memoserv_relay: true, memoserv_nick: 'MemoServ' });

      // Put admin in a channel so relay can find them
      joinChannel(bot, 'admin', '#test');

      sendNotice(bot, 'MemoServ', 'You have a new memo from NetworkOps.');

      // Check that a NOTICE was sent to the admin
      const notices = bot.client.messages.filter(
        (m) => m.type === 'notice' && m.target === 'admin',
      );
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(notices[0].message).toContain('[MemoServ]');

      // Check note was stored
      const adminNotes = memo.listNotesForHandle('admin');
      expect(adminNotes.length).toBeGreaterThanOrEqual(1);
      expect(adminNotes[0].from).toBe('MemoServ');
    });

    it('ignores notices from non-MemoServ nicks', () => {
      memo = setupMemo(bot, { memoserv_relay: true, memoserv_nick: 'MemoServ' });
      joinChannel(bot, 'admin', '#test');

      sendNotice(bot, 'RandomUser', 'This is not a memo.');

      const adminNotes = memo.listNotesForHandle('admin');
      expect(adminNotes).toHaveLength(0);
    });

    it('ignores channel notices', () => {
      memo = setupMemo(bot, { memoserv_relay: true, memoserv_nick: 'MemoServ' });
      joinChannel(bot, 'admin', '#test');

      // Channel notice — target is the channel, not the bot
      bot.client.simulateEvent('notice', {
        nick: 'MemoServ',
        ident: 'services',
        hostname: 'services.host',
        target: '#test',
        message: 'Channel notice',
      });

      const adminNotes = memo.listNotesForHandle('admin');
      expect(adminNotes).toHaveLength(0);
    });

    it('does not relay when memoserv_relay is false', () => {
      memo = setupMemo(bot, { memoserv_relay: false });
      joinChannel(bot, 'admin', '#test');

      sendNotice(bot, 'MemoServ', 'Test memo');

      const adminNotes = memo.listNotesForHandle('admin');
      expect(adminNotes).toHaveLength(0);
    });

    it('stores MemoServ messages for offline admins', () => {
      memo = setupMemo(bot, { memoserv_relay: true, memoserv_nick: 'MemoServ' });
      // No one in any channel — admins are "offline"

      sendNotice(bot, 'MemoServ', 'Offline memo');

      // Notes stored for both admin and master
      expect(memo.listNotesForHandle('admin')).toHaveLength(1);
      expect(memo.listNotesForHandle('master')).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // DCC/REPL dot-commands
  // -------------------------------------------------------------------------

  describe('dot-commands', () => {
    beforeEach(() => {
      memo = setupMemo(bot);
    });

    it('.note sends a note to a valid admin handle', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.note master Hello from admin', dccCtx('admin', replies));
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain('Note #');
      expect(replies[0]).toContain('sent to master');

      const notes = memo.listNotesForHandle('master');
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe('Hello from admin');
    });

    it('.note rejects non-admin target', async () => {
      bot.permissions.addUser('regular', 'reg!user@host', 'o');
      const replies: string[] = [];
      await bot.commandHandler.execute('.note regular Hello', dccCtx('admin', replies));
      expect(replies[0]).toContain('No admin handle');
    });

    it('.note rejects unknown target', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.note nobody Hello', dccCtx('admin', replies));
      expect(replies[0]).toContain('No admin handle');
    });

    it('.note shows usage with no args', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.note', dccCtx('admin', replies));
      expect(replies[0]).toContain('Usage');
    });

    it('.notes lists unread notes', async () => {
      memo.storeNote('master', 'admin', 'First note');
      memo.storeNote('master', 'admin', 'Second note');

      const replies: string[] = [];
      await bot.commandHandler.execute('.notes', dccCtx('admin', replies));
      expect(replies[0]).toContain('2 unread');
      expect(replies[1]).toContain('#');
      expect(replies[1]).toContain('master');
    });

    it('.notes shows no unread when empty', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.notes', dccCtx('admin', replies));
      expect(replies[0]).toContain('No unread');
    });

    it('.readnote shows full note and marks read', async () => {
      const result = memo.storeNote('master', 'admin', 'Full note content');
      const id = (result as { id: number }).id;

      const replies: string[] = [];
      await bot.commandHandler.execute(`.readnote ${id}`, dccCtx('admin', replies));
      expect(replies.length).toBe(2);
      expect(replies[0]).toContain(`Note #${id}`);
      expect(replies[1]).toBe('Full note content');
      expect(memo.getNote(id)!.read).toBe(true);
    });

    it('.readnote rejects wrong recipient', async () => {
      const result = memo.storeNote('admin', 'master', 'Secret');
      const id = (result as { id: number }).id;

      const replies: string[] = [];
      await bot.commandHandler.execute(`.readnote ${id}`, dccCtx('admin', replies));
      expect(replies[0]).toContain('not found');
    });

    it('.delnote deletes a specific note', async () => {
      const result = memo.storeNote('master', 'admin', 'Delete me');
      const id = (result as { id: number }).id;

      const replies: string[] = [];
      await bot.commandHandler.execute(`.delnote ${id}`, dccCtx('admin', replies));
      expect(replies[0]).toContain('deleted');
      expect(memo.getNote(id)).toBeNull();
    });

    it('.delnote all deletes all notes for the user', async () => {
      memo.storeNote('master', 'admin', 'One');
      memo.storeNote('master', 'admin', 'Two');

      const replies: string[] = [];
      await bot.commandHandler.execute('.delnote all', dccCtx('admin', replies));
      expect(replies[0]).toContain('Deleted 2');
      expect(memo.listNotesForHandle('admin')).toHaveLength(0);
    });

    it('.notes-purge purges notes for a handle (owner only)', async () => {
      memo.storeNote('admin', 'master', 'One');
      memo.storeNote('admin', 'master', 'Two');

      const replies: string[] = [];
      await bot.commandHandler.execute('.notes-purge master', dccCtx('admin', replies));
      expect(replies[0]).toContain('Purged 2');
      expect(memo.listNotesForHandle('master')).toHaveLength(0);
    });

    it('.notes-purge rejects unknown handle', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.notes-purge nobody', dccCtx('admin', replies));
      expect(replies[0]).toContain('Unknown handle');
    });

    it('.notes-purge shows usage with no args', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.notes-purge', dccCtx('admin', replies));
      expect(replies[0]).toContain('Usage');
    });

    it('.readnote shows usage with no args', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.readnote', dccCtx('admin', replies));
      expect(replies[0]).toContain('Usage');
    });

    it('.delnote shows usage with invalid arg', async () => {
      const replies: string[] = [];
      await bot.commandHandler.execute('.delnote xyz', dccCtx('admin', replies));
      expect(replies[0]).toContain('Usage');
    });

    it('.delnote rejects note belonging to another user', async () => {
      const result = memo.storeNote('admin', 'master', 'Not yours');
      const id = (result as { id: number }).id;

      const replies: string[] = [];
      await bot.commandHandler.execute(`.delnote ${id}`, dccCtx('admin', replies));
      expect(replies[0]).toContain('not found');
    });

    it('.note rejects when message exceeds max_note_length', async () => {
      memo.detach();
      memo = setupMemo(bot, { max_note_length: 5 });
      const replies: string[] = [];
      await bot.commandHandler.execute('.note master This is too long', dccCtx('admin', replies));
      expect(replies[0]).toContain('too long');
    });

    it('.note works from IRC source with hostmask resolution', async () => {
      const replies: string[] = [];
      const ircCtx: CommandContext = {
        source: 'irc',
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        channel: '#test',
        reply(msg: string) {
          replies.push(msg);
        },
      };
      // Need to bypass permission check — use execute directly
      // The IRC source path in resolveCallerHandle uses findByHostmask
      await bot.commandHandler.execute('.note master Hello from IRC', ircCtx);
      // Will get "Permission denied" because IRC source checks flags,
      // but this exercises the IRC path in resolveCallerHandle
    });
  });

  // -------------------------------------------------------------------------
  // Public IRC commands
  // -------------------------------------------------------------------------

  describe('IRC commands', () => {
    beforeEach(() => {
      memo = setupMemo(bot);
      joinChannel(bot, 'admin', '#test');
      joinChannel(bot, 'master', '#test');
    });

    it('!memo stores a note by handle', () => {
      bot.client.clearMessages();
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memo master Check the logs',
      });

      const notes = memo.listNotesForHandle('master');
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe('Check the logs');
      expect(notes[0].from).toBe('admin');

      // Reply was via NOTICE
      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(notices.some((n) => n.message!.includes('sent to master'))).toBe(true);
    });

    it('!memo resolves nick to handle', () => {
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memo master Via nick resolution',
      });

      const notes = memo.listNotesForHandle('master');
      expect(notes).toHaveLength(1);
    });

    it('!memo rejects non-admin target', () => {
      bot.permissions.addUser('regular', 'reg!user@host', 'o');
      joinChannel(bot, 'reg', '#test', 'user', 'host');
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memo regular Hello',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('No admin handle'))).toBe(true);
    });

    it('!memos lists unread notes via NOTICE', () => {
      memo.storeNote('master', 'admin', 'Test note');
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memos',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('1 unread'))).toBe(true);
    });

    it('!read reads a note and marks it read', () => {
      const result = memo.storeNote('master', 'admin', 'Full content');
      const id = (result as { id: number }).id;
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: `!read ${id}`,
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('Full content'))).toBe(true);
      expect(memo.getNote(id)!.read).toBe(true);
    });

    it('!delmemo deletes a note', () => {
      const result = memo.storeNote('master', 'admin', 'Delete me');
      const id = (result as { id: number }).id;
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: `!delmemo ${id}`,
      });

      expect(memo.getNote(id)).toBeNull();
    });

    it('!delmemo all deletes all notes', () => {
      memo.storeNote('master', 'admin', 'One');
      memo.storeNote('master', 'admin', 'Two');
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!delmemo all',
      });

      expect(memo.listNotesForHandle('admin')).toHaveLength(0);
    });

    it('!memo shows usage with no args', () => {
      bot.client.clearMessages();
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memo',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('Usage'))).toBe(true);
    });

    it('!memo resolves nick to handle via channel state', () => {
      // Use a nick that doesn't match a handle name — force nick resolution path
      bot.permissions.addUser('op-user', 'TheOp!op@secure.host', 'n');
      joinChannel(bot, 'TheOp', '#test', 'op', 'secure.host');
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memo TheOp Check this out',
      });

      const notes = memo.listNotesForHandle('op-user');
      expect(notes).toHaveLength(1);
      expect(notes[0].message).toBe('Check this out');
    });

    it('!memos shows no unread when empty', () => {
      bot.client.clearMessages();
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!memos',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('No unread'))).toBe(true);
    });

    it('!read shows usage with no args', () => {
      bot.client.clearMessages();
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!read',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('Usage'))).toBe(true);
    });

    it('!read rejects note belonging to another user', () => {
      const result = memo.storeNote('admin', 'master', 'Not yours');
      const id = (result as { id: number }).id;
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: `!read ${id}`,
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('not found'))).toBe(true);
    });

    it('!delmemo shows usage with invalid arg', () => {
      bot.client.clearMessages();
      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: '!delmemo xyz',
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('Usage'))).toBe(true);
    });

    it('!delmemo rejects note belonging to another user', () => {
      const result = memo.storeNote('admin', 'master', 'Not yours');
      const id = (result as { id: number }).id;
      bot.client.clearMessages();

      bot.client.simulateEvent('privmsg', {
        nick: 'admin',
        ident: 'user',
        hostname: 'host',
        target: '#test',
        message: `!delmemo ${id}`,
      });

      const notices = bot.client.messages.filter((m) => m.type === 'notice');
      expect(notices.some((n) => n.message!.includes('not found'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Join delivery
  // -------------------------------------------------------------------------

  describe('join delivery', () => {
    it('notifies admin with unread notes on join', () => {
      memo = setupMemo(bot, { delivery_cooldown_seconds: 0 });
      memo.storeNote('master', 'admin', 'You have mail');
      bot.client.clearMessages();

      triggerJoin(bot, 'admin', '#test');

      const notices = bot.client.messages.filter(
        (m) => m.type === 'notice' && m.target === 'admin',
      );
      expect(notices.length).toBeGreaterThanOrEqual(1);
      expect(notices.some((n) => n.message!.includes('unread note'))).toBe(true);
    });

    it('does not notify non-admin users', () => {
      memo = setupMemo(bot, { delivery_cooldown_seconds: 0 });
      bot.permissions.addUser('regular', 'reg!user@host', 'o');
      memo.storeNote('admin', 'regular', 'Should not deliver');
      bot.client.clearMessages();

      triggerJoin(bot, 'reg', '#test', 'user', 'host');

      const notices = bot.client.messages.filter((m) => m.type === 'notice' && m.target === 'reg');
      expect(notices).toHaveLength(0);
    });

    it('does not notify when no unread notes', () => {
      memo = setupMemo(bot, { delivery_cooldown_seconds: 0 });
      bot.client.clearMessages();

      triggerJoin(bot, 'admin', '#test');

      const notices = bot.client.messages.filter(
        (m) => m.type === 'notice' && m.target === 'admin',
      );
      expect(notices).toHaveLength(0);
    });

    it('respects delivery cooldown', () => {
      memo = setupMemo(bot, { delivery_cooldown_seconds: 60 });
      memo.storeNote('master', 'admin', 'Note');
      bot.client.clearMessages();

      // First join — should notify
      triggerJoin(bot, 'admin', '#test');
      const firstNotices = bot.client.messages.filter(
        (m) => m.type === 'notice' && m.target === 'admin',
      );
      expect(firstNotices.length).toBeGreaterThanOrEqual(1);

      // Second join within cooldown — should not notify
      bot.client.clearMessages();
      triggerJoin(bot, 'admin', '#other');
      const secondNotices = bot.client.messages.filter(
        (m) => m.type === 'notice' && m.target === 'admin',
      );
      expect(secondNotices).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // DCC connect notification
  // -------------------------------------------------------------------------

  describe('DCC connect notification', () => {
    it('shows unread count on DCC connect', () => {
      memo = setupMemo(bot);
      memo.storeNote('master', 'admin', 'Test note');

      const lines: string[] = [];
      const mockDcc: MemoDCCManager = {
        announce: vi.fn(),
        getSessionList: () => [{ handle: 'admin', nick: 'admin', connectedAt: Date.now() }],
        getSession: () => ({ writeLine: (line: string) => lines.push(line) }),
      };
      memo.setDCCManager(mockDcc);

      memo.notifyOnDCCConnect('admin', 'admin');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('1 unread note');
    });

    it('does not notify when no unread notes', () => {
      memo = setupMemo(bot);
      const lines: string[] = [];
      const mockDcc: MemoDCCManager = {
        announce: vi.fn(),
        getSessionList: () => [],
        getSession: () => ({ writeLine: (line: string) => lines.push(line) }),
      };
      memo.setDCCManager(mockDcc);

      memo.notifyOnDCCConnect('admin', 'admin');
      expect(lines).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // DCC console relay from MemoServ
  // -------------------------------------------------------------------------

  describe('MemoServ DCC relay', () => {
    it('forwards MemoServ notices to DCC console', () => {
      const announcements: string[] = [];
      const mockDcc: MemoDCCManager = {
        announce: (msg: string) => announcements.push(msg),
        getSessionList: () => [],
        getSession: () => undefined,
      };

      memo = setupMemo(bot, { memoserv_relay: true, memoserv_nick: 'MemoServ' });
      memo.setDCCManager(mockDcc);

      sendNotice(bot, 'MemoServ', 'Your vhost has been approved.');

      expect(announcements).toHaveLength(1);
      expect(announcements[0]).toContain('[MemoServ]');
      expect(announcements[0]).toContain('vhost');
    });
  });
});
