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
  return { dbPath, pluginDir, ownerHandle, ownerHostmask };
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
