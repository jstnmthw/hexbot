import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CHARACTER,
  getCharacter,
  loadCharacters,
  validateCharacter,
} from '../../../plugins/ai-chat/character-loader';
import type { Character } from '../../../plugins/ai-chat/characters/types';

const TMP_DIR = join(import.meta.dirname, '..', '..', 'tmp', 'test-characters');

function writeCharJson(name: string, data: Record<string, unknown>): void {
  writeFileSync(join(TMP_DIR, `${name}.json`), JSON.stringify(data));
}

describe('validateCharacter', () => {
  it('returns null for non-object input', () => {
    expect(validateCharacter(null as never, 'bad.json')).toBeNull();
    expect(validateCharacter('string' as never, 'bad.json')).toBeNull();
  });

  it('returns null when name is missing', () => {
    expect(validateCharacter({ persona: 'hi' }, 'noname.json')).toBeNull();
  });

  it('returns null when persona is missing', () => {
    expect(validateCharacter({ name: 'test' }, 'nopersona.json')).toBeNull();
  });

  it('fills defaults for optional fields', () => {
    const c = validateCharacter({ name: 'test', persona: 'hi {nick}' }, 'test.json');
    expect(c).not.toBeNull();
    expect(c!.archetype).toBe('regular');
    expect(c!.backstory).toBe('');
    expect(c!.style.casing).toBe('normal');
    expect(c!.style.punctuation).toBe('proper');
    expect(c!.style.verbosity).toBe('normal');
    expect(c!.style.slang).toEqual([]);
    expect(c!.style.catchphrases).toEqual([]);
    expect(c!.style.notes).toEqual([]);
    expect(c!.chattiness).toBe(0);
    expect(c!.triggers).toEqual([]);
    expect(c!.avoids).toEqual([]);
    expect(c!.generation).toBeUndefined();
  });

  it('parses style.notes as a string array', () => {
    const c = validateCharacter(
      {
        name: 'test',
        persona: 'p',
        style: { notes: ['one note', 'two notes', '   ', 42 as unknown as string] },
      },
      'test.json',
    );
    expect(c!.style.notes).toEqual(['one note', 'two notes']);
  });

  it('clamps chattiness to 0-1', () => {
    expect(
      validateCharacter({ name: 'a', persona: 'p', chattiness: 5 }, 'a.json')!.chattiness,
    ).toBe(1);
    expect(
      validateCharacter({ name: 'a', persona: 'p', chattiness: -2 }, 'a.json')!.chattiness,
    ).toBe(0);
  });

  it('parses generation overrides', () => {
    const c = validateCharacter(
      {
        name: 'test',
        persona: 'p',
        generation: { temperature: 0.9, maxOutputTokens: 64 },
      },
      'test.json',
    );
    expect(c!.generation).toEqual({ temperature: 0.9, maxOutputTokens: 64 });
  });

  it('ignores invalid generation values', () => {
    const c = validateCharacter(
      { name: 'test', persona: 'p', generation: { temperature: 'hot' as unknown as number } },
      'test.json',
    );
    expect(c!.generation).toBeUndefined();
  });
});

describe('loadCharacters', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it('always includes the default character', () => {
    const chars = loadCharacters(TMP_DIR);
    expect(chars.has('friendly')).toBe(true);
    expect(chars.get('friendly')!.name).toBe('friendly');
  });

  it('loads valid character JSON files', () => {
    writeCharJson('testchar', { name: 'testchar', persona: 'I am test' });
    const chars = loadCharacters(TMP_DIR);
    expect(chars.has('testchar')).toBe(true);
    expect(chars.get('testchar')!.persona).toBe('I am test');
  });

  it('skips invalid character files', () => {
    writeCharJson('bad', { persona: 'no name field' });
    const warnings: string[] = [];
    const chars = loadCharacters(TMP_DIR, (msg) => warnings.push(msg));
    expect(chars.has('bad')).toBe(false);
    expect(warnings.some((w) => w.includes('Invalid character'))).toBe(true);
  });

  it('skips malformed JSON', () => {
    writeFileSync(join(TMP_DIR, 'broken.json'), '{not json');
    const warnings: string[] = [];
    const chars = loadCharacters(TMP_DIR, (msg) => warnings.push(msg));
    expect(chars.has('broken')).toBe(false);
    expect(warnings.some((w) => w.includes('Failed to parse'))).toBe(true);
  });

  it('handles non-existent directory', () => {
    const chars = loadCharacters('/nonexistent/path');
    expect(chars.has('friendly')).toBe(true);
    expect(chars.size).toBe(1);
  });

  it('keys are lowercased', () => {
    writeCharJson('MixedCase', { name: 'MixedCase', persona: 'p' });
    const chars = loadCharacters(TMP_DIR);
    expect(chars.has('mixedcase')).toBe(true);
  });

  it('skips character files larger than the 64 KB cap', () => {
    // Build a JSON blob that's > 64 KB by padding a long backstory field.
    const bloat = 'x'.repeat(80 * 1024);
    writeCharJson('huge', { name: 'huge', persona: 'p', backstory: bloat });
    const warnings: string[] = [];
    const chars = loadCharacters(TMP_DIR, (msg) => warnings.push(msg));
    expect(chars.has('huge')).toBe(false);
    expect(warnings.some((w) => w.includes('over size cap'))).toBe(true);
  });
});

describe('getCharacter', () => {
  it('returns the named character', () => {
    const chars = new Map<string, Character>();
    const char: Character = {
      ...DEFAULT_CHARACTER,
      name: 'test',
    };
    chars.set('test', char);
    expect(getCharacter(chars, 'test').name).toBe('test');
  });

  it('falls back to friendly', () => {
    const chars = new Map<string, Character>();
    chars.set('friendly', DEFAULT_CHARACTER);
    expect(getCharacter(chars, 'nonexistent').name).toBe('friendly');
  });

  it('falls back to DEFAULT_CHARACTER if map is empty', () => {
    const chars = new Map<string, Character>();
    expect(getCharacter(chars, 'anything').name).toBe('friendly');
  });

  it('is case-insensitive', () => {
    const chars = new Map<string, Character>();
    chars.set('nightowl', { ...DEFAULT_CHARACTER, name: 'nightowl' });
    expect(getCharacter(chars, 'NightOwl').name).toBe('nightowl');
  });
});
