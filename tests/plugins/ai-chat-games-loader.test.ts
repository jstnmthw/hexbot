import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { listGames, loadGamePrompt, resolveGamesDir } from '../../plugins/ai-chat/games-loader';

const TMP_DIR = join(process.cwd(), 'tests', '.tmp-games-loader');

describe('games-loader', () => {
  beforeAll(() => {
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
    mkdirSync(TMP_DIR, { recursive: true });
    writeFileSync(join(TMP_DIR, '20questions.txt'), 'Rules of 20q');
    writeFileSync(join(TMP_DIR, 'trivia.txt'), 'Rules of trivia');
    writeFileSync(join(TMP_DIR, 'notes.md'), 'ignored');
    writeFileSync(join(TMP_DIR, 'huge.txt'), 'x'.repeat(40 * 1024));
  });

  afterAll(() => {
    rmSync(TMP_DIR, { recursive: true });
  });

  it('resolveGamesDir returns a path relative to the module', () => {
    const dir = resolveGamesDir('games');
    expect(dir).toMatch(/games$/);
  });

  it('listGames returns sorted .txt files without the extension', () => {
    expect(listGames(TMP_DIR)).toEqual(['20questions', 'huge', 'trivia']);
  });

  it('listGames returns [] for missing dir', () => {
    expect(listGames(join(TMP_DIR, 'nope'))).toEqual([]);
  });

  it('loadGamePrompt returns prompt text', () => {
    expect(loadGamePrompt(TMP_DIR, '20questions')).toBe('Rules of 20q');
  });

  it('loadGamePrompt returns null for unknown games', () => {
    expect(loadGamePrompt(TMP_DIR, 'missing')).toBeNull();
  });

  it('loadGamePrompt rejects unsafe names (path traversal)', () => {
    expect(loadGamePrompt(TMP_DIR, '../etc/passwd')).toBeNull();
    expect(loadGamePrompt(TMP_DIR, '..')).toBeNull();
    expect(loadGamePrompt(TMP_DIR, 'a/b')).toBeNull();
  });

  it('loadGamePrompt rejects files larger than 32KB', () => {
    expect(loadGamePrompt(TMP_DIR, 'huge')).toBeNull();
  });
});
