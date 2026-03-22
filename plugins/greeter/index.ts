// greeter — Configurable join greeting plugin
// Greets users when they join a channel with a customizable message template.
import type { HandlerContext, PluginAPI } from '../../src/types.js';

// eslint-disable-next-line no-control-regex
const IRC_FORMAT_RE = /[\x02\x03\x0F\x16\x1D\x1E\x1F]|\x03\d{1,2}(,\d{1,2})?/g;
function stripFormatting(s: string): string {
  return s.replace(IRC_FORMAT_RE, '');
}

export const name = 'greeter';
export const version = '1.0.0';
export const description = 'Greets users when they join a channel';

let botNick = '';

export function init(api: PluginAPI): void {
  const message = (api.config.message as string) ?? 'Welcome to {channel}, {nick}!';
  const irc = api.botConfig.irc as Record<string, unknown> | undefined;
  botNick = (irc?.nick as string) ?? '';

  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    // Don't greet the bot itself
    if (ctx.nick === botNick || ctx.nick.toLowerCase() === botNick.toLowerCase()) {
      return;
    }

    const greeting = message
      .replace(/\{channel\}/g, ctx.channel ?? '')
      .replace(/\{nick\}/g, stripFormatting(ctx.nick));

    ctx.reply(greeting);
  });
}

export function teardown(): void {
  // No cleanup needed
}
