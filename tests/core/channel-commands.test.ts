import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandHandler } from '../../src/command-handler';
import type { CommandContext } from '../../src/command-handler';
import { ChannelSettings } from '../../src/core/channel-settings';
import { registerChannelCommands } from '../../src/core/commands/channel-commands';
import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';

function makeCtx(
  overrides?: Partial<CommandContext>,
): CommandContext & { reply: Mock<(msg: string) => void> } {
  const reply = vi.fn<(msg: string) => void>();
  const ctx: CommandContext = {
    source: 'repl',
    nick: 'admin',
    ident: 'admin',
    hostname: 'localhost',
    channel: null,
    reply,
    ...overrides,
  };
  // Narrow: reply is always Mock<...> unless overridden — safe direct cast (no unknown bridge)
  return ctx as CommandContext & { reply: Mock<(msg: string) => void> };
}

describe('channel-commands', () => {
  let db: BotDatabase;
  let cs: ChannelSettings;
  let handler: CommandHandler;
  let permissions: Permissions;

  beforeEach(() => {
    db = new BotDatabase(':memory:');
    db.open();
    cs = new ChannelSettings(db);
    permissions = new Permissions(db);
    // Add an op user for IRC permission checks
    permissions.addUser('admin', '*!admin@localhost', 'o', 'test');
    handler = new CommandHandler(permissions);
    registerChannelCommands(handler, cs, db);

    // Register some test defs
    cs.register('testplugin', [
      {
        key: 'protect_topic',
        type: 'flag',
        default: false,
        description: 'Restore topic if changed',
      },
      { key: 'greet_msg', type: 'string', default: 'Welcome!', description: 'Join greeting' },
      { key: 'max_lines', type: 'int', default: 5, description: 'Max flood lines' },
    ]);
  });

  // ---------------------------------------------------------------------------
  // .chanset — flag operations
  // ---------------------------------------------------------------------------

  describe('.chanset flag operations', () => {
    it('+key sets flag to true', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test +protect_topic', ctx);
      expect(cs.get('#test', 'protect_topic')).toBe(true);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('ON'));
    });

    it('-key unsets the flag (reverts to default OFF)', async () => {
      cs.set('#test', 'protect_topic', true);
      const ctx = makeCtx();
      await handler.execute('.chanset #test -protect_topic', ctx);
      expect(cs.isSet('#test', 'protect_topic')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('reverted'));
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('OFF'));
    });

    it('-key on a flag with default ON shows ON in revert message', async () => {
      cs.register('tmp', [{ key: 'active', type: 'flag', default: true, description: 'Active' }]);
      cs.set('#test', 'active', false);
      const ctx = makeCtx();
      await handler.execute('.chanset #test -active', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('ON'));
    });

    it('-key on non-flag reverts to default string', async () => {
      cs.set('#test', 'greet_msg', 'custom');
      const ctx = makeCtx();
      await handler.execute('.chanset #test -greet_msg', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Welcome!'));
    });

    it('+key on non-flag def → type error reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test +greet_msg', ctx);
      expect(cs.isSet('#test', 'greet_msg')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('string settings'));
    });

    it('key value on flag def → type error reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test protect_topic true', ctx);
      expect(cs.isSet('#test', 'protect_topic')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('+protect_topic'));
    });

    it('show current flag value with description (false/OFF)', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test protect_topic', ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('OFF');
      expect(msg).toContain('(flag)');
      expect(msg).toContain('Restore topic if changed');
    });

    it('show current flag value with description (true/ON)', async () => {
      cs.set('#test', 'protect_topic', true);
      const ctx = makeCtx();
      await handler.execute('.chanset #test protect_topic', ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('ON');
      expect(msg).toContain('(flag)');
      expect(msg).toContain('Restore topic if changed');
    });
  });

  // ---------------------------------------------------------------------------
  // .chanset — string operations
  // ---------------------------------------------------------------------------

  describe('.chanset string operations', () => {
    it('key value stores the string', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test greet_msg Hello {nick}!', ctx);
      expect(cs.get('#test', 'greet_msg')).toBe('Hello {nick}!');
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Hello {nick}!'));
    });

    it('key (no value) shows current value with description', async () => {
      cs.set('#test', 'greet_msg', 'Custom greeting');
      const ctx = makeCtx();
      await handler.execute('.chanset #test greet_msg', ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('Custom greeting');
      expect(msg).toContain('(string)');
      expect(msg).toContain('Join greeting');
    });

    it('key (no value) shows default with description when not set', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test greet_msg', ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('default');
      expect(msg).toContain('(string)');
      expect(msg).toContain('Join greeting');
    });

    it('key (no value) shows (not set) for empty string with description', async () => {
      cs.register('tmp', [{ key: 'prefix', type: 'string', default: '', description: 'A prefix' }]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test prefix', ctx);
      const msg = ctx.reply.mock.calls[0][0];
      expect(msg).toContain('(not set)');
      expect(msg).toContain('(string)');
      expect(msg).toContain('A prefix');
    });
  });

  // ---------------------------------------------------------------------------
  // .chanset — int operations
  // ---------------------------------------------------------------------------

  describe('.chanset int operations', () => {
    it('key value stores integer', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test max_lines 10', ctx);
      expect(cs.get('#test', 'max_lines')).toBe(10);
    });

    it('non-integer value → error reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test max_lines notanumber', ctx);
      expect(cs.isSet('#test', 'max_lines')).toBe(false);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('not a valid integer'));
    });
  });

  // ---------------------------------------------------------------------------
  // .chanset — error cases
  // ---------------------------------------------------------------------------

  describe('.chanset error cases', () => {
    it('missing channel → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('non-channel arg → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset notachannel +protect_topic', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('unknown key → unknown setting reply', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test unknown_key', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Unknown setting'));
    });

    it('missing key arg → lists settings with flag grid and value lines', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Settings for #test'));
      const output = ctx.reply.mock.calls.map((c: string[]) => c[0]).join('\n');
      // Flags shown as +/- grid
      expect(output).toContain('-protect_topic');
      // String/int shown as key: value
      expect(output).toContain('greet_msg: Welcome!');
      expect(output).toContain('max_lines: 5');
    });

    it('pads multiple flags into aligned grid rows', async () => {
      cs.register('multi', [
        { key: 'flagA', type: 'flag', default: false, description: 'A' },
        { key: 'flagB', type: 'flag', default: true, description: 'B' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      const output = ctx.reply.mock.calls.map((c: string[]) => c[0]).join('\n');
      // Multiple flags on same line, padded to uniform width
      expect(output).toMatch(/-protect_topic\s+-flagA\s+\+flagB/);
    });

    it('lists only value lines when no flags are registered', async () => {
      cs.unregister('testplugin');
      cs.register('stronly', [
        { key: 'mystr', type: 'string', default: 'hi', description: 'A string' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chanset #test', ctx);
      const output = ctx.reply.mock.calls.map((c: string[]) => c[0]).join('\n');
      expect(output).toContain('mystr: hi');
      expect(output).not.toContain('+');
      expect(output).not.toContain('-');
    });

    it('empty key after stripping prefix → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chanset #test +', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });
  });

  // ---------------------------------------------------------------------------
  // .chaninfo
  // ---------------------------------------------------------------------------

  describe('.chaninfo', () => {
    it('lists all defs grouped by plugin with +/- flags and * markers', async () => {
      cs.set('#test', 'protect_topic', true);
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);

      const calls = ctx.reply.mock.calls.map((c: string[]) => c[0]);
      const header = calls.find((l: string) => l.includes('Channel settings'));
      expect(header).toBeDefined();
      expect(header).toContain('1 set');
      expect(header).toContain('2 default');

      const allLines = calls.flatMap((c: string) => c.split('\n'));

      // Flag displayed as +protect_topic* (ON, overridden)
      const protectLine = allLines.find((l: string) => l.includes('protect_topic'));
      expect(protectLine).toBeDefined();
      expect(protectLine).toContain('+protect_topic*');

      // String at default — no * marker
      const greetLine = allLines.find((l: string) => l.includes('greet_msg'));
      expect(greetLine).toBeDefined();
      expect(greetLine).toContain('greet_msg: Welcome!');
      expect(greetLine).not.toContain('*');
    });

    it('missing channel → usage error', async () => {
      const ctx = makeCtx();
      await handler.execute('.chaninfo', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('Usage'));
    });

    it('no defs registered → appropriate reply', async () => {
      cs.unregister('testplugin');
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      expect(ctx.reply).toHaveBeenCalledWith(expect.stringContaining('No settings'));
    });

    it('permission check: user without +o is rejected', async () => {
      const ctx = makeCtx({ source: 'irc', nick: 'randuser', ident: 'rand', hostname: 'rand.com' });
      await handler.execute('.chaninfo #test', ctx);
      // No user registered with this hostmask → fails permission check
      const calls = ctx.reply.mock.calls.map((c: string[]) => c[0]);
      const settingsHeader = calls.find((l: string) => l.includes('Channel settings'));
      expect(settingsHeader).toBeUndefined();
    });

    it('shows -flag for an unset flag (default=false)', async () => {
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      const allLines = ctx.reply.mock.calls.flatMap((c: string[]) => c[0].split('\n'));
      const protectLine = allLines.find((l: string) => l.includes('protect_topic'));
      expect(protectLine).toContain('-protect_topic');
    });

    it('shows (not set) for a string setting with empty-string default', async () => {
      cs.register('tmpplugin', [
        { key: 'prefix', type: 'string', default: '', description: 'Prefix' },
      ]);
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      const allLines = ctx.reply.mock.calls.flatMap((c: string[]) => c[0].split('\n'));
      const prefixLine = allLines.find((l: string) => l.includes('prefix'));
      expect(prefixLine).toContain('prefix: (not set)');
    });

    it('shows (not set) with * for a string explicitly set to empty', async () => {
      cs.set('#test', 'greet_msg', '');
      const ctx = makeCtx();
      await handler.execute('.chaninfo #test', ctx);
      const allLines = ctx.reply.mock.calls.flatMap((c: string[]) => c[0].split('\n'));
      const greetLine = allLines.find((l: string) => l.includes('greet_msg'));
      expect(greetLine).toContain('greet_msg*: (not set)');
    });
  });
});
