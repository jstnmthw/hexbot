import { type Mock, describe, expect, it, vi } from 'vitest';

import { ensureOwner } from '../../src/core/owner-bootstrap';
import { verifyPassword } from '../../src/core/password';
import { Permissions } from '../../src/core/permissions';
import { BotDatabase } from '../../src/database';
import type { LoggerLike } from '../../src/logger';
import type { BotConfig } from '../../src/types';

type TestLogger = LoggerLike & {
  info: Mock;
  warn: Mock;
  error: Mock;
  debug: Mock;
};

function makeLogger(): TestLogger {
  const logger: TestLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    setLevel: () => {},
    getLevel: () => 'info',
  };
  return logger;
}

function makeConfig(
  overrides: Partial<Pick<BotConfig, 'owner' | 'dcc'>> = {},
): Pick<BotConfig, 'owner' | 'dcc'> {
  return {
    owner: {
      handle: 'admin',
      hostmask: '*!admin@trusted.host',
      ...overrides.owner,
    },
    dcc: overrides.dcc,
  };
}

function setup() {
  const db = new BotDatabase(':memory:');
  db.open();
  const logger = makeLogger();
  const permissions = new Permissions(db, logger);
  return { db, logger, permissions };
}

describe('ensureOwner — user record', () => {
  it('creates the owner user with +n when missing', async () => {
    const { permissions, logger } = setup();
    await ensureOwner({ config: makeConfig(), permissions, logger });

    const user = permissions.getUser('admin');
    expect(user).not.toBeNull();
    expect(user?.global).toContain('n');
    expect(user?.hostmasks).toContain('*!admin@trusted.host');
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('added from config'));
  });

  it('adds a new hostmask to an existing owner without removing old ones', async () => {
    const { permissions, logger } = setup();
    permissions.addUser('admin', '*!old@old.host', 'n', 'REPL');

    await ensureOwner({ config: makeConfig(), permissions, logger });

    const user = permissions.getUser('admin');
    expect(user?.hostmasks).toEqual(
      expect.arrayContaining(['*!old@old.host', '*!admin@trusted.host']),
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('hostmask updated from config'),
    );
  });

  it('is a no-op when the config hostmask is already present', async () => {
    const { permissions, logger } = setup();
    permissions.addUser('admin', '*!admin@trusted.host', 'n', 'REPL');

    await ensureOwner({ config: makeConfig(), permissions, logger });

    const user = permissions.getUser('admin');
    expect(user?.hostmasks).toEqual(['*!admin@trusted.host']);
    // No "added" or "hostmask updated" info lines.
    const infoMessages = logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoMessages.every((m) => !m.includes('added from config'))).toBe(true);
    expect(infoMessages.every((m) => !m.includes('hostmask updated'))).toBe(true);
  });

  it('returns early when owner.handle is missing', async () => {
    const { permissions, logger } = setup();
    await ensureOwner({
      config: { owner: { handle: '', hostmask: '*!*@*' }, dcc: undefined },
      permissions,
      logger,
    });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns early when owner.hostmask is missing', async () => {
    const { permissions, logger } = setup();
    await ensureOwner({
      config: { owner: { handle: 'admin', hostmask: '' }, dcc: undefined },
      permissions,
      logger,
    });
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

describe('ensureOwner — password seeding', () => {
  it('seeds the password hash when missing and env is provided', async () => {
    const { permissions, logger } = setup();
    const config = makeConfig({
      owner: { handle: 'admin', hostmask: '*!admin@trusted.host', password: 'seededpass1' },
    });

    await ensureOwner({ config, permissions, logger });

    const hash = permissions.getPasswordHash('admin');
    expect(hash).not.toBeNull();
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('seededpass1', hash!)).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Seeded owner password'));
  });

  it('does not overwrite an existing hash (rotations via .chpass survive restart)', async () => {
    const { permissions, logger } = setup();
    permissions.addUser('admin', '*!admin@trusted.host', 'n', 'REPL');
    permissions.setPasswordHash('admin', 'scrypt$pre$existing', 'REPL');

    const config = makeConfig({
      owner: { handle: 'admin', hostmask: '*!admin@trusted.host', password: 'shouldnotoverwrite' },
    });
    await ensureOwner({ config, permissions, logger });

    expect(permissions.getPasswordHash('admin')).toBe('scrypt$pre$existing');
    // No "Seeded" info line.
    const infoMessages = logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoMessages.every((m) => !m.includes('Seeded owner password'))).toBe(true);
  });

  it('does nothing when no env password is provided and no hash exists', async () => {
    const { permissions, logger } = setup();
    await ensureOwner({ config: makeConfig(), permissions, logger });
    expect(permissions.getPasswordHash('admin')).toBeNull();
    const infoMessages = logger.info.mock.calls.map((c) => String(c[0]));
    expect(infoMessages.every((m) => !m.includes('Seeded owner password'))).toBe(true);
  });

  it('logs an error but does not throw if hashPassword rejects', async () => {
    const { permissions, logger } = setup();
    // Password too short — hashPassword throws synchronously via its length check.
    const config = makeConfig({
      owner: { handle: 'admin', hostmask: '*!admin@trusted.host', password: 'short' },
    });

    await expect(ensureOwner({ config, permissions, logger })).resolves.toBeUndefined();

    expect(permissions.getPasswordHash('admin')).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to seed owner password'),
    );
  });
});

describe('ensureOwner — DCC onboarding guardrail', () => {
  function dccEnabled() {
    return {
      enabled: true,
      ip: '0.0.0.0',
      port_range: [49152, 49171] as [number, number],
      require_flags: 'm',
      max_sessions: 5,
      idle_timeout_ms: 300000,
      nickserv_verify: false,
    };
  }

  it('warns when DCC is enabled and the owner has no password', async () => {
    const { permissions, logger } = setup();
    const config = makeConfig({ dcc: dccEnabled() });

    await ensureOwner({ config, permissions, logger });

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('has no password set'));
    const warnMsg = String(logger.warn.mock.calls[0][0]);
    expect(warnMsg).toContain('HEX_OWNER_PASSWORD');
    expect(warnMsg).toContain('.chpass admin');
  });

  it('does NOT warn when DCC is disabled', async () => {
    const { permissions, logger } = setup();
    await ensureOwner({
      config: makeConfig({ dcc: { ...dccEnabled(), enabled: false } }),
      permissions,
      logger,
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when DCC is enabled but the password was just seeded', async () => {
    const { permissions, logger } = setup();
    const config = makeConfig({
      owner: { handle: 'admin', hostmask: '*!admin@trusted.host', password: 'freshseed1' },
      dcc: dccEnabled(),
    });

    await ensureOwner({ config, permissions, logger });

    expect(permissions.getPasswordHash('admin')).not.toBeNull();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('does NOT warn when DCC is enabled and a hash already exists from a prior boot', async () => {
    const { permissions, logger } = setup();
    permissions.addUser('admin', '*!admin@trusted.host', 'n', 'REPL');
    permissions.setPasswordHash('admin', 'scrypt$existing$hash', 'REPL');

    await ensureOwner({
      config: makeConfig({ dcc: dccEnabled() }),
      permissions,
      logger,
    });

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when dcc.enabled is true even if the env var hashPassword call errored out', async () => {
    const { permissions, logger } = setup();
    const config = makeConfig({
      owner: { handle: 'admin', hostmask: '*!admin@trusted.host', password: 'bad' },
      dcc: dccEnabled(),
    });

    await ensureOwner({ config, permissions, logger });

    // error logged + no hash set + warn for missing hash
    expect(logger.error).toHaveBeenCalled();
    expect(permissions.getPasswordHash('admin')).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
