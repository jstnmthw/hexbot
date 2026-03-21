// n0xb0t — Interactive REPL
// Provides a terminal interface for bot administration.
// Commands are routed through the same CommandHandler used by IRC.

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import type { Bot } from './bot.js';
import type { Logger } from './logger.js';

// ---------------------------------------------------------------------------
// BotREPL
// ---------------------------------------------------------------------------

export class BotREPL {
  private bot: Bot;
  private rl: ReadlineInterface | null = null;
  private logger: Logger | null;

  constructor(bot: Bot, logger?: Logger | null) {
    this.bot = bot;
    this.logger = logger?.child('repl') ?? null;
  }

  /** Start the REPL. */
  start(): void {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'n0xb0t> ',
    });

    this.rl.prompt();

    this.rl.on('line', (line: string) => {
      this.handleLine(line).finally(() => {
        this.rl?.prompt();
      });
    });

    this.rl.on('close', () => {
      this.logger?.info('Shutting down...');
      this.bot.shutdown().then(() => process.exit(0));
    });

    this.logger?.info('Interactive mode. Type .help for commands, .quit to exit.');
  }

  /** Stop the REPL. */
  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;

    // REPL-only commands
    if (trimmed === '.quit' || trimmed === '.exit') {
      this.logger?.info('Shutting down...');
      await this.bot.shutdown();
      process.exit(0);
    }

    if (trimmed === '.clear') {
      console.clear();
      return;
    }

    console.log(`[repl] Command: ${trimmed}`);

    // Route through the command handler (REPL has implicit owner privileges)
    await this.bot.commandHandler.execute(trimmed, {
      source: 'repl',
      nick: 'REPL',
      channel: null,
      reply: (msg: string) => {
        console.log(msg);
      },
    });
  }
}
