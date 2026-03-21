import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CommandHandler, type CommandContext } from '../../../src/command-handler.js';
import { Permissions } from '../../../src/core/permissions.js';
import { registerPermissionCommands } from '../../../src/core/commands/permission-commands.js';

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

describe('permission-commands', () => {
  let handler: CommandHandler;
  let perms: Permissions;

  beforeEach(() => {
    handler = new CommandHandler();
    perms = new Permissions();
    registerPermissionCommands(handler, perms);
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

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('added');
    });

    it('should show usage when missing arguments', async () => {
      const ctx = makeCtx();
      await handler.execute('.adduser admin', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Usage');
    });

    it('should report error for duplicate user', async () => {
      const ctx1 = makeCtx();
      await handler.execute('.adduser admin *!t@h n', ctx1);

      const ctx2 = makeCtx();
      await handler.execute('.adduser admin *!t@h2 o', ctx2);

      const output = (ctx2.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
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

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('testuser');
      expect(output).toContain('ov');
    });

    it('should set channel flags with .flags handle +o #channel', async () => {
      const ctx = makeCtx();
      await handler.execute('.flags testuser +o #main', ctx);

      const user = perms.getUser('testuser')!;
      expect(user.channels['#main']).toBe('o');

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
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

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('not found');
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

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('alice');
      expect(output).toContain('bob');
      expect(output).toContain('2');
    });

    it('should report no users when empty', async () => {
      const ctx = makeCtx();
      await handler.execute('.users', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('No users');
    });
  });

  // -------------------------------------------------------------------------
  // .deluser
  // -------------------------------------------------------------------------

  describe('.deluser', () => {
    it('should remove a user', async () => {
      const addCtx = makeCtx();
      await handler.execute('.adduser admin *!t@h n', addCtx);

      const ctx = makeCtx();
      await handler.execute('.deluser admin', ctx);

      expect(perms.getUser('admin')).toBeNull();

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('removed');
    });

    it('should report error for unknown user', async () => {
      const ctx = makeCtx();
      await handler.execute('.deluser nobody', ctx);

      const output = (ctx.reply as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(output).toContain('Error');
      expect(output).toContain('not found');
    });
  });
});
