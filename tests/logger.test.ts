import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLogger } from '../src/logger.js';

describe('Logger', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
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
    it('should pass through additional arguments', () => {
      const logger = createLogger('info');
      const obj = { key: 'value' };

      logger.info('message', obj, 42);

      const callArgs = logSpy.mock.calls[0];
      // Should contain the extra args after the formatted parts
      expect(callArgs).toContain(obj);
      expect(callArgs).toContain(42);
    });
  });
});
