import { describe, expect, it } from 'vitest';

import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  isValidPasswordFormat,
  verifyPassword,
} from '../../src/core/password';

describe('password', () => {
  describe('hashPassword / verifyPassword round-trip', () => {
    it('verifies a correct password', async () => {
      const stored = await hashPassword('correcthorse');
      expect(await verifyPassword('correcthorse', stored)).toBe(true);
    });

    it('rejects a wrong password', async () => {
      const stored = await hashPassword('correcthorse');
      expect(await verifyPassword('wronghorse!', stored)).toBe(false);
    });

    it('rejects a password with extra trailing characters', async () => {
      const stored = await hashPassword('correcthorse');
      expect(await verifyPassword('correcthorse ', stored)).toBe(false);
    });

    it('is case-sensitive', async () => {
      const stored = await hashPassword('Password1');
      expect(await verifyPassword('password1', stored)).toBe(false);
      expect(await verifyPassword('Password1', stored)).toBe(true);
    });

    it('handles unicode and multibyte passwords', async () => {
      const stored = await hashPassword('пароль123🔑');
      expect(await verifyPassword('пароль123🔑', stored)).toBe(true);
      expect(await verifyPassword('пароль123', stored)).toBe(false);
    });
  });

  describe('salt randomization', () => {
    it('produces different stored values for the same password', async () => {
      const a = await hashPassword('samepassword');
      const b = await hashPassword('samepassword');
      expect(a).not.toBe(b);
    });

    it('still round-trips after independent hashes', async () => {
      const a = await hashPassword('samepassword');
      const b = await hashPassword('samepassword');
      expect(await verifyPassword('samepassword', a)).toBe(true);
      expect(await verifyPassword('samepassword', b)).toBe(true);
    });
  });

  describe('length enforcement', () => {
    it(`rejects passwords shorter than ${MIN_PASSWORD_LENGTH} characters`, async () => {
      await expect(hashPassword('short')).rejects.toThrow(/at least/);
    });

    it('accepts a password at the minimum length', async () => {
      const pw = 'a'.repeat(MIN_PASSWORD_LENGTH);
      const stored = await hashPassword(pw);
      expect(await verifyPassword(pw, stored)).toBe(true);
    });

    it('rejects non-string input', async () => {
      await expect(hashPassword(null as unknown as string)).rejects.toThrow();
      await expect(hashPassword(undefined as unknown as string)).rejects.toThrow();
    });
  });

  describe('isValidPasswordFormat', () => {
    it('accepts a freshly-hashed value', async () => {
      const stored = await hashPassword('goodpassword');
      expect(isValidPasswordFormat(stored)).toBe(true);
    });

    it('rejects a missing prefix', () => {
      expect(isValidPasswordFormat('00'.repeat(16) + '$' + '00'.repeat(64))).toBe(false);
    });

    it('rejects wrong prefix (e.g. argon2$)', () => {
      expect(isValidPasswordFormat(`argon2$${'00'.repeat(16)}$${'00'.repeat(64)}`)).toBe(false);
    });

    it('rejects truncated hash', async () => {
      const stored = await hashPassword('goodpassword');
      const truncated = stored.slice(0, stored.length - 10);
      expect(isValidPasswordFormat(truncated)).toBe(false);
    });

    it('rejects wrong salt length', () => {
      expect(isValidPasswordFormat(`scrypt$${'00'.repeat(8)}$${'00'.repeat(64)}`)).toBe(false);
    });

    it('rejects wrong key length', () => {
      expect(isValidPasswordFormat(`scrypt$${'00'.repeat(16)}$${'00'.repeat(32)}`)).toBe(false);
    });

    it('rejects missing salt/hash separator', () => {
      expect(isValidPasswordFormat(`scrypt$${'00'.repeat(80)}`)).toBe(false);
    });

    it('rejects non-hex characters', () => {
      expect(isValidPasswordFormat(`scrypt$${'zz'.repeat(16)}$${'00'.repeat(64)}`)).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isValidPasswordFormat('')).toBe(false);
    });

    it('rejects non-string input', () => {
      expect(isValidPasswordFormat(null as unknown as string)).toBe(false);
      expect(isValidPasswordFormat(undefined as unknown as string)).toBe(false);
    });
  });

  describe('verifyPassword on malformed stored values', () => {
    it('returns false for a non-parseable stored hash', async () => {
      expect(await verifyPassword('anything', 'notahash')).toBe(false);
    });

    it('returns false for a valid-format but altered hash', async () => {
      const stored = await hashPassword('correctpassword');
      const tampered = stored.slice(0, -2) + (stored.slice(-2) === 'aa' ? 'bb' : 'aa');
      expect(await verifyPassword('correctpassword', tampered)).toBe(false);
    });
  });
});
