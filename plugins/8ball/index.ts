// 8ball — Magic 8-Ball plugin
// Responds to !8ball <question> with a random answer.
import type { HandlerContext, PluginAPI } from '../../src/types.js';

export const name = '8ball';
export const version = '1.0.0';
export const description = 'Magic 8-Ball — ask a yes/no question';

const RESPONSES = [
  // Affirmative
  'It is certain.',
  'It is decidedly so.',
  'Without a doubt.',
  'Yes — definitely.',
  'You may rely on it.',
  'As I see it, yes.',
  'Most likely.',
  'Outlook good.',
  'Yes.',
  'Signs point to yes.',
  // Non-committal
  'Reply hazy, try again.',
  'Ask again later.',
  'Better not tell you now.',
  'Cannot predict now.',
  'Concentrate and ask again.',
  // Negative
  "Don't count on it.",
  'My reply is no.',
  'My sources say no.',
  'Outlook not so good.',
  'Very doubtful.',
];

export function init(api: PluginAPI): void {
  api.bind('pub', '-', '!8ball', (ctx: HandlerContext) => {
    if (!ctx.args.trim()) {
      ctx.reply('Usage: !8ball <question>');
      return;
    }

    const answer = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
    ctx.reply(`🎱 ${answer}`);
  });
}

export function teardown(): void {
  // No cleanup needed — binds are auto-removed by the loader
}
