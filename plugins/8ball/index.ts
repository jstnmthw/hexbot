// 8ball — Magic 8-Ball plugin
// Responds to !8ball <question> with a random answer.
import type { PluginAPI } from '../../src/types';

export const name = '8ball';
export const version = '1.0.0';
export const description = 'Magic 8-Ball — ask a yes/no question';

/**
 * Canonical 20-response Magic 8-Ball pool, ordered by category. Counts
 * (10 affirmative / 5 non-committal / 5 negative) match the physical toy's
 * icosahedron faces and produce its classic skew toward "yes". Reorder or
 * resize cautiously — uniform random selection over this array is what
 * gives the response distribution.
 */
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

/**
 * Plugin entry point. Registers the `!8ball` help entry and binds a `pub`
 * handler that emits a random response. Called once by the plugin loader on
 * load and again on reload.
 */
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

/**
 * Plugin teardown. Binds and help entries registered through the scoped
 * `PluginAPI` are tracked and reaped by the loader, so this hook has no
 * resources of its own to release.
 */
export function teardown(): void {}
