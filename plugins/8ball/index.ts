// 8ball — Magic 8-Ball plugin
// Responds to !8ball <question> with a random answer.
import type { PluginAPI } from '../../src/types';

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
  api.registerHelp([
    {
      command: '!8ball',
      flags: '-',
      usage: '!8ball <question>',
      description: 'Ask the magic 8-ball a yes/no question',
      category: 'fun',
    },
  ]);

  api.bind('pub', '-', '!8ball', (ctx) => {
    if (!ctx.args.trim()) {
      ctx.reply('Usage: !8ball <question>');
      return;
    }

    // Math.random is fine here — this is a fun toy, not a fairness or
    // security primitive. The classic 8-ball ratio (10/5/5 affirmative/
    // hedged/negative) is encoded by the order/count in RESPONSES.
    const answer = RESPONSES[Math.floor(Math.random() * RESPONSES.length)];
    ctx.reply(`🎱 ${answer}`);
  });
}

export function teardown(): void {
  // No cleanup needed — binds are auto-removed by the loader
}
