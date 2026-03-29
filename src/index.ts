// HexBot — Entry point
// Parses CLI args, starts the bot, optionally starts the REPL.
import { Bot } from './bot';
import { BotREPL } from './repl';

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const useRepl = args.includes('--repl');
const configIdx = args.indexOf('--config');
const configPath = configIdx !== -1 ? args[configIdx + 1] : undefined;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let bot: Bot | null = null;

async function main(): Promise<void> {
  bot = new Bot(configPath);

  await bot.start();

  if (useRepl) {
    const repl = new BotREPL(bot, bot.logger);
    repl.start();
  }
}

// ---------------------------------------------------------------------------
// Signal / error handlers
// ---------------------------------------------------------------------------

async function gracefulShutdown(signal: string): Promise<void> {
  bot?.logger.child('bot').info(`Received ${signal}, shutting down...`);
  if (bot) {
    await bot.shutdown();
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught exception:', err);
  if (bot) {
    bot.shutdown().finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled rejection:', reason);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error('[bot] Fatal error during startup:', err);
  process.exit(1);
});
