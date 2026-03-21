// n0xb0t — Logger service
// Structured console logging with level filtering, colored output, and child loggers.

import chalk from 'chalk';

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

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  private prefix: string | null;
  private levelRef: { value: LogLevel };

  /**
   * @param prefix  - Prefix shown in brackets, e.g. 'bot' → [bot]. Null for root.
   * @param levelRef - Shared mutable reference so setLevel on root affects all children.
   */
  constructor(prefix: string | null, levelRef: { value: LogLevel }) {
    this.prefix = prefix;
    this.levelRef = levelRef;
  }

  /** Create a child logger that shares the same level reference. */
  child(prefix: string): Logger {
    return new Logger(prefix, this.levelRef);
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

    const timestamp = chalk.gray(this.formatTime());
    const label = LEVEL_COLORS[level](LEVEL_LABELS[level]);
    const prefixStr = this.prefix ? chalk.cyan(`[${this.prefix}]`) : '';

    const parts = [timestamp, label];
    if (prefixStr) parts.push(prefixStr);

    if (level === 'error') {
      console.error(...parts, ...args);
    } else {
      console.log(...parts, ...args);
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
 */
export function createLogger(level: LogLevel = 'info'): Logger {
  return new Logger(null, { value: level });
}
