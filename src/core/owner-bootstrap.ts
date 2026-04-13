// HexBot — Owner bootstrap
//
// Ensures the configured owner user exists, and on first boot seeds their
// DCC password hash from an env var. The password lifecycle mirrors MySQL's
// `MYSQL_ROOT_PASSWORD`: the env var is consumed only when the DB has no
// hash on file. Subsequent boots find the hash present and leave it alone,
// so `.chpass` rotations persist across restarts. To force a re-seed, clear
// the hash and restart with the env var set.
import type { Logger } from '../logger';
import type { BotConfig } from '../types';
import { hashPassword } from './password';
import type { Permissions } from './permissions';

export interface EnsureOwnerDeps {
  config: Pick<BotConfig, 'owner' | 'dcc'>;
  permissions: Permissions;
  logger: Logger;
}

/**
 * Ensure the configured owner user exists, seed their password hash from
 * the env var on first boot, and emit a loud warning if DCC is enabled but
 * no password is available anywhere.
 */
export async function ensureOwner(deps: EnsureOwnerDeps): Promise<void> {
  const { config, permissions, logger } = deps;
  const ownerCfg = config.owner;
  if (!ownerCfg?.handle || !ownerCfg?.hostmask) return;

  // Create or update the user record from config.
  const existing = permissions.getUser(ownerCfg.handle);
  if (!existing) {
    permissions.addUser(ownerCfg.handle, ownerCfg.hostmask, 'n', 'config');
    logger.info(`Owner "${ownerCfg.handle}" added from config`);
  } else if (!existing.hostmasks.includes(ownerCfg.hostmask)) {
    permissions.addHostmask(ownerCfg.handle, ownerCfg.hostmask, 'config');
    logger.info(`Owner "${ownerCfg.handle}" hostmask updated from config: ${ownerCfg.hostmask}`);
  }

  // Seed-if-missing password hash. The env var (resolved into ownerCfg.password
  // by `resolveSecrets`) is the transport; the DB is the store of record.
  // Once seeded, `.chpass` rotations win on subsequent boots because the hash
  // already exists and this branch short-circuits.
  const hasHash = permissions.getPasswordHash(ownerCfg.handle) !== null;
  if (!hasHash && ownerCfg.password) {
    try {
      const hash = await hashPassword(ownerCfg.password);
      permissions.setPasswordHash(ownerCfg.handle, hash, 'config');
      logger.info(`Seeded owner password for "${ownerCfg.handle}" from owner.password_env`);
    } catch (err) {
      logger.error(
        `Failed to seed owner password for "${ownerCfg.handle}": ${(err as Error).message}`,
      );
    }
  }

  // Onboarding guardrail: if DCC is enabled but the owner still has no
  // password, they can't connect. Surface this loudly at startup so new
  // operators following the README don't hit a silent rejection later.
  const stillNoHash = permissions.getPasswordHash(ownerCfg.handle) === null;
  if (stillNoHash && config.dcc?.enabled) {
    logger.warn(
      `Owner "${ownerCfg.handle}" has no password set — DCC CHAT will reject this user. ` +
        `Set owner.password_env (e.g. HEX_OWNER_PASSWORD) in your config, or run ` +
        `.chpass ${ownerCfg.handle} <newpass> from the REPL.`,
    );
  }
}
