import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type LogRecord, type LogSink, Logger, createLogger } from '../src/logger';

describe('Logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    Logger.setOutputHook(null);
    Logger.clearSinks();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // createLogger
  // -------------------------------------------------------------------------

  describe('createLogger', () => {
    it('should create a logger with the specified level', () => {
      const logger = createLogger('warn');
      expect(logger.getLevel()).toBe('warn');
    });

    it('should default to info level', () => {
      const logger = createLogger();
      expect(logger.getLevel()).toBe('info');
    });
  });

  // -------------------------------------------------------------------------
  // Level filtering
  // -------------------------------------------------------------------------

  describe('level filtering', () => {
    it('should output messages at or above the configured level', () => {
      const logger = createLogger('info');

      logger.info('info message');
      logger.warn('warn message');
      logger.error('error message');

      // info and warn go to console.log, error goes to console.error
      expect(logSpy).toHaveBeenCalledTimes(2);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('should suppress messages below the configured level', () => {
      const logger = createLogger('warn');

      logger.debug('debug message');
      logger.info('info message');

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should show all messages at debug level', () => {
      const logger = createLogger('debug');

      logger.debug('debug');
      logger.info('info');
      logger.warn('warn');
      logger.error('error');

      // debug, info, warn go to console.log; error goes to console.error
      expect(logSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });

    it('should only show errors at error level', () => {
      const logger = createLogger('error');

      logger.debug('hidden');
      logger.info('hidden');
      logger.warn('hidden');
      logger.error('visible');

      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Output routing
  // -------------------------------------------------------------------------

  describe('output routing', () => {
    it('should route error() to console.error', () => {
      const logger = createLogger('debug');
      logger.error('test error');

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('should route debug/info/warn to console.log', () => {
      const logger = createLogger('debug');
      logger.debug('d');
      logger.info('i');
      logger.warn('w');

      expect(logSpy).toHaveBeenCalledTimes(3);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Output format
  // -------------------------------------------------------------------------

  describe('output format', () => {
    it('should include timestamp, level label, and message in output', () => {
      const logger = createLogger('info');
      logger.info('test message');

      expect(logSpy).toHaveBeenCalledTimes(1);
      const callArgs = logSpy.mock.calls[0];
      // The call should have multiple args: timestamp, level label, and the message
      // At minimum we check the message is present
      const fullOutput = callArgs.join(' ');
      expect(fullOutput).toContain('INF');
      expect(fullOutput).toContain('test message');
    });

    it('should include prefix when using child logger', () => {
      const logger = createLogger('info');
      const child = logger.child('mymodule');
      child.info('child message');

      const callArgs = logSpy.mock.calls[0];
      const fullOutput = callArgs.join(' ');
      expect(fullOutput).toContain('[mymodule]');
      expect(fullOutput).toContain('child message');
    });

    it('should include correct level labels', () => {
      const logger = createLogger('debug');

      logger.debug('d');
      logger.info('i');
      logger.warn('w');
      logger.error('e');

      expect(logSpy.mock.calls[0].join(' ')).toContain('DBG');
      expect(logSpy.mock.calls[1].join(' ')).toContain('INF');
      expect(logSpy.mock.calls[2].join(' ')).toContain('WRN');
      expect(errorSpy.mock.calls[0].join(' ')).toContain('ERR');
    });
  });

  // -------------------------------------------------------------------------
  // child()
  // -------------------------------------------------------------------------

  describe('child()', () => {
    it('should create a child with a prefix', () => {
      const root = createLogger('info');
      const child = root.child('dispatcher');
      child.info('dispatching');

      const callArgs = logSpy.mock.calls[0];
      const fullOutput = callArgs.join(' ');
      expect(fullOutput).toContain('[dispatcher]');
    });

    it('should share the same level reference between parent and child', () => {
      const root = createLogger('info');
      const child = root.child('test');

      // Child should follow root's level
      child.debug('hidden');
      expect(logSpy).not.toHaveBeenCalled();

      // Change root level
      root.setLevel('debug');
      child.debug('visible');
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('should propagate level changes from child to parent and siblings', () => {
      const root = createLogger('info');
      const childA = root.child('a');
      const childB = root.child('b');

      // Change via childA
      childA.setLevel('debug');

      // Root and childB should also be at debug
      expect(root.getLevel()).toBe('debug');
      expect(childB.getLevel()).toBe('debug');
    });

    it('should allow creating grandchild loggers', () => {
      const root = createLogger('info');
      const child = root.child('parent');
      const grandchild = child.child('grandchild');

      grandchild.info('nested');

      const callArgs = logSpy.mock.calls[0];
      const fullOutput = callArgs.join(' ');
      expect(fullOutput).toContain('[grandchild]');
    });
  });

  // -------------------------------------------------------------------------
  // setLevel / getLevel
  // -------------------------------------------------------------------------

  describe('setLevel / getLevel', () => {
    it('should change the level dynamically', () => {
      const logger = createLogger('error');
      expect(logger.getLevel()).toBe('error');

      logger.setLevel('debug');
      expect(logger.getLevel()).toBe('debug');
    });

    it('should take effect immediately', () => {
      const logger = createLogger('error');

      logger.info('hidden');
      expect(logSpy).not.toHaveBeenCalled();

      logger.setLevel('info');
      logger.info('visible');
      expect(logSpy).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple arguments
  // -------------------------------------------------------------------------

  describe('multiple arguments', () => {
    it('should include additional arguments in the formatted output', () => {
      const logger = createLogger('info');
      const obj = { key: 'value' };

      logger.info('message', obj, 42);

      const callArgs = logSpy.mock.calls[0];
      const fullOutput = callArgs.join(' ');
      expect(fullOutput).toContain('message');
      expect(fullOutput).toContain("key: 'value'");
      expect(fullOutput).toContain('42');
    });
  });

  // -------------------------------------------------------------------------
  // Output hook
  // -------------------------------------------------------------------------

  describe('output hook', () => {
    it('should route all output through the hook when set', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);
      const logger = createLogger('debug');

      logger.info('hello');

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toContain('INF');
      expect(hook.mock.calls[0][0]).toContain('hello');
      // console.log/error should NOT be called
      expect(logSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should route error-level output through the hook too', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);
      const logger = createLogger('debug');

      logger.error('boom');

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toContain('ERR');
      expect(hook.mock.calls[0][0]).toContain('boom');
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it('should resume normal console output when hook is cleared', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);
      const logger = createLogger('info');

      logger.info('hooked');
      expect(hook).toHaveBeenCalledTimes(1);
      expect(logSpy).not.toHaveBeenCalled();

      Logger.setOutputHook(null);
      logger.info('unhooked');
      expect(hook).toHaveBeenCalledTimes(1); // no additional calls
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('should still respect level filtering with the hook', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);
      const logger = createLogger('warn');

      logger.debug('hidden');
      logger.info('hidden');
      logger.warn('visible');

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toContain('WRN');
    });

    it('should include the child prefix in hooked output', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);
      const logger = createLogger('info');
      const child = logger.child('irc');

      child.info('test');

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toContain('[irc]');
      expect(hook.mock.calls[0][0]).toContain('test');
    });
  });

  // -------------------------------------------------------------------------
  // Multi-sink API
  // -------------------------------------------------------------------------

  describe('multi-sink output', () => {
    it('delivers records to sinks added via addSink alongside the console', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const logger = createLogger('info');
      logger.info('hello');

      // Console still receives the line (default consoleSink is not
      // removed when an additional sink is added).
      expect(logSpy).toHaveBeenCalledTimes(1);
      expect(sink).toHaveBeenCalledTimes(1);

      const record = sink.mock.calls[0][0];
      expect(record.level).toBe('info');
      expect(record.formatted).toContain('hello');
      expect(record.plain).toContain('hello');
      // eslint-disable-next-line no-control-regex
      expect(record.plain).not.toMatch(/\u001b\[/);
      expect(record.timestamp).toBeInstanceOf(Date);
      expect(record.source).toBeNull();
    });

    it('records the child prefix in LogRecord.source', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const root = createLogger('info');
      const child = root.child('plugin:chanmod');
      child.info('voiced bob');

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].source).toBe('plugin:chanmod');
    });

    it('embeds a category override in LogRecord.source', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const root = createLogger('info');
      const child = root.child('plugin:chanmod', { category: 'k' });
      child.info('ban foo');

      expect(sink.mock.calls[0][0].source).toBe('plugin:chanmod#k');
    });

    it('dccFormatted omits the time stamp but keeps the level label and prefix', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const root = createLogger('debug');
      root.child('plugin:chanmod').info('voiced bob');

      const record = sink.mock.calls[0][0];
      // No HH:MM:SS at the start of the line (strip ANSI first).
      // eslint-disable-next-line no-control-regex
      const dccPlain = record.dccFormatted.replace(/\u001b\[[0-9;]*m/g, '');
      expect(dccPlain).not.toMatch(/^\d{2}:\d{2}:\d{2}/);
      expect(dccPlain).toContain('INF');
      expect(dccPlain).toContain('[plugin:chanmod]');
      expect(dccPlain).toContain('voiced bob');
    });

    it('dccFormatted still labels debug/warn/error lines', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const root = createLogger('debug');
      root.child('dispatcher').debug('inside handler');
      root.child('plugin:chanmod').warn('heads up');
      root.child('plugin:chanmod').error('broke');

      // eslint-disable-next-line no-control-regex
      const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
      expect(strip(sink.mock.calls[0][0].dccFormatted)).toContain('DBG');
      expect(strip(sink.mock.calls[1][0].dccFormatted)).toContain('WRN');
      expect(strip(sink.mock.calls[2][0].dccFormatted)).toContain('ERR');
    });

    it('delivers each record to every registered sink', () => {
      const a = vi.fn<LogSink>();
      const b = vi.fn<LogSink>();
      Logger.addSink(a);
      Logger.addSink(b);

      const logger = createLogger('info');
      logger.info('fanout');

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
    });

    it('removeSink stops further delivery', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const logger = createLogger('info');
      logger.info('first');
      Logger.removeSink(sink);
      logger.info('second');

      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].plain).toContain('first');
    });

    it('a throwing sink does not break other sinks or the caller', () => {
      const boom = vi.fn<LogSink>(() => {
        throw new Error('boom');
      });
      const good = vi.fn<LogSink>();
      Logger.addSink(boom);
      Logger.addSink(good);

      const logger = createLogger('info');
      expect(() => logger.info('still works')).not.toThrow();
      expect(good).toHaveBeenCalledTimes(1);
      expect(good.mock.calls[0][0].plain).toContain('still works');
    });

    it('setOutputHook still receives formatted lines (back-compat)', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);

      const logger = createLogger('info');
      logger.info('legacy');

      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook.mock.calls[0][0]).toContain('legacy');
      // Console must NOT also receive it — the hook owns stdout.
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('setOutputHook coexists with an addSink caller', () => {
      const hook = vi.fn();
      const extra = vi.fn<LogSink>();
      Logger.setOutputHook(hook);
      Logger.addSink(extra);

      const logger = createLogger('info');
      logger.info('both');

      expect(hook).toHaveBeenCalledTimes(1);
      expect(extra).toHaveBeenCalledTimes(1);
      // Hook still owns stdout.
      expect(logSpy).not.toHaveBeenCalled();
    });

    it('setOutputHook(null) restores the default console sink', () => {
      const hook = vi.fn();
      Logger.setOutputHook(hook);
      Logger.setOutputHook(null);

      const logger = createLogger('info');
      logger.info('after clear');

      expect(hook).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledTimes(1);
    });

    it('delivers warn and error records with the correct level', () => {
      const sink = vi.fn<LogSink>();
      Logger.addSink(sink);

      const logger = createLogger('debug');
      logger.warn('w');
      logger.error('e');

      const levels = sink.mock.calls.map((c) => (c[0] as LogRecord).level);
      expect(levels).toEqual(['warn', 'error']);
    });
  });
});
