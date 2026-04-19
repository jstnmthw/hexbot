// HexBot — Config shape validation + secret resolution
// Two-stage pipeline for config/bot.json:
//   1. parseBotConfigOnDisk() — Zod-validates the parsed JSON against the
//      BotConfigOnDisk shape. Rejects unknown keys (typo guard) and reports
//      every mismatch with a field path.
//   2. resolveSecrets() — walks the validated tree and substitutes
//      `<field>_env` keys with values read from process.env.
//
// Convention for (2): any JSON field with an `_env` suffix names an
// environment variable. The resolver walks the parsed JSON tree recursively:
//   - For each `<field>_env: "VAR_NAME"` pair where the value is a string,
//     it reads process.env.VAR_NAME.
//   - If the env var is set, it emits `<field>: <env value>` in the resolved
//     output and drops the `_env` key.
//   - If the env var is unset, both keys are dropped (field remains
//     undefined).
//
// Plugins never read process.env directly — they declare `<field>_env` in
// their config.json or plugins.json overrides and the plugin loader calls
// resolveSecrets() before the plugin's init() runs.
import { z } from 'zod';

import { BotConfigOnDiskSchema } from './config/schemas';
import type { LoggerLike } from './logger';
import type { BotConfig, BotConfigOnDisk } from './types';

export { BotConfigOnDiskSchema };

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Validate that the raw JSON parsed from config/bot.json matches the expected
 * on-disk shape. Returns the typed config on success, throws on any shape
 * error with a multi-line message listing every mismatch with its path.
 * Call this after JSON.parse() and before resolveSecrets().
 */
export function parseBotConfigOnDisk(raw: unknown): BotConfigOnDisk {
  const result = BotConfigOnDiskSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new Error(formatZodError(result.error));
}

function formatZodError(err: z.ZodError): string {
  const lines = ['[config] Invalid config/bot.json:'];
  for (const issue of err.issues) {
    const where = formatPath(issue.path) || '(root)';
    // Zod reports missing required fields as `invalid_type` with
    // "received undefined" baked into the message. Rewrite these to a
    // clearer "is required" form so users don't scan the word "undefined"
    // and wonder why they have to set undefined.
    let message = issue.message;
    if (issue.code === 'invalid_type' && message.includes('received undefined')) {
      const expected = (issue as { expected?: string }).expected ?? 'value';
      message = `required field missing (expected ${expected})`;
    }
    lines.push(`  - ${where}: ${message}`);
  }
  return lines.join('\n');
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`;
    } else {
      out += out === '' ? String(seg) : `.${String(seg)}`;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/** Matches any object key ending in `_env` and captures the sibling field name
 *  (e.g. `password_env` → captures `password`). Used by `resolveObject` to
 *  pair `<field>_env` keys with the env var they reference. */
const ENV_SUFFIX_RE = /^(.+)_env$/;

/**
 * Walk an object tree and substitute `<field>_env` keys with values read from
 * process.env. Returns a fresh object — does NOT mutate the input.
 *
 * - Plain objects: each key is processed. `<field>_env` keys name an env var;
 *   if set, the sibling `<field>` is populated from process.env and `_env`
 *   is dropped. If unset, both are dropped.
 * - Arrays: mapped element-by-element (recursively resolved).
 * - Primitives: passed through unchanged.
 *
 * Edge cases:
 * - `_env` value is non-string (array/object/number): leave as-is, warn.
 * - Both `field` and `field_env` present: `_env` wins, warn (config drift).
 */
export function resolveSecrets(obj: BotConfigOnDisk, logger?: LoggerLike | null): BotConfig;
export function resolveSecrets(
  obj: Record<string, unknown>,
  logger?: LoggerLike | null,
): Record<string, unknown>;
export function resolveSecrets<T>(obj: T, logger?: LoggerLike | null): T;
export function resolveSecrets(obj: unknown, logger?: LoggerLike | null): unknown {
  // When no logger is plumbed through (bot startup runs before logger is
  // constructed because the log level lives in the config we're resolving),
  // fall back to console.warn so warnings are not silently lost.
  const warn = logger ? (msg: string) => logger.warn(msg) : (msg: string) => console.warn(msg);
  return resolveValue(obj, warn);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveValue(value: unknown, warn: (msg: string) => void): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v, warn));
  }
  if (isRecord(value)) {
    return resolveObject(value, warn);
  }
  return value;
}

function resolveObject(
  src: Record<string, unknown>,
  warn: (msg: string) => void,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Collect sibling keys that will be overridden by `_env` resolution. We still
  // visit keys in original insertion order so output order matches input (minus
  // dropped `_env` keys).
  const envSiblings = new Set<string>();
  for (const key of Object.keys(src)) {
    const match = ENV_SUFFIX_RE.exec(key);
    if (match) envSiblings.add(match[1]);
  }

  for (const key of Object.keys(src)) {
    const match = ENV_SUFFIX_RE.exec(key);
    if (match) {
      const siblingKey = match[1];
      const envVarName = src[key];
      if (typeof envVarName !== 'string') {
        warn(`[config] Ignoring "${key}": expected string env var name, got ${typeof envVarName}`);
        out[key] = resolveValue(envVarName, warn);
        continue;
      }
      if (siblingKey in src) {
        warn(
          `[config] Both "${siblingKey}" and "${key}" present — using "${key}" (${envVarName}) and ignoring inline value`,
        );
      }
      const envValue = process.env[envVarName];
      if (envValue !== undefined) {
        out[siblingKey] = envValue;
      }
      // drop the _env key itself, drop inline sibling (_env wins)
      continue;
    }
    // Skip if a sibling `<key>_env` resolution will supply this field —
    // we've already handled it above in the matching branch (which either
    // wrote the env value or dropped the field entirely).
    if (envSiblings.has(key)) {
      continue;
    }
    out[key] = resolveValue(src[key], warn);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Startup validation
// ---------------------------------------------------------------------------

/**
 * Validate that every required secret is present for the features that are
 * enabled. Throws on the first missing secret with a message naming the
 * exact env var to set.
 *
 * Call this after resolveSecrets() in loadConfig(), before the config is
 * returned to the rest of the bot.
 *
 * chanmod's nick_recovery_password is validated in the chanmod plugin on
 * load — it's plugin-scoped rather than a core concern.
 */
export function validateResolvedSecrets(cfg: BotConfig): void {
  // NickServ password — required for SASL PLAIN (and non-SASL identify)
  const saslMech = cfg.services.sasl_mechanism ?? 'PLAIN';
  if (cfg.services.sasl && saslMech !== 'EXTERNAL') {
    if (!cfg.services.password) {
      throw new Error(
        '[config] HEX_NICKSERV_PASSWORD must be set (services.sasl is true). Set it in .env or disable SASL.',
      );
    }
  }

  // SASL PLAIN over plaintext leaks the password on the wire — refuse to start.
  // Networks that advertise SASL PLAIN without offering TLS are vanishingly
  // rare and every such case is a misconfiguration. Use EXTERNAL (CertFP) or
  // disable SASL if this really isn't what you want.
  if (cfg.services.sasl && saslMech === 'PLAIN' && !cfg.irc.tls) {
    throw new Error(
      '[config] SASL PLAIN requires irc.tls=true — plaintext SASL leaks the NickServ password. ' +
        'Enable TLS or set services.sasl_mechanism="EXTERNAL" with a client cert.',
    );
  }

  // BotLink shared secret — required when botlink enabled
  if (cfg.botlink?.enabled) {
    if (!cfg.botlink.password) {
      throw new Error('[config] HEX_BOTLINK_PASSWORD must be set (botlink.enabled is true).');
    }
  }

  // SOCKS5 proxy password — required when proxy has a username set
  if (cfg.proxy?.enabled && cfg.proxy.username) {
    if (!cfg.proxy.password) {
      throw new Error('[config] HEX_PROXY_PASSWORD must be set (proxy.username is configured).');
    }
  }
}

/**
 * After `_env` resolution, a channel entry may have lost its `key` field
 * (unset env var → field dropped). This helper collects names of channels
 * whose `key_env` was declared but resolved to unset, so loadConfig can
 * fail with a clear message.
 *
 * This check runs on the on-disk shape BEFORE resolveSecrets drops the
 * `key_env` key — we need to know which channels declared a key_env to know
 * whose resolved `key` should be present.
 */
export function collectChannelsWithKeyEnv(
  channels: ReadonlyArray<unknown>,
): Array<{ name: string; envVarName: string }> {
  const out: Array<{ name: string; envVarName: string }> = [];
  for (const entry of channels) {
    if (!isRecord(entry)) continue;
    if (typeof entry.key_env === 'string' && typeof entry.name === 'string') {
      out.push({ name: entry.name, envVarName: entry.key_env });
    }
  }
  return out;
}

/**
 * Validate that every channel with a declared `key_env` actually resolved
 * to a non-empty key. Pass the on-disk channels array (pre-resolution) to
 * know which channels required keys, and the resolved channels to check
 * whether each one has a key now.
 */
export function validateChannelKeys(
  onDiskChannels: ReadonlyArray<unknown>,
  resolvedChannels: ReadonlyArray<unknown>,
): void {
  const required = collectChannelsWithKeyEnv(onDiskChannels);
  for (const { name, envVarName } of required) {
    const resolved = resolvedChannels.find(
      (c): c is Record<string, unknown> => isRecord(c) && c.name === name,
    );
    const key = resolved?.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error(`[config] Channel key env var ${envVarName} for ${name} is unset.`);
    }
  }
}
