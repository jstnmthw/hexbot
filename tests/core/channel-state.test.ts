import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });
      expect(state.isUserInChannel('#test', 'Alice')).toBe(true);

      client.simulateEvent('part', { nick: 'Alice', channel: '#test' });
      expect(state.isUserInChannel('#test', 'Alice')).toBe(false);
    });
  });

  describe('quit', () => {
    it('should remove a user from all channels on quit', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#chan1',
      });
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#chan2',
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
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });

      client.simulateEvent('kick', {
        nick: 'Op',
        kicked: 'Alice',
        channel: '#test',
        message: 'bye',
      });

      expect(state.isUserInChannel('#test', 'Alice')).toBe(false);
    });
  });

  describe('nick change', () => {
    it('should update nick across all channels', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#chan1',
      });
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#chan2',
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
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Alice' }],
      });

      expect(state.getUserModes('#test', 'Alice')).toContain('o');
    });

    it('should remove mode o on -o', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
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
        nick: 'Bob',
        ident: 'bob',
        hostname: 'host',
        channel: '#test',
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
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.example.com',
        channel: '#test',
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
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
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

    it('should update ident/hostname on existing user from userlist', () => {
      // User joins first with partial info
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: '',
        hostname: '',
        channel: '#test',
      });

      // Then userlist arrives with full details
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Alice', ident: 'realident', hostname: 'real.host.com', modes: '' }],
      });

      const user = state.getUser('#test', 'Alice');
      expect(user).toBeDefined();
      expect(user!.ident).toBe('realident');
      expect(user!.hostname).toBe('real.host.com');
      expect(user!.hostmask).toBe('Alice!realident@real.host.com');
    });

    it('should update modes on existing user when userlist has modes', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });
      expect(state.getUserModes('#test', 'Alice')).toEqual([]);

      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Alice', ident: 'alice', hostname: 'host', modes: '@' }],
      });

      expect(state.getUserModes('#test', 'Alice')).toContain('o');
    });

    it('should not overwrite modes when userlist has empty modes on existing user', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });
      // Give Alice op via mode event
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Alice' }],
      });
      expect(state.getUserModes('#test', 'Alice')).toContain('o');

      // Userlist with empty modes should not overwrite
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Alice', ident: 'alice', hostname: 'host', modes: '' }],
      });

      expect(state.getUserModes('#test', 'Alice')).toContain('o');
    });

    it('should update only ident when hostname is empty on existing user', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'old',
        hostname: 'old.host',
        channel: '#test',
      });

      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Alice', ident: 'newident', hostname: '', modes: '' }],
      });

      const user = state.getUser('#test', 'Alice');
      expect(user!.ident).toBe('newident');
      expect(user!.hostname).toBe('old.host');
      expect(user!.hostmask).toBe('Alice!newident@old.host');
    });
  });

  describe('case insensitivity', () => {
    it('should look up channels and nicks case-insensitively', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#Test',
      });

      expect(state.getUser('#test', 'alice')).toBeDefined();
      expect(state.isUserInChannel('#TEST', 'ALICE')).toBe(true);
    });
  });

  describe('wholist', () => {
    it('should update ident and hostname from wholist', () => {
      // User joins with incomplete info
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: '',
        hostname: '',
        channel: '#test',
      });

      client.simulateEvent('wholist', {
        users: [{ nick: 'Alice', ident: 'realident', hostname: 'real.host.com', channel: '#test' }],
      });

      const user = state.getUser('#test', 'Alice');
      expect(user).toBeDefined();
      expect(user!.ident).toBe('realident');
      expect(user!.hostname).toBe('real.host.com');
      expect(user!.hostmask).toBe('Alice!realident@real.host.com');
    });

    it('should update multiple users across channels', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: '',
        hostname: '',
        channel: '#chan1',
      });
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: '',
        hostname: '',
        channel: '#chan2',
      });

      client.simulateEvent('wholist', {
        users: [
          { nick: 'Alice', ident: 'alice', hostname: 'alice.host', channel: '#chan1' },
          { nick: 'Bob', ident: 'bob', hostname: 'bob.host', channel: '#chan2' },
        ],
      });

      const alice = state.getUser('#chan1', 'Alice');
      expect(alice!.ident).toBe('alice');
      expect(alice!.hostname).toBe('alice.host');

      const bob = state.getUser('#chan2', 'Bob');
      expect(bob!.ident).toBe('bob');
      expect(bob!.hostname).toBe('bob.host');
    });

    it('should ignore wholist entries for unknown channels', () => {
      client.simulateEvent('wholist', {
        users: [{ nick: 'Ghost', ident: 'ghost', hostname: 'ghost.host', channel: '#unknown' }],
      });

      expect(state.getChannel('#unknown')).toBeUndefined();
      expect(state.getUser('#unknown', 'Ghost')).toBeUndefined();
    });

    it('should ignore wholist entries for unknown users in known channels', () => {
      // Create channel by joining someone
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });

      // Wholist mentions a user not in the channel
      client.simulateEvent('wholist', {
        users: [{ nick: 'Ghost', ident: 'ghost', hostname: 'ghost.host', channel: '#test' }],
      });

      expect(state.getUser('#test', 'Ghost')).toBeUndefined();
      // Alice should be unaffected
      expect(state.getUser('#test', 'Alice')).toBeDefined();
    });

    it('should handle wholist with no users array', () => {
      // Should not throw
      client.simulateEvent('wholist', {});
      expect(state.getChannel('#test')).toBeUndefined();
    });

    it('should skip wholist entries with missing nick or channel', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });

      client.simulateEvent('wholist', {
        users: [
          { nick: '', ident: 'x', hostname: 'x', channel: '#test' },
          { nick: 'Alice', ident: 'updated', hostname: 'updated.host', channel: '' },
        ],
      });

      // Alice should not have been updated since the entry for her had empty channel
      const alice = state.getUser('#test', 'Alice');
      expect(alice!.ident).toBe('alice');
      expect(alice!.hostname).toBe('host');
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

    it('should update topic on an existing channel', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });

      client.simulateEvent('topic', {
        channel: '#test',
        topic: 'New topic',
      });

      const ch = state.getChannel('#test');
      expect(ch!.topic).toBe('New topic');
      // Users should still be present
      expect(state.isUserInChannel('#test', 'Alice')).toBe(true);
    });

    it('should set empty topic', () => {
      client.simulateEvent('topic', {
        channel: '#test',
        topic: 'Initial topic',
      });
      expect(state.getChannel('#test')!.topic).toBe('Initial topic');

      client.simulateEvent('topic', {
        channel: '#test',
        topic: '',
      });
      expect(state.getChannel('#test')!.topic).toBe('');
    });

    it('should handle topic with missing channel gracefully', () => {
      // Should not throw
      client.simulateEvent('topic', { channel: '', topic: 'orphan topic' });
      // No channel created for empty name
    });
  });

  describe('parseUserlistModes', () => {
    it('should parse @ symbol as op mode', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Op', ident: 'op', hostname: 'host', modes: '@' }],
      });
      expect(state.getUserModes('#test', 'Op')).toEqual(['o']);
    });

    it('should parse + symbol as voice mode', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Voice', ident: 'voice', hostname: 'host', modes: '+' }],
      });
      expect(state.getUserModes('#test', 'Voice')).toEqual(['v']);
    });

    it('should parse % symbol as halfop mode', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Half', ident: 'half', hostname: 'host', modes: '%' }],
      });
      expect(state.getUserModes('#test', 'Half')).toEqual(['h']);
    });

    it('should parse letter modes (o, v, h)', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [
          { nick: 'UserO', ident: 'u', hostname: 'h', modes: 'o' },
          { nick: 'UserV', ident: 'u', hostname: 'h', modes: 'v' },
          { nick: 'UserH', ident: 'u', hostname: 'h', modes: 'h' },
        ],
      });

      expect(state.getUserModes('#test', 'UserO')).toEqual(['o']);
      expect(state.getUserModes('#test', 'UserV')).toEqual(['v']);
      expect(state.getUserModes('#test', 'UserH')).toEqual(['h']);
    });

    it('should parse combined mode symbols (@+)', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Both', ident: 'b', hostname: 'h', modes: '@+' }],
      });

      const modes = state.getUserModes('#test', 'Both');
      expect(modes).toContain('o');
      expect(modes).toContain('v');
      expect(modes).toHaveLength(2);
    });

    it('should parse all three symbols together (@%+)', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'All', ident: 'a', hostname: 'h', modes: '@%+' }],
      });

      const modes = state.getUserModes('#test', 'All');
      expect(modes).toContain('o');
      expect(modes).toContain('v');
      expect(modes).toContain('h');
      expect(modes).toHaveLength(3);
    });

    it('should return empty modes for undefined modes string', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'NoMode', ident: 'n', hostname: 'h' }],
      });

      expect(state.getUserModes('#test', 'NoMode')).toEqual([]);
    });

    it('should return empty modes for empty string', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Empty', ident: 'e', hostname: 'h', modes: '' }],
      });

      expect(state.getUserModes('#test', 'Empty')).toEqual([]);
    });
  });

  describe('setCasemapping', () => {
    it('rfc1459 (default): nick with [ is stored under {-folded key', () => {
      client.simulateEvent('join', {
        nick: '[Brace]',
        ident: 'b',
        hostname: 'host.com',
        channel: '#test',
      });
      // Retrievable via the original nick (ircLower folds [ to {)
      const user = state.getUser('#test', '[Brace]');
      expect(user).toBeDefined();
      expect(user!.nick).toBe('[Brace]');
    });

    it('ascii: nick with [ is NOT folded — stored and retrieved as [', () => {
      state.setCasemapping('ascii');
      client.simulateEvent('join', {
        nick: '[Brace]',
        ident: 'b',
        hostname: 'host.com',
        channel: '#test',
      });
      const user = state.getUser('#test', '[Brace]');
      expect(user).toBeDefined();
      expect(user!.nick).toBe('[Brace]');
      // Under ascii: {Brace} is a different key — not found
      expect(state.getUser('#test', '{Brace}')).toBeUndefined();
    });

    it('rfc1459: {Brace} lookup finds [Brace] entry', () => {
      client.simulateEvent('join', {
        nick: '[Brace]',
        ident: 'b',
        hostname: 'host.com',
        channel: '#test',
      });
      // rfc1459: [Brace] and {Brace} both fold to {brace}
      const user = state.getUser('#test', '{Brace}');
      expect(user).toBeDefined();
    });
  });
});
