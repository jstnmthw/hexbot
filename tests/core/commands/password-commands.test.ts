import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import { registerPasswordCommands } from '../../../src/core/commands/password-commands';
import { verifyPassword } from '../../../src/core/password';
import { Permissions } from '../../../src/core/permissions';
import { BotDatabase } from '../../../src/database';

type CtxWithMocks = CommandContext & { reply: Mock<(msg: string) => void> };

function makeCtx(overrides: Partial<CommandContext> = {}): CtxWithMocks {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply, ...overrides };
  return ctx as CtxWithMocks;
}

function setup() {
  const handler = new CommandHandler();
  const db = new BotDatabase(':memory:');
  db.open();
  const perms = new Permissions(db);
  registerPasswordCommands({ handler, permissions: perms });
  return { handler, perms, db };
}

describe('.chpass', () => {
  let handler: CommandHandler;
  let perms: Permissions;
  let db: BotDatabase;

  beforeEach(() => {
    ({ handler, perms, db } = setup());
  });

  describe('REPL transport', () => {
    it('sets a password for a user with an explicit handle', async () => {
      perms.addUser('admin', '*!a@host', 'n', 'REPL');

      const ctx = makeCtx();
      await handler.execute('.chpass admin secret!!', ctx);

      const hash = perms.getPasswordHash('admin');
      expect(hash).not.toBeNull();
      expect(await verifyPassword('secret!!', hash!)).toBe(true);
    });

    it('REPL can rotate any user (no owner requirement)', async () => {
      perms.addUser('someoneelse', '*!s@host', 'o', 'REPL');

      const ctx = makeCtx();
      await handler.execute('.chpass someoneelse letmein!!', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('updated');
      expect(perms.getPasswordHash('someoneelse')).not.toBeNull();
    });

    it('rejects self-rotation from REPL (no hostmask to resolve caller)', async () => {
      // REPL has no bound identity — self-rotation needs an explicit handle.
      const ctx = makeCtx();
      await handler.execute('.chpass lonepassword', ctx);
      expect(ctx.reply).toHaveBeenCalled();
      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('could not resolve');
    });

    it('rejects short password with a clear error', async () => {
      perms.addUser('admin', '*!a@host', 'n', 'REPL');
      const ctx = makeCtx();
      await handler.execute('.chpass admin short', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('at least 8');
      expect(perms.getPasswordHash('admin')).toBeNull();
    });

    it('rejects unknown handle', async () => {
      const ctx = makeCtx();
      await handler.execute('.chpass nobody validpass', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('not found');
    });

    it('writes a mod_log entry with no plaintext or hash', async () => {
      perms.addUser('admin', '*!a@host', 'n', 'REPL');
      const ctx = makeCtx();
      await handler.execute('.chpass admin supersecretpassword', ctx);

      const entries = db.getModLog({ action: 'chpass' });
      expect(entries.length).toBeGreaterThan(0);
      const entry = entries[0];
      expect(entry.target).toBe('admin');
      expect(entry.by).toBe('REPL');
      // Never log plaintext or hash
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain('supersecretpassword');
      expect(serialized).not.toContain('scrypt$');
    });

    it('rejects when user has no hostmask patterns', async () => {
      // Force a user record with no hostmasks to simulate a broken import
      perms.addUser('broken', '*!b@host', 'n', 'REPL');
      perms.removeHostmask('broken', '*!b@host', 'REPL');

      const ctx = makeCtx();
      await handler.execute('.chpass broken valid12345', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('hostmask');
      expect(perms.getPasswordHash('broken')).toBeNull();
    });
  });

  describe('DCC transport', () => {
    beforeEach(() => {
      perms.addUser('owner', '*!owner@host', 'n', 'REPL');
      perms.addUser('master', '*!master@host', 'm', 'REPL');
      perms.addUser('oper', '*!oper@host', 'o', 'REPL');
    });

    it('owner can rotate another user\u2019s password', async () => {
      const ctx = makeCtx({
        source: 'dcc',
        nick: 'OwnerNick',
        ident: 'owner',
        hostname: 'host',
      });
      await handler.execute('.chpass master newmaster1', ctx);
      expect(perms.getPasswordHash('master')).not.toBeNull();
    });

    it('non-owner cannot rotate another user\u2019s password', async () => {
      const ctx = makeCtx({
        source: 'dcc',
        nick: 'MasterNick',
        ident: 'master',
        hostname: 'host',
      });
      await handler.execute('.chpass oper newoper12', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('owners');
      expect(perms.getPasswordHash('oper')).toBeNull();
    });

    it('non-owner can rotate their own password (explicit handle)', async () => {
      const ctx = makeCtx({
        source: 'dcc',
        nick: 'MasterNick',
        ident: 'master',
        hostname: 'host',
      });
      await handler.execute('.chpass master myownpass1', ctx);
      expect(perms.getPasswordHash('master')).not.toBeNull();
      const output = ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1][0];
      expect(output).toContain('updated');
    });

    it('non-owner can rotate their own password (self form)', async () => {
      const ctx = makeCtx({
        source: 'dcc',
        nick: 'OperNick',
        ident: 'oper',
        hostname: 'host',
      });
      await handler.execute('.chpass myownpass1', ctx);
      expect(perms.getPasswordHash('oper')).not.toBeNull();
      const output = ctx.reply.mock.calls[ctx.reply.mock.calls.length - 1][0];
      expect(output).toContain('your password');
    });

    it('unknown caller (no hostmask match) is rejected', async () => {
      const ctx = makeCtx({
        source: 'dcc',
        nick: 'Stranger',
        ident: 'stranger',
        hostname: 'host',
      });
      await handler.execute('.chpass oper newoper12', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('denied');
      expect(perms.getPasswordHash('oper')).toBeNull();
    });
  });

  describe('IRC transport (rejected)', () => {
    it('refuses to run over PRIVMSG', async () => {
      perms.addUser('admin', '*!a@host', 'n', 'REPL');
      const ctx = makeCtx({
        source: 'irc',
        nick: 'AdminNick',
        ident: 'a',
        hostname: 'host',
        channel: '#test',
      });
      await handler.execute('.chpass admin validpass1', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('must not be sent over IRC');
      expect(perms.getPasswordHash('admin')).toBeNull();
    });
  });

  describe('usage', () => {
    it('shows usage when no args', async () => {
      const ctx = makeCtx();
      await handler.execute('.chpass', ctx);
      expect(ctx.reply.mock.calls[0][0]).toContain('Usage');
    });
  });

  describe('mod_log resilience', () => {
    it('still replies success if db.logModAction throws', async () => {
      const handler = new CommandHandler();

      const throwingDb = {
        logModAction: vi.fn(() => {
          throw new Error('database offline');
        }),
        list: () => [],
        del: () => {},
        set: () => {},
      } as unknown as BotDatabase;
      const warns: unknown[][] = [];
      const logger = {
        info: () => {},
        warn: (...args: unknown[]) => warns.push(args),
        debug: () => {},
        error: () => {},
        child: () => logger,
      } as unknown as import('../../../src/logger').Logger;

      const perms = new Permissions(throwingDb, logger);
      perms.addUser('admin', '*!a@host', 'n', 'REPL');

      registerPasswordCommands({ handler, permissions: perms });

      const ctx = makeCtx();
      await handler.execute('.chpass admin resilientpassword', ctx);

      // Password was still set despite the mod_log failure
      expect(perms.getPasswordHash('admin')).not.toBeNull();
      // The warn logger should have been called with a descriptive message
      expect(warns.some((args) => String(args[0]).includes('Failed to record'))).toBe(true);
      // The user should have been told the password was updated
      expect(ctx.reply.mock.calls.some(([msg]) => String(msg).includes('updated'))).toBe(true);
    });
  });

  describe('missing ident/hostname fields', () => {
    it('rejects DCC caller whose hostmask has no ident/hostname', async () => {
      perms.addUser('owner', '*!owner@host', 'n', 'REPL');

      // ctx without ident/hostname — should fall through the `?? ''` defaults.
      const ctx = makeCtx({ source: 'dcc', nick: 'Stranger' });
      await handler.execute('.chpass owner newpass123', ctx);

      // No hostmask match → permission denied
      expect(ctx.reply.mock.calls[0][0]).toContain('denied');
      expect(perms.getPasswordHash('owner')).toBeNull();
    });

    it('self-rotation for a DCC caller with missing ident/hostname falls through to permission denied', async () => {
      // resolveCallerHandle falls through `?? ''` and findByHostmask returns null
      const ctx = makeCtx({ source: 'dcc', nick: 'Ghost' });
      await handler.execute('.chpass someownpassword', ctx);

      expect(ctx.reply).toHaveBeenCalled();
      // Either "could not resolve" (from resolveCallerAndTarget self-branch)
      // or "denied" (from the permission check) — both exercise the ?? '' fallback.
      const output = ctx.reply.mock.calls[0][0];
      expect(output.toLowerCase()).toMatch(/resolve|denied/);
    });
  });

  describe('password hashing', () => {
    it('stores a scrypt-formatted hash, not the plaintext', async () => {
      perms.addUser('admin', '*!a@host', 'n', 'REPL');
      const ctx = makeCtx();
      await handler.execute('.chpass admin plainpassword', ctx);

      const hash = perms.getPasswordHash('admin');
      expect(hash).not.toBeNull();
      expect(hash).toMatch(/^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);
      expect(hash).not.toContain('plainpassword');
    });

    it('rotation produces a different stored hash', async () => {
      perms.addUser('admin', '*!a@host', 'n', 'REPL');
      const ctx1 = makeCtx();
      await handler.execute('.chpass admin firstpass1', ctx1);
      const hash1 = perms.getPasswordHash('admin');

      const ctx2 = makeCtx();
      await handler.execute('.chpass admin secondpass1', ctx2);
      const hash2 = perms.getPasswordHash('admin');

      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword('firstpass1', hash2!)).toBe(false);
      expect(await verifyPassword('secondpass1', hash2!)).toBe(true);
    });
  });
});
