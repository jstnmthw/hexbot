import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KV_RETENTION_DAYS, scheduleKvMaintenance } from '../../src/core/kv-maintenance';

interface FakeDb {
  pruneOlderThan: ReturnType<typeof vi.fn>;
  vacuum: ReturnType<typeof vi.fn>;
}

interface FakeLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  child: () => FakeLogger;
  setLevel: () => void;
}

const fakeLogger = (): FakeLogger => {
  const logger: FakeLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    setLevel: () => {},
  };
  return logger;
};

const fakeDb = (overrides?: Partial<FakeDb>): FakeDb => ({
  pruneOlderThan: vi.fn().mockReturnValue(0),
  vacuum: vi.fn(),
  ...overrides,
});

const ONE_DAY = 24 * 60 * 60 * 1000;

describe('scheduleKvMaintenance', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a stop handle that cancels the timer', () => {
    const db = fakeDb();
    const handle = scheduleKvMaintenance(db as never, fakeLogger() as never);
    handle.stop();
    vi.advanceTimersByTime(ONE_DAY * 2);
    expect(db.pruneOlderThan).not.toHaveBeenCalled();
  });

  it('runs the configured retention table on the daily tick', () => {
    const db = fakeDb({ pruneOlderThan: vi.fn().mockReturnValue(3) });
    const logger = fakeLogger();
    const handle = scheduleKvMaintenance(db as never, logger as never);
    vi.advanceTimersByTime(ONE_DAY);
    expect(db.pruneOlderThan).toHaveBeenCalledTimes(KV_RETENTION_DAYS.length);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('kv daily prune'));
    handle.stop();
  });

  it('isolates a prune failure for one namespace from the rest', () => {
    const db = fakeDb({
      pruneOlderThan: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('boom');
        })
        .mockReturnValue(0),
    });
    const logger = fakeLogger();
    const handle = scheduleKvMaintenance(db as never, logger as never);
    vi.advanceTimersByTime(ONE_DAY);
    expect(db.pruneOlderThan).toHaveBeenCalledTimes(KV_RETENTION_DAYS.length);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('kv prune failed'),
      expect.any(Error),
    );
    handle.stop();
  });

  it('only vacuums after the monthly interval elapses', () => {
    const db = fakeDb();
    const handle = scheduleKvMaintenance(db as never, fakeLogger() as never);
    // First daily tick — well before 30 days, no vacuum.
    vi.advanceTimersByTime(ONE_DAY);
    expect(db.vacuum).not.toHaveBeenCalled();
    // 30 daily ticks later — interval has elapsed.
    vi.advanceTimersByTime(ONE_DAY * 30);
    expect(db.vacuum).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it('logs but does not throw if vacuum fails', () => {
    const db = fakeDb({
      vacuum: vi.fn(() => {
        throw new Error('disk full');
      }),
    });
    const logger = fakeLogger();
    const handle = scheduleKvMaintenance(db as never, logger as never);
    vi.advanceTimersByTime(ONE_DAY * 31);
    expect(db.vacuum).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('kv VACUUM failed'),
      expect.any(Error),
    );
    handle.stop();
  });

  it('accepts a custom retention list', () => {
    const db = fakeDb();
    const custom = [{ ns: 'plugin:test', days: 1 }];
    const handle = scheduleKvMaintenance(db as never, fakeLogger() as never, custom);
    vi.advanceTimersByTime(ONE_DAY);
    expect(db.pruneOlderThan).toHaveBeenCalledTimes(1);
    expect(db.pruneOlderThan).toHaveBeenCalledWith('plugin:test', 1);
    handle.stop();
  });
});
