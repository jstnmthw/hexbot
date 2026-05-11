// HexBot — Bootstrap layer
//
// Reads truly-bootstrap settings from process.env. These values are
// needed before the SQLite KV is open, so they cannot live in KV itself
// and must come from the environment. Everything else lives in KV
// (seeded from bot.json on first boot via the seed-from-json path) and
// is mutable at runtime via `.set` / `.rehash`.
//
// Required env vars:
//   HEX_DB_PATH         — Path to the SQLite database file.
//   HEX_PLUGIN_DIR      — Path to the plugin directory.
//   HEX_OWNER_HANDLE    — Handle for the initial owner; consumed once on
//                         first boot to seed the owner record.
//   HEX_OWNER_HOSTMASK  — Hostmask for the initial owner; consumed once
//                         on first boot to seed the owner record.
//
// Optional env vars:
//   HEX_FAIL_ON_PLUGIN_LOAD_FAILURE — `1`/`true` to exit non-zero when any
//                         plugin fails to load at startup. Default off so
//                         a single bad plugin doesn't take the bot offline.
//                         CI/staging deployments flip this on.
//
// `_env`-resolved secrets (e.g. `HEX_NICKSERV_PASSWORD`,
// `HEX_OWNER_PASSWORD`) are not bootstrap concerns — they continue to
// flow through `<field>_env` references in bot.json + resolveSecrets().

export interface Bootstrap {
  /** SQLite database path. Replaces the old `database` key in bot.json. */
  dbPath: string;
  /** Plugin directory. Replaces the old `pluginDir` key in bot.json. */
  pluginDir: string;
  /** Owner handle, used only on first boot to seed the owner record. */
  ownerHandle: string;
  /** Owner hostmask, used only on first boot to seed the owner record. */
  ownerHostmask: string;
  /**
   * When true, abort startup if any plugin fails to load. Default false —
   * a single bad plugin shouldn't take the bot offline in production.
   * CI/staging operators set `HEX_FAIL_ON_PLUGIN_LOAD_FAILURE=1` to surface
   * regressions at deploy time instead of in user reports.
   */
  failOnPluginLoadFailure: boolean;
}

/**
 * Read every required bootstrap value from process.env. Throws with an
 * explicit message naming the missing variable when any is unset, so an
 * operator's first run failure points straight at the fix.
 */
export function loadBootstrap(env: NodeJS.ProcessEnv = process.env): Bootstrap {
  const dbPath = requireEnv(env, 'HEX_DB_PATH');
  const pluginDir = requireEnv(env, 'HEX_PLUGIN_DIR');
  const ownerHandle = requireEnv(env, 'HEX_OWNER_HANDLE');
  const ownerHostmask = requireEnv(env, 'HEX_OWNER_HOSTMASK');
  const failOnPluginLoadFailure = parseBool(env['HEX_FAIL_ON_PLUGIN_LOAD_FAILURE']);
  return { dbPath, pluginDir, ownerHandle, ownerHostmask, failOnPluginLoadFailure };
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(
      `[bootstrap] ${name} is required but unset. ` +
        `Set it in config/bot.env (or your env_file). See config/bot.env.example.`,
    );
  }
  return value;
}

/**
 * Parse a permissive bool env var. `1`, `true`, `yes`, `on` (case-insensitive)
 * are truthy; everything else (including unset) is false. Mirrors the shape
 * operators expect from POSIX env conventions.
 */
function parseBool(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
