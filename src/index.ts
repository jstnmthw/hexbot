// HexBot — Entry point
// Parses CLI args, starts the bot, optionally starts the REPL.
import { closeSync, openSync, unlinkSync, utimesSync } from 'node:fs';

import { Bot } from './bot';
import { BotREPL } from './repl';

// ---------------------------------------------------------------------------
// Healthcheck heartbeat file
// ---------------------------------------------------------------------------

const HEALTHCHECK_FILE = '/tmp/.hexbot-healthy';
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

function touchHealthcheck(): void {
  try {
    // Create the file if missing, then update its mtime.
    // The Docker healthcheck uses `stat -c %Y` (mtime in seconds) — no content needed.
    closeSync(openSync(HEALTHCHECK_FILE, 'a'));
    const now = new Date();
    utimesSync(HEALTHCHECK_FILE, now, now);
  } catch {
    // Best-effort — /tmp may be read-only in exotic containers
  }
}

function removeHealthcheck(): void {
  try {
    unlinkSync(HEALTHCHECK_FILE);
  } catch {
    // File may not exist
  }
}

function startHeartbeat(): void {
  touchHealthcheck();
  heartbeatTimer = setInterval(touchHealthcheck, 30_000);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  removeHealthcheck();
}

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

  // Wire healthcheck heartbeat to connection events before start()
  // so the initial bot:connected is not missed.
  bot.eventBus.on('bot:connected', startHeartbeat);
  bot.eventBus.on('bot:disconnected', stopHeartbeat);

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
  stopHeartbeat();
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
