// HexBot — Interactive REPL
// Provides a terminal interface for bot administration.
// Commands are routed through the same CommandHandler used by IRC.
import { type Interface as ReadlineInterface, createInterface } from 'node:readline';

import type { Bot } from './bot';
import { tryAudit } from './core/audit';
import { buildReplStartupLine, buildReplStartupSummary } from './core/dcc/login-summary';
import { Logger, type LoggerLike } from './logger';
import { toEventObject } from './utils/irc-event';
import { sanitize } from './utils/sanitize';

// ---------------------------------------------------------------------------
// BotREPL
// ---------------------------------------------------------------------------

export class BotREPL {
  private bot: Bot;
  private rl: ReadlineInterface | null = null;
  private logger: LoggerLike | null;
  private ircLogger: LoggerLike | null;
  private ircListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  constructor(bot: Bot, logger?: LoggerLike | null) {
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

    // Surface aggregate DCC auth failures since boot — the REPL has no
    // per-user login event of its own, so we anchor on `startedAt` and
    // print one line above the first prompt when there's anything to show.
    this.printStartupLoginSummary();

    this.rl.on('line', (line: string) => {
      // Both `.catch()` and `.finally()` are wired: `catch` swallows
      // unexpected rejections from deep within `handleLine` (which
      // would otherwise become unhandled-rejection fatal exits),
      // and `finally` re-prompts regardless of outcome so the REPL
      // never hangs with no prompt. See stability audit 2026-04-14.
      this.handleLine(line)
        .catch((err) => {
          this.logger?.error('REPL handleLine rejected:', err);
        })
        .finally(() => {
          this.rl?.prompt();
        });
    });

    this.rl.on('close', () => {
      this.logger?.info('Shutting down...');
      this.stop();
      this.bot.shutdown().then(() => process.exit(0));
    });

    this.rl.prompt();
  }

  /**
   * Print a one-line aggregate of DCC auth failures since bot start.
   * Anchored on `Bot.startedAt` (unix seconds) so the window is exactly
   * "since this process started" — no per-user login event is written
   * for REPL, so there is no prior-login anchor to fall back on.
   */
  private printStartupLoginSummary(): void {
    try {
      const bootTs = Math.floor(this.bot.startedAt / 1000);
      const summary = buildReplStartupSummary(this.bot.db, bootTs);
      const line = buildReplStartupLine(summary);
      if (line !== null) this.print(line);
    } catch (err) {
      this.logger?.warn('REPL startup login summary failed:', err);
    }
  }

  /** Stop the REPL. Idempotent — safe to call from rl.on('close') and .quit. */
  stop(): void {
    Logger.setOutputHook(null);
    for (const { event, fn } of this.ircListeners) {
      this.bot.client.removeListener(event, fn);
    }
    this.ircListeners = [];
    if (this.rl) {
      const rl = this.rl;
      this.rl = null;
      rl.close();
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

      // One audit row per REPL line, regardless of whether the command
      // itself writes its own row. Without this, a REPL session that
      // runs e.g. `.status` or any inspection command leaves no trace
      // in mod_log — operators auditing for "what did the local console
      // run" would have to guess from secondary logs.
      tryAudit(this.bot.db, makeReplCtx(this.print.bind(this)), {
        action: 'repl-command',
        reason: trimmed.slice(0, 256),
      });

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

function makeReplCtx(reply: (msg: string) => void) {
  return {
    source: 'repl' as const,
    nick: 'REPL',
    channel: null,
    reply,
  };
}
