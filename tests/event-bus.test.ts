import { describe, expect, it, vi } from 'vitest';

import { BotEventBus } from '../src/event-bus';

describe('BotEventBus', () => {
  it('emit/on: listener receives event args', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.on('bot:disconnected', fn);
    bus.emit('bot:disconnected', 'ping timeout');
    expect(fn).toHaveBeenCalledWith('ping timeout');
  });

  it('once: listener fires exactly once', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.once('bot:connected', fn);
    bus.emit('bot:connected');
    bus.emit('bot:connected');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('off: removes a listener', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.on('bot:connected', fn);
    bus.off('bot:connected', fn);
    bus.emit('bot:connected');
    expect(fn).not.toHaveBeenCalled();
  });

  it('off: only removes the specified listener', () => {
    const bus = new BotEventBus();
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    bus.on('bot:connected', fn1);
    bus.on('bot:connected', fn2);
    bus.off('bot:connected', fn1);
    bus.emit('bot:connected');
    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledTimes(1);
  });

  it('once: listener can be removed before firing', () => {
    const bus = new BotEventBus();
    const fn = vi.fn();
    bus.once('bot:connected', fn);
    bus.off('bot:connected', fn);
    bus.emit('bot:connected');
    expect(fn).not.toHaveBeenCalled();
  });

  describe('trackListener / removeByOwner', () => {
    it('trackListener delivers events like on()', () => {
      const bus = new BotEventBus();
      const fn = vi.fn();
      bus.trackListener('plugin-x', 'bot:disconnected', fn);
      bus.emit('bot:disconnected', 'oops');
      expect(fn).toHaveBeenCalledWith('oops');
    });

    it('removeByOwner drops every tracked listener for that owner', () => {
      const bus = new BotEventBus();
      const connectedFn = vi.fn();
      const disconnectedFn = vi.fn();
      bus.trackListener('plugin-x', 'bot:connected', connectedFn);
      bus.trackListener('plugin-x', 'bot:disconnected', disconnectedFn);
      bus.removeByOwner('plugin-x');
      bus.emit('bot:connected');
      bus.emit('bot:disconnected', 'gone');
      expect(connectedFn).not.toHaveBeenCalled();
      expect(disconnectedFn).not.toHaveBeenCalled();
    });

    it('removeByOwner only affects the named owner', () => {
      const bus = new BotEventBus();
      const xFn = vi.fn();
      const yFn = vi.fn();
      bus.trackListener('plugin-x', 'bot:connected', xFn);
      bus.trackListener('plugin-y', 'bot:connected', yFn);
      bus.removeByOwner('plugin-x');
      bus.emit('bot:connected');
      expect(xFn).not.toHaveBeenCalled();
      expect(yFn).toHaveBeenCalledTimes(1);
    });

    it('removeByOwner for unknown owner is a no-op', () => {
      const bus = new BotEventBus();
      expect(() => bus.removeByOwner('nobody')).not.toThrow();
    });

    it('removeByOwner clears its registry so a second call is a no-op', () => {
      const bus = new BotEventBus();
      const fn = vi.fn();
      bus.trackListener('plugin-x', 'bot:connected', fn);
      bus.removeByOwner('plugin-x');
      bus.removeByOwner('plugin-x'); // second call — the owner entry is gone
      bus.emit('bot:connected');
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('listener-count thresholds', () => {
    it('warns once when crossing each configured threshold', () => {
      const bus = new BotEventBus();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Add 16 listeners to clear both the 10 and 15 thresholds.
        for (let i = 0; i < 16; i++) {
          bus.on('bot:connected', () => {});
        }
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.filter((m) => m.includes('threshold 10/20'))).toHaveLength(1);
        expect(messages.filter((m) => m.includes('threshold 15/20'))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('does not warn when listener count stays below the lowest threshold', () => {
      const bus = new BotEventBus();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        for (let i = 0; i < 9; i++) {
          bus.on('bot:connected', () => {});
        }
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
