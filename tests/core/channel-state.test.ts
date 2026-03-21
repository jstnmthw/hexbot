import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ChannelState } from '../../src/core/channel-state.js';
import { BotEventBus } from '../../src/event-bus.js';

// ---------------------------------------------------------------------------
// Mock IRC client
// ---------------------------------------------------------------------------

class MockClient extends EventEmitter {
  simulateEvent(event: string, data: Record<string, unknown>): void {
    this.emit(event, data);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelState', () => {
  let client: MockClient;
  let eventBus: BotEventBus;
  let state: ChannelState;

  beforeEach(() => {
    client = new MockClient();
    eventBus = new BotEventBus();
    state = new ChannelState(client, eventBus);
    state.attach();
  });

  afterEach(() => {
    state.detach();
  });

  describe('join', () => {
    it('should add a user to channel state on join', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host.com',
        channel: '#test',
      });

      const user = state.getUser('#test', 'Alice');
      expect(user).toBeDefined();
      expect(user!.nick).toBe('Alice');
      expect(user!.ident).toBe('alice');
      expect(user!.hostname).toBe('alice.host.com');
      expect(user!.hostmask).toBe('Alice!alice@alice.host.com');
      expect(user!.modes).toEqual([]);
    });
  });

  describe('part', () => {
    it('should remove a user on part', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#test',
      });
      expect(state.isUserInChannel('#test', 'Alice')).toBe(true);

      client.simulateEvent('part', { nick: 'Alice', channel: '#test' });
      expect(state.isUserInChannel('#test', 'Alice')).toBe(false);
    });
  });

  describe('quit', () => {
    it('should remove a user from all channels on quit', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#chan1',
      });
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#chan2',
      });

      expect(state.isUserInChannel('#chan1', 'Alice')).toBe(true);
      expect(state.isUserInChannel('#chan2', 'Alice')).toBe(true);

      client.simulateEvent('quit', { nick: 'Alice' });

      expect(state.isUserInChannel('#chan1', 'Alice')).toBe(false);
      expect(state.isUserInChannel('#chan2', 'Alice')).toBe(false);
    });
  });

  describe('kick', () => {
    it('should remove kicked user from channel', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#test',
      });

      client.simulateEvent('kick', {
        nick: 'Op', kicked: 'Alice', channel: '#test', message: 'bye',
      });

      expect(state.isUserInChannel('#test', 'Alice')).toBe(false);
    });
  });

  describe('nick change', () => {
    it('should update nick across all channels', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#chan1',
      });
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#chan2',
      });

      client.simulateEvent('nick', { nick: 'Alice', new_nick: 'Alice2' });

      expect(state.isUserInChannel('#chan1', 'Alice')).toBe(false);
      expect(state.isUserInChannel('#chan1', 'Alice2')).toBe(true);
      expect(state.isUserInChannel('#chan2', 'Alice2')).toBe(true);

      const user = state.getUser('#chan1', 'Alice2');
      expect(user!.nick).toBe('Alice2');
      expect(user!.hostmask).toBe('Alice2!alice@host');
    });
  });

  describe('mode changes', () => {
    it('should add mode o on +o', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#test',
      });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Alice' }],
      });

      expect(state.getUserModes('#test', 'Alice')).toContain('o');
    });

    it('should remove mode o on -o', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#test',
      });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Alice' }],
      });
      expect(state.getUserModes('#test', 'Alice')).toContain('o');

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '-o', param: 'Alice' }],
      });
      expect(state.getUserModes('#test', 'Alice')).not.toContain('o');
    });

    it('should handle +v mode', () => {
      client.simulateEvent('join', {
        nick: 'Bob', ident: 'bob', hostname: 'host', channel: '#test',
      });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+v', param: 'Bob' }],
      });

      expect(state.getUserModes('#test', 'Bob')).toContain('v');
    });
  });

  describe('getUser', () => {
    it('should return correct user info', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'alice.example.com', channel: '#test',
      });

      const user = state.getUser('#test', 'Alice');
      expect(user).toBeDefined();
      expect(user!.nick).toBe('Alice');
      expect(user!.ident).toBe('alice');
      expect(user!.hostname).toBe('alice.example.com');
    });
  });

  describe('getUserHostmask', () => {
    it('should return formatted hostmask string', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host.com', channel: '#test',
      });

      expect(state.getUserHostmask('#test', 'Alice')).toBe('Alice!alice@host.com');
    });

    it('should return undefined for unknown user', () => {
      expect(state.getUserHostmask('#test', 'Ghost')).toBeUndefined();
    });
  });

  describe('unknown channel', () => {
    it('should return undefined for unknown channels', () => {
      expect(state.getChannel('#nonexistent')).toBeUndefined();
      expect(state.getUser('#nonexistent', 'Alice')).toBeUndefined();
      expect(state.isUserInChannel('#nonexistent', 'Alice')).toBe(false);
    });
  });

  describe('userlist', () => {
    it('should bulk populate users from userlist event', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [
          { nick: 'Alice', ident: 'alice', hostname: 'host1', modes: '' },
          { nick: 'Bob', ident: 'bob', hostname: 'host2', modes: 'o' },
        ],
      });

      expect(state.isUserInChannel('#test', 'Alice')).toBe(true);
      expect(state.isUserInChannel('#test', 'Bob')).toBe(true);
      expect(state.getUserModes('#test', 'Bob')).toContain('o');
    });
  });

  describe('case insensitivity', () => {
    it('should look up channels and nicks case-insensitively', () => {
      client.simulateEvent('join', {
        nick: 'Alice', ident: 'alice', hostname: 'host', channel: '#Test',
      });

      expect(state.getUser('#test', 'alice')).toBeDefined();
      expect(state.isUserInChannel('#TEST', 'ALICE')).toBe(true);
    });
  });

  describe('topic', () => {
    it('should track channel topic', () => {
      client.simulateEvent('topic', {
        channel: '#test',
        topic: 'Welcome to #test!',
      });

      const ch = state.getChannel('#test');
      expect(ch).toBeDefined();
      expect(ch!.topic).toBe('Welcome to #test!');
    });
  });
});
