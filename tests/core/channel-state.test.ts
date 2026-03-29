import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
