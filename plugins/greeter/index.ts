// greeter — Configurable join greeting plugin with user-settable custom greets
import type { HandlerContext, PluginAPI, UserRecord } from '../../src/types';

// eslint-disable-next-line no-control-regex
const IRC_FORMAT_RE = /[\x02\x03\x0F\x16\x1D\x1E\x1F]|\x03\d{1,2}(,\d{1,2})?/g;
function stripFormatting(s: string): string {
  return s.replace(IRC_FORMAT_RE, '');
}

export const name = 'greeter';
export const version = '2.1.0';
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
    const chanFlags = record.channels[channel.toLowerCase()];
    if (chanFlags && flagsMeet(chanFlags)) return true;
  }

  return false;
}

let botNick = '';

export function init(api: PluginAPI): void {
  api.registerHelp([
    {
      command: '!greet',
      flags: '-',
      usage: '!greet [set <message>|delete]',
      description: 'View, set, or delete your custom join greeting',
      category: 'general',
    },
  ]);

  const message = (api.config.message as string) ?? 'Welcome to {channel}, {nick}!';
  const allowCustom = (api.config.allow_custom as boolean) ?? false;
  const minFlag = (api.config.min_flag as string) ?? 'v';
  const delivery = (api.config.delivery as string) ?? 'say';
  const joinNotice = (api.config.join_notice as string) ?? '';
  const irc = api.botConfig.irc as Record<string, unknown> | undefined;
  botNick = (irc?.nick as string) ?? '';

  // --- Join handler ---
  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    if (api.ircLower(ctx.nick) === api.ircLower(botNick)) return;

    let greeting = message;

    if (allowCustom) {
      const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
      const record = api.permissions.findByHostmask(hostmask);
      if (record) {
        const custom = api.db.get(`greet:${record.handle}`);
        if (custom !== undefined) greeting = custom;
      }
    }

    const text = greeting
      .replace(/\{channel\}/g, ctx.channel ?? '')
      .replace(/\{nick\}/g, stripFormatting(ctx.nick));

    if (delivery === 'channel_notice' && ctx.channel) {
      api.notice(ctx.channel, text);
    } else {
      ctx.reply(text); // 'say' — PRIVMSG to channel (default)
    }

    if (joinNotice) {
      const noticeText = joinNotice
        .replace(/[\r\n]/g, '')
        .replace(/\{channel\}/g, ctx.channel ?? '')
        .replace(/\{nick\}/g, stripFormatting(ctx.nick));
      api.notice(ctx.nick, noticeText);
    }
  });

  // --- !greet command ---
  api.bind('pub', '-', '!greet', async (ctx: HandlerContext) => {
    if (!allowCustom) {
      ctx.replyPrivate('Custom greets are disabled.');
      return;
    }

    const sub = ctx.args.trim();

    // !greet (no args) — show current greet
    if (!sub) {
      const record = api.permissions.findByHostmask(`${ctx.nick}!${ctx.ident}@${ctx.hostname}`);
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
      const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
      const record = api.permissions.findByHostmask(hostmask);
      if (!record) {
        ctx.replyPrivate('You must be a registered user to set a greet.');
        return;
      }
      if (!meetsMinFlag(record, minFlag, ctx.channel)) {
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
      const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
      const record = api.permissions.findByHostmask(hostmask);
      if (!record) {
        ctx.replyPrivate('You must be a registered user to remove a greet.');
        return;
      }
      if (!meetsMinFlag(record, minFlag, ctx.channel)) {
        ctx.replyPrivate(`You need at least +${minFlag} to remove a custom greet.`);
        return;
      }
      api.db.del(`greet:${record.handle}`);
      ctx.replyPrivate('Custom greet removed.');
      return;
    }

    ctx.replyPrivate('Usage: !greet | !greet set <message> | !greet del');
  });

  api.log('Loaded');
}

export function teardown(): void {
  // Binds are auto-removed by the plugin loader
}
