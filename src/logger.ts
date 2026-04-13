// HexBot — Logger service
// Structured console logging with level filtering, colored output, child
// loggers, and a multi-sink output model. Sinks let more than one consumer
// (REPL, DCC console, tests, future log files) observe every log line
// without stepping on each other — see `addSink`/`removeSink` below.
import chalk from 'chalk';
import { format } from 'node:util';

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
 * codes for sinks that don't want color. `source` carries the child
 * logger's prefix plus an optional `#<category>` suffix for callers that
 * declared an explicit category override.
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
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  private prefix: string | null;
  private readonly category: string | null;
  private levelRef: { value: LogLevel };

  /** Set of registered sinks. Iterated on every log line. */
  private static sinks: Set<LogSink> = new Set();

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

  /** Add a sink. Every subsequent log line is delivered to it. */
  static addSink(sink: LogSink): void {
    Logger.sinks.add(sink);
  }

  /** Remove a previously registered sink. */
  static removeSink(sink: LogSink): void {
    Logger.sinks.delete(sink);
  }

  /** Remove every registered sink, including the default console sink. */
  static clearSinks(): void {
    Logger.sinks.clear();
    Logger.hookWrapper = null;
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
    if (prefixPlain) {
      coloredParts.push(chalk.cyan(prefixPlain));
      plainParts.push(prefixPlain);
    }

    const formatted = format(...coloredParts, ...args);
    const plain = format(...plainParts, ...args);

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
