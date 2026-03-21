import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Services } from '../../src/core/services.js';
import { BotEventBus } from '../../src/event-bus.js';
import type { ServicesConfig, IdentityConfig } from '../../src/types.js';

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
  method?: IdentityConfig['method'];
}): { services: Services; client: MockClient; eventBus: BotEventBus } {
  const client = new MockClient();
  const eventBus = new BotEventBus();

  const servicesConfig: ServicesConfig = {
    type: opts?.type ?? 'atheme',
    nickserv: opts?.nickserv ?? 'NickServ',
    password: opts?.password ?? 'botpass',
    sasl: opts?.sasl ?? false,
  };

  const identityConfig: IdentityConfig = {
    method: opts?.method ?? 'hostmask',
    require_acc_for: [],
  };

  const services = new Services({
    client,
    servicesConfig,
    identityConfig,
    eventBus,
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
  });
});
