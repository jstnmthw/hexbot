// HexBot — IRC admin commands
// Registers .say, .join, .part, .invite, .status with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { isValidCommandTarget, parseTargetMessage } from '../../utils/parse-args';
import { sanitize } from '../../utils/sanitize';
import { stripFormatting } from '../../utils/strip-formatting';
import { tryAudit } from '../audit';
import type { ReconnectState } from '../reconnect-driver';

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
  /** Current reconnect-driver state, or null if the bot hasn't connected yet. */
  getReconnectState(): ReconnectState | null;
}

/**
 * Register IRC admin commands on the given command handler.
 *
 * `db` is used to write `say`/`msg`/`join`/`part`/`invite` audit rows so
 * arbitrary protocol injection through these commands is queryable in
 * `mod_log`. `say` and `msg` write the target in `target` and the message
 * in `metadata.message` so an audit reviewer can see both who did what
 * and what was said — this is the single biggest gap the review surfaced.
 */
export function registerIRCAdminCommands(
  handler: CommandHandler,
  client: AdminIRCClient,
  botInfo: AdminBotInfo,
  db: BotDatabase | null,
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
      tryAudit(db, ctx, {
        action: 'say',
        target: parsed.target,
        metadata: { message: stripFormatting(parsed.message) },
      });
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
      tryAudit(db, ctx, { action: 'join', channel });
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
      tryAudit(db, ctx, { action: 'part', channel, reason: message ?? null });
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
      tryAudit(db, ctx, {
        action: 'msg',
        target: parsed.target,
        metadata: { message: stripFormatting(parsed.message) },
      });
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
      tryAudit(db, ctx, { action: 'invite', channel, target: nick });
    },
  );

  handler.registerCommand(
    'uptime',
    {
      flags: '+o',
      description: 'Show bot uptime',
      usage: '.uptime',
      category: 'irc',
    },
    (_args, ctx) => {
      ctx.reply(`Uptime: ${formatUptimeColored(botInfo.getUptime())}`);
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
      const reconnectState = botInfo.getReconnectState();

      const lines = [
        `Status: ${connected} as ${nick}`,
        `Uptime: ${uptime}`,
        `Channels: ${channels.length > 0 ? channels.join(', ') : '(none)'}`,
        `Binds: ${binds} | Users: ${users}`,
      ];
      if (reconnectState) {
        lines.push(`Connection: ${formatReconnectState(reconnectState)}`);
      }
      ctx.reply(lines.join('\n'));
    },
  );
}

/**
 * Render the reconnect driver state for the `.status` command. Returns
 * a single human-readable line — never more — since `.status` stacks
 * short labelled lines.
 */
export function formatReconnectState(state: ReconnectState): string {
  if (state.status === 'connected') {
    return 'connected';
  }
  if (state.status === 'stopped') {
    return 'stopped';
  }
  // reconnecting or degraded — include tier, failure count, and next retry
  const errorPart = state.lastError ? `${state.lastError}, ` : '';
  const failurePart =
    state.consecutiveFailures > 1 ? `${state.consecutiveFailures} consecutive failures, ` : '';
  const nextPart = state.nextAttemptAt
    ? `next retry in ${formatDelay(state.nextAttemptAt - Date.now())}`
    : 'retry pending';
  return `${state.status} (${errorPart}${failurePart}${nextPart})`;
}

/** Format a millisecond delta as the shortest sensible "5s" / "3m" / "1h" string. */
function formatDelay(ms: number): string {
  if (ms < 0) return '0s';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  return `${hours}h`;
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

// mIRC formatting: \x02 bold, \x034 red, \x0F reset (same convention as src/core/dcc.ts)
/**
 * Same output shape as formatUptime() but each numeric component is
 * wrapped in bold+red so the digits pop while unit letters stay plain.
 */
export function formatUptimeColored(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const redBold = (n: number) => `\x02\x0304${n}\x0F`;
  const parts: string[] = [];
  if (days > 0) parts.push(`${redBold(days)}d`);
  if (hours > 0) parts.push(`${redBold(hours)}h`);
  if (minutes > 0) parts.push(`${redBold(minutes)}m`);
  parts.push(`${redBold(secs)}s`);
  return parts.join(' ');
}
