// Discover and load game system-prompt files from plugins/ai-chat/games/.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve the plugin's games directory, relative to the plugin root.
 *  When bundled to dist/index.js, go up one level to reach the plugin root. */
export function resolveGamesDir(relative = 'games'): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // If we're inside a dist/ directory (bundled), go up to the plugin root.
  const pluginRoot = here.endsWith('/dist') || here.endsWith('\\dist') ? resolve(here, '..') : here;
  return resolve(pluginRoot, relative);
}

/** List game names (without `.txt` extension) found in the games dir. */
export function listGames(gamesDir: string): string[] {
  if (!existsSync(gamesDir)) return [];
  try {
    return readdirSync(gamesDir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => f.replace(/\.txt$/, ''))
      .sort();
  } catch {
    return [];
  }
}

/** Load a game's system prompt. Returns null if the file doesn't exist or is unsafe. */
export function loadGamePrompt(gamesDir: string, name: string): string | null {
  // Strict allowlist for game names: no `/`, no `..`, no NUL — anything that
  // could escape the games dir or smuggle a path segment is rejected before
  // we touch the filesystem. Mirrors the character-name allowlist.
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  // Defence-in-depth: resolve both sides and refuse any path that escapes the
  // games dir. `gamesDir` is operator-supplied config (trusted), but a
  // symlink or future caller passing a relative segment shouldn't punch out.
  // Unreachable via the name regex above — kept as a last-line guard.
  const rootResolved = resolve(gamesDir);
  const filePath = resolve(rootResolved, `${name}.txt`);
  /* v8 ignore next */
  if (filePath !== join(rootResolved, `${name}.txt`)) return null;
  if (!existsSync(filePath)) return null;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    // 32 KB cap on game prompts. Game system prompts are typically a few KB
    // of rules + framing; anything larger is either misconfigured or hostile
    // (loading a multi-megabyte file would burn prompt-eval cost on every
    // turn of every game). Mirrors the 64 KB cap on character JSON.
    if (st.size > 32 * 1024) return null;
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }
}
