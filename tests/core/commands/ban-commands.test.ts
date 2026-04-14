// Tests for .bans, .ban, .unban, .stick, .unstick admin commands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../../src/command-handler';
import type { CommandContext } from '../../../src/command-handler';
import { BanStore } from '../../../src/core/ban-store';
import { registerBanCommands } from '../../../src/core/commands/ban-commands';
import type { BanOperator } from '../../../src/core/irc-commands';
import { Permissions } from '../../../src/core/permissions';
import { BotDatabase } from '../../../src/database';
import { createLogger } from '../../../src/logger';

function makeReply(): { reply: ReturnType<typeof vi.fn>; ctx: CommandContext } {
  const reply = vi.fn();
  const ctx: CommandContext = {
    nick: 'Admin',
    ident: 'admin',
    hostname: 'admin.host',
    channel: null,
    source: 'repl',
    reply,
  };
  return { reply, ctx };
}

describe('ban admin commands', () => {
  let db: BotDatabase;
  let banStore: BanStore;
  let commandHandler: CommandHandler;
  let banSpy: BanOperator['ban'];
  let unbanSpy: BanOperator['unban'];

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    banStore = new BanStore(db, (s) => s.toLowerCase());
    const perms = new Permissions(db, createLogger('error'));
    perms.loadFromDb();
    commandHandler = new CommandHandler(perms);
    banSpy = vi.fn();
    unbanSpy = vi.fn();
    registerBanCommands({
      commandHandler,
      banStore,
      ircCommands: { ban: banSpy, unban: unbanSpy },
      db,
      hub: null,
      sharedBanList: null,
      ircLower: (s: string) => s.toLowerCase(),
    });
  });

  afterEach(() => {
    db.close();
  });

  // -----------------------------------------------------------------------
  // .bans
  // -----------------------------------------------------------------------

  describe('.bans', () => {
    it('reports no bans when empty', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.bans', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('No tracked bans'));
    });

    it('lists all bans across channels', async () => {
      banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
      banStore.storeBan('#other', '*!*@bad.com', 'admin', 1_800_000);
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.bans', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Channel bans (2)'));
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('*!*@evil.com'));
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('*!*@bad.com'));
    });

    it('filters by channel when specified', async () => {
      banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
      banStore.storeBan('#other', '*!*@bad.com', 'admin', 0);
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.bans #test', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Channel bans (1)'));
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('*!*@evil.com'));
      expect(reply).not.toHaveBeenCalledWith(expect.stringContaining('*!*@bad.com'));
    });

    it('includes shared-only bans tagged [shared]', async () => {
      // Register with a mock shared ban list
      const db2 = new BotDatabase(':memory:');
      db2.open();
      const bs2 = new BanStore(db2, (s) => s.toLowerCase());
      const perms2 = new Permissions(db2, createLogger('error'));
      perms2.loadFromDb();
      const ch2 = new CommandHandler(perms2);
      const mockSharedBanList = {
        getBans: (ch: string) =>
          ch === '#test' ? [{ mask: '*!*@shared.host', setBy: 'hub2', setAt: Date.now() }] : [],
        getChannels: () => ['#test'],
      };
      registerBanCommands({
        commandHandler: ch2,
        banStore: bs2,
        ircCommands: { ban: vi.fn(), unban: vi.fn() },
        db: db2,
        hub: null,
        sharedBanList: mockSharedBanList as never,
        ircLower: (s: string) => s.toLowerCase(),
      });
      const { reply, ctx } = makeReply();
      await ch2.execute('.bans', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('[shared]'));
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('*!*@shared.host'));
      db2.close();
    });

    it('shows sticky tag for sticky bans', async () => {
      banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
      banStore.setSticky('#test', '*!*@evil.com', true);
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.bans', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('[sticky]'));
    });
  });

  // -----------------------------------------------------------------------
  // .ban
  // -----------------------------------------------------------------------

  describe('.ban', () => {
    it('stores ban and calls ircCommands.ban()', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.ban #test *!*@evil.com 30m', ctx);
      expect(banSpy).toHaveBeenCalledWith('#test', '*!*@evil.com');
      const ban = banStore.getBan('#test', '*!*@evil.com');
      expect(ban).not.toBeNull();
      expect(ban!.expires).toBeGreaterThan(0);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Banned'));
    });

    it('defaults to permanent when no duration given', async () => {
      const { ctx } = makeReply();
      await commandHandler.execute('.ban #test *!*@evil.com', ctx);
      const ban = banStore.getBan('#test', '*!*@evil.com');
      expect(ban!.expires).toBe(0);
    });

    it('shows usage when args missing', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.ban', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('shows usage when channel is missing #', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.ban test *!*@evil.com', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('rejects ban mask longer than 200 chars', async () => {
      const { reply, ctx } = makeReply();
      const longMask = '*!*@' + 'a'.repeat(200);
      await commandHandler.execute(`.ban #test ${longMask}`, ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('too long'));
      expect(banSpy).not.toHaveBeenCalled();
    });

    it('broadcasts CHAN_BAN_ADD when hub is present', async () => {
      const db2 = new BotDatabase(':memory:');
      db2.open();
      const bs2 = new BanStore(db2, (s) => s.toLowerCase());
      const perms2 = new Permissions(db2, createLogger('error'));
      perms2.loadFromDb();
      const ch2 = new CommandHandler(perms2);
      const broadcastSpy = vi.fn();
      const mockHub = { broadcast: broadcastSpy } as never;
      registerBanCommands({
        commandHandler: ch2,
        banStore: bs2,
        ircCommands: { ban: vi.fn(), unban: vi.fn() },
        db: db2,
        hub: mockHub,
        sharedBanList: null,
        ircLower: (s: string) => s.toLowerCase(),
      });
      const { ctx } = makeReply();
      await ch2.execute('.ban #test *!*@evil.com', ctx);
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CHAN_BAN_ADD', channel: '#test', mask: '*!*@evil.com' }),
      );
      db2.close();
    });

    it('logs mod action', async () => {
      const { reply: _, ctx } = makeReply();
      await commandHandler.execute('.ban #test *!*@evil.com 1h bad user', ctx);
      const log = db.getModLog({ action: 'ban' });
      expect(log).toHaveLength(1);
      expect(log[0].channel).toBe('#test');
      expect(log[0].target).toBe('*!*@evil.com');
      expect(log[0].reason).toBe('bad user');
    });
  });

  // -----------------------------------------------------------------------
  // .unban
  // -----------------------------------------------------------------------

  describe('.unban', () => {
    it('removes ban and calls ircCommands.unban()', async () => {
      banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.unban #test *!*@evil.com', ctx);
      expect(unbanSpy).toHaveBeenCalledWith('#test', '*!*@evil.com');
      expect(banStore.getBan('#test', '*!*@evil.com')).toBeNull();
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Unbanned'));
    });

    it('shows usage when args missing', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.unban', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('broadcasts CHAN_BAN_DEL when hub is present', async () => {
      const db2 = new BotDatabase(':memory:');
      db2.open();
      const bs2 = new BanStore(db2, (s) => s.toLowerCase());
      bs2.storeBan('#test', '*!*@evil.com', 'admin', 0);
      const perms2 = new Permissions(db2, createLogger('error'));
      perms2.loadFromDb();
      const ch2 = new CommandHandler(perms2);
      const broadcastSpy = vi.fn();
      const mockHub = { broadcast: broadcastSpy } as never;
      registerBanCommands({
        commandHandler: ch2,
        banStore: bs2,
        ircCommands: { ban: vi.fn(), unban: vi.fn() },
        db: db2,
        hub: mockHub,
        sharedBanList: null,
        ircLower: (s: string) => s.toLowerCase(),
      });
      const { ctx } = makeReply();
      await ch2.execute('.unban #test *!*@evil.com', ctx);
      expect(broadcastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'CHAN_BAN_DEL', channel: '#test', mask: '*!*@evil.com' }),
      );
      db2.close();
    });
  });

  // -----------------------------------------------------------------------
  // .stick / .unstick
  // -----------------------------------------------------------------------

  describe('.stick', () => {
    it('shows usage when args missing', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.stick', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('sets sticky flag on existing ban', async () => {
      banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.stick #test *!*@evil.com', ctx);
      expect(banStore.getBan('#test', '*!*@evil.com')!.sticky).toBe(true);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('sticky'));
      const [row] = db.getModLog({ action: 'stick' });
      expect(row).toBeDefined();
      expect(row.channel).toBe('#test');
      expect(row.target).toBe('*!*@evil.com');
    });

    it('reports error when ban does not exist', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.stick #test *!*@nope.com', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('No tracked ban'));
    });
  });

  describe('.unstick', () => {
    it('shows usage when args missing', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.unstick', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('clears sticky flag', async () => {
      banStore.storeBan('#test', '*!*@evil.com', 'admin', 0);
      banStore.setSticky('#test', '*!*@evil.com', true);
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.unstick #test *!*@evil.com', ctx);
      expect(banStore.getBan('#test', '*!*@evil.com')!.sticky).toBe(false);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('no longer sticky'));
      const [row] = db.getModLog({ action: 'unstick' });
      expect(row).toBeDefined();
      expect(row.channel).toBe('#test');
      expect(row.target).toBe('*!*@evil.com');
    });

    it('reports error when ban does not exist', async () => {
      const { reply, ctx } = makeReply();
      await commandHandler.execute('.unstick #test *!*@nope.com', ctx);
      expect(reply).toHaveBeenCalledWith(expect.stringContaining('No tracked ban'));
    });
  });
});
