import { describe, expect, it, vi } from 'vitest';

import type {
  RelayDCCView,
  RelayHandlerDeps,
  RelaySessionMap,
} from '../../src/core/botlink-relay-handler';
import { handleRelayFrame } from '../../src/core/botlink-relay-handler';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<RelayHandlerDeps>): RelayHandlerDeps {
  return {
    permissions: {
      getUser: (handle: string) => ({ hostmasks: [`${handle}!user@host`] }),
    },
    commandHandler: { execute: vi.fn().mockResolvedValue(undefined) },
    dccManager: {
      getSessionList: () => [],
      getSession: () => undefined,
      announce: vi.fn(),
    },
    botname: 'testbot',
    sender: { sendTo: vi.fn().mockReturnValue(true), send: vi.fn() },
    stripFormatting: (t: string) => t,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRelayFrame', () => {
  it('ignores non-RELAY frames', () => {
    const deps = createDeps();
    const sessions: RelaySessionMap = new Map();
    handleRelayFrame({ type: 'PARTY_CHAT' }, deps, sessions);
    expect(sessions.size).toBe(0);
    expect(deps.sender.send).not.toHaveBeenCalled();
  });

  describe('RELAY_REQUEST', () => {
    it('creates a virtual session and sends RELAY_ACCEPT', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'alice', fromBot: 'leafbot' },
        deps,
        sessions,
      );
      expect(sessions.has('alice')).toBe(true);
      expect(deps.sender.sendTo).toHaveBeenCalledWith('leafbot', {
        type: 'RELAY_ACCEPT',
        handle: 'alice',
        toBot: 'testbot',
      });
    });

    it('rejects if user not found in permissions', () => {
      const deps = createDeps({ permissions: { getUser: () => null } });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'unknown', fromBot: 'leafbot' },
        deps,
        sessions,
      );
      expect(sessions.has('unknown')).toBe(false);
      expect(deps.sender.sendTo).toHaveBeenCalledWith(
        'leafbot',
        expect.objectContaining({ type: 'RELAY_END', handle: 'unknown' }),
      );
    });

    it('accepts even when no local DCC manager (leaf target without DCC)', () => {
      const deps = createDeps({ dccManager: null });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'alice', fromBot: 'leafbot' },
        deps,
        sessions,
      );
      expect(sessions.has('alice')).toBe(true);
      expect(deps.sender.sendTo).toHaveBeenCalledWith('leafbot', {
        type: 'RELAY_ACCEPT',
        handle: 'alice',
        toBot: 'testbot',
      });
    });
  });

  describe('RELAY_ACCEPT', () => {
    it('confirms the origin DCC session when accept arrives', () => {
      const confirmRelay = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine: vi.fn(),
            isRelaying: true,
            relayTarget: null,
            exitRelay: vi.fn(),
            confirmRelay,
          }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_ACCEPT', handle: 'alice', toBot: 'leafbot' }, deps, sessions);
      expect(confirmRelay).toHaveBeenCalled();
    });

    it('is a no-op without a local DCC manager', () => {
      const deps = createDeps({ dccManager: null });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_ACCEPT', handle: 'alice', toBot: 'leafbot' }, deps, sessions);
      // No throw, no calls
      expect(deps.sender.sendTo).not.toHaveBeenCalled();
    });
  });

  describe('logging', () => {
    function makeLogger(): {
      info: ReturnType<typeof vi.fn>;
      warn: ReturnType<typeof vi.fn>;
      debug: ReturnType<typeof vi.fn>;
      error: ReturnType<typeof vi.fn>;
    } {
      return { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    }

    it('logs RELAY_REQUEST accept and reject paths', () => {
      const log = makeLogger();
      const deps = createDeps({ logger: log as never });
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'alice', fromBot: 'leafbot' },
        deps,
        new Map(),
      );
      expect(log.info).toHaveBeenCalled();

      const denyLog = makeLogger();
      const denyDeps = createDeps({
        permissions: { getUser: () => null },
        logger: denyLog as never,
      });
      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'unknown', fromBot: 'leafbot' },
        denyDeps,
        new Map(),
      );
      expect(denyLog.warn).toHaveBeenCalled();
    });

    it('logs RELAY_INPUT, RELAY_ACCEPT, and RELAY_END transitions', async () => {
      const log = makeLogger();
      const deps = createDeps({
        logger: log as never,
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine: vi.fn(),
            isRelaying: true,
            relayTarget: null,
            exitRelay: vi.fn(),
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });

      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice', line: '.x' }, deps, sessions);
      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'ghost', line: '.x' }, deps, sessions);
      handleRelayFrame({ type: 'RELAY_ACCEPT', handle: 'alice', toBot: 'leaf' }, deps, sessions);
      handleRelayFrame({ type: 'RELAY_END', handle: 'alice', reason: 'bye' }, deps, sessions);

      expect(log.debug).toHaveBeenCalled();
      expect(log.info).toHaveBeenCalled();
    });

    it('logs command-handler rejection with warn', async () => {
      const log = makeLogger();
      const deps = createDeps({
        logger: log as never,
        commandHandler: { execute: vi.fn().mockRejectedValue(new Error('boom')) },
      });
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });
      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice', line: '.x' }, deps, sessions);
      await vi.waitFor(() => expect(log.warn).toHaveBeenCalled());
    });
  });

  describe('RELAY_OUTPUT and RELAY_END edge cases', () => {
    it('RELAY_OUTPUT skips sessions whose handle does not match', () => {
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [
            { handle: 'bob', nick: 'Bob', connectedAt: 0 },
            { handle: 'alice', nick: 'Alice', connectedAt: 0 },
          ],
          getSession: (nick: string) =>
            nick === 'Alice'
              ? {
                  writeLine,
                  isRelaying: true,
                  relayTarget: null,
                  exitRelay: vi.fn(),
                  confirmRelay: vi.fn(),
                }
              : {
                  writeLine: vi.fn(),
                  isRelaying: true,
                  relayTarget: null,
                  exitRelay: vi.fn(),
                  confirmRelay: vi.fn(),
                },
          announce: vi.fn(),
        },
      });
      handleRelayFrame({ type: 'RELAY_OUTPUT', handle: 'alice', line: 'hi' }, deps, new Map());
      expect(writeLine).toHaveBeenCalledWith('hi');
    });

    it('RELAY_END is a no-op on the origin side when no DCC manager', () => {
      const deps = createDeps({ dccManager: null });
      const sessions: RelaySessionMap = new Map();
      // No virtual session for this handle either — should not throw
      handleRelayFrame({ type: 'RELAY_END', handle: 'ghost', reason: 'gone' }, deps, sessions);
    });

    it('RELAY_END falls back to default reason when frame omits one', () => {
      const exitRelay = vi.fn();
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine,
            isRelaying: true,
            relayTarget: null,
            exitRelay,
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      handleRelayFrame({ type: 'RELAY_END', handle: 'alice' }, deps, new Map());
      expect(writeLine).toHaveBeenCalledWith('*** Relay ended: remote bot');
    });

    it('handles RELAY_REQUEST with missing fromBot via default empty string', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_REQUEST', handle: 'alice' }, deps, sessions);
      expect(sessions.has('alice')).toBe(true);
      expect(deps.sender.sendTo).toHaveBeenCalledWith(
        '',
        expect.objectContaining({ type: 'RELAY_ACCEPT' }),
      );
    });

    it('handles RELAY_INPUT with missing line via default empty string', () => {
      const deps = createDeps();
      const sendOutput = vi.fn();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput });
      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice' }, deps, sessions);
      // Empty string is not a dot-command, so it goes to party-line path
      expect(sendOutput).toHaveBeenCalledWith('<alice> ');
    });

    it('RELAY_OUTPUT writes empty string when frame omits line', () => {
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine,
            isRelaying: true,
            relayTarget: null,
            exitRelay: vi.fn(),
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      handleRelayFrame({ type: 'RELAY_OUTPUT', handle: 'alice' }, deps, new Map());
      expect(writeLine).toHaveBeenCalledWith('');
    });

    it('RELAY_INPUT command path uses handle when user has no hostmask prefix', async () => {
      const deps = createDeps({
        permissions: { getUser: () => ({ hostmasks: [] }) },
      });
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });
      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice', line: '.x' }, deps, sessions);
      await vi.waitFor(() => {
        expect(deps.commandHandler.execute).toHaveBeenCalledWith(
          '.x',
          expect.objectContaining({ nick: 'alice' }),
        );
      });
    });
  });

  describe('RELAY_INPUT command reply', () => {
    it('splits multi-line replies and forwards each as RELAY_OUTPUT', async () => {
      let capturedReply: ((msg: string) => void) | null = null;
      const deps = createDeps({
        commandHandler: {
          execute: vi.fn(async (_cmd, ctx) => {
            capturedReply = ctx.reply;
          }),
        },
      });
      const sendOutput = vi.fn();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput });

      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice', line: '.help' }, deps, sessions);
      await vi.waitFor(() => expect(capturedReply).not.toBeNull());

      capturedReply!('line1\nline2\nline3');
      expect(sendOutput).toHaveBeenCalledTimes(3);
      expect(sendOutput).toHaveBeenNthCalledWith(1, 'line1');
      expect(sendOutput).toHaveBeenNthCalledWith(2, 'line2');
      expect(sendOutput).toHaveBeenNthCalledWith(3, 'line3');
    });
  });

  describe('RELAY_INPUT', () => {
    it('routes dot-commands through commandHandler', async () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });

      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'alice', line: '.status' }, deps, sessions);

      // Wait for the async execute call
      await vi.waitFor(() => {
        expect(deps.commandHandler.execute).toHaveBeenCalledWith(
          '.status',
          expect.objectContaining({ source: 'botlink', nick: 'alice' }),
        );
      });
    });

    it('broadcasts plain text as party line chat', () => {
      const deps = createDeps();
      const sendOutput = vi.fn();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput });

      handleRelayFrame(
        { type: 'RELAY_INPUT', handle: 'alice', line: 'hello everyone' },
        deps,
        sessions,
      );

      expect((deps.dccManager as RelayDCCView).announce).toHaveBeenCalledWith(
        '<alice@relay> hello everyone',
      );
      expect(sendOutput).toHaveBeenCalledWith('<alice> hello everyone');
    });

    it('ignores input for unknown session', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_INPUT', handle: 'nobody', line: 'hi' }, deps, sessions);
      expect(deps.commandHandler.execute).not.toHaveBeenCalled();
    });
  });

  describe('RELAY_OUTPUT', () => {
    it('writes output to matching DCC session', () => {
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine,
            isRelaying: true,
            relayTarget: null,
            exitRelay: vi.fn(),
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame(
        { type: 'RELAY_OUTPUT', handle: 'alice', line: 'response text' },
        deps,
        sessions,
      );

      expect(writeLine).toHaveBeenCalledWith('response text');
    });

    it('does nothing without dccManager', () => {
      const deps = createDeps({ dccManager: null });
      const sessions: RelaySessionMap = new Map();
      handleRelayFrame({ type: 'RELAY_OUTPUT', handle: 'alice', line: 'text' }, deps, sessions);
      // No error thrown
    });

    it('prefixes output with the relay target bot name when known', () => {
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine,
            isRelaying: true,
            relayTarget: 'BlueAngel',
            exitRelay: vi.fn(),
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      handleRelayFrame(
        { type: 'RELAY_OUTPUT', handle: 'alice', line: 'Message sent to #hexbot' },
        deps,
        new Map(),
      );
      expect(writeLine).toHaveBeenCalledWith('[BlueAngel] Message sent to #hexbot');
    });
  });

  describe('RELAY_END', () => {
    it('removes virtual session', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();
      sessions.set('alice', { fromBot: 'leafbot', sendOutput: vi.fn() });

      handleRelayFrame({ type: 'RELAY_END', handle: 'alice', reason: 'done' }, deps, sessions);

      expect(sessions.has('alice')).toBe(false);
    });

    it('exits relay mode on DCC session if relaying', () => {
      const exitRelay = vi.fn();
      const writeLine = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine,
            isRelaying: true,
            relayTarget: null,
            exitRelay,
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame(
        { type: 'RELAY_END', handle: 'alice', reason: 'disconnected' },
        deps,
        sessions,
      );

      expect(exitRelay).toHaveBeenCalled();
      expect(writeLine).toHaveBeenCalledWith('*** Relay ended: disconnected');
    });

    it('does not exit relay if session is not relaying', () => {
      const exitRelay = vi.fn();
      const deps = createDeps({
        dccManager: {
          getSessionList: () => [{ handle: 'alice', nick: 'Alice', connectedAt: 0 }],
          getSession: () => ({
            writeLine: vi.fn(),
            isRelaying: false,
            relayTarget: null,
            exitRelay,
            confirmRelay: vi.fn(),
          }),
          announce: vi.fn(),
        },
      });
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame({ type: 'RELAY_END', handle: 'alice' }, deps, sessions);

      expect(exitRelay).not.toHaveBeenCalled();
    });
  });

  describe('RELAY_OUTPUT from virtual session sendOutput', () => {
    it('session sendOutput sends RELAY_OUTPUT frame to originating bot', () => {
      const deps = createDeps();
      const sessions: RelaySessionMap = new Map();

      handleRelayFrame(
        { type: 'RELAY_REQUEST', handle: 'bob', fromBot: 'remoteleaf' },
        deps,
        sessions,
      );

      const vs = sessions.get('bob')!;
      vs.sendOutput('hello from remote');

      expect(deps.sender.sendTo).toHaveBeenCalledWith('remoteleaf', {
        type: 'RELAY_OUTPUT',
        handle: 'bob',
        line: 'hello from remote',
      });
    });
  });
});
