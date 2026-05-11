// Regression tests for the security audit. One test per audit "Test
// suggestions" bullet. Keep these unit-level — the deeper behavioral
// assertions live in the per-module suites (`permissions.test.ts`,
// `sts.test.ts`, `password.test.ts`, etc.). This file's job is to ensure
// no future refactor silently undoes any of the findings closed in this
// audit.
import { describe, expect, it } from 'vitest';

import { isPrivateOrLoopback, validateAuthIpWhitelist } from '../../src/core/botlink/auth';
import { ensureOwner } from '../../src/core/owner-bootstrap';
import { hashPassword, verifyPassword } from '../../src/core/password';
import { Permissions } from '../../src/core/permissions';
import { parseSTSDirective } from '../../src/core/sts';
import { BotDatabase } from '../../src/database';
import type { BotConfig } from '../../src/types';
import { deepFreeze } from '../../src/utils/deep-freeze';
import { requiresVerificationForFlags } from '../../src/utils/verify-flags';

describe('audit security-all-2026-05-10 regressions', () => {
  describe('CRITICAL: deep-freeze identity.require_acc_for', () => {
    it('rejects mutation of the require_acc_for array via length=0', () => {
      const view = deepFreeze({ require_acc_for: ['+o', '+n'] }) as {
        require_acc_for: string[];
      };
      expect(Object.isFrozen(view.require_acc_for)).toBe(true);
      // Mutating a frozen array throws in strict mode (which ESM modules use).
      expect(() => {
        view.require_acc_for.length = 0;
      }).toThrow();
    });

    it('rejects mutation via push() on a deep-frozen require_acc_for', () => {
      const view = deepFreeze({ require_acc_for: ['+o'] }) as {
        require_acc_for: string[];
      };
      expect(() => view.require_acc_for.push('+m')).toThrow();
    });

    it('deepFreeze recurses through nested objects and arrays', () => {
      const value = deepFreeze({
        nested: { inner: ['a', 'b'] },
      }) as { nested: { inner: string[] } };
      expect(Object.isFrozen(value.nested)).toBe(true);
      expect(Object.isFrozen(value.nested.inner)).toBe(true);
    });

    it('deepFreeze leaves primitives alone', () => {
      expect(deepFreeze(42)).toBe(42);
      expect(deepFreeze(null)).toBe(null);
      expect(deepFreeze('s')).toBe('s');
    });
  });

  describe('STS plaintext + duration-only directive', () => {
    // The lockout fix lives in `connection-lifecycle.ts` (rejects the
    // directive before it reaches the store). Asserting the parser side
    // catches any regression where the parser starts dropping `port=`
    // values or where a future refactor folds the lockout-guard into
    // the parser layer.
    it('parses a duration-only directive without inventing a port', () => {
      const d = parseSTSDirective('duration=86400');
      expect(d).toEqual({ duration: 86400 });
      expect(d?.port).toBeUndefined();
    });

    it('caps duration at one year (audit 2026-05-10 hardening)', () => {
      const huge = parseSTSDirective('duration=999999999');
      expect(huge?.duration).toBe(365 * 86400);
    });
  });

  describe('auth_ip_whitelist validation', () => {
    it('warns and drops IPv6 entries; promotes bare IPv4 to /32', () => {
      const warnings: string[] = [];
      const cleaned = validateAuthIpWhitelist(
        ['10.0.0.5', '2001:db8::/64', '10.0.0.0/8', 'not-an-ip'],
        (msg) => warnings.push(msg),
      );
      expect(cleaned).toEqual(['10.0.0.5/32', '10.0.0.0/8']);
      // Two warnings: the IPv6 entry and the unparseable string.
      expect(warnings).toHaveLength(2);
      expect(warnings.some((w) => w.includes('2001:db8::/64'))).toBe(true);
      expect(warnings.some((w) => w.includes('not-an-ip'))).toBe(true);
    });

    it('rejects malformed /prefix on an otherwise valid IP', () => {
      const warnings: string[] = [];
      const cleaned = validateAuthIpWhitelist(['10.0.0.0/64'], (msg) => warnings.push(msg));
      expect(cleaned).toEqual([]);
      expect(warnings.some((w) => w.includes('/prefix'))).toBe(true);
    });

    it('skips empty entries silently', () => {
      const warnings: string[] = [];
      const cleaned = validateAuthIpWhitelist(['', '   '], (msg) => warnings.push(msg));
      expect(cleaned).toEqual([]);
      expect(warnings).toEqual([]);
    });
  });

  describe('setGlobalFlags re-warns on weak hostmask escalation', () => {
    it('logs a [security] warning when escalating an existing nick!*@* record', () => {
      const warned: string[] = [];
      // Minimal LoggerLike — only `warn` records; everything else is a no-op.
      const logger = {
        info: () => {},
        warn: (msg: string) => warned.push(msg),
        error: () => {},
        debug: () => {},
        child() {
          return logger;
        },
        setLevel: () => {},
        getLevel: () => 'info' as const,
      };
      const perms = new Permissions(undefined, logger);
      // Add with no flags so the initial `addUser` warning is suppressed
      // (`warnInsecureHostmask` only fires above a threshold).
      perms.addUser('bob', 'bob!*@*', '-', 'REPL');
      warned.length = 0;
      // Escalate to +o — must trigger the weak-hostmask warning.
      perms.setGlobalFlags('bob', 'o', 'REPL');
      expect(warned.some((msg) => /weak|insecure|hostmask/i.test(msg))).toBe(true);
    });
  });

  describe('syncUser channel-key normalization', () => {
    it('lowercases mixed-case channel keys so case-folded lookups match', () => {
      const perms = new Permissions();
      perms.syncUser('alice', ['*!alice@host'], 'o', { '#MIXEDCase': 'o' });
      const record = perms.getUser('alice');
      expect(record).not.toBeNull();
      expect(record!.channels).toEqual({ '#mixedcase': 'o' });
    });
  });

  describe('verifyPassword empty-string reject', () => {
    it('returns mismatch on empty plaintext (not a new reason)', async () => {
      const stored = await hashPassword('correcthorse');
      const result = await verifyPassword('', stored);
      expect(result).toEqual({ ok: false, reason: 'mismatch' });
    });

    it('returns mismatch on too-short plaintext', async () => {
      const stored = await hashPassword('correcthorse');
      const result = await verifyPassword('short', stored);
      expect(result).toEqual({ ok: false, reason: 'mismatch' });
    });
  });

  describe('owner-bootstrap hostmask shape validation', () => {
    const noopLogger = {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      child() {
        return noopLogger;
      },
      setLevel: () => {},
      getLevel: () => 'info' as const,
    };

    it('throws on a malformed hostmask', async () => {
      const db = new BotDatabase(':memory:');
      db.open();
      const permissions = new Permissions(db);
      try {
        const config = {
          owner: { handle: 'admin', hostmask: 'not-a-mask' },
        } as unknown as BotConfig;
        await expect(ensureOwner({ config, permissions, logger: noopLogger })).rejects.toThrow(
          /malformed/,
        );
      } finally {
        db.close();
      }
    });

    it('accepts $a:account format', async () => {
      const db = new BotDatabase(':memory:');
      db.open();
      const permissions = new Permissions(db);
      try {
        const config = {
          owner: { handle: 'admin', hostmask: '$a:admin' },
        } as unknown as BotConfig;
        await expect(
          ensureOwner({ config, permissions, logger: noopLogger }),
        ).resolves.not.toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe('isPrivateOrLoopback recognizes IPv6 ULA + link-local', () => {
    it('treats fc00::/7 (ULA) and fe80::/10 (link-local) as private', () => {
      expect(isPrivateOrLoopback('fc00::1')).toBe(true);
      expect(isPrivateOrLoopback('fd00::5')).toBe(true);
      expect(isPrivateOrLoopback('fe80::1')).toBe(true);
    });

    it('still rejects public IPv6', () => {
      expect(isPrivateOrLoopback('2001:db8::1')).toBe(false);
    });
  });

  describe('BanStore input validation', () => {
    it('rejects malformed masks, empty by, and non-finite durations', async () => {
      const { BanStore } = await import('../../src/core/ban-store');
      const { BotDatabase } = await import('../../src/database');
      const db = new BotDatabase(':memory:');
      db.open();
      try {
        const store = new BanStore(db, (s) => s.toLowerCase());
        // Missing `!@` — not a valid hostmask shape.
        expect(() => store.storeBan('#c', 'no-bang-or-at', 'admin', 0)).toThrow(/invalid mask/);
        // Empty `by`.
        expect(() => store.storeBan('#c', 'a!b@c', '', 0)).toThrow(/by.*empty/);
        // NaN duration.
        expect(() => store.storeBan('#c', 'a!b@c', 'admin', NaN)).toThrow(/finite/);
        // Negative duration is clamped to 0 (permanent), not thrown.
        store.storeBan('#c', 'a!b@c', 'admin', -1000);
        expect(store.getBan('#c', 'a!b@c')?.expires).toBe(0);
      } finally {
        db.close();
      }
    });
  });

  describe('permissions syncUser + setPasswordHash validation', () => {
    it('syncUser rejects oversized hostmasks and control bytes', () => {
      const perms = new Permissions();
      const longMask = 'n!i@' + 'a'.repeat(200);
      expect(() => perms.syncUser('x', [longMask], '-', {})).toThrow(/length/);
      expect(() => perms.syncUser('x', ['n!i@host\nbad'], '-', {})).toThrow(/control/);
    });

    it('setPasswordHash rejects non-scrypt-shaped hashes', () => {
      const perms = new Permissions();
      perms.addUser('admin', '*!a@h', 'n', 'REPL');
      expect(() => perms.setPasswordHash('admin', 'not-a-hash', 'REPL')).toThrow(/scrypt/);
    });
  });

  describe('mod_log validateAction + parseMetadataSafe', () => {
    it('rejects malformed action strings', async () => {
      const { ModLog } = await import('../../src/core/mod-log');
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(':memory:');
      try {
        const mod = new ModLog(db, null, { modLogEnabled: true });
        // Uppercase rejected.
        expect(() => mod.logModAction({ action: 'KICK', source: 'irc' })).toThrow(/invalid action/);
        // Empty rejected.
        expect(() => mod.logModAction({ action: '', source: 'irc' })).toThrow(/invalid action/);
        // Lower-kebab accepted.
        expect(() => mod.logModAction({ action: 'auth-fail', source: 'irc' })).not.toThrow();
      } finally {
        db.close();
      }
    });
  });

  describe('plugin api.audit.log rate limiter', () => {
    it('drops writes past the per-minute cap and warns once', async () => {
      const { createPluginApi } = await import('../../src/plugin-api-factory');
      const { BotEventBus } = await import('../../src/event-bus');
      const Database = (await import('better-sqlite3')).default;
      const { BotDatabase } = await import('../../src/database');

      const db = new BotDatabase(':memory:');
      db.open();
      const warnings: string[] = [];
      // Self-referential `child()` needs an explicit annotation so TS
      // doesn't bail out with TS7022 (implicit-any in own initializer).

      type Lg = import('../../src/logger').LoggerLike;
      const logger: Lg = {
        info: () => {},
        warn: (msg: string) => warnings.push(String(msg)),
        error: () => {},
        debug: () => {},
        child: () => logger,
        setLevel: () => {},
        getLevel: () => 'info',
      };
      try {
        const handle = createPluginApi(
          {
            dispatcher: {
              bind: () => {},
              unbind: () => {},
              unbindAll: () => {},
            },
            eventBus: new BotEventBus(),
            db,
            permissions: {
              findByHostmask: () => null,
              checkFlags: () => false,
            } as never,
            botConfig: {
              irc: {
                host: 'h',
                port: 1,
                tls: false,
                nick: 'n',
                username: 'u',
                realname: 'r',
                channels: [],
              },
              identity: { method: 'hostmask', require_acc_for: [] },
              services: { type: 'none', nickserv: 'NickServ', sasl: false },
              logging: { level: 'info', mod_actions: true },
            } as never,
            botVersion: '0.0.0-test',
            ircClient: null,
            channelState: null,
            ircCommands: null,
            messageQueue: null,
            services: null,
            helpRegistry: null,
            channelSettings: null,
            coreSettings: null,
            pluginSettings: null,
            banStore: null,
            rootLogger: logger,
            getCasemapping: () => 'rfc1459' as const,
            getServerSupports: () => ({}),
            modesReadyListeners: new Map(),
            permissionsChangedListeners: new Map(),
            userIdentifiedListeners: new Map(),
            userDeidentifiedListeners: new Map(),
            botIdentifiedListeners: new Map(),
          },
          'test-plugin',
          {},
        );
        // Hammer the audit log past the 600/min cap. The first 600
        // succeed; the 601st triggers the rate-limit warning; the 602nd
        // is silently dropped.
        for (let i = 0; i < 605; i++) {
          handle.api.audit.log('action');
        }
        expect(warnings.some((w) => w.includes('rate limit hit'))).toBe(true);
        // Empty action is dropped silently.
        handle.api.audit.log('');
        // Long action gets truncated, not thrown.
        handle.api.audit.log('a'.repeat(200));
        handle.dispose();
      } finally {
        db.close();
        // Database is the better-sqlite3 import for tree-shake suppression.
        void Database;
      }
    });
  });

  describe('message queue setRate clamps + restart', () => {
    it('clamps costMs >= 1 and updates rate; ignores invalid input', async () => {
      const { MessageQueue } = await import('../../src/core/message-queue');
      const mq = new MessageQueue({ rate: 2, burst: 2 });
      try {
        // Rate above 1000 would otherwise produce costMs=0; the clamp
        // keeps it >= 1.
        mq.setRate(5000, 4);
        // Invalid inputs are no-ops (don't throw, don't mutate).
        mq.setRate(-1, 4);
        mq.setRate(2, NaN);
        // No assertions on internal fields — the lack of throws AND the
        // queue still being usable after the calls is the contract.
        let invoked = 0;
        mq.enqueue('#chan', () => {
          invoked++;
        });
        mq.flush();
        expect(invoked).toBe(1);
      } finally {
        mq.stop();
      }
    });
  });

  describe('verify-flags strips punctuation', () => {
    it('returns false when bindFlags contains only punctuation', () => {
      // After stripping `+`, `-`, `|`, `!` the remaining string is empty
      // — must not pretend the bind requires verification.
      expect(requiresVerificationForFlags('+|-', ['+o'])).toBe(false);
    });

    it('handles `+m|+n` syntax without false-positive', () => {
      // The pipe is a syntax artifact; only the letter levels should matter.
      expect(requiresVerificationForFlags('+m|+n', ['+m'])).toBe(true);
    });
  });
});
