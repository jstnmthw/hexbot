// greeter — Configurable join greeting plugin with user-settable custom greets
import type { PluginAPI, PublicUserRecord } from '../../src/types';

export const name = 'greeter';
export const version = '3.0.0';
export const description = 'Greets users when they join; lets registered users set a custom greet';

/** Flag hierarchy order: n > m > o > v (lower index = higher privilege). */
const FLAG_ORDER = 'nmov';
const MAX_GREET_LEN = 200;

/**
 * KV key for a user's custom greet, namespaced by their permission handle.
 * Kept as a helper so the `greet:` prefix lives in exactly one place — any
 * future schema change (versioning, per-channel greets, etc.) only needs to
 * edit this function.
 */
function greetKey(handle: string): string {
  return `greet:${handle}`;
}

/** Read a string-typed config entry, returning `fallback` when absent or wrong-typed. */
function cfgString(config: Record<string, unknown>, key: string, fallback: string): string {
  const v = config[key];
  return typeof v === 'string' ? v : fallback;
}

/**
 * Returns true if the user record has at least the privilege level of minFlag,
 * using the n > m > o > v hierarchy.
 */
export function meetsMinFlag(
  record: PublicUserRecord,
  minFlag: string,
  channel: string | null,
): boolean {
  const minLevel = FLAG_ORDER.indexOf(minFlag);
  if (minLevel === -1) return false;

  const flagsMeet = (flags: string): boolean => {
    for (const f of flags) {
      const lvl = FLAG_ORDER.indexOf(f);
      if (lvl !== -1 && lvl <= minLevel) return true;
    }
    return false;
  };

  if (flagsMeet(record.global)) return true;

  if (channel) {
    const chanFlags = record.channels[channel];
    if (chanFlags && flagsMeet(chanFlags)) return true;
  }

  return false;
}

export function init(api: PluginAPI): void {
  api.registerHelp([
    {
      command: '!greet',
      flags: '-',
      usage: '!greet [set <message>|del]',
      description: 'View, set, or delete your custom join greeting',
      detail: [
        'Use {nick} and {channel} in your message for substitution.',
        `Requires +${cfgString(api.config, 'min_flag', 'v')} to set or delete.`,
      ],
      category: 'general',
    },
    {
      command: '!greet set',
      flags: '-',
      usage: '!greet set <message>',
      description: 'Set a custom join greeting — supports {nick} and {channel}',
      category: 'general',
    },
    {
      command: '!greet del',
      flags: '-',
      usage: '!greet del',
      description: 'Delete your custom join greeting',
      category: 'general',
    },
  ]);

  const minFlag = cfgString(api.config, 'min_flag', 'v');
  const delivery = cfgString(api.config, 'delivery', 'say');
  const joinNotice = cfgString(api.config, 'join_notice', '');

  // Per-channel join-rate tracking to debounce netsplit rejoin
  // floods. Without this, a heal with 50+ simultaneous rejoins
  // pushes 50 greet lines in a few seconds — which the bot's
  // message queue will rate-limit, but still looks like spam in
  // the channel. Above `MASSJOIN_THRESHOLD` joins within
  // `MASSJOIN_WINDOW_MS`, greetings are suppressed until the rate
  // falls below the threshold. See stability audit 2026-04-14.
  const MASSJOIN_WINDOW_MS = 10_000;
  const MASSJOIN_THRESHOLD = 5;
  const MASSJOIN_COOLDOWN_MS = 30_000;
  interface JoinRateEntry {
    windowStart: number;
    count: number;
    suppressUntil: number;
  }
  const joinRates = new Map<string, JoinRateEntry>();
  const isMassJoinInProgress = (channel: string, now: number): boolean => {
    const key = api.ircLower(channel);
    let state = joinRates.get(key);
    if (!state) {
      state = { windowStart: now, count: 0, suppressUntil: 0 };
      joinRates.set(key, state);
    }
    if (now < state.suppressUntil) {
      return true;
    }
    if (now - state.windowStart > MASSJOIN_WINDOW_MS) {
      state.windowStart = now;
      state.count = 0;
    }
    state.count++;
    if (state.count > MASSJOIN_THRESHOLD) {
      state.suppressUntil = now + MASSJOIN_COOLDOWN_MS;
      api.warn(
        `Massjoin detected on ${channel} (${state.count} joins in ${MASSJOIN_WINDOW_MS / 1000}s) — suppressing greetings for ${MASSJOIN_COOLDOWN_MS / 1000}s`,
      );
      return true;
    }
    return false;
  };

  // Register per-channel greeting setting; default reflects the global config value
  api.channelSettings.register([
    {
      key: 'greet_msg',
      type: 'string',
      default: cfgString(api.config, 'message', 'Welcome to {channel}, {nick}!'),
      description: 'Per-channel join greeting ({channel} and {nick} substituted)',
    },
  ]);

  // --- Join handler ---
  api.bind('join', '-', '*', (ctx) => {
    if (api.isBotNick(ctx.nick)) return;

    const { channel } = ctx;

    // Massjoin debounce — see init-scope helper above.
    if (isMassJoinInProgress(channel, Date.now())) return;

    // Precedence: user custom greet > channel greet_msg setting > global default
    let greeting = api.channelSettings.getString(channel, 'greet_msg');

    const hostmask = api.buildHostmask(ctx);
    const record = api.permissions.findByHostmask(hostmask);
    if (record) {
      const custom = api.db.get(greetKey(record.handle));
      if (custom !== undefined) greeting = custom;
    }

    const text = greeting
      .replace(/\{channel\}/g, channel)
      .replace(/\{nick\}/g, api.stripFormatting(ctx.nick));

    if (delivery === 'channel_notice') {
      api.notice(channel, text);
    } else {
      ctx.reply(text); // 'say' — PRIVMSG to channel (default)
    }

    if (joinNotice) {
      const noticeText = joinNotice
        .replace(/[\r\n]/g, '')
        .replace(/\{channel\}/g, channel)
        .replace(/\{nick\}/g, api.stripFormatting(ctx.nick));
      api.notice(ctx.nick, noticeText);
    }
  });

  // --- !greet command ---
  api.bind('pub', '-', '!greet', async (ctx) => {
    const sub = ctx.args.trim();

    // !greet (no args) — show current greet
    if (!sub) {
      const record = api.permissions.findByHostmask(api.buildHostmask(ctx));
      if (!record) {
        ctx.replyPrivate('No custom greet set.');
        return;
      }
      const current = api.db.get(greetKey(record.handle));
      ctx.replyPrivate(current !== undefined ? `Your greet: ${current}` : 'No custom greet set.');
      return;
    }

    // !greet set <message>
    if (sub.startsWith('set ') || sub === 'set') {
      const rawMsg = sub.slice(4).trim();
      if (!rawMsg) {
        ctx.replyPrivate('Usage: !greet set <message>');
        return;
      }
      const hostmask = api.buildHostmask(ctx);
      const record = api.permissions.findByHostmask(hostmask);
      if (!record) {
        ctx.replyPrivate('You must be a registered user to set a greet.');
        return;
      }
      if (!meetsMinFlag(record, minFlag, api.ircLower(ctx.channel))) {
        ctx.replyPrivate(`You need at least +${minFlag} to set a custom greet.`);
        return;
      }
      // Strip IRC control codes on write (in addition to CRLF) so a user
      // can't seed a greet with `\x03` / `\x02` and have it rendered back
      // later as colored or bold spoof lines.
      const sanitized = api
        .stripFormatting(rawMsg)
        .replace(/[\r\n\0]/g, '')
        .slice(0, MAX_GREET_LEN);
      api.db.set(greetKey(record.handle), sanitized);
      ctx.replyPrivate('Custom greet set.');
      return;
    }

    // !greet del
    if (sub === 'del') {
      const hostmask = api.buildHostmask(ctx);
      const record = api.permissions.findByHostmask(hostmask);
      if (!record) {
        ctx.replyPrivate('You must be a registered user to remove a greet.');
        return;
      }
      if (!meetsMinFlag(record, minFlag, api.ircLower(ctx.channel))) {
        ctx.replyPrivate(`You need at least +${minFlag} to remove a custom greet.`);
        return;
      }
      api.db.del(greetKey(record.handle));
      ctx.replyPrivate('Custom greet removed.');
      return;
    }

    ctx.replyPrivate('Usage: !greet | !greet set <message> | !greet del');
  });
}

export function teardown(): void {
  // Binds are auto-removed by the plugin loader
}
