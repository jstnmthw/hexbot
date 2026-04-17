// Load and validate character definitions from JSON files.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Character, CharacterJson } from './characters/types';

/** Upper bound on character JSON file size — mirrors games-loader's cap. */
const MAX_CHARACTER_FILE_BYTES = 64 * 1024;

const DEFAULT_CHARACTER: Character = {
  name: 'friendly',
  archetype: 'regular',
  backstory: 'A friendly person who hangs out in IRC channels.',
  style: {
    casing: 'normal',
    punctuation: 'proper',
    slang: [],
    catchphrases: [],
    verbosity: 'normal',
  },
  chattiness: 0,
  triggers: [],
  avoids: [],
  prompt:
    'You are {nick}, someone who hangs out in {channel} on {network}. ' +
    'You are friendly, approachable, and concise.\n\n' +
    'Rules:\n' +
    '- you are a person in a chat room, not an AI assistant\n' +
    '- responses are 1-3 lines maximum, like a real IRC message\n' +
    '- do not offer help unless someone is obviously stuck and asks\n' +
    '- react to conversations naturally — agree, disagree, joke, riff\n' +
    '- never break character to be "helpful" or "informative"\n' +
    '- users in channel: {users}',
};

/** Resolve the characters directory relative to the plugin root. */
export function resolveCharactersDir(relative = 'characters'): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const pluginRoot = here.endsWith('/dist') || here.endsWith('\\dist') ? resolve(here, '..') : here;
  return resolve(pluginRoot, relative);
}

/** Validate and fill defaults for a parsed character JSON. */
export function validateCharacter(raw: CharacterJson, _filename: string): Character | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.name !== 'string' || !raw.name) return null;
  if (typeof raw.prompt !== 'string' || !raw.prompt) return null;

  const style: Partial<Character['style']> = raw.style ?? {};
  return {
    name: raw.name,
    archetype: typeof raw.archetype === 'string' ? raw.archetype : 'regular',
    backstory: typeof raw.backstory === 'string' ? raw.backstory : '',
    style: {
      casing: isValidCasing(style.casing) ? style.casing : 'normal',
      punctuation: isValidPunctuation(style.punctuation) ? style.punctuation : 'proper',
      slang: Array.isArray(style.slang) ? style.slang.filter((s) => typeof s === 'string') : [],
      catchphrases: Array.isArray(style.catchphrases)
        ? style.catchphrases.filter((s) => typeof s === 'string')
        : [],
      verbosity: isValidVerbosity(style.verbosity) ? style.verbosity : 'normal',
    },
    chattiness: typeof raw.chattiness === 'number' ? Math.max(0, Math.min(1, raw.chattiness)) : 0,
    triggers: Array.isArray(raw.triggers) ? raw.triggers.filter((s) => typeof s === 'string') : [],
    avoids: Array.isArray(raw.avoids) ? raw.avoids.filter((s) => typeof s === 'string') : [],
    prompt: raw.prompt,
    generation: parseGeneration(raw.generation),
  };
}

function isValidCasing(v: unknown): v is Character['style']['casing'] {
  return v === 'normal' || v === 'lowercase' || v === 'uppercase';
}

function isValidPunctuation(v: unknown): v is Character['style']['punctuation'] {
  return v === 'proper' || v === 'minimal' || v === 'excessive';
}

function isValidVerbosity(v: unknown): v is Character['style']['verbosity'] {
  return v === 'terse' || v === 'normal' || v === 'verbose';
}

function parseGeneration(raw: unknown): Character['generation'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const g = raw as Record<string, unknown>;
  const result: NonNullable<Character['generation']> = {};
  if (typeof g.provider === 'string') result.provider = g.provider;
  if (typeof g.model === 'string') result.model = g.model;
  if (typeof g.temperature === 'number') result.temperature = g.temperature;
  if (typeof g.topP === 'number') result.topP = g.topP;
  if (typeof g.repeatPenalty === 'number') result.repeatPenalty = g.repeatPenalty;
  if (typeof g.maxOutputTokens === 'number') result.maxOutputTokens = g.maxOutputTokens;
  if (typeof g.maxContextMessages === 'number') result.maxContextMessages = g.maxContextMessages;
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Load all character JSON files from a directory.
 * Returns a Map keyed by character name (lowercase).
 */
export function loadCharacters(dir: string, log?: (msg: string) => void): Map<string, Character> {
  const characters = new Map<string, Character>();

  // Always include the hardcoded default
  characters.set(DEFAULT_CHARACTER.name, DEFAULT_CHARACTER);

  if (!existsSync(dir)) {
    log?.(`Characters directory not found: ${dir}`);
    return characters;
  }

  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort();
  } catch {
    log?.(`Failed to read characters directory: ${dir}`);
    return characters;
  }

  for (const file of files) {
    try {
      const path = join(dir, file);
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > MAX_CHARACTER_FILE_BYTES) {
        log?.(`Skipping character file (not a file or over size cap): ${file} (${stat.size}B)`);
        continue;
      }
      const raw = JSON.parse(readFileSync(path, 'utf-8')) as CharacterJson;
      const character = validateCharacter(raw, file);
      if (character) {
        characters.set(character.name.toLowerCase(), character);
      } else {
        log?.(`Invalid character file (missing name or prompt): ${file}`);
      }
    } catch (err) {
      log?.(`Failed to parse character file ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return characters;
}

/** Get a character by name, falling back to default. */
export function getCharacter(characters: Map<string, Character>, name: string): Character {
  return characters.get(name.toLowerCase()) ?? characters.get('friendly') ?? DEFAULT_CHARACTER;
}

export { DEFAULT_CHARACTER };
