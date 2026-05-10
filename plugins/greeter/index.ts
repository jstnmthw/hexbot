// greeter — Configurable join greeting plugin with user-settable custom greets
import type { PluginAPI, PublicUserRecord } from '../../src/types';

export const name = 'greeter';
export const version = '3.0.0';
export const description = 'Greets users when they join; lets registered users set a custom greet';

/** Flag hierarchy order: n > m > o > v (lower index = higher privilege). */
const FLAG_ORDER = 'nmov';
/**
 * Hard cap on stored greet length. Comfortably under the IRC line limit
 * after `{nick}`/`{channel}` substitution and leaves headroom for server
 * prefixes so a user-set greet can never truncate mid-UTF-8-codepoint.
 */
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

/**
 * Plugin entry point. Wires up the JOIN handler that emits greetings,
 * registers the `!greet` user-facing command, and registers the per-channel
 * `greet_msg` setting through `api.channelSettings`.
 *
 * State scoped inside this function (the massjoin rate-limit map) is
 * intentional: it keeps each plugin reload's closure isolated so the GC
 * can collect the previous module's state once the loader drops it.
 */
export function init(api: PluginAPI): void {
  api.registerHelp([
    {
      command: '!greet',
      flags: '-',
      usage: '!greet [set <message>|del]',
      description: 'View, set, or delete your custom join greeting',
      detail: ['Use {nick} and {channel} in your message for substitution.'],
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

  api.settings.register([
    {
      key: 'min_flag',
      type: 'string',
      default: 'v',
      description: 'Minimum flag required to set/del a custom greet (n>m>o>v)',
      allowedValues: ['n', 'm', 'o', 'v'],
    },
    {
      key: 'delivery',
      type: 'string',
      default: 'say',
      description: 'How to deliver join greetings: say (PRIVMSG to channel) or channel_notice',
      allowedValues: ['say', 'channel_notice'],
    },
    {
      key: 'join_notice',
      type: 'string',
      default: '',
      description: 'Optional NOTICE sent privately to the joining nick (empty = no notice)',
    },
    {
      key: 'message',
      type: 'string',
      default: 'Welcome to {channel}, {nick}!',
      description: 'Default join greeting (used as default for the per-channel greet_msg setting)',
    },
  ]);

  // Snapshot at init: these affect handler dispatch (which API call is made
  // and which permission gate triggers); changing them mid-process needs a
  // .restart for clarity. The per-greet message text is read live below
  // through channelSettings.getString — that path picks up `.set` writes
  // immediately.
  const minFlag = api.settings.getString('min_flag') || 'v';
  const delivery = api.settings.getString('delivery') || 'say';
  const joinNotice = api.settings.getString('join_notice');

  // Per-channel join-rate tracking to debounce netsplit rejoin
  // floods. Without this, a heal with 50+ simultaneous rejoins
  // pushes 50 greet lines in a few seconds — which the bot's
  // message queue will rate-limit, but still looks like spam in
  // the channel. Above `MASSJOIN_THRESHOLD` joins within
  // `MASSJOIN_WINDOW_MS`, greetings are suppressed until the rate
  // falls below the threshold.
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

  // Register per-channel greeting setting; default reflects the plugin-scope
  // `message` value so a `.set greeter message <text>` cascades into the
  // default for any channel that hasn't pinned its own greet_msg.
  api.channelSettings.register([
    {
      key: 'greet_msg',
      type: 'string',
      default: api.settings.getString('message') || 'Welcome to {channel}, {nick}!',
      description: 'Per-channel join greeting ({channel} and {nick} substituted)',
    },
  ]);

  // --- Bot-PART / bot-KICK: drop massjoin state for the channel we just
  // left so the map doesn't accumulate one entry per channel-ever-visited
  // across the bot's lifetime. Mirrors chanmod's `dropChannelState` pattern.
  const dropJoinRate = (channel: string): void => {
    joinRates.delete(api.ircLower(channel));
  };
  api.bind('part', '-', '*', (ctx) => {
    if (api.isBotNick(ctx.nick)) dropJoinRate(ctx.channel);
  });
  api.bind('kick', '-', '*', (ctx) => {
    // `ctx.nick` is the *kicked* user on a 'kick' bind (per dispatch.ts).
    if (api.isBotNick(ctx.nick)) dropJoinRate(ctx.channel);
  });

  // --- Join handler ---
  api.bind('join', '-', '*', (ctx) => {
    // Don't greet ourselves when the bot rejoins (e.g. after a kick or a
    // reconnect): the bot's own JOIN fires this handler too.
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

/**
 * Plugin teardown. Binds, help entries, and channel-setting registrations
 * are reaped by the loader; the per-init `joinRates` map is dropped with
 * the module's closure graph.
 */
export function teardown(): void {}
