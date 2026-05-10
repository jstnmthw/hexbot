// HexBot — Logger service
// Structured console logging with level filtering, colored output, child
// loggers, and a multi-sink output model. Sinks let more than one consumer
// (REPL, DCC console, tests, future log files) observe every log line
// without stepping on each other — see `addSink`/`removeSink` below.
import chalk from 'chalk';
import { format } from 'node:util';

/**
 * Strip control bytes that have no business in a non-terminal log sink.
 * Drops `\r`, `\x00`, mIRC color codes (`\x02`/`\x03`/`\x0f`/`\x16`/`\x1d`/
 * `\x1e`/`\x1f`), and the lone bell. Newlines and tab survive so
 * multi-line stack traces still render correctly.
 */
function stripLogControls(input: string): string {
  // eslint-disable-next-line no-control-regex -- IRC formatting + bell
  return input.replace(/[\x00\x02\x03\x07\x0f\x16\x1d\x1e\x1f\r]/g, '');
}

/**
 * Field names whose values are redacted if they end up in a log line as a
 * `key=value` or `"key":"value"` pair. Defense-in-depth — no current call
 * path logs the config object or credential tuples directly, but a future
 * careless caller shouldn't be able to leak a password into `[bot]`
 * output. Keep the list short and biased toward true positives (matches
 * on exact key names, not substrings).
 */
const REDACT_FIELDS = [
  'password',
  'password_env',
  'password_hash',
  'sasl',
  'sasl_password',
  'token',
  'secret',
  'api_key',
  'apiKey',
];
/** Matches JSON-shaped credential pairs: `"password":"value"` (handles
 *  embedded `\"` escape sequences in the value). Captures the key+colon
 *  preamble in $1 so we can rewrite the value while preserving the key. */
const REDACT_JSON_RE = new RegExp(
  `("(?:${REDACT_FIELDS.join('|')})"\\s*:\\s*)"[^"\\\\]*(?:\\\\.[^"\\\\]*)*"`,
  'gi',
);
/** Matches loose `key=value`, `key: value`, or `key="value"` shapes outside
 *  of JSON — e.g. how an Error.toString or `util.format('%j')` of a partial
 *  object might surface a credential. Word-boundary anchored to avoid
 *  matching `mypassword` as the key `password`. */
const REDACT_ASSIGN_RE = new RegExp(
  `\\b(${REDACT_FIELDS.join('|')})\\s*[:=]\\s*(?:"[^"]*"|'[^']*'|\\S+)`,
  'gi',
);

/**
 * Replace the value portion of any `REDACT_FIELDS`-named key inside `s`.
 * Handles both JSON-shaped (`"password":"abc"`) and loose (`password=abc`,
 * `password: abc`) forms. Purely defensive — callers should still avoid
 * logging credential-bearing objects.
 */
function redactCredentialFields(s: string): string {
  return s.replace(REDACT_JSON_RE, '$1"[REDACTED]"').replace(REDACT_ASSIGN_RE, '$1=[REDACTED]');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Log level names. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric priority for each level (higher = more severe). */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Short labels for output. */
const LEVEL_LABELS: Record<LogLevel, string> = {
  debug: 'DBG',
  info: 'INF',
  warn: 'WRN',
  error: 'ERR',
};

/** Chalk colorizers for each level label. */
const LEVEL_COLORS: Record<LogLevel, (s: string) => string> = {
  debug: chalk.gray,
  info: chalk.blue,
  warn: chalk.yellow,
  error: chalk.red,
};

/**
 * A structured log record delivered to each sink. `formatted` is the
 * colorized, console-ready string; `plain` is the same output with no ANSI
 * codes for sinks that don't want color. `dccFormatted` is the colorized
 * line with the leading `HH:MM:SS` time stamp omitted — DCC clients
 * timestamp inbound lines themselves, so the server-side time is just
 * noise on the partyline. `source` carries the child logger's prefix plus
 * an optional `#<category>` suffix for callers that declared an explicit
 * category override.
 */
export interface LogRecord {
  level: LogLevel;
  timestamp: Date;
  /** Prefix like 'bot', 'plugin:chanmod', 'plugin:chanmod#k', or null for root. */
  source: string | null;
  /** Formatted, colorized line identical to what would go to the console. */
  formatted: string;
  /** Raw message text with no ANSI, for sinks that don't want color. */
  plain: string;
  /** Colorized line without the leading `HH:MM:SS` time stamp, for DCC consoles. */
  dccFormatted: string;
}

export type LogSink = (record: LogRecord) => void;

/** Options accepted by {@link Logger.child}. */
export interface ChildLoggerOptions {
  /**
   * Single-letter DCC console category override. When set, the child
   * logger's source is recorded as `"<prefix>#<category>"` so sinks can
   * route the line to a specific console flag regardless of the default
   * prefix-to-category table.
   */
  category?: string;
}

// ---------------------------------------------------------------------------
// LoggerLike — the narrow interface consumers should depend on
// ---------------------------------------------------------------------------

/**
 * The instance surface of {@link Logger}. Consumers should type their
 * logger field as `LoggerLike` so tests can pass plain mock objects
 * without `as unknown as Logger` casts. `Logger implements LoggerLike`
 * keeps the two in lockstep.
 */
export interface LoggerLike {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  child(prefix: string, options?: ChildLoggerOptions): LoggerLike;
  setLevel(level: LogLevel): void;
  getLevel(): LogLevel;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger implements LoggerLike {
  private prefix: string | null;
  private readonly category: string | null;
  private levelRef: { value: LogLevel };

  /** Set of registered sinks. Iterated on every log line. */
  private static sinks: Set<LogSink> = new Set();

  /**
   * Owner → sinks installed by that owner. Lets a caller (typically a
   * plugin) bulk-remove every sink it installed via a single
   * `removeByOwner(name)` instead of having to track each `LogSink`
   * reference for `removeSink()`. Mirrors the
   * `BotEventBus.trackListener` / `removeByOwner` pattern.
   */
  private static sinksByOwner: Map<string, Set<LogSink>> = new Map();

  /** Default sink that writes to console.log / console.error. */
  private static readonly consoleSink: LogSink = (record) => {
    if (record.level === 'error') {
      console.error(record.formatted);
    } else {
      console.log(record.formatted);
    }
  };

  /** The wrapper sink installed by the current setOutputHook caller, if any. */
  private static hookWrapper: LogSink | null = null;

  /**
   * Ensure the default console sink is registered. Called from
   * {@link createLogger} so every root logger starts with stdout coverage,
   * unless a {@link setOutputHook} caller is already owning stdout.
   */
  static ensureConsoleSink(): void {
    if (!Logger.hookWrapper && !Logger.sinks.has(Logger.consoleSink)) {
      Logger.sinks.add(Logger.consoleSink);
    }
  }

  /**
   * Sink-count threshold above which {@link addSink} logs a warning. Plugins
   * should `removeSink` in `teardown()`, so a steady climb past this
   * suggests a teardown leak — every leaked sink holds a closure over
   * the unloaded plugin's module scope. Adjust upward only after
   * auditing what the legitimate set looks like in production.
   */
  private static readonly SINK_WARN_THRESHOLD = 8;
  /** True after we've already warned about exceeding SINK_WARN_THRESHOLD. */
  private static sinkWarnFired = false;

  /** Number of currently registered sinks (for diagnostics / audits). */
  static sinkCount(): number {
    return Logger.sinks.size;
  }

  /** Add a sink. Every subsequent log line is delivered to it. */
  static addSink(sink: LogSink): void {
    Logger.sinks.add(sink);
    if (Logger.sinks.size > Logger.SINK_WARN_THRESHOLD && !Logger.sinkWarnFired) {
      Logger.sinkWarnFired = true;
      console.warn(
        `[logger] sink count is ${Logger.sinks.size} (threshold ${Logger.SINK_WARN_THRESHOLD}). ` +
          'Plugins must removeSink() in teardown() — suspect leak if this keeps climbing.',
      );
    }
  }

  /** Remove a previously registered sink. */
  static removeSink(sink: LogSink): void {
    Logger.sinks.delete(sink);
    // Drop the sink from any owner-tracked set as well so a subsequent
    // `removeByOwner` doesn't try to delete an already-released sink.
    for (const [owner, set] of Logger.sinksByOwner) {
      if (set.delete(sink) && set.size === 0) Logger.sinksByOwner.delete(owner);
    }
    // Re-arm the warning once the count drops back under the threshold so
    // a future re-leak warns instead of silently growing past it again.
    if (Logger.sinks.size <= Logger.SINK_WARN_THRESHOLD) Logger.sinkWarnFired = false;
  }

  /**
   * Register a sink and tag it with `owner` so a single
   * `removeByOwner(owner)` releases everything that owner installed.
   * Plugins should prefer this over {@link addSink} — without an owner
   * tag, every sink registered before a missed `removeSink` becomes
   * impossible to find without the original `LogSink` reference, which
   * a plugin reload typically loses.
   */
  static addSinkByOwner(owner: string, sink: LogSink): void {
    Logger.addSink(sink);
    let set = Logger.sinksByOwner.get(owner);
    if (!set) {
      set = new Set();
      Logger.sinksByOwner.set(owner, set);
    }
    set.add(sink);
  }

  /** Remove every sink that `owner` installed via {@link addSinkByOwner}. */
  static removeByOwner(owner: string): void {
    const set = Logger.sinksByOwner.get(owner);
    if (!set) return;
    for (const sink of set) Logger.sinks.delete(sink);
    Logger.sinksByOwner.delete(owner);
    if (Logger.sinks.size <= Logger.SINK_WARN_THRESHOLD) Logger.sinkWarnFired = false;
  }

  /** Remove every registered sink, including the default console sink. */
  static clearSinks(): void {
    Logger.sinks.clear();
    Logger.sinksByOwner.clear();
    Logger.hookWrapper = null;
    Logger.sinkWarnFired = false;
  }

  /**
   * @deprecated Prefer {@link addSink} / {@link removeSink}. Kept as a thin
   * compatibility wrapper so the REPL (which clears the prompt before
   * printing) does not need to change. Installing a hook replaces the
   * default console sink; clearing the hook restores it.
   */
  static setOutputHook(hook: ((line: string) => void) | null): void {
    if (Logger.hookWrapper) {
      Logger.sinks.delete(Logger.hookWrapper);
      Logger.hookWrapper = null;
    }
    if (hook) {
      // The hook owns stdout — drop the console sink so we don't double-print.
      Logger.sinks.delete(Logger.consoleSink);
      Logger.hookWrapper = (record) => hook(record.formatted);
      Logger.sinks.add(Logger.hookWrapper);
    } else {
      // Restore the default console sink if nothing else is covering it.
      if (!Logger.sinks.has(Logger.consoleSink)) {
        Logger.sinks.add(Logger.consoleSink);
      }
    }
  }

  /**
   * @param prefix  - Prefix shown in brackets, e.g. 'bot' → [bot]. Null for root.
   * @param levelRef - Shared mutable reference so setLevel on root affects all children.
   * @param category - Optional DCC-console category override embedded in `source`.
   */
  constructor(
    prefix: string | null,
    levelRef: { value: LogLevel },
    category: string | null = null,
  ) {
    this.prefix = prefix;
    this.levelRef = levelRef;
    this.category = category;
  }

  /** Create a child logger that shares the same level reference. */
  child(prefix: string, options?: ChildLoggerOptions): Logger {
    return new Logger(prefix, this.levelRef, options?.category ?? null);
  }

  /** Set the log level (affects this logger and all children sharing the same root). */
  setLevel(level: LogLevel): void {
    this.levelRef.value = level;
  }

  /** Get the current log level. */
  getLevel(): LogLevel {
    return this.levelRef.value;
  }

  /** Log at debug level. */
  debug(...args: unknown[]): void {
    this.write('debug', args);
  }

  /** Log at info level. */
  info(...args: unknown[]): void {
    this.write('info', args);
  }

  /** Log at warn level. */
  warn(...args: unknown[]): void {
    this.write('warn', args);
  }

  /** Log at error level. */
  error(...args: unknown[]): void {
    this.write('error', args);
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private write(level: LogLevel, args: unknown[]): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.levelRef.value]) return;

    const time = this.formatTime();
    const labelPlain = LEVEL_LABELS[level];
    const prefixPlain = this.prefix ? `[${this.prefix}]` : '';

    const coloredParts: string[] = [chalk.gray(time), LEVEL_COLORS[level](labelPlain)];
    const plainParts: string[] = [time, labelPlain];
    const dccParts: string[] = [LEVEL_COLORS[level](labelPlain)];
    if (prefixPlain) {
      coloredParts.push(chalk.cyan(prefixPlain));
      plainParts.push(prefixPlain);
      dccParts.push(chalk.cyan(prefixPlain));
    }

    const formatted = redactCredentialFields(format(...coloredParts, ...args));
    // Strip control bytes from sinks that lack ANSI rendering — the file
    // sink and the DCC fanout both treat the line as literal text, so a
    // log line carrying a sanitized but still-mIRC-colored message can
    // poison downstream operator consoles. The colored stdout sink keeps
    // its ANSI escapes; only `plain` / `dccFormatted` are scrubbed.
    const plain = redactCredentialFields(stripLogControls(format(...plainParts, ...args)));
    const dccFormatted = redactCredentialFields(format(...dccParts, ...args));

    const source = this.prefix
      ? this.category
        ? `${this.prefix}#${this.category}`
        : this.prefix
      : null;

    const record: LogRecord = {
      level,
      timestamp: new Date(),
      source,
      formatted,
      plain,
      dccFormatted,
    };

    for (const sink of Logger.sinks) {
      try {
        sink(record);
        /* v8 ignore start -- defensive: sink errors shouldn't propagate */
      } catch {
        // Swallow — a buggy sink must not break other sinks or the caller.
      }
      /* v8 ignore stop */
    }
  }

  /**
   * Format the current time as `HH:MM:SS`. Date-less by design — log lines
   * are scanned line-by-line during incident response, and the date is
   * already available from the surrounding journalctl/file-rotation
   * envelope. Including it again would just consume column width. Sinks
   * that need a full timestamp should read `record.timestamp` (the raw
   * `Date`) instead of parsing this string.
   */
  private formatTime(): string {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    const s = String(now.getSeconds()).padStart(2, '0');
    return `${h}:${m}:${s}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a root logger with the given level.
 * All children created via `.child()` share the same mutable level reference.
 * Ensures the default console sink is installed so new callers see output
 * on stdout unless a prior `setOutputHook` has already claimed it.
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  Logger.ensureConsoleSink();
  return new Logger(null, { value: level });
}
