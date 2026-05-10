// Phase 3 regression guard: every plugin that drives a privileged action
// (mode mutations, kicks, bans, structured config events) must produce a
// `mod_log` row tagged with `source='plugin'` and the plugin name in the
// `plugin` column. The test exercises the plugin-api factory directly with
// a real BotDatabase + IRCCommands rather than spinning up the full bot, so
// the cost is a few hundred ms and the failure mode is sharp ("plugin X no
// longer audits").
//
// New plugins with privileged paths must add a case here. Doing so is the
// cheapest way to lock in the audit contract: the type system forces an
// `api.audit.log` call to compile; this test forces the row to actually land.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IRCCommands, type IRCCommandsClient } from '../../src/core/irc-commands';
import { BotDatabase } from '../../src/database';
import { BotEventBus } from '../../src/event-bus';
import { type PluginApiDeps, createPluginApi } from '../../src/plugin-api-factory';
import type { PluginAPI } from '../../src/types';

class StubClient implements IRCCommandsClient {
  sent: Array<{ type: string; args: unknown[] }> = [];
  say(t: string, m: string): void {
    this.sent.push({ type: 'say', args: [t, m] });
  }
  notice(t: string, m: string): void {
    this.sent.push({ type: 'notice', args: [t, m] });
  }
  join(c: string): void {
    this.sent.push({ type: 'join', args: [c] });
  }
  part(c: string, m?: string): void {
    this.sent.push({ type: 'part', args: [c, m] });
  }
  raw(line: string): void {
    this.sent.push({ type: 'raw', args: [line] });
  }
  mode(target: string, mode: string, ...params: string[]): void {
    this.sent.push({ type: 'mode', args: [target, mode, ...params] });
  }
}

function buildApi(pluginId: string): { api: PluginAPI; db: BotDatabase } {
  const db = new BotDatabase(':memory:');
  db.open();
  const eventBus = new BotEventBus();
  db.setEventBus(eventBus);
  const ircCommands = new IRCCommands(new StubClient(), db);

  const deps: PluginApiDeps = {
    dispatcher: {
      bind: vi.fn(),
      unbind: vi.fn(),
      unbindAll: vi.fn(),
    },
    eventBus,
    db,
    permissions: {} as PluginApiDeps['permissions'],
    botVersion: '0.0.0-test',
    botConfig: {
      irc: {
        host: 'h',
        port: 6667,
        tls: false,
        nick: 'hexbot',
        username: 'h',
        realname: 'h',
        channels: [],
      },
      owner: { handle: 'o', hostmask: '*!*@o' },
      identity: { method: 'hostmask', require_acc_for: [] },
      services: { type: 'none', nickserv: 'NickServ', sasl: false, password: '' },
      database: ':memory:',
      pluginDir: '',
      logging: { level: 'info', mod_actions: true },
    } as PluginApiDeps['botConfig'],
    ircClient: null,
    channelState: null,
    ircCommands,
    messageQueue: null,
    services: null,
    helpRegistry: null,
    channelSettings: null,
    coreSettings: null,
    pluginSettings: null,
    banStore: null,
    rootLogger: null,
    getCasemapping: () => 'rfc1459',
    getServerSupports: () => ({}),
    modesReadyListeners: new Map(),
    permissionsChangedListeners: new Map(),
    userIdentifiedListeners: new Map(),
    userDeidentifiedListeners: new Map(),
    botIdentifiedListeners: new Map(),
  };

  const { api } = createPluginApi(deps, pluginId, {});
  return { api, db };
}

describe('plugin audit coverage', () => {
  let db: BotDatabase | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it('api.irc.* writes a row tagged with the plugin name', () => {
    const built = buildApi('chanmod');
    db = built.db;
    built.api.op('#test', 'Alice');

    const rows = db.getModLog({ action: 'op' });
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('plugin');
    expect(rows[0].plugin).toBe('chanmod');
    expect(rows[0].by).toBe('chanmod');
  });

  it('every privileged api.irc.* method auto-attributes to the plugin', () => {
    const built = buildApi('test-plugin');
    db = built.db;
    const api = built.api;

    api.op('#t', 'a');
    api.deop('#t', 'a');
    api.voice('#t', 'a');
    api.devoice('#t', 'a');
    api.halfop('#t', 'a');
    api.dehalfop('#t', 'a');
    api.kick('#t', 'a', 'bye');
    api.ban('#t', '*!*@bad');
    api.invite('#t', 'a');
    api.topic('#t', 'new topic');

    const rows = db.getModLog();
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      expect(row.source).toBe('plugin');
      expect(row.plugin).toBe('test-plugin');
      expect(row.by).toBe('test-plugin');
    }
  });

  it('api.audit.log forces source/plugin/by regardless of caller intent', () => {
    const built = buildApi('rss');
    db = built.db;
    built.api.audit.log('rss-feed-add', {
      channel: '#news',
      target: 'feed-1',
      reason: 'https://example.com/rss',
      metadata: { interval: 3600 },
    });

    const [row] = db.getModLog({ action: 'rss-feed-add' });
    expect(row.source).toBe('plugin');
    expect(row.plugin).toBe('rss');
    expect(row.by).toBe('rss');
    expect(row.channel).toBe('#news');
    expect(row.target).toBe('feed-1');
    expect(row.metadata).toEqual({ interval: 3600 });
  });

  it('emits audit:log on the event bus for every successful write', () => {
    const built = buildApi('chanmod');
    db = built.db;
    const events: unknown[] = [];
    const bus = new BotEventBus();
    db.setEventBus(bus);
    bus.on('audit:log', (entry) => events.push(entry));

    built.api.op('#test', 'Alice');

    expect(events).toHaveLength(1);
    const entry = events[0] as { plugin: string; action: string; source: string };
    expect(entry.action).toBe('op');
    expect(entry.plugin).toBe('chanmod');
    expect(entry.source).toBe('plugin');
  });

  it('audit:log carries metadata back to subscribers', () => {
    const built = buildApi('flood');
    db = built.db;
    const events: unknown[] = [];
    db.setEventBus(
      (() => {
        const bus = new BotEventBus();
        bus.on('audit:log', (entry) => events.push(entry));
        return bus;
      })(),
    );

    built.api.audit.log('flood-lockdown', {
      channel: '#flood',
      reason: '+R',
      metadata: { mode: 'R', flooderCount: 5 },
    });

    expect(events).toHaveLength(1);
    const entry = events[0] as { metadata: Record<string, unknown> };
    expect(entry.metadata).toEqual({ mode: 'R', flooderCount: 5 });
  });
});
