// HexBot — Password hashing for per-user authentication.
//
// Used by .chpass and the DCC CHAT prompt to hash, verify, and sanity-check
// passwords stored on UserRecord.password_hash. Format is prefixed with
// `scrypt$` so future rotation (larger parameters, argon2, …) can coexist.
//
// Why scrypt and not argon2: scrypt ships in node:crypto with no native
// module or extra dependency, and is already the KDF used by the bot-link
// auth path (src/core/botlink-protocol.ts). Keeping both paths on the same
// primitive avoids a second vetted-crypto dependency.
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/** Minimum password length — operators are responsible for their own hygiene. */
export const MIN_PASSWORD_LENGTH = 8;

/** Stored-hash prefix. Future algorithms get a distinct prefix for unambiguous rotation. */
const PREFIX = 'scrypt$';

/** 16-byte random salt — aligns with common KDF recommendations. */
const SALT_BYTES = 16;

/** 64-byte derived key. */
const KEY_BYTES = 64;

/**
 * scrypt cost parameters. N=16384 (2^14) is the node default and gives
 * ~10-50ms per hash on a modern CPU — slow enough to deter brute force,
 * fast enough not to stall a DCC handshake.
 */
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 } as const;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, SCRYPT_OPTIONS, (err, derivedKey) => {
      /* v8 ignore next -- scrypt only errors on OOM or invalid params we control; defensive */
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Hash `plaintext` into a self-describing string of the form
 * `scrypt$<salt_hex>$<hash_hex>`. Rejects passwords shorter than
 * {@link MIN_PASSWORD_LENGTH} characters.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== 'string' || plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = randomBytes(SALT_BYTES);
  const hash = await scryptAsync(plaintext, salt);
  return `${PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`;
}

/**
 * Result of {@link verifyPassword}. Callers that only care whether the
 * password matched can check `result.ok`; callers that log (e.g. the DCC
 * auth path) can distinguish a genuine mismatch from a storage-level
 * problem via `result.reason`.
 */
export type VerifyPasswordResult =
  | { ok: true }
  | { ok: false; reason: 'mismatch' | 'malformed' | 'scrypt-error' };

/**
 * Verify `plaintext` against a previously-stored hash string. Never throws
 * for malformed stored values or scrypt errors; both surface as `ok:false`
 * with a distinguishable `reason`. All three `ok:false` branches should be
 * treated as "bad password" from the caller's auth-decision perspective —
 * the reason field is for logging only.
 */
export async function verifyPassword(
  plaintext: string,
  stored: string,
): Promise<VerifyPasswordResult> {
  // Reject sub-minimum-length plaintext at the top — `hashPassword()`
  // refuses to create a hash from such input, so verifying a short
  // candidate against any stored hash can only ever fail. Returning
  // `'mismatch'` (rather than a new reason) keeps the timing oracle
  // closed — an attacker probing short candidates can't distinguish
  // "below minimum" from "wrong password".
  if (typeof plaintext !== 'string' || plaintext.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: 'mismatch' };
  }
  if (!isValidPasswordFormat(stored)) return { ok: false, reason: 'malformed' };
  const [, saltHex, hashHex] = stored.split('$');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  let actual: Buffer;
  try {
    actual = await scryptAsync(plaintext, salt);
    /* v8 ignore start -- scrypt only errors on OOM / invalid params we control; defensive */
  } catch {
    return { ok: false, reason: 'scrypt-error' };
  }
  /* v8 ignore stop */
  // Explicit length equality before timingSafeEqual. isValidPasswordFormat
  // already enforces the expected hex length, so on the current code path
  // `actual.length` and `expected.length` always agree — but timingSafeEqual
  // throws on mismatched lengths, and a future refactor that weakens the
  // format check would leak timing via exception-vs-boolean. The guard keeps
  // the two defenses independent.
  if (actual.length !== expected.length) return { ok: false, reason: 'mismatch' };
  return timingSafeEqual(actual, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Sanity-check whether a stored string looks like a password hash this module
 * can verify. Does not run scrypt — cheap enough to call from boot-time
 * validation or migration paths.
 */
export function isValidPasswordFormat(stored: string): boolean {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const [, saltHex, hashHex] = parts;
  if (saltHex.length !== SALT_BYTES * 2 || hashHex.length !== KEY_BYTES * 2) return false;
  // Both sides must be valid hex
  return /^[0-9a-f]+$/i.test(saltHex) && /^[0-9a-f]+$/i.test(hashHex);
}
