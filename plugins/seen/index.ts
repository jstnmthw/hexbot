// seen — Last-seen tracking plugin
// Tracks when users were last active in a channel and responds to !seen queries.
import type { HandlerContext, PluginAPI } from '../../src/types';

export const name = 'seen';
export const version = '1.1.0';
export const description = 'Tracks and reports when users were last seen';

const DEFAULT_MAX_AGE_DAYS = 365;

export function init(api: PluginAPI): void {
  api.registerHelp([
    {
      command: '!seen',
      flags: '-',
      usage: '!seen <nick>',
      description: 'Show when a nick was last seen in channel',
      category: 'info',
    },
  ]);

  const maxAgeDays = (api.config.max_age_days as number | undefined) ?? DEFAULT_MAX_AGE_DAYS;
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  const MAX_TEXT_LENGTH = 200;

  // Track every channel message (pubm is stackable, won't interfere with others)
  api.bind('pubm', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;

    const text =
      ctx.text.length > MAX_TEXT_LENGTH ? ctx.text.substring(0, MAX_TEXT_LENGTH) + '...' : ctx.text;

    const record = JSON.stringify({
      nick: ctx.nick,
      channel: ctx.channel,
      text,
      time: Date.now(),
    });

    api.db.set(`seen:${api.ircLower(ctx.nick)}`, record);
  });

  // Respond to !seen queries
  api.bind('pub', '-', '!seen', (ctx: HandlerContext) => {
    cleanupStale(api, maxAgeMs);
    const targetNick = ctx.args.trim().split(/\s+/)[0];
    if (!targetNick) {
      ctx.reply('Usage: !seen <nick>');
      return;
    }

    const raw = api.db.get(`seen:${api.ircLower(targetNick)}`);
    if (!raw) {
      ctx.reply(`I haven't seen ${targetNick}.`);
      return;
    }

    try {
      const record = JSON.parse(raw) as {
        nick: string;
        channel: string;
        text: string;
        time: number;
      };
      const age = Date.now() - record.time;

      if (age > maxAgeMs) {
        api.db.del(`seen:${api.ircLower(targetNick)}`);
        ctx.reply(`I haven't seen ${targetNick}.`);
        return;
      }

      const ago = formatRelativeTime(age);
      ctx.reply(`${record.nick} was last seen ${ago} in ${record.channel} saying: ${record.text}`);
    } catch {
      ctx.reply(`I haven't seen ${targetNick}.`);
    }
  });

  // Hourly cleanup of stale entries
  api.bind('time', '-', '3600', () => {
    cleanupStale(api, maxAgeMs);
  });
}

export function teardown(): void {
  // No cleanup needed
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cleanupStale(api: PluginAPI, maxAgeMs: number): void {
  const now = Date.now();
  const entries = api.db.list('seen:');

  for (const entry of entries) {
    try {
      const record = JSON.parse(entry.value) as { time: number };
      if (now - record.time > maxAgeMs) {
        api.db.del(entry.key);
      }
    } catch {
      // Corrupt entry — remove it
      api.db.del(entry.key);
    }
  }
}

function formatRelativeTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h ago`;
}
