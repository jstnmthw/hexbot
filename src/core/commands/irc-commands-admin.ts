// HexBot — IRC admin commands
// Registers .say, .join, .part, .invite, .status with the command handler.
import type { CommandHandler } from '../../command-handler';
import { isValidCommandTarget, parseTargetMessage } from '../../utils/parse-args';
import { sanitize } from '../../utils/sanitize';

/** Minimal IRC client interface for admin commands. */
export interface AdminIRCClient {
  say(target: string, message: string): void;
  join(channel: string): void;
  part(channel: string, message?: string): void;
  raw(line: string): void;
  connected: boolean;
  user?: { nick: string };
}

/** Minimal bot interface for status reporting. */
export interface AdminBotInfo {
  getUptime(): number;
  getChannels(): string[];
  getBindCount(): number;
  getUserCount(): number;
}

/**
 * Register IRC admin commands on the given command handler.
 */
export function registerIRCAdminCommands(
  handler: CommandHandler,
  client: AdminIRCClient,
  botInfo: AdminBotInfo,
): void {
  handler.registerCommand(
    'say',
    {
      flags: '+o',
      description: 'Send a message to a channel or user',
      usage: '.say <target> <message>',
      category: 'irc',
    },
    (_args, ctx) => {
      const parsed = parseTargetMessage(_args);
      if (!parsed) {
        ctx.reply('Usage: .say <target> <message>');
        return;
      }
      if (!isValidCommandTarget(parsed.target)) {
        ctx.reply('Invalid target.');
        return;
      }
      client.say(parsed.target, sanitize(parsed.message));
      ctx.reply(`Message sent to ${parsed.target}`);
    },
  );

  handler.registerCommand(
    'join',
    {
      flags: '+o',
      description: 'Join a channel',
      usage: '.join <#channel>',
      category: 'irc',
    },
    (_args, ctx) => {
      const channel = _args.trim();
      if (!channel || !channel.startsWith('#')) {
        ctx.reply('Usage: .join <#channel>');
        return;
      }
      client.join(channel);
      ctx.reply(`Joining ${channel}`);
    },
  );

  handler.registerCommand(
    'part',
    {
      flags: '+o',
      description: 'Leave a channel',
      usage: '.part <#channel> [message]',
      category: 'irc',
    },
    (_args, ctx) => {
      const parts = _args.trim().split(/\s+/);
      const channel = parts[0];
      if (!channel || !channel.startsWith('#')) {
        ctx.reply('Usage: .part <#channel> [message]');
        return;
      }
      const message = parts.slice(1).join(' ') || undefined;
      client.part(channel, message);
      ctx.reply(`Leaving ${channel}`);
    },
  );

  handler.registerCommand(
    'msg',
    {
      flags: '+o',
      description: 'Send a PRIVMSG to any target (user, nick, or service)',
      usage: '.msg <target> <message>',
      category: 'irc',
    },
    (_args, ctx) => {
      const parsed = parseTargetMessage(_args);
      if (!parsed) {
        ctx.reply('Usage: .msg <target> <message>');
        return;
      }
      // .msg accepts any non-whitespace target (channel, nick, service).
      if (!/^\S+$/.test(parsed.target)) {
        ctx.reply('Invalid target.');
        return;
      }
      client.say(parsed.target, sanitize(parsed.message));
      ctx.reply(`Message sent to ${parsed.target}`);
    },
  );

  handler.registerCommand(
    'invite',
    {
      flags: '+o',
      description: 'Invite a user to a channel',
      usage: '.invite <#channel> <nick>',
      category: 'irc',
    },
    (_args, ctx) => {
      // Reject raw args containing control characters (\r, \n) before splitting
      if (/[\r\n]/.test(_args)) {
        ctx.reply('Invalid nick.');
        return;
      }
      const parts = _args.trim().split(/\s+/);
      const channel = parts[0];
      const nick = parts[1];
      if (!channel || !channel.startsWith('#') || !nick) {
        ctx.reply('Usage: .invite <#channel> <nick>');
        return;
      }
      client.raw(`INVITE ${sanitize(nick)} ${sanitize(channel)}`);
      ctx.reply(`Invited ${nick} to ${channel}`);
    },
  );

  handler.registerCommand(
    'status',
    {
      flags: '+o',
      description: 'Show bot status',
      usage: '.status',
      category: 'irc',
    },
    (_args, ctx) => {
      const connected = client.connected ? 'connected' : 'disconnected';
      const nick = client.user?.nick ?? 'unknown';
      const uptime = formatUptime(botInfo.getUptime());
      const channels = botInfo.getChannels();
      const binds = botInfo.getBindCount();
      const users = botInfo.getUserCount();

      const lines = [
        `Status: ${connected} as ${nick}`,
        `Uptime: ${uptime}`,
        `Channels: ${channels.length > 0 ? channels.join(', ') : '(none)'}`,
        `Binds: ${binds} | Users: ${users}`,
      ];
      ctx.reply(lines.join('\n'));
    },
  );
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}
