import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ConnectionLifecycleDeps,
  type LifecycleIRCClient,
  type ReconnectPolicy,
  classifyCloseReason,
  registerConnectionEvents,
} from '../../src/core/connection-lifecycle';
import type { ReconnectDriver, ReconnectState } from '../../src/core/reconnect-driver';
import { BotEventBus } from '../../src/event-bus';
import type { LoggerLike } from '../../src/logger';
import type { BotConfig } from '../../src/types';
import { createMockLogger } from '../helpers/mock-logger';

// ---------------------------------------------------------------------------
// Mock IRC client
// ---------------------------------------------------------------------------

class MockClient extends EventEmitter implements LifecycleIRCClient {
  public joins: Array<{ channel: string; key?: string }> = [];
  /** Simulates irc-framework's client.user.nick — set in tests to trigger nick collision. */
  public user?: { nick?: string };
  public network: LifecycleIRCClient['network'] & {
    supports: ReturnType<typeof vi.fn>;
    cap: { available: Map<string, string>; enabled: string[] };
  } = {
    supports: vi.fn<(feature: string) => unknown>().mockReturnValue('rfc1459'),
    cap: { available: new Map<string, string>(), enabled: [] },
  };
  /** Simulates irc-framework's internal connection/transport chain for TLS tests. */
  public connection?: { transport?: { socket?: unknown } };

  join(channel: string, key?: string): void {
    this.joins.push({ channel, key });
  }

  quit(_message?: string): void {
    // Simulate closing the connection
    this.emit('close');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_BOT_CONFIG: BotConfig = {
  irc: {
    host: 'irc.example.com',
    port: 6667,
    tls: false,
    nick: 'testbot',
    username: 'test',
    realname: 'Test Bot',
    channels: [],
  },
  owner: { handle: 'admin', hostmask: '*!*@localhost' },
  identity: { method: 'hostmask', require_acc_for: [] },
  services: { type: 'none', nickserv: 'NickServ', password: '', sasl: false },
  database: ':memory:',
  pluginDir: './plugins',
  logging: { level: 'info', mod_actions: false },
};

const makeLogger = createMockLogger;

interface MockReconnectDriver extends ReconnectDriver {
  onDisconnect: ReturnType<typeof vi.fn<(policy: ReconnectPolicy) => void>>;
  onConnected: ReturnType<typeof vi.fn<() => void>>;
  cancel: ReturnType<typeof vi.fn<() => void>>;
  lastPolicy: ReconnectPolicy | null;
}

function makeMockDriver(): MockReconnectDriver {
  let lastPolicy: ReconnectPolicy | null = null;
  const state: ReconnectState = {
    status: 'connected',
    lastError: null,
    lastErrorTier: null,
    consecutiveFailures: 0,
    nextAttemptAt: null,
    attemptCount: 0,
  };
  const driver: MockReconnectDriver = {
    onDisconnect: vi.fn((policy: ReconnectPolicy) => {
      lastPolicy = policy;
      driver.lastPolicy = policy;
    }),
    onConnected: vi.fn(() => {}),
    cancel: vi.fn(() => {}),
    getState: () => state,
    lastPolicy,
  };
  return driver;
}

interface TestContext {
  client: MockClient;
  eventBus: BotEventBus;
  logger: LoggerLike;
  applyCasemapping: ReturnType<typeof vi.fn>;
  messageQueue: { clear: ReturnType<typeof vi.fn> };
  dispatcher: { bind: ReturnType<typeof vi.fn> };
  reconnectDriver: MockReconnectDriver;
  deps: ConnectionLifecycleDeps;
}

function makeContext(overrides?: Partial<ConnectionLifecycleDeps>): TestContext {
  const client = new MockClient();
  const eventBus = new BotEventBus();
  const logger = makeLogger();
  const applyCasemapping = vi.fn();
  const messageQueue = { clear: vi.fn() };
  const dispatcher = { bind: vi.fn() };
  const reconnectDriver = makeMockDriver();

  const deps: ConnectionLifecycleDeps = {
    client,
    config: MINIMAL_BOT_CONFIG,
    configuredChannels: [],
    eventBus,
    applyCasemapping,
    applyServerCapabilities: vi.fn(),
    messageQueue,
    dispatcher,
    logger,
    reconnectDriver,
    ...overrides,
  };

  return {
    client,
    eventBus,
    logger,
    applyCasemapping,
    messageQueue,
    dispatcher,
    reconnectDriver,
    deps,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerConnectionEvents', () => {
  describe('registered event', () => {
    it('calls resolve', () => {
      const { client, deps } = makeContext();
      const resolve = vi.fn();
      registerConnectionEvents(deps, resolve, () => {});
      client.emit('registered');
      expect(resolve).toHaveBeenCalledOnce();
    });

    it('emits bot:connected', () => {
      const { client, deps, eventBus } = makeContext();
      const handler = vi.fn();
      eventBus.on('bot:connected', handler);
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(handler).toHaveBeenCalledOnce();
    });

    it('joins all configured channels with their keys', () => {
      const { client, deps } = makeContext({
        configuredChannels: [{ name: '#alpha', key: 'secret' }, { name: '#beta' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(client.joins).toHaveLength(2);
      expect(client.joins[0]).toEqual({ channel: '#alpha', key: 'secret' });
      expect(client.joins[1]).toEqual({ channel: '#beta', key: undefined });
    });

    it('propagates rfc1459 casemapping', () => {
      const { client, deps, applyCasemapping } = makeContext();
      client.network.supports.mockReturnValue('rfc1459');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(applyCasemapping).toHaveBeenCalledWith('rfc1459');
    });

    it('propagates ascii casemapping', () => {
      const { client, deps, applyCasemapping } = makeContext();
      client.network.supports.mockReturnValue('ascii');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(applyCasemapping).toHaveBeenCalledWith('ascii');
    });

    it('propagates strict-rfc1459 casemapping', () => {
      const { client, deps, applyCasemapping } = makeContext();
      client.network.supports.mockReturnValue('strict-rfc1459');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(applyCasemapping).toHaveBeenCalledWith('strict-rfc1459');
    });

    it('falls back to rfc1459 for unknown casemapping value', () => {
      const { client, deps, applyCasemapping } = makeContext();
      client.network.supports.mockReturnValue('unicode');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(applyCasemapping).toHaveBeenCalledWith('rfc1459');
    });

    it('warns on unknown casemapping instead of silently falling through (§4)', () => {
      // Atheme networks may advertise `rfc7613` (unicode). hexbot still uses
      // rfc1459 but the operator needs to see the mismatch in the log.
      const { client, deps, logger } = makeContext();
      client.network.supports.mockReturnValue('rfc7613');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(warnCalls.some((s) => String(s).includes('Unknown CASEMAPPING'))).toBe(true);
    });

    it('falls back to rfc1459 without warning when CASEMAPPING is not a string', () => {
      const { client, deps, applyCasemapping, logger } = makeContext();
      client.network.supports.mockReturnValue(undefined);
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(applyCasemapping).toHaveBeenCalledWith('rfc1459');
      // No warning for undefined/non-string values — only warn on unrecognized strings
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(warnCalls.some((s) => String(s).includes('Unknown CASEMAPPING'))).toBe(false);
    });

    it('forwards a parsed STS directive to onSTSDirective when advertised (§5)', () => {
      const onSTSDirective = vi.fn();
      const { client, deps } = makeContext({ onSTSDirective });
      client.network.cap.available.set('sts', 'port=6697,duration=2592000');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(onSTSDirective).toHaveBeenCalledOnce();
      const [directive, currentTls] = onSTSDirective.mock.calls[0];
      expect(directive).toEqual({ port: 6697, duration: 2592000 });
      expect(currentTls).toBe(false);
    });

    it('does not fire onSTSDirective when no sts cap is advertised', () => {
      const onSTSDirective = vi.fn();
      const { client, deps } = makeContext({ onSTSDirective });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(onSTSDirective).not.toHaveBeenCalled();
    });

    it('warns and drops a malformed sts value', () => {
      const onSTSDirective = vi.fn();
      const { client, deps, logger } = makeContext({ onSTSDirective });
      client.network.cap.available.set('sts', 'port=6697'); // no duration → invalid
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(onSTSDirective).not.toHaveBeenCalled();
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(warnCalls.some((s) => String(s).includes('malformed STS directive'))).toBe(true);
    });

    it('propagates a parsed ISUPPORT snapshot on registration', () => {
      const applyServerCapabilities = vi.fn();
      const { client, deps } = makeContext({ applyServerCapabilities });
      // Stage a realistic PREFIX/CHANMODES/MODES/CHANTYPES snapshot.
      client.network.supports.mockImplementation((feature: string) => {
        switch (feature) {
          case 'PREFIX':
            return [
              { symbol: '~', mode: 'q' },
              { symbol: '@', mode: 'o' },
              { symbol: '+', mode: 'v' },
            ];
          case 'CHANMODES':
            return ['beI', 'k', 'l', 'imnpst'];
          case 'CHANTYPES':
            return ['#', '&', '!'];
          case 'MODES':
            return '6';
          case 'CASEMAPPING':
            return 'rfc1459';
          default:
            return false;
        }
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(applyServerCapabilities).toHaveBeenCalledOnce();
      const caps = applyServerCapabilities.mock.calls[0][0];
      expect(caps.prefixModes).toEqual(['q', 'o', 'v']);
      expect(caps.chantypes).toBe('#&!');
      expect(caps.modesPerLine).toBe(6);
      expect(caps.isValidChannel('!retro')).toBe(true);
    });

    it('does not mention TLS when tls is false', () => {
      const { client, deps, logger } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(infoCalls.some((s) => String(s).includes('TLS'))).toBe(false);
    });

    it('logs cipher info when TLS socket exposes getCipher', () => {
      const tlsConfig: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        irc: { ...MINIMAL_BOT_CONFIG.irc, tls: true },
      };
      const { client, deps, logger } = makeContext({ config: tlsConfig });
      client.connection = {
        transport: {
          socket: {
            getCipher: () => ({ name: 'ECDHE-RSA-AES256-GCM-SHA384', version: 'TLSv1.2' }),
          },
        },
      };
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('ECDHE-RSA-AES256-GCM-SHA384'),
      );
    });

    it('logs generic TLS connected when getCipher is unavailable', () => {
      const tlsConfig: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        irc: { ...MINIMAL_BOT_CONFIG.irc, tls: true },
      };
      const { client, deps, logger } = makeContext({ config: tlsConfig });
      // No .connection property on the mock — getCipher unavailable
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(logger.info).toHaveBeenCalledWith('TLS connected');
    });

    it('registers irc error and unknown command listeners', () => {
      const { client, deps } = makeContext();
      const onSpy = vi.spyOn(client, 'on');
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      const registeredEvents = onSpy.mock.calls.map((c) => c[0]);
      expect(registeredEvents).toContain('irc error');
      expect(registeredEvents).toContain('unknown command');
    });

    it('does not stack listeners on reconnect', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      try {
        const { client, deps } = makeContext({
          configuredChannels: [{ name: '#test' }],
        });
        const onSpy = vi.spyOn(client, 'on');
        registerConnectionEvents(
          deps,
          () => {},
          () => {},
        );

        // First connect
        client.emit('registered');
        const countAfterFirst = onSpy.mock.calls.filter(
          (c) => c[0] === 'irc error' || c[0] === 'unknown command',
        ).length;

        // Simulate reconnect cycle
        client.emit('reconnecting');
        client.emit('close');
        client.emit('registered');
        const countAfterSecond = onSpy.mock.calls.filter(
          (c) => c[0] === 'irc error' || c[0] === 'unknown command',
        ).length;

        // Should not have added more listeners
        expect(countAfterSecond).toBe(countAfterFirst);

        // Dispatcher bind (invite handler) should also only be called once
        expect(deps.dispatcher.bind).toHaveBeenCalledTimes(1);
      } finally {
        exitSpy.mockRestore();
      }
    });
  });

  describe('close event', () => {
    it('emits bot:disconnected with reason when close fires before registration', () => {
      const { client, deps, eventBus } = makeContext();
      const handler = vi.fn();
      eventBus.on('bot:disconnected', handler);
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('close');
      expect(handler).toHaveBeenCalledWith('connection closed');
    });

    it('forwards the IRC ERROR reason to the driver', () => {
      const { client, deps, eventBus, reconnectDriver } = makeContext();
      const handler = vi.fn();
      eventBus.on('bot:disconnected', handler);
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('irc error', { error: 'irc', reason: 'Closing Link: (Throttled)' });
      client.emit('close');
      expect(handler).toHaveBeenCalledWith('Closing Link: (Throttled)');
      expect(reconnectDriver.onDisconnect).toHaveBeenCalledOnce();
      const policy = reconnectDriver.onDisconnect.mock.calls[0][0];
      expect(policy.tier).toBe('rate-limited');
    });

    it('delegates a post-registration close to the driver as transient by default', () => {
      const { client, deps, reconnectDriver } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      client.emit('close'); // no ERROR reason
      expect(reconnectDriver.onDisconnect).toHaveBeenCalledOnce();
      const policy = reconnectDriver.onDisconnect.mock.calls[0][0];
      expect(policy.tier).toBe('transient');
    });

    it('delegates a K-lined close to the driver as rate-limited (no exit)', () => {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
      try {
        const { client, deps, reconnectDriver } = makeContext();
        registerConnectionEvents(
          deps,
          () => {},
          () => {},
        );
        client.emit('irc error', {
          error: 'irc',
          reason: 'Closing Link: 1.2.3.4 (K-Lined: spam)',
        });
        client.emit('close');
        expect(reconnectDriver.onDisconnect).toHaveBeenCalledOnce();
        const policy = reconnectDriver.onDisconnect.mock.calls[0][0];
        expect(policy.tier).toBe('rate-limited');
        expect('label' in policy ? policy.label : null).toBe('K-Lined');
        // Lifecycle no longer calls process.exit — the driver is responsible
        // for fatal tiers, and this isn't one.
        expect(exitSpy).not.toHaveBeenCalled();
      } finally {
        exitSpy.mockRestore();
      }
    });

    it('delegates a K-lined close AFTER registration to the driver', () => {
      const { client, deps, reconnectDriver } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      client.emit('irc error', {
        error: 'irc',
        reason: 'Closing Link: 1.2.3.4 (K-Lined: spam)',
      });
      client.emit('close');
      expect(reconnectDriver.onDisconnect).toHaveBeenCalledOnce();
      expect(reconnectDriver.onDisconnect.mock.calls[0][0].tier).toBe('rate-limited');
    });

    it('clears the message queue on every close', () => {
      const { client, deps, messageQueue } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('close');
      expect(messageQueue.clear).toHaveBeenCalledOnce();
    });

    it('invokes onReconnecting on every close so identity caches drop (§7)', () => {
      const onReconnecting = vi.fn();
      const { client, deps } = makeContext({ onReconnecting });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('close');
      expect(onReconnecting).toHaveBeenCalledOnce();
    });
  });

  describe('socket error event', () => {
    it('captures the socket error for driver classification', () => {
      const { client, deps, reconnectDriver } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('socket error', new Error('unable to verify the first certificate'));
      client.emit('close');
      const policy = reconnectDriver.onDisconnect.mock.calls[0][0];
      expect(policy.tier).toBe('fatal');
    });

    it('emits bot:error with the error object', () => {
      const { client, deps, eventBus } = makeContext();
      const handler = vi.fn();
      eventBus.on('bot:error', handler);
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      const err = new Error('socket failure');
      client.emit('socket error', err);
      expect(handler).toHaveBeenCalledWith(err);
    });
  });

  describe('registration timeout (§6)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('aborts registration if no IRC greeting arrives within 30s of connection attempt', () => {
      const { client, deps, reconnectDriver } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      // Connecting event fires when client.connect() is called
      client.emit('connecting');
      expect(reconnectDriver.onDisconnect).not.toHaveBeenCalled();

      // Advance to 30s — registration timeout should fire
      vi.advanceTimersByTime(30_000);
      expect(reconnectDriver.onDisconnect).toHaveBeenCalledOnce();
      const policy = reconnectDriver.onDisconnect.mock.calls[0][0];
      expect(policy.tier).toBe('transient');
      expect(policy.label).toBe('registration timeout');
    });

    it('cancels the timeout if registration completes before 30s', () => {
      const { client, deps, reconnectDriver } = makeContext();
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('connecting');
      vi.advanceTimersByTime(10_000);
      client.emit('registered');
      vi.advanceTimersByTime(20_000);
      expect(reconnectDriver.onDisconnect).not.toHaveBeenCalled();
    });
  });

  describe('irc error listeners (registered after connect)', () => {
    let ctx: TestContext;

    beforeEach(() => {
      ctx = makeContext();
      registerConnectionEvents(
        ctx.deps,
        () => {},
        () => {},
      );
      ctx.client.emit('registered');
    });

    it('logs warning for channel_is_full', () => {
      ctx.client.emit('irc error', { error: 'channel_is_full', channel: '#busy' });
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('channel is full'));
    });

    it('logs warning for invite_only_channel', () => {
      ctx.client.emit('irc error', { error: 'invite_only_channel', channel: '#priv' });
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('invite only'));
    });

    it('logs warning for banned_from_channel', () => {
      ctx.client.emit('irc error', { error: 'banned_from_channel', channel: '#strict' });
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('banned'));
    });

    it('logs warning for bad_channel_key', () => {
      ctx.client.emit('irc error', { error: 'bad_channel_key', channel: '#keyed' });
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('bad channel key'));
    });

    it('does not log for unrecognized irc errors', () => {
      const warnsBefore = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      ctx.client.emit('irc error', { error: 'unknown_error', channel: '#test' });
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(warnsBefore);
    });

    it('logs warning for numeric 477 (need to register nick)', () => {
      ctx.client.emit('unknown command', { command: '477', params: ['testbot', '#restricted'] });
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('#restricted'));
    });

    it('ignores non-477 unknown command numerics', () => {
      const warnsBefore = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      ctx.client.emit('unknown command', { command: '999', params: ['testbot', '#test'] });
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(warnsBefore);
    });

    it('irc error: missing error field falls back to empty string via ??', () => {
      // Fires the handler but reason is undefined (JOIN_ERROR_NAMES[''] = undefined) → no warn
      const warnsBefore = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      ctx.client.emit('irc error', {}); // no error field — hits e.error ?? '' fallback
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(warnsBefore);
    });

    it('irc error: missing channel field falls back to empty string via ??', () => {
      // Error is known but channel is missing — hits e.channel ?? '' fallback
      ctx.client.emit('irc error', { error: 'channel_is_full' }); // no channel field
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('channel is full'));
      expect(ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining(':'));
    });

    it('unknown command: missing command field falls back via ??', () => {
      // Hits e.command ?? '' → '' !== '477' → no warn
      const warnsBefore = (ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length;
      ctx.client.emit('unknown command', {}); // no command field
      expect((ctx.logger.warn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(warnsBefore);
    });

    it('unknown command 477: non-array params falls back to empty array', () => {
      // Array.isArray(e.params) false branch → params = [] → params[1] undefined → ?? '' fallback
      ctx.client.emit('unknown command', { command: '477', params: { notAnArray: true } });
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('need to register nick'),
      );
    });

    it('unknown command 477: short params array falls back to empty string via ??', () => {
      // params[1] is undefined → hits params[1] ?? '' fallback
      ctx.client.emit('unknown command', { command: '477', params: ['testbot'] }); // only 1 element
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('need to register nick'),
      );
    });
  });

  describe('core INVITE handler', () => {
    it('re-joins a configured channel when invited', () => {
      const { client, deps } = makeContext({
        configuredChannels: [{ name: '#test', key: 'mykey' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');

      const [, , , handler] = (deps.dispatcher.bind as ReturnType<typeof vi.fn>).mock.calls[0];
      client.joins = []; // clear joins from startup
      handler({ nick: 'op', channel: '#test' });

      expect(client.joins).toContainEqual({ channel: '#test', key: 'mykey' });
    });

    it('ignores invite to a non-configured channel', () => {
      const { client, deps } = makeContext({
        configuredChannels: [{ name: '#test' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');

      const [, , , handler] = (deps.dispatcher.bind as ReturnType<typeof vi.fn>).mock.calls[0];
      client.joins = [];
      handler({ nick: 'op', channel: '#other' });

      expect(client.joins).toHaveLength(0);
    });

    it('ignores invite with null channel', () => {
      const { client, deps } = makeContext({
        configuredChannels: [{ name: '#test' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');

      const [, , , handler] = (deps.dispatcher.bind as ReturnType<typeof vi.fn>).mock.calls[0];
      client.joins = [];
      handler({ nick: 'op', channel: null });

      expect(client.joins).toHaveLength(0);
    });
  });

  describe('handle cleanup methods', () => {
    it('removeListeners() removes all registered listeners from the client', () => {
      const { client, deps } = makeContext();
      const handle = registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );

      // Before: listeners registered
      expect(client.listenerCount('registered')).toBeGreaterThan(0);
      expect(client.listenerCount('close')).toBeGreaterThan(0);

      handle.removeListeners();

      // After: all listeners from lifecycle removed
      expect(client.listenerCount('registered')).toBe(0);
      expect(client.listenerCount('close')).toBe(0);
      expect(client.listenerCount('irc error')).toBe(0);
      expect(client.listenerCount('socket error')).toBe(0);
      expect(client.listenerCount('unknown command')).toBe(0);
    });

    it('cancelReconnect() forwards to the driver', () => {
      const { deps, reconnectDriver } = makeContext();
      const handle = registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      handle.cancelReconnect();
      expect(reconnectDriver.cancel).toHaveBeenCalledOnce();
    });
  });

  describe('identifyWithServices callback', () => {
    it('calls identifyWithServices after registration', () => {
      const identifyWithServices = vi.fn();
      const { client, deps } = makeContext({ identifyWithServices });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      expect(identifyWithServices).toHaveBeenCalledOnce();
    });

    it('does not throw when identifyWithServices is omitted', () => {
      const { client, deps } = makeContext(); // no identifyWithServices
      expect(() => {
        registerConnectionEvents(
          deps,
          () => {},
          () => {},
        );
        client.emit('registered');
      }).not.toThrow();
    });
  });

  describe('nick collision detection (C-4)', () => {
    it('emits bot:nick-collision when registered nick differs from configured', async () => {
      const { client, deps, eventBus } = makeContext({
        configuredChannels: [{ name: '#test' }],
      });
      const collisionListener = vi.fn();
      eventBus.on('bot:nick-collision', collisionListener);
      client.user = { nick: 'testbot_' }; // server assigned alternate nick
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      await Promise.resolve(); // flush async registered handler
      expect(collisionListener).toHaveBeenCalledWith('testbot_');
    });

    it('does not emit bot:nick-collision when nick matches configured', async () => {
      const { client, deps, eventBus } = makeContext();
      const collisionListener = vi.fn();
      eventBus.on('bot:nick-collision', collisionListener);
      client.user = { nick: 'testbot' };
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      await Promise.resolve();
      expect(collisionListener).not.toHaveBeenCalled();
    });

    it('warns in log when nick collision is detected', async () => {
      const { client, deps, logger } = makeContext();
      client.user = { nick: 'testbot_' };
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      await Promise.resolve();
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(warnCalls.some((s) => String(s).includes('nick collision'))).toBe(true);
    });

    it('logs normal connect message when no collision', async () => {
      const { client, deps, logger } = makeContext();
      client.user = { nick: 'testbot' };
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      await Promise.resolve();
      const infoCalls = (logger.info as ReturnType<typeof vi.fn>).mock.calls.flat();
      expect(infoCalls.some((s) => String(s).includes('Connected to'))).toBe(true);
    });

    it('falls back to configured nick when client.user is undefined', async () => {
      const { client, deps, eventBus } = makeContext();
      const collisionListener = vi.fn();
      eventBus.on('bot:nick-collision', collisionListener);
      // client.user is undefined — actualNick falls back to cfg.nick
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');
      await Promise.resolve();
      expect(collisionListener).not.toHaveBeenCalled();
    });
  });

  describe('identify_before_join gate (W-1)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('gates JOIN on bot:identified when identify_before_join is true', async () => {
      const config: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        services: {
          ...MINIMAL_BOT_CONFIG.services,
          identify_before_join: true,
          identify_before_join_timeout_ms: 5_000,
        },
      };
      const { client, deps, eventBus } = makeContext({
        config,
        configuredChannels: [{ name: '#test' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');

      // Let async handler reach the await point
      await Promise.resolve();
      // Channels should NOT be joined yet — gate is blocking on bot:identified
      expect(client.joins).toHaveLength(0);

      // Fire bot:identified to release the gate.
      // Need two microtask ticks: one for Promise.race to resolve,
      // one for the onRegistered continuation to run joinConfiguredChannels.
      eventBus.emit('bot:identified');
      await Promise.resolve();
      await Promise.resolve();

      expect(client.joins).toHaveLength(1);
      expect(client.joins[0].channel).toBe('#test');
    });

    it('falls through and JOINs after timeout when bot:identified never fires', async () => {
      const config: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        services: {
          ...MINIMAL_BOT_CONFIG.services,
          identify_before_join: true,
          identify_before_join_timeout_ms: 5_000,
        },
      };
      const { client, deps } = makeContext({
        config,
        configuredChannels: [{ name: '#test' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');

      await Promise.resolve();
      expect(client.joins).toHaveLength(0);

      // Advance past the identify_before_join timeout
      await vi.advanceTimersByTimeAsync(5_000);

      expect(client.joins).toHaveLength(1);
    });

    it('uses 10s default timeout when identify_before_join_timeout_ms is not set', async () => {
      const config: BotConfig = {
        ...MINIMAL_BOT_CONFIG,
        services: {
          ...MINIMAL_BOT_CONFIG.services,
          identify_before_join: true,
          // identify_before_join_timeout_ms omitted → defaults to 10_000
        },
      };
      const { client, deps } = makeContext({
        config,
        configuredChannels: [{ name: '#test' }],
      });
      registerConnectionEvents(
        deps,
        () => {},
        () => {},
      );
      client.emit('registered');

      await Promise.resolve();
      // Not yet joined after 5s
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.joins).toHaveLength(0);

      // Joined after 10s default timeout
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.joins).toHaveLength(1);
    });
  });

  describe('classifyCloseReason', () => {
    const cases: Array<[string, ReconnectPolicy['tier'], string | undefined]> = [
      // Transient — unknown / well-known non-fatal causes
      ['ping timeout', 'transient', 'ping timeout'],
      ['Registration timed out', 'transient', 'registration timeout'],
      ['Server shutting down', 'transient', 'server shutting down'],
      ['Restart in progress', 'transient', 'server restart'],
      ['some garbage nobody has seen before', 'transient', undefined],
      // Rate-limited — K/G/Z line, DNSBL, throttle
      ['Closing Link: K-Lined: spam', 'rate-limited', 'K-Lined'],
      ['Closing Link: G-Lined', 'rate-limited', 'G-Lined'],
      ['Closing Link: Z-Lined', 'rate-limited', 'Z-Lined'],
      ['Banned from server', 'rate-limited', 'banned from server'],
      ['You are not welcome on this network', 'rate-limited', 'banned from server'],
      ['Your IP is listed in DNSBL', 'rate-limited', 'blocked by DNSBL'],
      ['Throttled: reconnecting too fast', 'rate-limited', 'throttled'],
      ['Too many connections from your IP', 'rate-limited', 'too many connections'],
      ['Excess Flood', 'rate-limited', 'excess flood'],
      // Fatal — SASL / TLS
      ['SASL authentication failed', 'fatal', 'SASL authentication failed'],
      ['SASL failed: invalid credentials', 'fatal', 'SASL authentication failed'],
      ['SASL mechanism not supported', 'fatal', 'SASL mechanism not supported'],
      ['unable to verify the first certificate', 'fatal', 'TLS certificate untrusted'],
      ["Hostname/IP does not match certificate's altnames", 'fatal', 'TLS hostname mismatch'],
      ['CERT_HAS_EXPIRED', 'fatal', 'TLS certificate expired'],
    ];

    it.each(cases)('%s → tier %s (label: %s)', (reason, tier, label) => {
      const policy = classifyCloseReason(reason);
      expect(policy.tier).toBe(tier);
      if (label !== undefined) {
        expect('label' in policy ? policy.label : undefined).toBe(label);
      }
    });

    it('null reason → transient with no label', () => {
      const policy = classifyCloseReason(null);
      expect(policy.tier).toBe('transient');
      expect('label' in policy ? policy.label : undefined).toBeUndefined();
    });

    it('fatal policy carries exitCode 2', () => {
      const policy = classifyCloseReason('SASL authentication failed');
      expect(policy.tier).toBe('fatal');
      if (policy.tier === 'fatal') {
        expect(policy.exitCode).toBe(2);
      }
    });
  });
});
