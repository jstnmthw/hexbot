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
  // Only allow safe names (no path separators, no traversal).
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return null;
  const filePath = join(gamesDir, `${name}.txt`);
  if (!existsSync(filePath)) return null;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return null;
    // Sanity: cap at 32 KB to avoid loading huge files.
    if (st.size > 32 * 1024) return null;
    return readFileSync(filePath, 'utf-8').trim();
  } catch {
    return null;
  }
}
