// HexBot — Permission management commands
// Registers .adduser, .deluser, .flags, .users with the command handler.
import type { CommandHandler } from '../../command-handler';
import { formatTable } from '../../utils/table';
import { OWNER_FLAG, type Permissions } from '../permissions';

/**
 * Register permission management commands on the given command handler.
 */
export function registerPermissionCommands(
  handler: CommandHandler,
  permissions: Permissions,
): void {
  handler.registerCommand(
    'adduser',
    {
      flags: '+n',
      description: 'Add a user to the bot',
      usage: '.adduser <handle> <hostmask> <flags>',
      category: 'permissions',
      relayToHub: true,
    },
    (args, ctx) => {
      const parts = args.split(/\s+/);
      if (parts.length < 3) {
        ctx.reply('Usage: .adduser <handle> <hostmask> <flags>');
        return;
      }

      const [handle, hostmask, flags] = parts;

      // Shape and length validation — reject garbage arguments before they
      // hit the DB. Handles follow the same character set as plugin
      // directory names; hostmasks are bounded to prevent unbounded DB
      // rows; all three reject embedded control characters as a defense
      // against log / audit injection from a compromised transport.
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(handle)) {
        ctx.reply(
          'Invalid handle — must start alphanumeric, then alphanumeric/underscore/hyphen, max 32 chars.',
        );
        return;
      }
      if (hostmask.length === 0 || hostmask.length > 200 || /[\r\n\0]/.test(hostmask)) {
        ctx.reply('Invalid hostmask — max 200 chars and no control characters.');
        return;
      }
      if (flags.length === 0 || flags.length > 16 || /[\r\n\0]/.test(flags)) {
        ctx.reply('Invalid flags — max 16 chars and no control characters.');
        return;
      }

      const source = ctx.source === 'repl' ? 'REPL' : ctx.nick;
      permissions.addUser(handle, hostmask, flags, source, ctx.source);
      ctx.reply(`User "${handle}" added with hostmask ${hostmask} and flags ${flags}`);
    },
  );

  handler.registerCommand(
    'deluser',
    {
      flags: '+n',
      description: 'Remove a user from the bot',
      usage: '.deluser <handle>',
      category: 'permissions',
      relayToHub: true,
    },
    (args, ctx) => {
      const handle = args.trim();
      if (!handle) {
        ctx.reply('Usage: .deluser <handle>');
        return;
      }

      // Last-owner guard: if the target is `+n` and they are the only `+n`
      // user on the bot, refuse the deletion. Losing the last owner leaves
      // the bot with no one able to run owner-only commands and requires
      // manual DB surgery to recover.
      const target = permissions.getUser(handle);
      if (target && target.global.includes(OWNER_FLAG)) {
        const ownerCount = permissions
          .listUsers()
          .filter((u) => u.global.includes(OWNER_FLAG)).length;
        if (ownerCount <= 1) {
          ctx.reply(
            `Refusing to delete "${handle}" — they are the only +n owner. Add another owner first.`,
          );
          return;
        }
      }

      const source = ctx.source === 'repl' ? 'REPL' : ctx.nick;
      permissions.removeUser(handle, source, ctx.source);
      ctx.reply(`User "${handle}" removed`);
    },
  );

  handler.registerCommand(
    'flags',
    {
      flags: '+n|+m',
      description: 'View or set user flags',
      usage: '.flags [handle] [+flags [#channel]]',
      category: 'permissions',
      relayToHub: true,
    },
    (args, ctx) => {
      const parts = args.split(/\s+/);
      if (parts.length === 0 || !parts[0]) {
        ctx.reply(
          'Flag legend: n=owner (all access), m=master (user mgmt), o=op (channel cmds), v=voice, d=deop (no auto-op, +v if flagged)',
        );
        ctx.reply('Usage: .flags <handle> [+flags [#channel]]');
        return;
      }

      const handle = parts[0];
      const user = permissions.getUser(handle);
      if (!user) {
        ctx.reply(`User "${handle}" not found`);
        return;
      }

      // View mode: just show current flags
      if (parts.length === 1) {
        const channelInfo = Object.entries(user.channels)
          .map(([ch, fl]) => `${ch}: ${fl}`)
          .join(', ');
        const channelStr = channelInfo ? ` | channels: ${channelInfo}` : '';
        ctx.reply(`${user.handle}: global flags: ${user.global || '(none)'}${channelStr}`);
        return;
      }

      // Set mode
      const flagsArg = parts[1];
      const source = ctx.source === 'repl' ? 'REPL' : ctx.nick;

      // Guard: only owners can grant flags at master level (`m`) or higher.
      // A `+m` master was previously allowed to promote arbitrary users to
      // `+m`, which is an escalation path — any master could seed a parallel
      // line of masters without owner involvement. Tighten the gate so
      // granting `m` or `n` requires `+n`.
      if (ctx.source !== 'repl' && ctx.source !== 'botlink') {
        const callerHostmask = `${ctx.nick}!${ctx.ident ?? ''}@${ctx.hostname ?? ''}`;
        const caller = permissions.findByHostmask(callerHostmask);
        const callerIsOwner = caller?.global.includes(OWNER_FLAG) ?? false;
        const grantsMasterOrHigher = flagsArg.includes(OWNER_FLAG) || flagsArg.includes('m');
        if (grantsMasterOrHigher && !callerIsOwner) {
          ctx.reply('Only owners (+n) can grant master or higher flags.');
          return;
        }
      }

      if (parts.length >= 3 && parts[2].startsWith('#')) {
        // Channel-specific flags
        const channel = parts[2];
        permissions.setChannelFlags(
          handle,
          channel,
          flagsArg.replace(/^\+/, ''),
          source,
          ctx.source,
        );
        ctx.reply(`Channel flags for "${handle}" in ${channel} set to "${flagsArg}"`);
      } else {
        // Global flags
        permissions.setGlobalFlags(handle, flagsArg.replace(/^\+/, ''), source, ctx.source);
        ctx.reply(`Global flags for "${handle}" set to "${flagsArg}"`);
      }
    },
  );

  handler.registerCommand(
    'users',
    {
      flags: '+o',
      description: 'List all bot users',
      usage: '.users',
      category: 'permissions',
    },
    (_args, ctx) => {
      const users = permissions.listUsers();
      if (users.length === 0) {
        ctx.reply('No users registered.');
        return;
      }

      const rows = users.map((u) => [
        u.handle,
        `flags=${u.global || '(none)'}`,
        `hostmasks=[${u.hostmasks.join(', ')}]`,
      ]);
      ctx.reply(`Users (${users.length}):\n${formatTable(rows)}`);
    },
  );
}
