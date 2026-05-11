// HexBot — config-file I/O.
//
// Pure file-read + parse + secret-resolve routines for `bot.json` and
// `plugins.json`. Lives in its own module so `Bot.loadConfig` is a thin
// call site and tests can exercise the loader without instantiating
// the full bot.
import { accessSync, constants as fsConstants, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Bootstrap } from '../bootstrap';
import {
  parseBotConfigOnDisk,
  resolveSecrets,
  validateChannelKeys,
  validateResolvedSecrets,
} from '../config';
import type { LoggerLike } from '../logger';
import type { BotConfig } from '../types';
import { checkDotenvPermissions, enforceSecretFilePermissions } from './file-permissions';

/**
 * Load and validate the bot config file. Exits the process on any failure
 * — the bot cannot run with a broken config, and the structured logger
 * isn't constructed yet (the log level lives in the file we're reading),
 * so errors go to console with a `<3>` journald priority prefix.
 */
export function loadBotConfig(configPath: string, bootstrap: Bootstrap): BotConfig {
  // Probe readability separately from the open() so we can emit a friendlier
  // "did you copy the example?" hint before the JSON parser even runs.
  try {
    accessSync(configPath, fsConstants.R_OK);
  } catch {
    // `<3>` is the systemd / journald priority for ERR — journalctl -p err
    // surfaces this without needing a structured logger.
    console.error(`<3>[bootstrap] Config file not found: ${configPath}`);
    console.error('<3>[bootstrap] Copy config/bot.example.json to config/bot.json and edit it.');
    process.exit(1);
  }

  // Refuse to load if the config file is world-readable (mode & 0o004) —
  // fatal because config is the primary secrets source.
  enforceSecretFilePermissions(configPath, { fatal: true });

  // Also check any `.env*` files in the project root. These aren't consumed
  // directly by hexbot (the config uses `_env` fields that read from
  // process.env), but operators commonly keep credentials there and the
  // shell that launched the process has already read them. A world-readable
  // `.env*` file is fatal; group-readable (mode & 0o040) is a `[security]`
  // warning — matching the advice in SECURITY.md for POSIX-mode secrets.
  checkDotenvPermissions();

  try {
    const raw = readFileSync(configPath, 'utf-8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      throw new Error(`[config] Failed to parse JSON in ${configPath}: ${m}`, { cause: err });
    }
    // Shape validation: rejects unknown keys, missing required fields, and
    // wrong primitive types. Catches typos that would otherwise silently
    // load as undefined and surface as confusing runtime errors later.
    const onDisk = parseBotConfigOnDisk(parsed);
    // Resolve `_env` suffix fields from process.env into their sibling
    // non-suffixed fields. The on-disk shape excludes the bootstrap-
    // sourced fields (database, pluginDir, owner.handle, owner.hostmask),
    // so the resolved object is BotConfig-shaped except for those keys —
    // we fold them in from the bootstrap layer below to satisfy the
    // runtime BotConfig type the rest of the bot consumes.
    const resolved = resolveSecrets(onDisk);
    const merged: BotConfig = {
      ...resolved,
      database: bootstrap.dbPath,
      pluginDir: bootstrap.pluginDir,
      owner: {
        handle: bootstrap.ownerHandle,
        hostmask: bootstrap.ownerHostmask,
        ...(resolved.owner?.password !== undefined ? { password: resolved.owner.password } : {}),
      },
    };
    validateResolvedSecrets(merged);
    // Channels keyed via key_env need their own post-resolution check —
    // the resolver drops unset env vars, so validateResolvedSecrets can't
    // tell the difference between "never had a key" and "env var unset".
    validateChannelKeys(onDisk.irc.channels, merged.irc.channels);
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`<3>[bootstrap] ${message}`);
    process.exit(1);
  }
}

/**
 * Re-read bot.json on demand for `.rehash`. Runs the same parse +
 * resolveSecrets pipeline as the boot path so both routes apply identical
 * coercions. Returns null and logs on any failure (the original config
 * stays live).
 */
export function readBotJsonAsRecord(
  configPath: string,
  logger: LoggerLike,
): Record<string, unknown> | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const onDisk = parseBotConfigOnDisk(parsed);
    const resolved = resolveSecrets(onDisk) as unknown as Record<string, unknown>;
    return resolved;
  } catch (err) {
    logger.warn('Failed to re-read bot.json for .rehash:', err);
    return null;
  }
}

/**
 * Re-read plugins.json on demand for `.rehash`. Returns the bare plugins
 * map; `.rehash` reaches into each plugin's `config` block to seed that
 * plugin's settings registry.
 */
export function readPluginsJsonAsRecord(
  pluginsConfig: string | undefined,
  logger: LoggerLike,
): Record<string, { config?: Record<string, unknown> } | undefined> | null {
  if (!pluginsConfig) return null;
  try {
    const raw = readFileSync(resolve(pluginsConfig), 'utf-8');
    return JSON.parse(raw) as Record<string, { config?: Record<string, unknown> } | undefined>;
  } catch (err) {
    logger.warn('Failed to re-read plugins.json for .rehash:', err);
    return null;
  }
}
