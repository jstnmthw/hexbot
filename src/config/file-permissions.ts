// HexBot — POSIX-mode permission checks for files that hold credentials.
//
// World-readable is always fatal (other local users can cat the file);
// group-readable earns a `[security]` warning. These run early in
// bootstrap before any structured logger is available — the writes go
// to console with a `<3>`/`[security]` prefix so journald can route them
// without setup.
import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Enforce POSIX-mode permissions on a file that holds credentials. World-
 * readable is always fatal (other local users can cat the file); group-
 * readable is a warning unless `fatal` is true. Silent when the file is
 * unreadable — `accessSync` already handled "not found" at the config
 * path.
 */
export function enforceSecretFilePermissions(path: string, opts: { fatal: boolean }): void {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    // stat failed — caller's readability check already ran or the file
    // simply doesn't exist. Not our job to report that here.
    return;
  }
  const octal = (mode & 0o777).toString(8);
  if (mode & 0o004) {
    console.error(`[bot] SECURITY: ${path} is world-readable (mode ${octal})`);
    console.error(`[bot] Run: chmod 600 ${path}`);
    if (opts.fatal) process.exit(1);
    return;
  }
  if (mode & 0o040) {
    console.error(
      `[security] ${path} is group-readable (mode ${octal}) — consider chmod 600 ${path}`,
    );
  }
}

/**
 * Check `.env`, `.env.local`, and `.env.<NODE_ENV>` in the project root for
 * overly permissive modes. These aren't consumed directly by hexbot (secrets
 * land in config via `_env` fields), but operators typically keep
 * credentials there and the shell that launched the bot has already
 * sourced them into the process env. A world-readable file on a shared
 * host is functionally a credential leak, so we abort; group-readable
 * earns a `[security]` warning.
 */
export function checkDotenvPermissions(): void {
  const env = process.env.NODE_ENV;
  // Cover both root-level `.env` files and the `config/bot.env*` variants
  // operators commonly use for hexbot-specific secrets. The set mirrors the
  // resolution order documented in `config/bot.env.example`.
  const candidates = ['.env', '.env.local', 'config/bot.env', 'config/bot.env.local'];
  if (env) {
    candidates.push(`.env.${env}`);
    candidates.push(`config/bot.env.${env}`);
  }
  // Multi-bot deployments keep per-instance env files at arbitrary paths
  // under config/ (e.g. `config/<net>/<bot>.env`) that the fixed candidate
  // list can't anticipate — sweep the config tree for anything env-shaped
  // so those files get the same fatal world-readable check. An operator
  // sourcing an env file from outside the project tree can point
  // `HEX_ENV_FILE` at it to opt in to the check.
  for (const path of findEnvFiles(resolve('config'), 3)) {
    candidates.push(path);
  }
  const hinted = process.env.HEX_ENV_FILE;
  if (hinted) candidates.push(hinted);
  for (const name of candidates) {
    const path = resolve(name);
    enforceSecretFilePermissions(path, { fatal: true });
  }
}

/**
 * Recursively collect files under `dir` whose name is `.env`, ends in
 * `.env`, or contains `.env.` (covers `bot.env.production`). Depth-capped
 * and silent on unreadable directories — this runs pre-logger during
 * bootstrap and must never be the thing that breaks startup.
 */
function findEnvFiles(dir: string, maxDepth: number): string[] {
  if (maxDepth <= 0) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findEnvFiles(path, maxDepth - 1));
    } else if (
      entry.isFile() &&
      (entry.name === '.env' || entry.name.endsWith('.env') || entry.name.includes('.env.')) &&
      // Example files (`bot.env.example`) hold no secrets and are meant to
      // be world-readable — a fatal check on them would break fresh checkouts.
      !entry.name.includes('example')
    ) {
      found.push(path);
    }
  }
  return found;
}
