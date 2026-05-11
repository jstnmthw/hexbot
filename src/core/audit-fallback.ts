// HexBot — bounded in-memory ring buffer for audit rows that the SQLite
// layer could not persist (SQLITE_BUSY/FULL/IOERR). Wired as the database's
// `setAuditFallback` sink so disk-full or fatal-DB conditions don't silently
// lose audit rows. The buffer is bounded — old entries are FIFO-dropped when
// the cap is reached so a long degraded period doesn't bloat memory.
// Operators see the count via `.status`; the raw entries can be retrieved
// by core commands for triage.
import type { LogModActionOptions } from './mod-log';

const DEFAULT_CAPACITY = 256;

export class AuditFallbackBuffer {
  private readonly buffer: LogModActionOptions[] = [];
  private overflowCount = 0;

  constructor(private readonly capacity: number = DEFAULT_CAPACITY) {}

  /**
   * Append an audit-fallback entry. FIFO-evicts the oldest entry once the
   * buffer is full so memory cannot grow unbounded during a long degraded
   * period.
   */
  push(options: LogModActionOptions): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
      this.overflowCount++;
    }
    this.buffer.push(options);
  }

  /**
   * Defensive snapshot copy so callers can iterate without seeing concurrent
   * mutations. Used by `.status` and ops triage.
   */
  snapshot(): LogModActionOptions[] {
    return this.buffer.slice();
  }

  /**
   * Number of audit rows currently held plus how many were dropped due to
   * overflow. `dropped` is monotonic for the buffer's lifetime — it does
   * not reset when the buffer is read.
   */
  stats(): { held: number; dropped: number } {
    return { held: this.buffer.length, dropped: this.overflowCount };
  }
}
