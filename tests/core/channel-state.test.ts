import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelState } from '../../src/core/channel-state';
import { BotEventBus } from '../../src/event-bus';

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

    it('does not throw when parting an unknown channel', () => {
      // PART for a channel the bot never joined — should be a no-op
      expect(() => {
        client.simulateEvent('part', { nick: 'Alice', channel: '#unknown' });
      }).not.toThrow();
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
    it('ignores mode events for untracked targets (e.g. user modes)', () => {
      // MODE BotNick +i — target is not a channel we track
      client.simulateEvent('mode', {
        target: 'BotNick',
        modes: [{ mode: '+i', param: '' }],
      });

      // Should not throw and should not create a channel entry
      expect(state.getChannel('BotNick')).toBeUndefined();
    });

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

    it('silently ignores mode change for a user not in channel state', () => {
      // A different user joins so the channel exists in state, but Ghost is not tracked
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });

      // Mode event for Ghost — user not in state; exercises if (user) false branch
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Ghost' }],
      });

      expect(state.getUser('#test', 'Ghost')).toBeUndefined();
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

    it('handles userlist with missing channel field', () => {
      // Defensive: irc-framework should always provide channel, but the coercion handles it
      client.simulateEvent('userlist', {
        users: [{ nick: 'Ghost', ident: 'g', hostname: 'h', modes: '' }],
      });
      // Creates channel '' which is harmless; key assertion is no crash
      expect(state.isUserInChannel('', 'Ghost')).toBe(true);
    });

    it('skips hostmask update when both ident and hostname are empty in userlist update', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host.com',
        channel: '#test',
      });

      // Userlist with both empty — only modes should update
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Alice', ident: '', hostname: '', modes: 'o' }],
      });

      const user = state.getUser('#test', 'Alice');
      expect(user!.ident).toBe('alice');
      expect(user!.hostname).toBe('alice.host.com');
      expect(user!.hostmask).toBe('Alice!alice@alice.host.com');
      expect(user!.modes).toContain('o');
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

    it('handles topic event with no topic field (??-fallback covers branch)', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'a',
        hostname: 'a.host',
        channel: '#test',
      });
      expect(() => {
        client.simulateEvent('topic', { channel: '#test' }); // no topic field
      }).not.toThrow();
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

    it('returns early when event.users is not an array of objects', () => {
      // Should not throw or create any channel state
      expect(() => {
        client.simulateEvent('userlist', {
          channel: '#test',
          users: 'not-an-array',
        });
      }).not.toThrow();

      expect(state.getChannel('#test')).toBeUndefined();
    });

    it('returns early when event.users is undefined', () => {
      expect(() => {
        client.simulateEvent('userlist', {
          channel: '#test',
          // no users field
        });
      }).not.toThrow();

      expect(state.getChannel('#test')).toBeUndefined();
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

  // -------------------------------------------------------------------------
  // IRCv3: extended-join, account-notify, chghost
  // -------------------------------------------------------------------------

  describe('IRCv3 extended-join', () => {
    it('stores account name when extended-join provides one', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: 'AliceAccount',
      });

      expect(state.getAccountForNick('Alice')).toBe('AliceAccount');
      expect(state.getUser('#test', 'Alice')!.accountName).toBe('AliceAccount');
    });

    it('stores null when extended-join account is false (not identified)', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: false,
      });

      expect(state.getAccountForNick('Alice')).toBeNull();
      expect(state.getUser('#test', 'Alice')!.accountName).toBeNull();
    });

    it('stores null when extended-join account is null', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: null,
      });

      expect(state.getAccountForNick('Alice')).toBeNull();
      expect(state.getUser('#test', 'Alice')!.accountName).toBeNull();
    });

    it('returns undefined for a nick with no account-notify/extended-join data', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        // no account field — server didn't negotiate extended-join
      });

      expect(state.getAccountForNick('Alice')).toBeUndefined();
    });
  });

  describe('IRCv3 account-notify', () => {
    it('updates account name when user identifies', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: false,
      });
      expect(state.getAccountForNick('Alice')).toBeNull();

      client.simulateEvent('account', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        account: 'AliceAccount',
      });

      expect(state.getAccountForNick('Alice')).toBe('AliceAccount');
      expect(state.getUser('#test', 'Alice')!.accountName).toBe('AliceAccount');
    });

    it('clears account name when user deidentifies', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: 'AliceAccount',
      });
      expect(state.getAccountForNick('Alice')).toBe('AliceAccount');

      client.simulateEvent('account', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        account: false,
      });

      expect(state.getAccountForNick('Alice')).toBeNull();
      expect(state.getUser('#test', 'Alice')!.accountName).toBeNull();
    });
  });

  describe('IRCv3 account-notify event emissions', () => {
    // These tests exercise the event-bus surface added for late-authentication
    // reconciliation (docs/services-identify-before-join.md). The old behaviour
    // just updated cache state silently; now the transition itself is surfaced
    // to chanmod and other subscribers.
    it('emits user:identified when a nick transitions from no account to an account', () => {
      const seen: Array<[string, string]> = [];
      eventBus.on('user:identified', (nick, account) => seen.push([nick, account]));

      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
        account: false,
      });
      client.simulateEvent('account', { nick: 'Alice', account: 'AliceAcct' });

      expect(seen).toEqual([['Alice', 'AliceAcct']]);
    });

    it('emits user:deidentified with previous account when a nick deidentifies', () => {
      const seen: Array<[string, string]> = [];
      eventBus.on('user:deidentified', (nick, prev) => seen.push([nick, prev]));

      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
        account: 'AliceAcct',
      });
      client.simulateEvent('account', { nick: 'Alice', account: false });

      expect(seen).toEqual([['Alice', 'AliceAcct']]);
    });

    it('suppresses events on a no-op duplicate account-notify', () => {
      const idents: unknown[] = [];
      const deidents: unknown[] = [];
      eventBus.on('user:identified', (...a) => idents.push(a));
      eventBus.on('user:deidentified', (...a) => deidents.push(a));

      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
        account: 'AliceAcct',
      });
      // The join already seeded the account — a duplicate notify must not re-fire.
      client.simulateEvent('account', { nick: 'Alice', account: 'AliceAcct' });

      expect(idents).toEqual([]);
      expect(deidents).toEqual([]);
    });

    it('account switch A→B fires both deidentify(prev) and identify(new) in order', () => {
      const log: Array<['id' | 'de', string, string]> = [];
      eventBus.on('user:identified', (n, a) => log.push(['id', n, a]));
      eventBus.on('user:deidentified', (n, p) => log.push(['de', n, p]));

      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
        account: 'AcctA',
      });
      client.simulateEvent('account', { nick: 'Alice', account: 'AcctB' });

      expect(log).toEqual([
        ['de', 'Alice', 'AcctA'],
        ['id', 'Alice', 'AcctB'],
      ]);
    });
  });

  describe('IRCv3 account-notify edge cases', () => {
    it('account event for nick not in a tracked channel still updates networkAccounts', () => {
      // Bob is in the channel; Ghost is not — covers the if(user) false branch in the loop
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: 'bob',
        hostname: 'bob.host',
        channel: '#test',
      });
      client.simulateEvent('account', { nick: 'Ghost', account: 'GhostAccount' });
      expect(state.getAccountForNick('Ghost')).toBe('GhostAccount');
      // Bob's accountName should not be set to GhostAccount
      expect(state.getUser('#test', 'Bob')?.accountName).not.toBe('GhostAccount');
    });
  });

  describe('IRCv3 chghost', () => {
    it('updates ident and hostname on user updated event', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'old.host.com',
        channel: '#test',
      });

      client.simulateEvent('user updated', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'old.host.com',
        new_ident: 'newident',
        new_hostname: 'cloaked.host.net',
      });

      const user = state.getUser('#test', 'Alice')!;
      expect(user.ident).toBe('newident');
      expect(user.hostname).toBe('cloaked.host.net');
      expect(user.hostmask).toBe('Alice!newident@cloaked.host.net');
    });

    it('updates only ident when new_hostname is absent', () => {
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: 'bob',
        hostname: 'bob.host.com',
        channel: '#test',
      });
      client.simulateEvent('user updated', { nick: 'Bob', new_ident: 'newbob' });
      const user = state.getUser('#test', 'Bob')!;
      expect(user.ident).toBe('newbob');
      expect(user.hostname).toBe('bob.host.com'); // unchanged
    });

    it('updates only hostname when new_ident is absent', () => {
      client.simulateEvent('join', {
        nick: 'Carol',
        ident: 'carol',
        hostname: 'carol.host.com',
        channel: '#test',
      });
      client.simulateEvent('user updated', { nick: 'Carol', new_hostname: 'cloaked.carol.net' });
      const user = state.getUser('#test', 'Carol')!;
      expect(user.ident).toBe('carol'); // unchanged
      expect(user.hostname).toBe('cloaked.carol.net');
    });

    it('ignores user updated event with neither new_ident nor new_hostname', () => {
      client.simulateEvent('join', {
        nick: 'Dave',
        ident: 'dave',
        hostname: 'dave.host.com',
        channel: '#test',
      });
      client.simulateEvent('user updated', { nick: 'Dave' }); // neither field present
      const user = state.getUser('#test', 'Dave')!;
      expect(user.ident).toBe('dave'); // unchanged
    });

    it('silently skips update for user not in any tracked channel (covers if(user) false branch)', () => {
      // Bob is in #test; Nobody is not — covers the false branch of if(user) in the loop
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: 'bob',
        hostname: 'bob.host.com',
        channel: '#test',
      });
      expect(() => {
        client.simulateEvent('user updated', {
          nick: 'Nobody',
          new_ident: 'newident',
          new_hostname: 'new.host',
        });
      }).not.toThrow();
      // Bob should be unaffected
      expect(state.getUser('#test', 'Bob')?.ident).toBe('bob');
    });
  });

  describe('account tracking on nick change and quit', () => {
    it('carries account forward when user changes nick', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: 'AliceAccount',
      });
      expect(state.getAccountForNick('Alice')).toBe('AliceAccount');

      client.simulateEvent('nick', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        new_nick: 'Alice2',
      });

      expect(state.getAccountForNick('Alice2')).toBe('AliceAccount');
      expect(state.getAccountForNick('Alice')).toBeUndefined();
    });

    it('removes account from map on quit', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
        account: 'AliceAccount',
      });
      expect(state.getAccountForNick('Alice')).toBe('AliceAccount');

      client.simulateEvent('quit', { nick: 'Alice' });

      expect(state.getAccountForNick('Alice')).toBeUndefined();
    });
  });

  describe('??-fallback branches (missing event fields)', () => {
    it('returns empty array from getUserModes for non-existent user', () => {
      // user?.modes ?? []: user is undefined → ?. gives undefined → ?? returns []
      expect(state.getUserModes('#test', 'Ghost')).toEqual([]);
    });

    it('handles join with missing nick/ident/hostname fields', () => {
      // event.nick ?? '', event.ident ?? '', event.hostname ?? '' right branches triggered
      client.simulateEvent('join', { channel: '#test' });
      expect(state.getUser('#test', '')).toBeDefined();
    });

    it('handles part with missing nick field', () => {
      // event.nick ?? '' right branch triggered
      client.simulateEvent('join', { nick: 'Y', ident: 'y', hostname: 'y.host', channel: '#test' });
      expect(() => {
        client.simulateEvent('part', { channel: '#test' }); // nick missing → ''
      }).not.toThrow();
    });

    it('handles part with missing channel field', () => {
      // event.channel ?? '' right branch triggered; pre-create '' channel so the ! assertion is safe
      client.simulateEvent('join', { nick: 'Y', ident: 'y', hostname: 'y.host', channel: '' });
      expect(() => {
        client.simulateEvent('part', { nick: 'Y' }); // channel missing → ''
      }).not.toThrow();
    });

    it('handles quit with missing nick field', () => {
      // event.nick ?? '' right branch triggered (nick = '' → deletes '' from all channels, no-op)
      expect(() => {
        client.simulateEvent('quit', { message: 'gone' }); // no nick
      }).not.toThrow();
    });

    it('handles kick with missing kicked field', () => {
      // event.kicked ?? '' right branch triggered
      client.simulateEvent('join', {
        nick: 'Kicker',
        ident: 'k',
        hostname: 'k.host',
        channel: '#test',
      });
      expect(() => {
        client.simulateEvent('kick', { nick: 'Kicker', channel: '#test' }); // no kicked
      }).not.toThrow();
    });

    it('handles kick with missing channel field', () => {
      // event.channel ?? '' right branch triggered; channels.get('') → undefined → if(ch) false branch
      expect(() => {
        client.simulateEvent('kick', { nick: 'Kicker', kicked: 'Alice' }); // no channel
      }).not.toThrow();
    });

    it('handles wholist entry with undefined channel field', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host.com',
        channel: '#test',
      });
      // Entry with no channel field — falls back to '' which won't match any tracked channel
      client.simulateEvent('wholist', {
        users: [{ nick: 'Alice', ident: 'updated', hostname: 'updated.host' }],
      });
      // Alice should be unchanged since channel defaulted to '' (no match)
      expect(state.getUser('#test', 'Alice')!.ident).toBe('alice');
    });

    it('handles wholist entry with undefined nick/ident/hostname fields', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'host',
        channel: '#test',
      });
      // Entry with channel but no nick/ident/hostname — ?? '' fallbacks triggered
      client.simulateEvent('wholist', {
        users: [{ channel: '#test' }], // missing nick, ident, hostname
      });
      // Should not throw; the user (nick='') doesn't match Alice
      expect(state.getUser('#test', 'Alice')!.ident).toBe('alice');
    });

    it('handles userlist entry with undefined nick/ident/hostname fields', () => {
      // Fire a userlist event with an entry missing nick/ident/hostname — ?? '' fallbacks
      expect(() => {
        client.simulateEvent('userlist', {
          channel: '#test',
          users: [{ modes: '' }], // no nick/ident/hostname fields
        });
      }).not.toThrow();
    });

    it('handles topic event with undefined channel field', () => {
      // channel defaults to '' via ??; ensureChannel('') creates an empty-string entry but doesn't throw
      expect(() => {
        client.simulateEvent('topic', { topic: 'orphan' });
      }).not.toThrow();
    });

    it('handles account event with undefined nick field', () => {
      // nick defaults to '' — should not throw
      expect(() => {
        client.simulateEvent('account', { account: 'SomeAccount' });
      }).not.toThrow();
    });

    it('handles user updated event with undefined nick field', () => {
      // nick defaults to '' — no channel entry to update; should not throw
      expect(() => {
        client.simulateEvent('user updated', { new_ident: 'x', new_hostname: 'y' });
      }).not.toThrow();
    });

    it('handles mode event entry with no param field (falsy param branch)', () => {
      // m.param falsy → param = '' branch in `m.param ? String(m.param) : ''`
      client.simulateEvent('join', { nick: 'Alice', ident: 'a', hostname: 'h', channel: '#test' });
      expect(() => {
        client.simulateEvent('mode', {
          target: '#test',
          modes: [{ mode: '+m' }], // no param
        });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Channel mode tracking (modes, key, limit)
  // -------------------------------------------------------------------------

  describe('channel mode tracking', () => {
    it('populates modes, key, and limit from channel info event', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });
      client.simulateEvent('channel info', {
        channel: '#test',
        modes: [
          { mode: '+n', param: null },
          { mode: '+t', param: null },
          { mode: '+s', param: null },
          { mode: '+k', param: 'secret' },
          { mode: '+l', param: '50' },
        ],
        raw_modes: '+ntskl',
        raw_params: ['secret', '50'],
      });

      const ch = state.getChannel('#test');
      expect(ch).toBeDefined();
      expect(ch!.modes).toBe('ntskl');
      expect(ch!.key).toBe('secret');
      expect(ch!.limit).toBe(50);
    });

    it('emits channel:modesReady after processing channel info', () => {
      let readyChannel = '';
      eventBus.on('channel:modesReady', (ch) => {
        readyChannel = ch;
      });

      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });
      client.simulateEvent('channel info', {
        channel: '#test',
        modes: [{ mode: '+n', param: null }],
        raw_modes: '+n',
        raw_params: [],
      });

      expect(readyChannel).toBe('#test');
    });

    it('ignores channel info events without modes array (e.g. RPL_CREATIONTIME)', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });
      // RPL_CREATIONTIME sends channel info with created_at instead of modes
      client.simulateEvent('channel info', {
        channel: '#test',
        created_at: 1234567890,
      });

      const ch = state.getChannel('#test');
      expect(ch).toBeDefined();
      expect(ch!.modes).toBe('');
      expect(ch!.key).toBe('');
      expect(ch!.limit).toBe(0);
    });

    it('tracks +k / -k mode changes', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      // Set key
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+k', param: 'newkey' }],
      });
      let ch = state.getChannel('#test')!;
      expect(ch.key).toBe('newkey');
      expect(ch.modes).toContain('k');

      // Change key (already has 'k' in modes — should not duplicate)
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+k', param: 'changed' }],
      });
      ch = state.getChannel('#test')!;
      expect(ch.key).toBe('changed');
      expect(ch.modes.split('k').length - 1).toBe(1);

      // Remove key
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '-k', param: 'changed' }],
      });
      ch = state.getChannel('#test')!;
      expect(ch.key).toBe('');
      expect(ch.modes).not.toContain('k');
    });

    it('tracks +l / -l mode changes', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      // Set limit
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+l', param: '25' }],
      });
      let ch = state.getChannel('#test')!;
      expect(ch.limit).toBe(25);
      expect(ch.modes).toContain('l');

      // Change limit (already has 'l' in modes — should not duplicate)
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+l', param: '50' }],
      });
      ch = state.getChannel('#test')!;
      expect(ch.limit).toBe(50);
      expect(ch.modes.split('l').length - 1).toBe(1);

      // Remove limit
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '-l' }],
      });
      ch = state.getChannel('#test')!;
      expect(ch.limit).toBe(0);
      expect(ch.modes).not.toContain('l');
    });

    it('tracks simple channel mode changes (+i, -i, +s, -s, etc.)', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+i', param: '' }],
      });
      let ch = state.getChannel('#test')!;
      expect(ch.modes).toContain('i');

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+s', param: '' }],
      });
      ch = state.getChannel('#test')!;
      expect(ch.modes).toContain('s');
      expect(ch.modes).toContain('i');

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '-i', param: '' }],
      });
      ch = state.getChannel('#test')!;
      expect(ch.modes).not.toContain('i');
      expect(ch.modes).toContain('s');
    });

    it('does not duplicate mode chars when set twice', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+n', param: '' }],
      });
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+n', param: '' }],
      });
      const ch = state.getChannel('#test')!;
      expect(ch.modes.split('n').length - 1).toBe(1); // exactly one 'n'
    });

    it('ignores ban/except/invite list modes in ch.modes', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+b', param: '*!*@evil.host' }],
      });
      const ch = state.getChannel('#test')!;
      expect(ch.modes).not.toContain('b');
    });

    it('returns early when event.modes is not a valid mode array (string)', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      // Give the channel a mode so we can verify it wasn't wiped
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+n', param: '' }],
      });
      expect(state.getChannel('#test')!.modes).toContain('n');

      // Fire a mode event with modes as a string instead of an array
      expect(() => {
        client.simulateEvent('mode', {
          target: '#test',
          modes: '+o Alice',
        });
      }).not.toThrow();

      // Channel modes should be unchanged — handler returned early
      expect(state.getChannel('#test')!.modes).toContain('n');
    });

    it('returns early when event.modes is undefined', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      expect(() => {
        client.simulateEvent('mode', {
          target: '#test',
          // modes field is absent — isModeArray(undefined) → false
        });
      }).not.toThrow();
    });

    it('returns early when event.modes contains non-object entries', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#test' });

      expect(() => {
        client.simulateEvent('mode', {
          target: '#test',
          modes: ['not', 'objects'],
        });
      }).not.toThrow();
    });

    it('handles mode entry with undefined mode property', () => {
      client.simulateEvent('join', { nick: 'Alice', ident: 'a', hostname: 'h', channel: '#test' });

      // mode entry with no mode property — hits the m.mode ?? '' fallback
      expect(() => {
        client.simulateEvent('mode', {
          target: '#test',
          modes: [{ param: 'Alice' }],
        });
      }).not.toThrow();
    });

    it('does not duplicate user mode when +o is set twice', () => {
      client.simulateEvent('join', { nick: 'Alice', ident: 'a', hostname: 'h', channel: '#test' });

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Alice' }],
      });
      expect(state.getUserModes('#test', 'Alice')).toEqual(['o']);

      // Set +o again — should not duplicate
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'Alice' }],
      });
      expect(state.getUserModes('#test', 'Alice')).toEqual(['o']);
      expect(state.getUserModes('#test', 'Alice')).toHaveLength(1);
    });
  });

  describe('channel info with +l mode (parseInt branch)', () => {
    it('parses numeric +l param from channel info', () => {
      client.simulateEvent('join', { nick: 'Bot', ident: 'b', hostname: 'h', channel: '#limited' });

      client.simulateEvent('channel info', {
        channel: '#limited',
        modes: [{ mode: '+l', param: 100 }], // numeric param, not string
        raw_modes: '+l',
        raw_params: ['100'],
      });

      const ch = state.getChannel('#limited');
      expect(ch).toBeDefined();
      expect(ch!.limit).toBe(100);
      expect(ch!.modes).toContain('l');
    });

    it('parses +l as the only mode in channel info', () => {
      client.simulateEvent('channel info', {
        channel: '#onlylimit',
        modes: [{ mode: '+l', param: '42' }],
        raw_modes: '+l',
        raw_params: ['42'],
      });

      const ch = state.getChannel('#onlylimit');
      expect(ch).toBeDefined();
      expect(ch!.limit).toBe(42);
      expect(ch!.modes).toBe('l');
      expect(ch!.key).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // NAMES multi-prefix parsing (§A.3) — the audit's P0 finding
  // -------------------------------------------------------------------------

  describe('NAMES prefix-mode tracking', () => {
    it('tracks every prefix from a multi-prefix NAMES array', () => {
      // irc-framework parses `~&@%+nick` into modes = ['q','a','o','h','v'].
      // The audit found that the old code silently ignored this array and
      // stored [] for every user, breaking every op-check in every plugin.
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [
          {
            nick: 'founder',
            ident: 'f',
            hostname: 'h',
            modes: ['q', 'o', 'v'],
          },
          {
            nick: 'admin',
            ident: 'a',
            hostname: 'h',
            modes: ['a'],
          },
          {
            nick: 'voice',
            ident: 'v',
            hostname: 'h',
            modes: ['v'],
          },
          {
            nick: 'plain',
            ident: 'p',
            hostname: 'h',
            modes: [],
          },
        ],
      });

      expect(state.getUserModes('#test', 'founder').sort()).toEqual(['o', 'q', 'v']);
      expect(state.getUserModes('#test', 'admin')).toEqual(['a']);
      expect(state.getUserModes('#test', 'voice')).toEqual(['v']);
      expect(state.getUserModes('#test', 'plain')).toEqual([]);
    });

    it('maps status symbols to modes when NAMES ships symbol strings', () => {
      // Bot-link CHAN sync frames historically used a concatenated string
      // of status symbols — the fallback path should still work.
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [
          { nick: 'Bob', ident: 'b', hostname: 'h', modes: '@+' },
          { nick: 'Carol', ident: 'c', hostname: 'h', modes: '%' },
        ],
      });
      expect(state.getUserModes('#test', 'Bob').sort()).toEqual(['o', 'v']);
      expect(state.getUserModes('#test', 'Carol')).toEqual(['h']);
    });

    it('dedupes a mode that arrives twice (symbol + mode char)', () => {
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Dave', ident: 'd', hostname: 'h', modes: ['@', 'o', '+', 'v'] }],
      });
      expect(state.getUserModes('#test', 'Dave').sort()).toEqual(['o', 'v']);
    });
  });

  // -------------------------------------------------------------------------
  // Prefix-mode tracking via MODE events (§3) — now ISUPPORT-aware
  // -------------------------------------------------------------------------

  describe('MODE events with non-default prefix modes', () => {
    it('tracks +q/+a changes against the default q/a/o/h/v prefix set', () => {
      // Seed a user in the channel so the MODE handler has someone to update.
      client.simulateEvent('userlist', {
        channel: '#test',
        users: [{ nick: 'Eve', ident: 'e', hostname: 'h', modes: [] }],
      });

      // +q (founder) — present in the default PREFIX set now.
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+q', param: 'Eve' }],
      });
      expect(state.getUserModes('#test', 'Eve')).toContain('q');

      // -q removes it again.
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '-q', param: 'Eve' }],
      });
      expect(state.getUserModes('#test', 'Eve')).not.toContain('q');
    });
  });

  // -------------------------------------------------------------------------
  // IRCv3 away-notify (§A.2)
  // -------------------------------------------------------------------------

  describe('away-notify tracking', () => {
    beforeEach(() => {
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: 'bob',
        hostname: 'host',
        channel: '#chan1',
      });
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: 'bob',
        hostname: 'host',
        channel: '#chan2',
      });
    });

    it('marks the user as away across every channel they share with the bot', () => {
      client.simulateEvent('away', { nick: 'Bob', message: 'lunch' });
      expect(state.getUser('#chan1', 'Bob')?.away).toBe(true);
      expect(state.getUser('#chan1', 'Bob')?.awayMessage).toBe('lunch');
      expect(state.getUser('#chan2', 'Bob')?.away).toBe(true);
    });

    it('clears the away flag on the `back` event (RPL_UNAWAY / empty AWAY)', () => {
      client.simulateEvent('away', { nick: 'Bob', message: 'brb' });
      client.simulateEvent('back', { nick: 'Bob', message: '' });
      expect(state.getUser('#chan1', 'Bob')?.away).toBe(false);
      expect(state.getUser('#chan1', 'Bob')?.awayMessage).toBeUndefined();
    });

    it('emits channel:awayChanged for every affected channel', () => {
      const events: Array<[string, string, boolean]> = [];
      eventBus.on('channel:awayChanged', (ch, nick, away) => {
        events.push([ch, nick, away]);
      });
      client.simulateEvent('away', { nick: 'Bob', message: 'bbl' });
      expect(events).toEqual([
        ['#chan1', 'Bob', true],
        ['#chan2', 'Bob', true],
      ]);
    });

    it('ignores away events for users we do not track', () => {
      const events: Array<[string, string, boolean]> = [];
      eventBus.on('channel:awayChanged', (ch, nick, away) => {
        events.push([ch, nick, away]);
      });
      client.simulateEvent('away', { nick: 'Eve', message: 'lurking' });
      expect(events).toEqual([]);
    });

    it('ignores away events with an empty nick', () => {
      const events: Array<[string, string, boolean]> = [];
      eventBus.on('channel:awayChanged', (ch, nick, away) => {
        events.push([ch, nick, away]);
      });
      client.simulateEvent('away', { nick: '', message: 'ghost' });
      expect(events).toEqual([]);
    });

    it('defaults to empty string when message is not a string', () => {
      client.simulateEvent('away', { nick: 'Bob', message: 123 });
      // awayMessage should be empty string (non-string message defaults to '')
      // but away flag should still be set
      expect(state.getUser('#chan1', 'Bob')?.away).toBe(true);
    });

    it('logs away-notify through the logger when present', () => {
      // Construct a ChannelState with a mock logger to cover the logger?.debug branch
      const logClient = new MockClient();
      const logBus = new BotEventBus();
      const mockDebug = vi.fn();
      const mockLogger = {
        child: () => ({ info: vi.fn(), debug: mockDebug, warn: vi.fn(), error: vi.fn() }),
      };
      const logState = new ChannelState(logClient, logBus, mockLogger as never);
      logState.attach();
      try {
        logClient.simulateEvent('join', {
          nick: 'Zoe',
          ident: 'z',
          hostname: 'host',
          channel: '#log',
        });
        logClient.simulateEvent('away', { nick: 'Zoe', message: 'brb' });
        expect(mockDebug).toHaveBeenCalledWith(expect.stringContaining('away'));
      } finally {
        logState.detach();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Account-tag pushed from irc-bridge (§A.2)
  // -------------------------------------------------------------------------

  describe('setAccountForNick', () => {
    it('stores the account in networkAccounts and on per-channel UserInfo', () => {
      client.simulateEvent('join', {
        nick: 'Carol',
        ident: 'c',
        hostname: 'host',
        channel: '#test',
      });
      state.setAccountForNick('Carol', 'CarolAcct');
      expect(state.getAccountForNick('Carol')).toBe('CarolAcct');
      expect(state.getUser('#test', 'Carol')?.accountName).toBe('CarolAcct');
    });

    it('updates the account when a later tag contradicts the earlier value', () => {
      client.simulateEvent('join', {
        nick: 'Carol',
        ident: 'c',
        hostname: 'host',
        channel: '#test',
      });
      state.setAccountForNick('Carol', 'OldAcct');
      state.setAccountForNick('Carol', 'NewAcct');
      expect(state.getAccountForNick('Carol')).toBe('NewAcct');
    });

    it('stores null when a tag explicitly says the user is unidentified', () => {
      state.setAccountForNick('Dave', null);
      expect(state.getAccountForNick('Dave')).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // clearNetworkAccounts — reconnect hygiene (§7 Phase 4)
  // -------------------------------------------------------------------------

  describe('clearNetworkAccounts', () => {
    it('drops every cached account so stale auth cannot survive reconnect', () => {
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'a',
        hostname: 'host',
        channel: '#test',
        account: 'AliceAcct',
      });
      client.simulateEvent('join', {
        nick: 'Bob',
        ident: 'b',
        hostname: 'host',
        channel: '#test',
        account: 'BobAcct',
      });
      expect(state.getAccountForNick('Alice')).toBe('AliceAcct');
      expect(state.getAccountForNick('Bob')).toBe('BobAcct');

      state.clearNetworkAccounts();

      // Network-wide map must be empty; getAccountForNick returns undefined
      // (not null) to signal "we know nothing", which lets the dispatcher's
      // verification fall through to the NickServ slow path.
      expect(state.getAccountForNick('Alice')).toBeUndefined();
      expect(state.getAccountForNick('Bob')).toBeUndefined();
      // Per-channel UserInfo.accountName also cleared so plugins don't
      // read a stale value from a user record that survived the reset.
      expect(state.getUser('#test', 'Alice')?.accountName).toBeUndefined();
      expect(state.getUser('#test', 'Bob')?.accountName).toBeUndefined();
    });

    it('is a no-op when no accounts are cached', () => {
      expect(() => state.clearNetworkAccounts()).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // clearAllChannels — reconnect hygiene (mem-leak audit 2026-04-13)
  // -------------------------------------------------------------------------

  describe('clearAllChannels', () => {
    it('drops every tracked channel so stale state cannot accumulate over reconnects', () => {
      client.simulateEvent('join', {
        nick: 'HexBot',
        ident: 'h',
        hostname: 'h.local',
        channel: '#a',
      });
      client.simulateEvent('join', {
        nick: 'HexBot',
        ident: 'h',
        hostname: 'h.local',
        channel: '#b',
      });
      expect(state.getAllChannels().length).toBe(2);

      state.clearAllChannels();

      expect(state.getAllChannels().length).toBe(0);
      expect(state.getChannel('#a')).toBeUndefined();
      expect(state.getChannel('#b')).toBeUndefined();
    });

    it('is a no-op when no channels are tracked', () => {
      expect(() => state.clearAllChannels()).not.toThrow();
      expect(state.getAllChannels().length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // `+l` NaN guard (§3)
  // -------------------------------------------------------------------------

  describe('channel limit (+l) NaN guard', () => {
    it('ignores non-numeric +l params instead of storing NaN', () => {
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+l', param: 'abc' }],
      });
      const ch = state.getChannel('#test');
      // Old behaviour stored NaN; new behaviour clamps to 0.
      expect(ch?.limit ?? 0).toBe(0);
    });
  });

  describe('self-PART/KICK channel cleanup', () => {
    it('removes the channel entry when the bot PARTs', () => {
      state.setBotNick('HexBot');

      client.simulateEvent('join', {
        nick: 'HexBot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      expect(state.getChannel('#test')).toBeDefined();

      client.simulateEvent('part', { nick: 'HexBot', channel: '#test' });
      expect(state.getChannel('#test')).toBeUndefined();
    });

    it('removes the channel entry when the bot is KICKed', () => {
      state.setBotNick('HexBot');

      client.simulateEvent('join', {
        nick: 'HexBot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      expect(state.getChannel('#test')).toBeDefined();

      client.simulateEvent('kick', { kicked: 'HexBot', nick: 'Oper', channel: '#test' });
      expect(state.getChannel('#test')).toBeUndefined();
    });

    it('does not remove the channel when another user PARTs', () => {
      state.setBotNick('HexBot');

      client.simulateEvent('join', {
        nick: 'HexBot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host',
        channel: '#test',
      });

      client.simulateEvent('part', { nick: 'Alice', channel: '#test' });
      expect(state.getChannel('#test')).toBeDefined();
    });
  });

  describe('networkAccounts cleanup on PART', () => {
    it('evicts networkAccounts entry when user leaves all tracked channels', () => {
      state.setBotNick('HexBot');

      // User joins one channel with an account
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host',
        channel: '#test',
        account: 'Alice',
      });
      expect(state.getAccountForNick('Alice')).toBe('Alice');

      // User parts — no longer in any channel
      client.simulateEvent('part', { nick: 'Alice', channel: '#test' });
      expect(state.getAccountForNick('Alice')).toBeUndefined();
    });

    it('keeps networkAccounts entry when user is still in another channel', () => {
      state.setBotNick('HexBot');

      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host',
        channel: '#chan1',
        account: 'Alice',
      });
      client.simulateEvent('join', {
        nick: 'Alice',
        ident: 'alice',
        hostname: 'alice.host',
        channel: '#chan2',
      });

      // Part from one channel — still in the other
      client.simulateEvent('part', { nick: 'Alice', channel: '#chan1' });
      expect(state.getAccountForNick('Alice')).toBe('Alice');
    });
  });

  describe('initialState seed', () => {
    it('pre-populates channels and networkAccounts from the constructor seed', () => {
      const seededClient = new MockClient();
      const seededBus = new BotEventBus();
      const seededState = new ChannelState(seededClient, seededBus, null, {
        channels: [
          [
            '#preloaded',
            {
              name: '#preloaded',
              topic: 'hello',
              modes: 'nt',
              key: '',
              limit: 0,
              users: new Map(),
            },
          ],
        ],
        networkAccounts: [['alice', 'AliceAcct']],
      });
      expect(seededState.getChannel('#preloaded')?.topic).toBe('hello');
      expect(seededState.getAccountForNick('alice')).toBe('AliceAcct');
    });
  });
});
