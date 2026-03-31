import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it } from 'vitest';

import type { LinkFrame } from '../../src/core/botlink';
import { ChannelStateSyncer, PermissionSyncer } from '../../src/core/botlink-sync';
import { ChannelState } from '../../src/core/channel-state';
import { Permissions } from '../../src/core/permissions';
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
// ChannelStateSyncer
// ---------------------------------------------------------------------------

describe('ChannelStateSyncer', () => {
  let client: MockClient;
  let eventBus: BotEventBus;
  let state: ChannelState;

  beforeEach(() => {
    client = new MockClient();
    eventBus = new BotEventBus();
    state = new ChannelState(client, eventBus);
    state.attach();
  });

  describe('buildSyncFrames', () => {
    it('returns empty array for no channels', () => {
      expect(ChannelStateSyncer.buildSyncFrames(state)).toEqual([]);
    });

    it('builds a CHAN frame with users for a tracked channel', () => {
      // Simulate a channel with users via IRC events
      client.simulateEvent('join', {
        channel: '#test',
        nick: 'alice',
        ident: 'alice',
        hostname: 'host.com',
      });
      client.simulateEvent('join', {
        channel: '#test',
        nick: 'bob',
        ident: 'bob',
        hostname: 'other.com',
      });
      client.simulateEvent('topic', { channel: '#test', topic: 'Hello world' });

      const frames = ChannelStateSyncer.buildSyncFrames(state);

      expect(frames).toHaveLength(1);
      expect(frames[0].type).toBe('CHAN');
      expect(frames[0].channel).toBe('#test');
      expect(frames[0].topic).toBe('Hello world');
      const users = frames[0].users as Array<Record<string, unknown>>;
      expect(users).toHaveLength(2);
      expect(users.map((u) => u.nick).sort()).toEqual(['alice', 'bob']);
    });

    it('includes channel modes, key, and limit', () => {
      client.simulateEvent('join', {
        channel: '#secret',
        nick: 'bot',
        ident: 'bot',
        hostname: 'bot.host',
      });
      // Simulate RPL_CHANNELMODEIS via 'channel info'
      client.simulateEvent('channel info', {
        channel: '#secret',
        modes: [
          { mode: '+n', param: '' },
          { mode: '+t', param: '' },
          { mode: '+k', param: 'mykey' },
          { mode: '+l', param: '50' },
        ],
      });

      const frames = ChannelStateSyncer.buildSyncFrames(state);

      expect(frames[0].modes).toBe('ntkl');
      expect(frames[0].key).toBe('mykey');
      expect(frames[0].limit).toBe(50);
    });

    it('includes user modes (op, voice)', () => {
      client.simulateEvent('join', {
        channel: '#test',
        nick: 'op_user',
        ident: 'op',
        hostname: 'h',
      });
      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'op_user' }],
      });

      const frames = ChannelStateSyncer.buildSyncFrames(state);
      const users = frames[0].users as Array<Record<string, unknown>>;
      expect(users[0].modes).toEqual(['o']);
    });

    it('builds frames for multiple channels', () => {
      client.simulateEvent('join', {
        channel: '#a',
        nick: 'bot',
        ident: 'b',
        hostname: 'h',
      });
      client.simulateEvent('join', {
        channel: '#b',
        nick: 'bot',
        ident: 'b',
        hostname: 'h',
      });

      const frames = ChannelStateSyncer.buildSyncFrames(state);
      expect(frames).toHaveLength(2);
      expect(frames.map((f) => f.channel).sort()).toEqual(['#a', '#b']);
    });
  });

  describe('applyFrame', () => {
    it('applies a CHAN frame to populate a fresh channel state', () => {
      const frame: LinkFrame = {
        type: 'CHAN',
        channel: '#test',
        topic: 'Synced topic',
        modes: 'ntk',
        key: 'secret',
        limit: 0,
        users: [
          { nick: 'alice', ident: 'alice', hostname: 'a.com', modes: ['o'] },
          { nick: 'bob', ident: 'bob', hostname: 'b.com', modes: [] },
        ],
      };

      ChannelStateSyncer.applyFrame(frame, state);

      const ch = state.getChannel('#test');
      expect(ch).toBeDefined();
      expect(ch!.topic).toBe('Synced topic');
      expect(ch!.modes).toBe('ntk');
      expect(ch!.key).toBe('secret');
      expect(ch!.users.size).toBe(2);

      const alice = state.getUser('#test', 'alice');
      expect(alice).toBeDefined();
      expect(alice!.modes).toEqual(['o']);
      expect(alice!.hostname).toBe('a.com');

      const bob = state.getUser('#test', 'bob');
      expect(bob).toBeDefined();
      expect(bob!.modes).toEqual([]);
    });

    it('replaces existing channel data on re-sync', () => {
      // First populate via IRC
      client.simulateEvent('join', {
        channel: '#test',
        nick: 'old_user',
        ident: 'x',
        hostname: 'x',
      });

      // Now apply sync — should replace
      ChannelStateSyncer.applyFrame(
        {
          type: 'CHAN',
          channel: '#test',
          topic: 'New topic',
          modes: 'n',
          users: [{ nick: 'new_user', ident: 'y', hostname: 'y', modes: [] }],
        },
        state,
      );

      const ch = state.getChannel('#test');
      expect(ch!.topic).toBe('New topic');
      expect(ch!.users.size).toBe(1);
      expect(state.getUser('#test', 'old_user')).toBeUndefined();
      expect(state.getUser('#test', 'new_user')).toBeDefined();
    });

    it('ignores non-CHAN frames', () => {
      ChannelStateSyncer.applyFrame({ type: 'ADDUSER', handle: 'admin' }, state);
      expect(state.getAllChannels()).toHaveLength(0);
    });

    it('handles CHAN frame with missing fields (uses ?? defaults)', () => {
      ChannelStateSyncer.applyFrame({ type: 'CHAN', users: [{ nick: 'u' }] }, state);
      const channels = state.getAllChannels();
      expect(channels).toHaveLength(1);
      expect(channels[0].topic).toBe('');
      expect(channels[0].modes).toBe('');
      const user = state.getUser('', 'u');
      expect(user).toBeDefined();
      expect(user!.ident).toBe('');
    });

    it('handles CHAN frame with non-array users', () => {
      ChannelStateSyncer.applyFrame(
        { type: 'CHAN', channel: '#test2', topic: 'hi', modes: 'n' },
        state,
      );
      const ch = state.getChannel('#test2');
      expect(ch!.users.size).toBe(0);
    });

    it('handles CHAN frame user with non-array modes', () => {
      ChannelStateSyncer.applyFrame(
        {
          type: 'CHAN',
          channel: '#test3',
          topic: '',
          modes: '',
          users: [{ nick: 'u', ident: 'i', hostname: 'h', modes: 'not-an-array' }],
        },
        state,
      );
      const user = state.getUser('#test3', 'u');
      expect(user!.modes).toEqual([]);
    });
  });

  describe('roundtrip', () => {
    it('build → apply produces equivalent state', () => {
      // Populate source state
      client.simulateEvent('join', {
        channel: '#dev',
        nick: 'alice',
        ident: 'alice',
        hostname: 'alice.host',
      });
      client.simulateEvent('join', {
        channel: '#dev',
        nick: 'bob',
        ident: 'bob',
        hostname: 'bob.host',
      });
      client.simulateEvent('mode', {
        target: '#dev',
        modes: [{ mode: '+o', param: 'alice' }],
      });
      client.simulateEvent('topic', { channel: '#dev', topic: 'Development' });

      // Build frames from source
      const frames = ChannelStateSyncer.buildSyncFrames(state);

      // Apply to fresh target state
      const targetClient = new MockClient();
      const targetBus = new BotEventBus();
      const target = new ChannelState(targetClient, targetBus);
      target.attach();

      for (const frame of frames) {
        ChannelStateSyncer.applyFrame(frame, target);
      }

      // Verify
      const ch = target.getChannel('#dev');
      expect(ch).toBeDefined();
      expect(ch!.topic).toBe('Development');
      expect(ch!.users.size).toBe(2);

      const alice = target.getUser('#dev', 'alice');
      expect(alice!.modes).toEqual(['o']);
      expect(alice!.hostname).toBe('alice.host');

      const bob = target.getUser('#dev', 'bob');
      expect(bob!.modes).toEqual([]);

      target.detach();
    });
  });
});

// ---------------------------------------------------------------------------
// PermissionSyncer
// ---------------------------------------------------------------------------

describe('PermissionSyncer', () => {
  let perms: Permissions;

  beforeEach(() => {
    perms = new Permissions();
  });

  describe('buildSyncFrames', () => {
    it('returns empty array for no users', () => {
      expect(PermissionSyncer.buildSyncFrames(perms)).toEqual([]);
    });

    it('builds ADDUSER frames for each user', () => {
      perms.addUser('admin', '*!admin@host', 'nmov');
      perms.addUser('oper', '*!oper@host', 'mo');
      perms.setChannelFlags('oper', '#dev', 'o');

      const frames = PermissionSyncer.buildSyncFrames(perms);

      expect(frames).toHaveLength(2);
      const adminFrame = frames.find((f) => f.handle === 'admin')!;
      expect(adminFrame.type).toBe('ADDUSER');
      expect(adminFrame.hostmasks).toEqual(['*!admin@host']);
      expect(adminFrame.globalFlags).toBe('nmov');
      expect(adminFrame.channelFlags).toEqual({});

      const operFrame = frames.find((f) => f.handle === 'oper')!;
      expect(operFrame.globalFlags).toBe('mo');
      expect(operFrame.channelFlags).toEqual({ '#dev': 'o' });
    });
  });

  describe('applyFrame', () => {
    it('applies ADDUSER to add a new user', () => {
      PermissionSyncer.applyFrame(
        {
          type: 'ADDUSER',
          handle: 'admin',
          hostmasks: ['*!admin@host'],
          globalFlags: 'nmov',
          channelFlags: { '#test': 'o' },
        },
        perms,
      );

      const user = perms.getUser('admin');
      expect(user).not.toBeNull();
      expect(user!.global).toBe('nmov');
      expect(user!.hostmasks).toEqual(['*!admin@host']);
      expect(user!.channels).toEqual({ '#test': 'o' });
    });

    it('applies ADDUSER to update an existing user (upsert)', () => {
      perms.addUser('admin', '*!old@host', 'o');

      PermissionSyncer.applyFrame(
        {
          type: 'ADDUSER',
          handle: 'admin',
          hostmasks: ['*!new@host'],
          globalFlags: 'nmov',
          channelFlags: {},
        },
        perms,
      );

      const user = perms.getUser('admin');
      expect(user!.hostmasks).toEqual(['*!new@host']);
      expect(user!.global).toBe('nmov');
    });

    it('applies SETFLAGS to update flags', () => {
      perms.addUser('oper', '*!oper@host', 'o');

      PermissionSyncer.applyFrame(
        {
          type: 'SETFLAGS',
          handle: 'oper',
          hostmasks: ['*!oper@host'],
          globalFlags: 'mo',
          channelFlags: { '#ops': 'n' },
        },
        perms,
      );

      const user = perms.getUser('oper');
      expect(user!.global).toBe('mo');
      expect(user!.channels).toEqual({ '#ops': 'n' });
    });

    it('applies DELUSER to remove a user', () => {
      perms.addUser('temp', '*!t@host', 'v');

      PermissionSyncer.applyFrame({ type: 'DELUSER', handle: 'temp' }, perms);

      expect(perms.getUser('temp')).toBeNull();
    });

    it('DELUSER is a no-op for unknown users', () => {
      PermissionSyncer.applyFrame({ type: 'DELUSER', handle: 'unknown' }, perms);
    });

    it('DELUSER with empty handle is a no-op', () => {
      PermissionSyncer.applyFrame({ type: 'DELUSER', handle: '' }, perms);
      expect(perms.listUsers()).toHaveLength(0);
    });

    it('ADDUSER with non-array hostmasks defaults to empty array', () => {
      PermissionSyncer.applyFrame(
        {
          type: 'ADDUSER',
          handle: 'test',
          hostmasks: 'not-an-array',
          globalFlags: 'o',
          channelFlags: {},
        },
        perms,
      );
      const user = perms.getUser('test');
      expect(user).not.toBeNull();
      expect(user!.hostmasks).toEqual([]);
    });

    it('ADDUSER with missing channelFlags defaults to empty object', () => {
      PermissionSyncer.applyFrame(
        { type: 'ADDUSER', handle: 'test2', hostmasks: ['*!*@h'], globalFlags: 'v' },
        perms,
      );
      const user = perms.getUser('test2');
      expect(user!.channels).toEqual({});
    });

    it('ignores frames with empty handle', () => {
      PermissionSyncer.applyFrame(
        { type: 'ADDUSER', handle: '', hostmasks: [], globalFlags: '', channelFlags: {} },
        perms,
      );
      expect(perms.listUsers()).toHaveLength(0);
    });

    it('ignores non-permission frame types', () => {
      PermissionSyncer.applyFrame({ type: 'CHAN', channel: '#test' }, perms);
      expect(perms.listUsers()).toHaveLength(0);
    });
  });

  describe('roundtrip', () => {
    it('build → apply produces equivalent user database', () => {
      // Source
      perms.addUser('admin', '*!admin@host.com', 'nmov');
      perms.addUser('oper1', '*!oper@shell.net', 'mo');
      perms.addHostmask('oper1', '*!oper@backup.net');
      perms.setChannelFlags('oper1', '#main', 'o');
      perms.addUser('voice', '*!user@home', 'v');

      const frames = PermissionSyncer.buildSyncFrames(perms);

      // Target
      const target = new Permissions();
      for (const frame of frames) {
        PermissionSyncer.applyFrame(frame, target);
      }

      // Verify each user matches
      expect(target.listUsers()).toHaveLength(3);

      const admin = target.getUser('admin');
      expect(admin!.global).toBe('nmov');
      expect(admin!.hostmasks).toEqual(['*!admin@host.com']);

      const oper = target.getUser('oper1');
      expect(oper!.global).toBe('mo');
      expect(oper!.hostmasks).toEqual(['*!oper@shell.net', '*!oper@backup.net']);
      expect(oper!.channels).toEqual({ '#main': 'o' });

      const voice = target.getUser('voice');
      expect(voice!.global).toBe('v');
    });
  });
});
