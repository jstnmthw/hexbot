import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import { registerPermissionCommands } from '../../../src/core/commands/permission-commands';
import { Permissions } from '../../../src/core/permissions';
import { BotDatabase } from '../../../src/database';

/** Helper: create a minimal CommandContext with a typed reply mock. */
function makeCtx(
  overrides: Partial<CommandContext> = {},
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = { source: 'repl', nick: 'admin', channel: null, reply, ...overrides };
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
}

describe('permission-commands', () => {
  let handler: CommandHandler;
  let perms: Permissions;

  beforeEach(() => {
    handler = new CommandHandler();
    perms = new Permissions();
    registerPermissionCommands({ handler, permissions: perms });
  });

  // -------------------------------------------------------------------------
  // .adduser
  // -------------------------------------------------------------------------

  describe('.adduser', () => {
    it('should create a user via permissions', async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser admin *!test@host nmov', ctx);

      const user = perms.getUser('admin');
      expect(user).not.toBeNull();
      expect(user!.handle).toBe('admin');
      expect(user!.hostmasks).toEqual(['*!test@host']);
      expect(user!.global).toBe('nmov');

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('added');
    });

    it('should show usage when missing arguments (handle only)', async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser admin', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Usage');
    });

    it('should show usage with only handle and hostmask (no flags)', async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser admin *!t@h', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Usage');
    });

    it('should report error for duplicate user', async () => {
      const ctx1 = makeCtx();
      await handler.execute('.adduser admin *!t@h n', ctx1);

      const ctx2 = makeCtx();
      await handler.execute('.adduser admin *!t@h2 o', ctx2);

      const output = ctx2.reply.mock.calls[0][0];
      expect(output).toContain('Error');
      expect(output).toContain('already exists');
    });
  });

  // -------------------------------------------------------------------------
  // .flags
  // -------------------------------------------------------------------------

  describe('.flags', () => {
    beforeEach(async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser testuser *!test@host ov', ctx);
    });

    it('should show current flags', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags testuser', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('testuser');
      expect(output).toContain('ov');
    });

    it('should set channel flags with .flags handle +o #channel', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags testuser +o #main', ctx);

      const user = perms.getUser('testuser')!;
      expect(user.channels['#main']).toBe('o');

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('#main');
    });

    it('should set global flags', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags testuser +nmov', ctx);

      const user = perms.getUser('testuser')!;
      expect(user.global).toBe('nmov');
    });

    it('should report error for unknown user', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags nobody', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('not found');
    });

    it('should show channel overrides in view mode', async () => {
      // Set channel-specific flags first
      const setCtx = makeCtx();
      await handler.execute('.flags testuser +o #special', setCtx);

      // Now view flags — should display channel info
      const viewCtx = makeCtx();
      await handler.execute('.flags testuser', viewCtx);

      const output = viewCtx.reply.mock.calls[0][0];
      expect(output).toContain('testuser');
      expect(output).toContain('#special');
      expect(output).toContain('channels');
    });

    it('should set channel-specific flags with # arg', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags testuser +mv #ops', ctx);

      const user = perms.getUser('testuser')!;
      expect(user.channels['#ops']).toBeDefined();

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('#ops');
      expect(output).toContain('Channel flags');
    });
  });

  // -------------------------------------------------------------------------
  // .users
  // -------------------------------------------------------------------------

  describe('.users', () => {
    it('should list users', async () => {
      const addCtx = makeCtx();
      await handler.execute('.adduser alice *!a@h o', addCtx);
      await handler.execute('.adduser bob *!b@h v', addCtx);

      const ctx = makeCtx();
      await handler.execute('.users', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('alice');
      expect(output).toContain('bob');
      expect(output).toContain('2');
    });

    it('should report no users when empty', async () => {
      const ctx = makeCtx();
      await handler.execute('.users', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('No users');
    });
  });

  // -------------------------------------------------------------------------
  // .deluser
  // -------------------------------------------------------------------------

  describe('.deluser', () => {
    it('should remove a user', async () => {
      // Seed two owners so the last-owner deletion guard doesn't block.
      // The guard refuses to remove the last +n record, so tests that
      // actually delete an owner need a spare.
      await handler.execute('.adduser admin *!t@h n', makeCtx());
      await handler.execute('.adduser spare *!s@h n', makeCtx());

      const ctx = makeCtx();
      await handler.execute('.deluser admin', ctx);

      expect(perms.getUser('admin')).toBeNull();

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('removed');
    });

    it('refuses to delete the last +n owner', async () => {
      await handler.execute('.adduser solo *!s@h n', makeCtx());

      const ctx = makeCtx();
      await handler.execute('.deluser solo', ctx);

      expect(perms.getUser('solo')).not.toBeNull();
      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('only +n owner');
    });

    it('should report error for unknown user', async () => {
      const ctx = makeCtx();
      await handler.execute('.deluser nobody', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Error');
      expect(output).toContain('not found');
    });

    it('should show usage when no handle provided', async () => {
      const ctx = makeCtx();
      await handler.execute('.deluser', ctx);

      const output = ctx.reply.mock.calls[0][0];
      expect(output).toContain('Usage');
    });
  });

  // -------------------------------------------------------------------------
  // .flags — no args (legend)
  // -------------------------------------------------------------------------

  describe('.flags no args', () => {
    it('should show flag legend when called with no arguments', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags', ctx);

      const calls = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(2);
      expect(calls[0][0]).toContain('legend');
      expect(calls[1][0]).toContain('Usage');
    });
  });

  // -------------------------------------------------------------------------
  // (none) display in flags view and users list
  // -------------------------------------------------------------------------

  describe('empty global flags display', () => {
    it('should show (none) in flags view for user with no global flags', async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser noflags *!nf@host -', ctx);

      const viewCtx = makeCtx();
      await handler.execute('.flags noflags', viewCtx);

      expect(viewCtx.reply).toHaveBeenCalledWith(expect.stringContaining('(none)'));
    });

    it('should show (none) in users list for user with no global flags', async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser noflags *!nf@host -', ctx);

      const listCtx = makeCtx();
      await handler.execute('.users', listCtx);

      expect(listCtx.reply.mock.calls[0][0]).toContain('(none)');
    });
  });
});

// ---------------------------------------------------------------------------
// IRC-source commands (cover ctx.nick branch in source ternary)
// ---------------------------------------------------------------------------

describe('permission-commands (IRC source)', () => {
  let db: BotDatabase;
  let perms: Permissions;
  let handler: CommandHandler;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    perms = new Permissions(db);
    // Owner-level user so all permission checks pass
    perms.addUser('owner', '*!owner@host', 'n', 'setup');
    handler = new CommandHandler(perms);
    registerPermissionCommands({ handler, permissions: perms });
  });

  it('adduser from IRC uses ctx.nick as the audit source', async () => {
    const ctx = makeCtx({ source: 'irc', nick: 'owner', ident: 'owner', hostname: 'host' });
    await handler.execute('.adduser newuser *!new@h o', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('added'));
    expect(perms.getUser('newuser')).not.toBeNull();
  });

  it('deluser from IRC uses ctx.nick as the audit source', async () => {
    perms.addUser('todel', '*!td@h', 'o', 'setup');
    const ctx = makeCtx({ source: 'irc', nick: 'owner', ident: 'owner', hostname: 'host' });
    await handler.execute('.deluser todel', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('removed'));
    expect(perms.getUser('todel')).toBeNull();
  });

  it('flags set from IRC uses ctx.nick as the audit source', async () => {
    perms.addUser('target', '*!t@h', 'o', 'setup');
    const ctx = makeCtx({ source: 'irc', nick: 'owner', ident: 'owner', hostname: 'host' });
    await handler.execute('.flags target +mo', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Global flags'));
  });
});

// ---------------------------------------------------------------------------
// .flags — owner flag escalation guard (W-1)
// ---------------------------------------------------------------------------

describe('.flags owner escalation guard', () => {
  let db: BotDatabase;
  let perms: Permissions;
  let handler: CommandHandler;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    perms = new Permissions(db);
    // Owner user
    perms.addUser('owner', '*!owner@host', 'n', 'setup');
    // Master user (no owner flag)
    perms.addUser('master', '*!master@host', 'm', 'setup');
    // Target user to modify
    perms.addUser('target', '*!t@h', 'o', 'setup');
    handler = new CommandHandler(perms);
    registerPermissionCommands({ handler, permissions: perms });
  });

  it('a +m user trying to set +n flags gets rejected', async () => {
    const ctx = makeCtx({ source: 'irc', nick: 'master', ident: 'master', hostname: 'host' });
    await handler.execute('.flags target +n', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Only owners (+n) can grant master or higher flags.');
    // Flags should remain unchanged
    expect(perms.getUser('target')!.global).toBe('o');
  });

  it('a +n user can still set +n flags', async () => {
    const ctx = makeCtx({ source: 'irc', nick: 'owner', ident: 'owner', hostname: 'host' });
    await handler.execute('.flags target +n', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Global flags'));
    expect(perms.getUser('target')!.global).toBe('n');
  });

  it('REPL source bypasses the owner guard', async () => {
    const ctx = makeCtx({ source: 'repl' });
    await handler.execute('.flags target +n', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Global flags'));
    expect(perms.getUser('target')!.global).toBe('n');
  });

  it('rejects +n escalation even when ident/hostname are missing', async () => {
    // DCC context may lack ident/hostname — exercises the ?? '' fallbacks
    perms.addUser('dccmaster', '*!*@*', 'm', 'setup');
    const ctx = makeCtx({ source: 'dcc', nick: 'dccmaster' });
    await handler.execute('.flags target +n', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Only owners (+n) can grant master or higher flags.');
    expect(perms.getUser('target')!.global).toBe('o');
  });

  it('a +m user can still set +o or +v flags', async () => {
    const ctx = makeCtx({ source: 'irc', nick: 'master', ident: 'master', hostname: 'host' });
    await handler.execute('.flags target +ov', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Global flags'));
    expect(perms.getUser('target')!.global).toBe('ov');
  });

  // -------------------------------------------------------------------------
  // Regression: botlink source must NOT bypass the escalation guard. Before
  // fix, `ctx.source === 'botlink'` exempted the caller entirely, so a +m
  // master on any leaf could run `.flags self +n`, the hub executed it as
  // `botlink` source, and the master silently promoted to owner across the
  // entire botnet. See audit 2026-04-19 (CRITICAL).
  // -------------------------------------------------------------------------

  it('botlink caller without +n is rejected when granting +n', async () => {
    // Botlink cmd-exec.ts pins ident/hostname to 'botlink' and sets
    // ctx.nick = fromHandle. The guard now resolves by handle for botlink,
    // so a +m master who issues .flags self +n across the link is rejected.
    const ctx = makeCtx({
      source: 'botlink',
      nick: 'master',
      ident: 'botlink',
      hostname: 'botlink',
    });
    await handler.execute('.flags master +n', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Only owners (+n) can grant master or higher flags.');
    expect(perms.getUser('master')!.global).toBe('m');
  });

  it('botlink caller without +n is rejected when granting +m', async () => {
    const ctx = makeCtx({
      source: 'botlink',
      nick: 'master',
      ident: 'botlink',
      hostname: 'botlink',
    });
    await handler.execute('.flags target +m', ctx);

    expect(ctx.reply).toHaveBeenCalledWith('Only owners (+n) can grant master or higher flags.');
    expect(perms.getUser('target')!.global).toBe('o');
  });

  it('botlink caller with +n can grant +n', async () => {
    const ctx = makeCtx({
      source: 'botlink',
      nick: 'owner',
      ident: 'botlink',
      hostname: 'botlink',
    });
    await handler.execute('.flags target +n', ctx);

    expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Global flags'));
    expect(perms.getUser('target')!.global).toBe('n');
  });
});
