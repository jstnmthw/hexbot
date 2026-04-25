import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Services } from '../../src/core/services';
import { BotEventBus } from '../../src/event-bus';
import type { ServicesConfig } from '../../src/types';

// ---------------------------------------------------------------------------
// Mock IRC client
// ---------------------------------------------------------------------------

interface SentMessage {
  target: string;
  message: string;
}

class MockClient extends EventEmitter {
  sent: SentMessage[] = [];

  say(target: string, message: string): void {
    this.sent.push({ target, message });
  }

  changeNick(_nick: string): void {
    // no-op in tests
  }

  simulateNotice(nick: string, message: string): void {
    this.emit('notice', { nick, message });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createServices(opts?: {
  type?: ServicesConfig['type'];
  nickserv?: string;
  password?: string;
  sasl?: boolean;
  botNick?: string;
}): { services: Services; client: MockClient; eventBus: BotEventBus } {
  const client = new MockClient();
  const eventBus = new BotEventBus();

  const servicesConfig: ServicesConfig = {
    type: opts?.type ?? 'atheme',
    nickserv: opts?.nickserv ?? 'NickServ',
    password: opts?.password ?? 'botpass',
    sasl: opts?.sasl ?? false,
  };

  const services = new Services({
    client,
    servicesConfig,
    eventBus,
    botNick: opts?.botNick,
  });

  services.attach();
  return { services, client, eventBus };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Services', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('bot authentication', () => {
    it('should send IDENTIFY on connect (non-SASL mode)', () => {
      const { services, client } = createServices({ sasl: false, password: 'mypass' });

      services.identify();

      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].target).toBe('NickServ');
      expect(client.sent[0].message).toBe('IDENTIFY mypass');
    });

    it('should not send IDENTIFY when SASL is enabled', () => {
      const { services, client } = createServices({ sasl: true, password: 'mypass' });

      services.identify();

      expect(client.sent).toHaveLength(0);
    });

    it('should not send IDENTIFY when type is none', () => {
      const { services, client } = createServices({ type: 'none' });

      services.identify();

      expect(client.sent).toHaveLength(0);
    });

    it('should not send IDENTIFY when no password', () => {
      const { services, client } = createServices({ password: '' });

      services.identify();

      expect(client.sent).toHaveLength(0);
    });
  });

  describe('verifyUser — Atheme', () => {
    it('should send correct ACC command for atheme', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Alice', 1000);

      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].target).toBe('NickServ');
      expect(client.sent[0].message).toBe('ACC Alice');

      // Simulate response
      client.simulateNotice('NickServ', 'Alice ACC 3');

      const result = await promise;
      expect(result.verified).toBe(true);
      expect(result.account).toBe('Alice');
    });

    it('should return verified=false for ACC level 1', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Bob', 1000);
      client.simulateNotice('NickServ', 'Bob ACC 1');

      const result = await promise;
      expect(result.verified).toBe(false);
      expect(result.account).toBeNull();
    });

    it('should return verified=false for ACC level 0', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Charlie', 1000);
      client.simulateNotice('NickServ', 'Charlie ACC 0');

      const result = await promise;
      expect(result.verified).toBe(false);
    });
  });

  describe('verifyUser — Anope', () => {
    it('should send correct STATUS command for anope', async () => {
      const { services, client } = createServices({ type: 'anope' });

      const promise = services.verifyUser('Alice', 1000);

      expect(client.sent[0].message).toBe('STATUS Alice');

      // Simulate response
      client.simulateNotice('NickServ', 'STATUS Alice 3');

      const result = await promise;
      expect(result.verified).toBe(true);
    });

    it('should return verified=false for STATUS level 1', async () => {
      const { services, client } = createServices({ type: 'anope' });

      const promise = services.verifyUser('Bob', 1000);
      client.simulateNotice('NickServ', 'STATUS Bob 1');

      const result = await promise;
      expect(result.verified).toBe(false);
    });
  });

  describe('verifyUser — ACC/STATUS fallback', () => {
    it('should fall back to STATUS when ACC is unknown', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Alice', 2000);

      // First command should be ACC
      expect(client.sent[0].message).toBe('ACC Alice');

      // NickServ replies "Unknown command ACC."
      client.simulateNotice('NickServ', 'Unknown command ACC.  "/msg NickServ HELP" for help.');

      // Should retry with STATUS
      expect(client.sent[1].message).toBe('STATUS Alice');

      // Simulate STATUS response
      client.simulateNotice('NickServ', 'STATUS Alice 3');

      const result = await promise;
      expect(result.verified).toBe(true);
    });

    it('should fall back to ACC when STATUS is unknown', async () => {
      const { services, client } = createServices({ type: 'anope' });

      const promise = services.verifyUser('Bob', 2000);

      // First command should be STATUS
      expect(client.sent[0].message).toBe('STATUS Bob');

      // NickServ replies "Unknown command STATUS."
      client.simulateNotice('NickServ', 'Unknown command STATUS.');

      // Should retry with ACC
      expect(client.sent[1].message).toBe('ACC Bob');

      // Simulate ACC response
      client.simulateNotice('NickServ', 'Bob ACC 3');

      const result = await promise;
      expect(result.verified).toBe(true);
    });
  });

  describe('verification timeout', () => {
    it('should return verified=false on timeout', async () => {
      const { services } = createServices({ type: 'atheme' });

      // Use a very short timeout
      const result = await services.verifyUser('SlowNick', 50);

      expect(result.verified).toBe(false);
      expect(result.account).toBeNull();
    });
  });

  describe('services type: none', () => {
    it('should always return verified=true when type is none', async () => {
      const { services, client } = createServices({ type: 'none' });

      const result = await services.verifyUser('Anyone');

      expect(result.verified).toBe(true);
      expect(result.account).toBe('Anyone');
      // No NickServ query sent
      expect(client.sent).toHaveLength(0);
    });
  });

  describe('DALnet adapter', () => {
    it('should use correct NickServ target for DALnet', () => {
      const { services, client } = createServices({
        type: 'atheme',
        nickserv: 'nickserv@services.dal.net',
      });

      services.identify();

      expect(client.sent[0].target).toBe('nickserv@services.dal.net');
    });

    it('should recognize NickServ responses from DALnet services nick', async () => {
      const { services, client } = createServices({
        type: 'atheme',
        nickserv: 'nickserv@services.dal.net',
      });

      const promise = services.verifyUser('Alice', 1000);

      // DALnet's NickServ sends from 'nickserv' nick
      client.simulateNotice('nickserv', 'Alice ACC 3');

      const result = await promise;
      expect(result.verified).toBe(true);
    });
  });

  describe('isAvailable', () => {
    it('should return true when services are configured', () => {
      const { services } = createServices({ type: 'atheme' });
      expect(services.isAvailable()).toBe(true);
    });

    it('should return false when type is none', () => {
      const { services } = createServices({ type: 'none' });
      expect(services.isAvailable()).toBe(false);
    });
  });

  describe('getServicesType', () => {
    it('should return the configured type', () => {
      const { services } = createServices({ type: 'anope' });
      expect(services.getServicesType()).toBe('anope');
    });
  });

  describe('setCasemapping', () => {
    it('should update casemapping without throwing', () => {
      const { services } = createServices({ type: 'atheme' });
      // Should not throw; exercises line 63
      expect(() => services.setCasemapping('ascii')).not.toThrow();
    });
  });

  describe('duplicate pending verification', () => {
    it('should share one in-flight promise across concurrent callers for the same nick', async () => {
      // Stability audit 2026-04-14: the old behavior canceled the
      // existing pending verify on every duplicate, restarting the
      // timeout and piling up abandoned promises under dispatch
      // pressure. The new behavior deduplicates — both callers share
      // one ACC/STATUS round-trip and see the same result.
      const { services, client } = createServices({ type: 'atheme' });

      const promise1 = services.verifyUser('Alice', 5000);
      const promise2 = services.verifyUser('Alice', 5000);

      // Only ONE ACC command should be on the wire for both callers.
      expect(client.sent.filter((m) => m.message === 'ACC Alice')).toHaveLength(1);

      client.simulateNotice('NickServ', 'Alice ACC 3');
      const [result1, result2] = await Promise.all([promise1, promise2]);

      expect(result1.verified).toBe(true);
      expect(result2.verified).toBe(true);
      expect(result1).toEqual(result2);
    });

    it('rejects new verifies above MAX_PENDING_VERIFIES fail-closed', async () => {
      const { services } = createServices({ type: 'atheme' });

      // Burn the cap with 128 distinct-nick verifies. None resolve —
      // the promises stay pending for the entire test. The 129th call
      // must return {verified:false} immediately.
      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < 128; i++) {
        pending.push(services.verifyUser(`nick${i}`, 60_000));
      }

      const rejected = await services.verifyUser('overflow', 60_000);
      expect(rejected.verified).toBe(false);
      expect(services.getPendingCapRejectionCount()).toBe(1);

      services.detach();
      await Promise.all(pending);
    });

    it('emits a nickserv-verify-cap audit row when the cap is exceeded', async () => {
      const { BotDatabase } = await import('../../src/database');
      const db = new BotDatabase(':memory:');
      db.open();
      const client = new MockClient();
      const eventBus = new BotEventBus();
      const services = new Services({
        client,
        servicesConfig: {
          type: 'atheme',
          nickserv: 'NickServ',
          password: 'pw',
          sasl: false,
        },
        eventBus,
        db,
      });
      services.attach();

      const pending: Array<Promise<unknown>> = [];
      for (let i = 0; i < 128; i++) {
        pending.push(services.verifyUser(`nick${i}`, 60_000));
      }
      await services.verifyUser('overflow', 60_000);

      const rows = db.getModLog({ action: 'nickserv-verify-cap' });
      expect(rows).toHaveLength(1);
      expect(rows[0].target).toBe('overflow');

      services.detach();
      await Promise.all(pending);
      db.close();
    });
  });

  describe('event emission', () => {
    it('should emit user:identified on successful verification', async () => {
      const { services, client, eventBus } = createServices({ type: 'atheme' });
      const listener = vi.fn();
      eventBus.on('user:identified', listener);

      const promise = services.verifyUser('Alice', 1000);
      client.simulateNotice('NickServ', 'Alice ACC 3');
      await promise;

      expect(listener).toHaveBeenCalledWith('Alice', 'Alice');
    });
  });

  describe('cleanup', () => {
    it('should resolve pending verifications on detach', async () => {
      const { services } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Alice', 10000);
      services.detach();

      const result = await promise;
      expect(result.verified).toBe(false);
    });

    it('cancelPendingVerifies aborts all in-flight verifications', async () => {
      const { services } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Alice', 10_000);
      expect(services.getPendingVerifyCount()).toBe(1);

      services.cancelPendingVerifies('socket disconnect');

      const result = await promise;
      expect(result.verified).toBe(false);
      expect(services.getPendingVerifyCount()).toBe(0);
    });

    it('cancelPendingVerifies is a no-op when no verifications are pending', () => {
      const { services } = createServices({ type: 'atheme' });
      expect(() => services.cancelPendingVerifies('no pending')).not.toThrow();
    });
  });

  describe('observability counters', () => {
    it('getServicesTimeoutCount starts at zero', () => {
      const { services } = createServices();
      expect(services.getServicesTimeoutCount()).toBe(0);
    });

    it('getPendingVerifyCount reflects current in-flight count', async () => {
      const { services, client } = createServices({ type: 'atheme' });
      expect(services.getPendingVerifyCount()).toBe(0);
      const promise = services.verifyUser('Alice', 5000);
      expect(services.getPendingVerifyCount()).toBe(1);
      client.simulateNotice('NickServ', 'Alice ACC 3');
      await promise;
      expect(services.getPendingVerifyCount()).toBe(0);
    });
  });

  describe('getNickServTarget fallback', () => {
    it('falls back to NickServ when nickserv config is empty string', () => {
      const { services, client } = createServices({ nickserv: '', password: 'pass', sasl: false });
      services.identify();
      // Empty nickserv → falls back to 'NickServ' via || operator (line 251)
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].target).toBe('NickServ');
    });
  });

  describe('notice handling edge cases', () => {
    it('ignores non-NickServ notices but logs when verifications are pending', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      // Start a verification (creates pending entry)
      const promise = services.verifyUser('Alice', 5000);

      // Send a notice from a non-NickServ source while pending
      client.simulateNotice('SomeOtherUser', 'hello there');

      // The notice is ignored — Alice's verification is still pending
      // Clean up by resolving the pending verification
      client.simulateNotice('NickServ', 'Alice ACC 3');
      await promise;
    });

    it('handles NickServ notice that does not match any pattern when verifications are pending', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Bob', 5000);

      // NickServ sends an unrecognized notice while Bob's verification is pending
      client.simulateNotice('NickServ', 'Welcome to NickServ!');

      // Not matched — Bob's verification still pending; resolve it
      client.simulateNotice('NickServ', 'Bob ACC 3');
      await promise;
    });

    it('silently ignores unmatched NickServ notice when no verifications are pending', () => {
      const { client } = createServices({ type: 'atheme' });
      // No pending verifications — exercises false branch of `if (pending.size > 0)` at line 226
      expect(() => {
        client.simulateNotice('NickServ', 'Welcome to NickServ!');
      }).not.toThrow();
    });

    it('silently ignores non-NickServ notice when no verifications are pending', () => {
      const { client } = createServices({ type: 'atheme' });
      // Non-NickServ source + no pending — exercises false branch of pending.size > 0 at line 172
      expect(() => {
        client.simulateNotice('SomeUser', 'hello there');
      }).not.toThrow();
    });

    it('handles Unknown command that does not match any pending method', async () => {
      const { services, client } = createServices({ type: 'atheme' });
      const promise = services.verifyUser('Alice', 2000);

      // 'FOOBAR' doesn't match 'acc' or 'status' — shouldRetry is false (covers line 208 false branch)
      client.simulateNotice('NickServ', 'Unknown command FOOBAR.');

      // Alice's verification should still be pending
      client.simulateNotice('NickServ', 'Alice ACC 3');
      const result = await promise;
      expect(result.verified).toBe(true);
    });

    it('handles notice with missing message field (covers event.message ?? "" fallback)', () => {
      const { client } = createServices({ type: 'atheme' });
      // Emit notice without a message field — exercises the "" fallback at line 163
      expect(() => {
        client.emit('notice', { nick: 'NickServ' }); // no message property
      }).not.toThrow();
    });

    it('handles notice with missing nick field (covers event.nick ?? "" fallback)', () => {
      const { client } = createServices({ type: 'atheme' });
      // Emit notice without a nick field — exercises the ?? '' fallback at line 159
      expect(() => {
        client.emit('notice', { message: 'Alice ACC 3' }); // no nick property
      }).not.toThrow();
    });

    it('ignores ACC response for a nick not being verified', async () => {
      const { services, client } = createServices({ type: 'atheme' });

      const promise = services.verifyUser('Alice', 2000);

      // ACC for Ghost (not being verified) — exercises `if (!pending) return` at resolveVerification
      client.simulateNotice('NickServ', 'Ghost ACC 3');

      // Alice is still pending — resolve her
      client.simulateNotice('NickServ', 'Alice ACC 3');
      const result = await promise;
      expect(result.verified).toBe(true);
    });
  });

  describe('isNickServVerificationReply', () => {
    it('matches ACC replies from the configured NickServ', () => {
      const { services } = createServices();
      expect(services.isNickServVerificationReply('NickServ', 'alice ACC 3')).toBe(true);
    });

    it('matches STATUS replies from the configured NickServ', () => {
      const { services } = createServices();
      expect(services.isNickServVerificationReply('NickServ', 'STATUS alice 3')).toBe(true);
    });

    it('is case-insensitive on the sender nick', () => {
      const { services } = createServices();
      expect(services.isNickServVerificationReply('nickserv', 'STATUS alice 3')).toBe(true);
    });

    it('rejects replies from a non-NickServ sender', () => {
      const { services } = createServices();
      expect(services.isNickServVerificationReply('RandomBot', 'STATUS foo 3')).toBe(false);
    });

    it('rejects non-ACC/STATUS messages', () => {
      const { services } = createServices();
      expect(services.isNickServVerificationReply('NickServ', 'You are now identified.')).toBe(
        false,
      );
    });

    it('matches when services.nickserv uses a network-prefixed form (nick@host)', () => {
      const { services } = createServices({ nickserv: 'nickserv@services.example.net' });
      expect(services.isNickServVerificationReply('NickServ', 'STATUS alice 3')).toBe(true);
    });

    it('rejects verification shape from a custom NickServ nick when sender is different', () => {
      const { services } = createServices({ nickserv: 'NickServAlt' });
      expect(services.isNickServVerificationReply('NickServ', 'STATUS alice 3')).toBe(false);
      expect(services.isNickServVerificationReply('NickServAlt', 'STATUS alice 3')).toBe(true);
    });
  });

  describe('verifyUser timeout — audit', () => {
    it('writes a nickserv-verify-timeout row when verification times out', async () => {
      const { BotDatabase } = await import('../../src/database');
      const db = new BotDatabase(':memory:');
      db.open();
      const client = new MockClient();
      const eventBus = new BotEventBus();
      const services = new Services({
        client,
        servicesConfig: {
          type: 'atheme',
          nickserv: 'NickServ',
          password: 'pw',
          sasl: false,
        },
        eventBus,
        db,
      });
      services.attach();

      // 1ms timeout — fires before the test fixture has a chance to inject
      // a NickServ reply, exercising the timer branch.
      const result = await services.verifyUser('Alice', 1);
      expect(result.verified).toBe(false);

      const rows = db.getModLog({ action: 'nickserv-verify-timeout' });
      expect(rows).toHaveLength(1);
      expect(rows[0].source).toBe('system');
      expect(rows[0].target).toBe('Alice');
      expect(rows[0].outcome).toBe('failure');
      expect(rows[0].metadata).toMatchObject({ timeoutMs: 1 });
      db.close();
    });
  });

  // ---------------------------------------------------------------------------
  // Bot identify state machine (stability audit 2026-04-21)
  // ---------------------------------------------------------------------------

  describe('bot identify state transitions', () => {
    it('identify() transitions state to pending on non-SASL network', () => {
      const { services } = createServices({ sasl: false, password: 'mypass' });
      expect(services.getBotIdentifyState()).toBe('unknown');
      services.identify();
      expect(services.getBotIdentifyState()).toBe('pending');
      expect(services.isBotIdentified()).toBe(false);
    });

    it('markBotIdentified() sets state to identified and emits bot:identified', () => {
      const { services, eventBus } = createServices();
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      services.markBotIdentified();
      expect(services.isBotIdentified()).toBe(true);
      expect(services.getBotIdentifyState()).toBe('identified');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('markBotIdentified() is a no-op when already identified', () => {
      const { services, eventBus } = createServices();
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      services.markBotIdentified();
      services.markBotIdentified();
      expect(listener).toHaveBeenCalledOnce();
    });

    it('NickServ "You are now identified" notice sets identified and emits bot:identified', () => {
      const { services, client, eventBus } = createServices({ sasl: false, password: 'mypass' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      services.identify();
      client.simulateNotice('NickServ', 'You are now identified for myaccount.');
      expect(services.getBotIdentifyState()).toBe('identified');
      expect(services.isBotIdentified()).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
    });

    it('NickServ "You are now identified" is a no-op if already identified', () => {
      const { services, client, eventBus } = createServices({ sasl: false, password: 'mypass' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      services.identify();
      client.simulateNotice('NickServ', 'You are now identified for myaccount.');
      client.simulateNotice('NickServ', 'You are now identified for myaccount.');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('NickServ "password accepted" also triggers identified state', () => {
      const { services, client, eventBus } = createServices({ sasl: false, password: 'mypass' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      services.identify();
      client.simulateNotice('NickServ', 'Password accepted for myaccount.');
      expect(services.isBotIdentified()).toBe(true);
      expect(listener).toHaveBeenCalledOnce();
    });

    it('NickServ please-identify (SASL+password) sends fallback IDENTIFY and sets pending', () => {
      const { services, client } = createServices({ sasl: true, password: 'saslpass' });
      client.simulateNotice(
        'NickServ',
        'This nickname is registered. Please identify via /msg NickServ identify.',
      );
      expect(services.getBotIdentifyState()).toBe('pending');
      const identifyMsg = client.sent.find((m) => m.message.startsWith('IDENTIFY'));
      expect(identifyMsg).toBeDefined();
      expect(identifyMsg?.message).toBe('IDENTIFY saslpass');
    });

    it('NickServ please-identify (no SASL) sets state to unidentified and warns', () => {
      const { services, client } = createServices({ sasl: false, password: '' });
      client.simulateNotice('NickServ', 'This nickname is registered. Please identify.');
      expect(services.getBotIdentifyState()).toBe('unidentified');
      expect(services.isBotIdentified()).toBe(false);
    });

    it('NickServ please-identify (SASL, no password) sets unidentified without IDENTIFY', () => {
      const { services, client } = createServices({ sasl: true, password: '' });
      client.simulateNotice('NickServ', 'This nickname is registered');
      expect(services.getBotIdentifyState()).toBe('unidentified');
      // No IDENTIFY sent (no password to use)
      expect(client.sent).toHaveLength(0);
    });

    it('NickServ please-identify after fallback already sent sets unidentified', () => {
      const { services, client } = createServices({ sasl: true, password: 'saslpass' });
      // First notice — sends fallback, sets pending
      client.simulateNotice('NickServ', 'This nickname is registered');
      expect(services.getBotIdentifyState()).toBe('pending');
      // Second notice — fallback already sent
      client.simulateNotice('NickServ', 'This nickname is registered');
      expect(services.getBotIdentifyState()).toBe('unidentified');
    });

    it('verifyUser fails fast when bot state is unidentified (C-3)', async () => {
      const { services, client } = createServices({ sasl: false, password: '' });
      // Drive state to unidentified
      client.simulateNotice('NickServ', 'This nickname is registered. Please identify.');
      expect(services.getBotIdentifyState()).toBe('unidentified');

      const sentBefore = client.sent.length;
      const result = await services.verifyUser('Alice', 5000);
      expect(result.verified).toBe(false);
      expect(result.account).toBeNull();
      // No ACC/STATUS query sent — fast fail
      expect(client.sent.length).toBe(sentBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // bot:connected / bot:disconnected event handlers
  // ---------------------------------------------------------------------------

  describe('bot:connected handler', () => {
    it('clears identifyFallbackSent on connect', () => {
      const { client, eventBus } = createServices({ sasl: true, password: 'pass' });
      // Trigger fallback to set the flag
      client.simulateNotice('NickServ', 'This nickname is registered');
      // bot:connected should reset the flag so IDENTIFY can be sent again
      eventBus.emit('bot:connected');
      client.sent = [];
      client.simulateNotice('NickServ', 'This nickname is registered');
      expect(client.sent.some((m) => m.message.startsWith('IDENTIFY'))).toBe(true);
    });

    it('does not schedule SASL warning when SASL is not configured', () => {
      const { eventBus } = createServices({ sasl: false });
      // Should not throw or create dangling timers
      expect(() => eventBus.emit('bot:connected')).not.toThrow();
    });

    describe('SASL warning timer (fake timers)', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      it('warns after 3s if SASL configured and bot not yet identified', async () => {
        const { eventBus } = createServices({ sasl: true, password: 'saslpass' });
        eventBus.emit('bot:connected');
        // Advance past the 3s SASL warning threshold
        await vi.advanceTimersByTimeAsync(3_001);
        // Just exercises the timer path — no assertion on logger (logger is null in tests)
      });

      it('does not warn after 3s if bot is already identified', async () => {
        const { services, eventBus } = createServices({ sasl: true, password: 'saslpass' });
        services.markBotIdentified();
        eventBus.emit('bot:connected');
        await vi.advanceTimersByTimeAsync(3_001);
        // Exercises the identified branch inside the timer callback (no warn path)
      });
    });
  });

  describe('bot:disconnected handler', () => {
    it('emits bot:deidentified on disconnect when bot was identified', () => {
      const { services, client, eventBus } = createServices({ sasl: false, password: 'pass' });
      const listener = vi.fn();
      eventBus.on('bot:deidentified', listener);
      services.identify();
      client.simulateNotice('NickServ', 'You are now identified for myaccount.');
      expect(services.isBotIdentified()).toBe(true);

      eventBus.emit('bot:disconnected', 'ping timeout');

      expect(listener).toHaveBeenCalledOnce();
      expect(services.getBotIdentifyState()).toBe('unknown');
    });

    it('does not emit bot:deidentified if bot was not identified', () => {
      const { eventBus } = createServices();
      const listener = vi.fn();
      eventBus.on('bot:deidentified', listener);
      eventBus.emit('bot:disconnected', 'ping timeout');
      expect(listener).not.toHaveBeenCalled();
    });

    it('resets state to unknown on disconnect even when pending', () => {
      const { services, eventBus } = createServices({ sasl: false, password: 'pass' });
      services.identify();
      expect(services.getBotIdentifyState()).toBe('pending');
      eventBus.emit('bot:disconnected', 'ping timeout');
      expect(services.getBotIdentifyState()).toBe('unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // IRCv3 account-notify (SASL / extended-join confirmation)
  // ---------------------------------------------------------------------------

  describe('account-notify (IRCv3 SASL confirmation)', () => {
    it('emits bot:identified on SASL success (nick=*)', () => {
      const { services, client, eventBus } = createServices({ botNick: 'HEX' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      client.emit('account', { nick: '*', account: 'hexaccount' });
      expect(services.getBotIdentifyState()).toBe('identified');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('emits bot:identified on account-notify for the bot own nick', () => {
      const { services, client, eventBus } = createServices({ botNick: 'HEX' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      client.emit('account', { nick: 'HEX', account: 'hexaccount' });
      expect(services.getBotIdentifyState()).toBe('identified');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('account-notify is a no-op when already identified', () => {
      const { client, eventBus } = createServices({ botNick: 'HEX' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      client.emit('account', { nick: '*', account: 'hexaccount' });
      client.emit('account', { nick: '*', account: 'hexaccount' });
      expect(listener).toHaveBeenCalledOnce();
    });

    it('emits bot:deidentified on null account-notify when bot was identified', () => {
      const { services, client, eventBus } = createServices({ botNick: 'HEX' });
      const deidentifiedListener = vi.fn();
      eventBus.on('bot:deidentified', deidentifiedListener);
      client.emit('account', { nick: '*', account: 'hexaccount' });
      expect(services.isBotIdentified()).toBe(true);
      client.emit('account', { nick: 'HEX', account: null });
      expect(services.getBotIdentifyState()).toBe('unidentified');
      expect(deidentifiedListener).toHaveBeenCalledOnce();
    });

    it('sets unidentified on null account-notify when bot was not identified (no event)', () => {
      const { services, client, eventBus } = createServices({ botNick: 'HEX' });
      const listener = vi.fn();
      eventBus.on('bot:deidentified', listener);
      client.emit('account', { nick: 'HEX', account: null });
      expect(services.getBotIdentifyState()).toBe('unidentified');
      expect(listener).not.toHaveBeenCalled();
    });

    it('treats account: false the same as null (IRCv3 deauth)', () => {
      const { services, client, eventBus } = createServices({ botNick: 'HEX' });
      const listener = vi.fn();
      eventBus.on('bot:deidentified', listener);
      client.emit('account', { nick: '*', account: 'hexaccount' });
      client.emit('account', { nick: 'HEX', account: false });
      expect(services.getBotIdentifyState()).toBe('unidentified');
      expect(listener).toHaveBeenCalledOnce();
    });

    it('ignores account-notify for other nicks', () => {
      const { services, client, eventBus } = createServices({ botNick: 'HEX' });
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      client.emit('account', { nick: 'OtherBot', account: 'oaccount' });
      expect(services.getBotIdentifyState()).toBe('unknown');
      expect(listener).not.toHaveBeenCalled();
    });

    it('is a no-op when botNick is not configured', () => {
      const { services, client, eventBus } = createServices(); // no botNick
      const listener = vi.fn();
      eventBus.on('bot:identified', listener);
      client.emit('account', { nick: '*', account: 'hexaccount' });
      expect(services.getBotIdentifyState()).toBe('unknown');
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // ghostAndReclaim (nick recovery after collision)
  // ---------------------------------------------------------------------------

  describe('ghostAndReclaim', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends GHOST then NICK to NickServ after 1.5s delay', async () => {
      const { services, client } = createServices({ password: 'botpass' });
      const changeNickSpy = vi.spyOn(client, 'changeNick');

      const promise = services.ghostAndReclaim('HEX', 'botpass');

      // GHOST sent immediately
      expect(client.sent).toHaveLength(1);
      expect(client.sent[0].target).toBe('NickServ');
      expect(client.sent[0].message).toBe('GHOST HEX botpass');
      // changeNick not yet called (waiting 1.5s)
      expect(changeNickSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      expect(changeNickSpy).toHaveBeenCalledWith('HEX');
    });

    it('resets _identifyFallbackSent so the re-identify path can fire after reclaim', async () => {
      const { services, client } = createServices({ sasl: true, password: 'saslpass' });
      // Drive _identifyFallbackSent to true
      client.simulateNotice('NickServ', 'This nickname is registered');
      expect(services.getBotIdentifyState()).toBe('pending');

      const promise = services.ghostAndReclaim('HEX', 'saslpass');
      await vi.advanceTimersByTimeAsync(1500);
      await promise;

      // Clear sent messages to verify re-identify fires on next notice
      client.sent = [];
      client.simulateNotice('NickServ', 'This nickname is registered');
      expect(client.sent.some((m) => m.message.startsWith('IDENTIFY'))).toBe(true);
    });

    it('races the 1.5s delay against a GHOST ack notice and proceeds early', async () => {
      const { services, client } = createServices({ password: 'botpass' });
      const changeNickSpy = vi.spyOn(client, 'changeNick');

      const promise = services.ghostAndReclaim('HEX', 'botpass');
      // Before the 1.5s sleep expires, simulate an Atheme-style ack.
      await vi.advanceTimersByTimeAsync(100);
      client.simulateNotice('NickServ', 'HEX has been ghosted.');
      // Drain pending microtasks so the race resolves and changeNick fires
      // without having to burn the full 1500ms.
      await vi.advanceTimersByTimeAsync(0);
      await promise;
      expect(changeNickSpy).toHaveBeenCalledWith('HEX');
    });
  });

  describe('services_host_pattern NickServ source guard', () => {
    it('accepts NickServ notices from a matching host', () => {
      const client = new MockClient();
      const eventBus = new BotEventBus();
      const services = new Services({
        client,
        servicesConfig: {
          type: 'atheme',
          nickserv: 'NickServ',
          password: 'pw',
          sasl: false,
          services_host_pattern: 'services.*',
        },
        eventBus,
      });
      services.attach();
      const verify = services.verifyUser('alice');
      client.emit('notice', {
        nick: 'NickServ',
        hostname: 'services.example.net',
        message: 'alice ACC 3',
      });
      return verify.then((r) => expect(r.verified).toBe(true));
    });

    it('rejects NickServ-nick notices from an unexpected host', async () => {
      vi.useFakeTimers();
      const client = new MockClient();
      const eventBus = new BotEventBus();
      const services = new Services({
        client,
        servicesConfig: {
          type: 'atheme',
          nickserv: 'NickServ',
          password: 'pw',
          sasl: false,
          services_host_pattern: 'services.*',
        },
        eventBus,
      });
      services.attach();
      const verifyPromise = services.verifyUser('alice');
      // Spoofed notice from a non-services host — must be ignored.
      client.emit('notice', {
        nick: 'NickServ',
        hostname: 'evil.badnet.org',
        message: 'alice ACC 3',
      });
      // No ack → falls through the natural 5s timeout path.
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await verifyPromise;
      expect(result.verified).toBe(false);
      vi.useRealTimers();
    });
  });
});
