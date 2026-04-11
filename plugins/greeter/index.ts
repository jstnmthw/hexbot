// greeter — Configurable join greeting plugin with user-settable custom greets
import type { PluginAPI, UserRecord } from '../../src/types';

export const name = 'greeter';
export const version = '3.0.0';
export const description = 'Greets users when they join; lets registered users set a custom greet';

/** Flag hierarchy order: n > m > o > v (lower index = higher privilege). */
const FLAG_ORDER = 'nmov';
const MAX_GREET_LEN = 200;

/**
 * Returns true if the user record has at least the privilege level of minFlag,
 * using the n > m > o > v hierarchy.
 */
export function meetsMinFlag(record: UserRecord, minFlag: string, channel: string | null): boolean {
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
        `Requires +${(api.config.min_flag as string) ?? 'v'} to set or delete.`,
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

  const minFlag = (api.config.min_flag as string) ?? 'v';
  const delivery = (api.config.delivery as string) ?? 'say';
  const joinNotice = (api.config.join_notice as string) ?? '';

  // Register per-channel greeting setting; default reflects the global config value
  api.channelSettings.register([
    {
      key: 'greet_msg',
      type: 'string',
      default: (api.config.message as string) ?? 'Welcome to {channel}, {nick}!',
      description: 'Per-channel join greeting ({channel} and {nick} substituted)',
    },
  ]);

  // --- Join handler ---
  api.bind('join', '-', '*', (ctx) => {
    if (api.isBotNick(ctx.nick)) return;

    const { channel } = ctx;

    // Precedence: user custom greet > channel greet_msg setting > global default
    let greeting = api.channelSettings.getString(channel, 'greet_msg');

    const hostmask = api.buildHostmask(ctx);
    const record = api.permissions.findByHostmask(hostmask);
    if (record) {
      const custom = api.db.get(`greet:${record.handle}`);
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
      const current = api.db.get(`greet:${record.handle}`);
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
      const sanitized = rawMsg.replace(/[\r\n]/g, '').slice(0, MAX_GREET_LEN);
      api.db.set(`greet:${record.handle}`, sanitized);
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
      api.db.del(`greet:${record.handle}`);
      ctx.replyPrivate('Custom greet removed.');
      return;
    }

    ctx.replyPrivate('Usage: !greet | !greet set <message> | !greet del');
  });
}

export function teardown(): void {
  // Binds are auto-removed by the plugin loader
}
