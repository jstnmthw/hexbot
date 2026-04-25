// HexBot — Entry point
// Parses CLI args, starts the bot, optionally starts the REPL.
import { closeSync, openSync, readFileSync, unlinkSync, utimesSync } from 'node:fs';
import net from 'node:net';
import { basename } from 'node:path';

import { Bot } from './bot';
import { isRecoverableSocketError, shutdownWithTimeout } from './process-handlers';
import { BotREPL } from './repl';

// Disable Happy Eyeballs (RFC 8305) connection racing. Node.js tries multiple
// IPs simultaneously by default, which breaks under WireGuard + nftables
// policy routing where the fwmark-based routing confuses connection racing.
net.setDefaultAutoSelectFamily(false);

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
    // Best-effort — /tmp may be read-only in exotic containers (read-only
    // rootfs setups, --tmpfs mounted with `noexec,ro`). A failure here just
    // means the healthcheck won't see a heartbeat; the bot itself keeps
    // running, and an external supervisor can decide what to do.
  }
}

function removeHealthcheck(): void {
  try {
    unlinkSync(HEALTHCHECK_FILE);
  } catch {
    // File may not exist (never created — see touchHealthcheck above).
    // Idempotent on shutdown; nothing else to do.
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

// Accept both `--config PATH` and `--config=PATH` forms — docker-compose arrays
// commonly use the equals form, while shell invocations prefer the space form.
// First match wins; later occurrences are ignored. No validation here — the
// path is opened by `loadConfig()` and surfaces a clean error there.
function parseConfigArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--config') return argv[i + 1];
    if (arg.startsWith('--config=')) return arg.slice('--config='.length);
  }
  return undefined;
}
const configPath = parseConfigArg(args);

// Set process.title so htop/ps shows e.g. "hexbot (v0.2.3) - blueangel"
// instead of the full `tsx … --config=…` line. Read package.json relative
// to this file so it resolves under both `tsx src/index.ts` and `node dist/index.js`.
//
// Guard the parse: a malformed package.json during development (merge
// conflict marker, truncated write) should produce a clear error
// message, not a cryptic SyntaxError with no context. See stability
// audit 2026-04-14.
let pkgVersion = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as {
    version: string;
  };
  pkgVersion = pkg.version ?? '0.0.0';
} catch (err) {
  console.error('[bot] Failed to parse package.json for process title:', err);
}
const instanceName = configPath ? basename(configPath, '.json') : 'default';
process.title = `hexbot (v${pkgVersion}) - ${instanceName}`;

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

// Hard cap on any shutdown path — prevents the process hanging indefinitely
// when a subsystem's cleanup stalls (stuck socket drain, blocked flush, etc).
const SHUTDOWN_TIMEOUT_MS = 10_000;

async function runBotShutdown(): Promise<void> {
  if (!bot) return;
  const currentBot = bot;
  const result = await shutdownWithTimeout(() => currentBot.shutdown(), SHUTDOWN_TIMEOUT_MS);
  if (result === 'timeout') {
    console.error(`[bot] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
  }
}

async function gracefulShutdown(signal: string): Promise<void> {
  bot?.logger.child('bot').info(`Received ${signal}, shutting down...`);
  stopHeartbeat();
  await runBotShutdown();
  process.exit(0);
}

// Re-entrancy guard: once we've committed to a fatal exit, subsequent
// uncaught errors from shutdown itself should not restart the chain.
let fatalInProgress = false;

function fatalExit(label: string, value: unknown): void {
  if (fatalInProgress) return;
  fatalInProgress = true;
  console.error(`[bot] ${label}:`, value);
  stopHeartbeat();
  runBotShutdown().finally(() => process.exit(1));
}

process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});
process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});

// Bounded rate limiter on recoverable socket-read swallowing. If the bot
// ever ends up in a tight error loop (server is hanging up immediately
// on every reconnect, for example) we'd otherwise spin forever printing
// recovered errors. Past 100 in 60 seconds we escalate to fatalExit so
// the supervisor restarts us cleanly.
/** 60s sliding window — chosen to be long enough that a network blip producing
 *  a few burst errors doesn't trip the cap, but short enough that a sustained
 *  error storm escalates within ~one minute rather than letting the bot spin
 *  noisily for hours. */
const RECOVERABLE_RATE_WINDOW_MS = 60_000;
/** ~100 swallowed socket errors per minute is comfortably above any real
 *  network flap (a connect/disconnect cycle produces at most a handful) and
 *  comfortably below the rate at which a true tight-loop would saturate the
 *  log. Past this we escalate to fatalExit so the supervisor restarts cleanly. */
const RECOVERABLE_RATE_MAX = 100;
const recoverableTimestamps: number[] = [];

function noteRecoverable(): boolean {
  const now = Date.now();
  while (
    recoverableTimestamps.length > 0 &&
    now - recoverableTimestamps[0] > RECOVERABLE_RATE_WINDOW_MS
  ) {
    recoverableTimestamps.shift();
  }
  recoverableTimestamps.push(now);
  return recoverableTimestamps.length > RECOVERABLE_RATE_MAX;
}

process.on('uncaughtException', (err) => {
  if (isRecoverableSocketError(err)) {
    if (noteRecoverable()) {
      fatalExit(`Recoverable socket errors exceeded ${RECOVERABLE_RATE_MAX}/min`, err);
      return;
    }
    console.warn('[bot] Recovered socket read error (continuing):', err);
    return;
  }
  fatalExit('Uncaught exception', err);
});

process.on('unhandledRejection', (reason) => {
  if (isRecoverableSocketError(reason)) {
    if (noteRecoverable()) {
      fatalExit(`Recoverable socket errors exceeded ${RECOVERABLE_RATE_MAX}/min`, reason);
      return;
    }
    console.warn('[bot] Recovered socket read error (continuing):', reason);
    return;
  }
  fatalExit('Unhandled rejection', reason);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Top-level await would be cleaner but ESM top-level await requires Node 20
// and a tsconfig `module: "node20"` — for now keep the .catch() so a startup
// rejection produces a clean exit-1 instead of a default unhandled-rejection
// kill that confuses operators staring at the supervisor logs.
main().catch((err) => {
  console.error('[bot] Fatal error during startup:', err);
  process.exit(1);
});
