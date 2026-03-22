// n0xb0t — Permission management commands
// Registers .adduser, .deluser, .flags, .users with the command handler.
import type { CommandHandler } from '../../command-handler.js';
import type { Permissions } from '../permissions.js';

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
    },
    (args, ctx) => {
      const parts = args.split(/\s+/);
      if (parts.length < 3) {
        ctx.reply('Usage: .adduser <handle> <hostmask> <flags>');
        return;
      }

      const [handle, hostmask, flags] = parts;
      const source = ctx.source === 'repl' ? 'REPL' : ctx.nick;
      permissions.addUser(handle, hostmask, flags, source);
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
    },
    (args, ctx) => {
      const handle = args.trim();
      if (!handle) {
        ctx.reply('Usage: .deluser <handle>');
        return;
      }

      const source = ctx.source === 'repl' ? 'REPL' : ctx.nick;
      permissions.removeUser(handle, source);
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
    },
    (args, ctx) => {
      const parts = args.split(/\s+/);
      if (parts.length === 0 || !parts[0]) {
        ctx.reply(
          'Flag legend: n=owner (all access), m=master (user mgmt), o=op (channel cmds), v=voice',
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

      if (parts.length >= 3 && parts[2].startsWith('#')) {
        // Channel-specific flags
        const channel = parts[2];
        permissions.setChannelFlags(handle, channel, flagsArg.replace(/^\+/, ''), source);
        ctx.reply(`Channel flags for "${handle}" in ${channel} set to "${flagsArg}"`);
      } else {
        // Global flags
        permissions.setGlobalFlags(handle, flagsArg.replace(/^\+/, ''), source);
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

      const lines = users.map((u) => {
        const masks = u.hostmasks.join(', ');
        return `  ${u.handle}: flags=${u.global || '(none)'} hostmasks=[${masks}]`;
      });
      ctx.reply(`Users (${users.length}):\n${lines.join('\n')}`);
    },
  );
}
