// HexBot — Config secret resolution
// Resolves `<field>_env` suffix fields from process.env into their sibling
// non-suffixed field. See docs/plans/config-secrets-env.md for the full spec.
//
// Convention: any JSON field with an `_env` suffix names an environment
// variable. The resolver walks the parsed JSON tree recursively:
//   1. For each `<field>_env: "VAR_NAME"` pair where the value is a string,
//      it reads process.env.VAR_NAME.
//   2. If the env var is set, it emits `<field>: <env value>` in the resolved
//      output and drops the `_env` key.
//   3. If the env var is unset, both keys are dropped (field remains
//      undefined).
//
// Plugins never read process.env directly — they declare `<field>_env` in
// their config.json or plugins.json overrides and the plugin loader calls
// resolveSecrets() before the plugin's init() runs.
import type { BotConfig } from './types';

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

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
export function resolveSecrets<T>(obj: T): T {
  return resolveValue(obj) as T;
}

function resolveValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => resolveValue(v));
  }
  if (value !== null && typeof value === 'object') {
    return resolveObject(value as Record<string, unknown>);
  }
  return value;
}

function resolveObject(src: Record<string, unknown>): Record<string, unknown> {
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
        console.warn(
          `[config] Ignoring "${key}": expected string env var name, got ${typeof envVarName}`,
        );
        out[key] = resolveValue(envVarName);
        continue;
      }
      if (siblingKey in src) {
        console.warn(
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
    out[key] = resolveValue(src[key]);
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
        '[config] NICKSERV_PASSWORD must be set (services.sasl is true). Set it in .env or disable SASL.',
      );
    }
  }

  // BotLink shared secret — required when botlink enabled
  if (cfg.botlink?.enabled) {
    if (!cfg.botlink.password) {
      throw new Error('[config] BOTLINK_PASSWORD must be set (botlink.enabled is true).');
    }
  }

  // SOCKS5 proxy password — required when proxy has a username set
  if (cfg.proxy?.enabled && cfg.proxy.username) {
    if (!cfg.proxy.password) {
      throw new Error('[config] PROXY_PASSWORD must be set (proxy.username is configured).');
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
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.key_env === 'string' && typeof e.name === 'string') {
      out.push({ name: e.name, envVarName: e.key_env });
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
      (c) => typeof c === 'object' && c !== null && (c as { name?: unknown }).name === name,
    ) as { key?: string } | undefined;
    if (!resolved?.key) {
      throw new Error(`[config] Channel key env var ${envVarName} for ${name} is unset.`);
    }
  }
}
