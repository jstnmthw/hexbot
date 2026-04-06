// HexBot — Interactive REPL
// Provides a terminal interface for bot administration.
// Commands are routed through the same CommandHandler used by IRC.
import { type Interface as ReadlineInterface, createInterface } from 'node:readline';

import type { Bot } from './bot';
import { Logger } from './logger';
import { toEventObject } from './utils/irc-event';
import { sanitize } from './utils/sanitize';

// ---------------------------------------------------------------------------
// BotREPL
// ---------------------------------------------------------------------------

export class BotREPL {
  private bot: Bot;
  private rl: ReadlineInterface | null = null;
  private logger: Logger | null;
  private ircLogger: Logger | null;
  private ircListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(bot: Bot, logger?: Logger | null) {
    this.bot = bot;
    this.logger = logger?.child('repl') ?? null;
    this.ircLogger = logger?.child('irc') ?? null;
  }

  /** True while handleLine is executing — suppresses prompt redisplay in print(). */
  private busy = false;

  /** Print a line above the prompt without disrupting the input line. */
  private print(line: string): void {
    if (this.rl) {
      // Clear the current prompt line, print the message, then redisplay the prompt
      process.stdout.write('\r\x1b[K');
      console.log(line);
      if (!this.busy) this.rl.prompt(true);
    } else {
      console.log(line);
    }
  }

  /** Start the REPL. */
  start(): void {
    this.rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'hexbot> ',
    });

    // Mirror incoming private messages and notices to the console via the
    // logger so they get uniform timestamps/levels and respect level filtering.
    const onNotice = (event: unknown) => {
      const e = toEventObject(event);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      // Only print notices sent directly to the bot (not channel notices)
      if (target && /^[#&]/.test(target)) return;
      this.ircLogger?.debug(`-${sanitize(nick)}- ${sanitize(message)}`);
    };
    const onPrivmsg = (event: unknown) => {
      const e = toEventObject(event);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      // Only print private messages (not channel messages)
      if (target && /^[#&]/.test(target)) return;
      this.ircLogger?.debug(`<${sanitize(nick)}> ${sanitize(message)}`);
    };

    this.bot.client.on('notice', onNotice);
    this.bot.client.on('privmsg', onPrivmsg);
    this.ircListeners = [
      { event: 'notice', fn: onNotice },
      { event: 'privmsg', fn: onPrivmsg },
    ];

    // Route all logger output through print() so log lines don't collide with the prompt
    Logger.setOutputHook((line: string) => this.print(line));

    this.logger?.info('Interactive mode. Type .help for commands, .quit to exit.');

    this.rl.on('line', (line: string) => {
      this.handleLine(line).finally(() => {
        this.rl?.prompt();
      });
    });

    this.rl.on('close', () => {
      this.logger?.info('Shutting down...');
      this.bot.shutdown().then(() => process.exit(0));
    });

    this.rl.prompt();
  }

  /** Stop the REPL. */
  stop(): void {
    Logger.setOutputHook(null);
    for (const { event, fn } of this.ircListeners) {
      this.bot.client.removeListener(event, fn);
    }
    this.ircListeners = [];
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

    this.busy = true;
    try {
      this.logger?.info(`Command: ${trimmed}`);

      // Announce REPL activity to botnet so DCC-connected users see local admin work
      this.bot.dccManager?.announce(`*** REPL: ${trimmed}`);

      // Route through the command handler (REPL has implicit owner privileges)
      await this.bot.commandHandler.execute(trimmed, {
        source: 'repl',
        nick: 'REPL',
        channel: null,
        reply: (msg: string) => {
          this.print(msg);
        },
      });
    } finally {
      this.busy = false;
    }
  }
}
