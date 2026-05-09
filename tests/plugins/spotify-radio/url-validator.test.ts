import { describe, expect, it } from 'vitest';

import { validateJamUrl } from '../../../plugins/spotify-radio/url-validator';

const DEFAULT_HOSTS = ['open.spotify.com'];
const PERMISSIVE_HOSTS = ['open.spotify.com', 'spotify.link'];

describe('validateJamUrl', () => {
  // -------------------------------------------------------------------------
  describe('accept paths', () => {
    it('accepts a canonical Jam URL', () => {
      expect(validateJamUrl('https://open.spotify.com/socialsession/abc123', DEFAULT_HOSTS)).toBe(
        'https://open.spotify.com/socialsession/abc123',
      );
    });

    it('accepts a Jam URL with a trailing slash', () => {
      expect(validateJamUrl('https://open.spotify.com/socialsession/abc123/', DEFAULT_HOSTS)).toBe(
        'https://open.spotify.com/socialsession/abc123/',
      );
    });

    it('preserves the `si` query parameter', () => {
      expect(
        validateJamUrl('https://open.spotify.com/socialsession/abc?si=xyz', DEFAULT_HOSTS),
      ).toBe('https://open.spotify.com/socialsession/abc?si=xyz');
    });

    it('strips utm_* and other tracking params but keeps `si`', () => {
      const got = validateJamUrl(
        'https://open.spotify.com/socialsession/abc?si=xyz&utm_source=evil&pi=hostile',
        DEFAULT_HOSTS,
      );
      expect(got).not.toBeNull();
      const u = new URL(got!);
      expect(u.searchParams.get('si')).toBe('xyz');
      expect(u.searchParams.get('utm_source')).toBeNull();
      expect(u.searchParams.get('pi')).toBeNull();
    });

    it('strips the share-options-sheet utm/ssp params from a real share URL', () => {
      // The exact query string Spotify's browser landing page emits after
      // the spotify.link → spotify.app.link → open.spotify.com bounce.
      const got = validateJamUrl(
        'https://open.spotify.com/socialsession/abc?utm_source=share-options-sheet&utm_medium=share-link&ssp=1',
        DEFAULT_HOSTS,
      );
      expect(got).toBe('https://open.spotify.com/socialsession/abc');
    });

    it('drops the URL fragment', () => {
      expect(validateJamUrl('https://open.spotify.com/socialsession/abc#here', DEFAULT_HOSTS)).toBe(
        'https://open.spotify.com/socialsession/abc',
      );
    });

    it('accepts spotify.link only when explicitly opted in', () => {
      expect(validateJamUrl('https://spotify.link/ABcd1234', PERMISSIVE_HOSTS)).toBe(
        'https://spotify.link/ABcd1234',
      );
    });

    it('lowercases the hostname during the allowlist check', () => {
      expect(validateJamUrl('https://OPEN.spotify.com/socialsession/abc123', DEFAULT_HOSTS)).toBe(
        'https://open.spotify.com/socialsession/abc123',
      );
    });

    it('trims surrounding whitespace before parsing', () => {
      expect(validateJamUrl('  https://open.spotify.com/socialsession/abc  ', DEFAULT_HOSTS)).toBe(
        'https://open.spotify.com/socialsession/abc',
      );
    });
  });

  // -------------------------------------------------------------------------
  describe('reject paths', () => {
    it('rejects empty string', () => {
      expect(validateJamUrl('', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects whitespace-only', () => {
      expect(validateJamUrl('   ', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects garbage', () => {
      expect(validateJamUrl('not a url', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects http://', () => {
      expect(validateJamUrl('http://open.spotify.com/socialsession/abc', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects deceptive lookalike host', () => {
      expect(
        validateJamUrl('https://evil.com/open.spotify.com/socialsession/abc', DEFAULT_HOSTS),
      ).toBeNull();
    });

    it('rejects /track/ path on the right host', () => {
      expect(validateJamUrl('https://open.spotify.com/track/abc123', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects the legacy /jam/ path (Spotify renamed to /socialsession/)', () => {
      expect(validateJamUrl('https://open.spotify.com/jam/abc123', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects /socialsession/ with no id', () => {
      expect(validateJamUrl('https://open.spotify.com/socialsession/', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects deeper path segments after /socialsession/<id>', () => {
      expect(
        validateJamUrl(
          'https://open.spotify.com/socialsession/abc/arbitrary/nested/path',
          DEFAULT_HOSTS,
        ),
      ).toBeNull();
    });

    it('rejects an encoded newline smuggled into the id', () => {
      expect(
        validateJamUrl('https://open.spotify.com/socialsession/abc%0D%0AFOO', DEFAULT_HOSTS),
      ).toBeNull();
    });

    it('rejects raw \\r in the input', () => {
      expect(
        validateJamUrl('https://open.spotify.com/socialsession/abc\rfoo', DEFAULT_HOSTS),
      ).toBeNull();
    });

    it('rejects raw \\n in the input', () => {
      expect(
        validateJamUrl('https://open.spotify.com/socialsession/abc\nfoo', DEFAULT_HOSTS),
      ).toBeNull();
    });

    it('rejects raw \\0 in the input', () => {
      expect(
        validateJamUrl('https://open.spotify.com/socialsession/abc\0foo', DEFAULT_HOSTS),
      ).toBeNull();
    });

    it('rejects spotify.link by default', () => {
      expect(validateJamUrl('https://spotify.link/ABcd1234', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects an unknown allowed host (no path-shape rule for it)', () => {
      expect(validateJamUrl('https://other.example/jam/abc', ['other.example'])).toBeNull();
    });

    it('rejects userinfo in the URL', () => {
      expect(
        validateJamUrl('https://user:pw@open.spotify.com/socialsession/abc', DEFAULT_HOSTS),
      ).toBeNull();
    });

    it('rejects ftp://', () => {
      expect(validateJamUrl('ftp://open.spotify.com/socialsession/abc', DEFAULT_HOSTS)).toBeNull();
    });

    it('rejects an id longer than the regex allows', () => {
      const longId = 'a'.repeat(65);
      expect(
        validateJamUrl(`https://open.spotify.com/socialsession/${longId}`, DEFAULT_HOSTS),
      ).toBeNull();
    });

    it("rejects spotify.link with a path that doesn't match the short-link shape", () => {
      // spotify.link is in the allowlist on this call, but the path is wrong.
      expect(validateJamUrl('https://spotify.link/way/too/deep/path', PERMISSIVE_HOSTS)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe('hostile-input fuzz', () => {
    // Deterministic seeded RNG for reproducibility.
    function lcg(seed: number): () => number {
      let state = seed >>> 0;
      return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x1_0000_0000;
      };
    }

    function pick<T>(rng: () => number, arr: readonly T[]): T {
      return arr[Math.floor(rng() * arr.length)]!;
    }

    it('rejects every URL produced by a hostile generator', () => {
      const rng = lcg(0xdeadbeef);
      const schemes = ['http://', 'ftp://', 'javascript:', 'data:', 'file://'];
      const hosts = ['evil.com', 'spotify.com.evil.com', '127.0.0.1', 'localhost'];
      const paths = ['/jam/', '/jam/x/y', '/track/abc', '/playlist/abc', '/?si=xx'];
      const queries = ['?utm_source=phish', '#foo', '?si=&q=evil', ''];

      for (let i = 0; i < 50; i += 1) {
        const url = `${pick(rng, schemes)}${pick(rng, hosts)}${pick(rng, paths)}${pick(rng, queries)}`;
        expect(validateJamUrl(url, DEFAULT_HOSTS)).toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('quirk handling', () => {
    it('rejects non-string input gracefully (defence-in-depth)', () => {
      // The IRC bridge always hands strings through but the validator
      // is the only thing between an op's command and the rebroadcast,
      // so guarding against a future caller (REPL, DCC, bot-link
      // relay) is cheap. The signature accepts `unknown`, so these
      // calls don't need a cast.
      expect(validateJamUrl(undefined, DEFAULT_HOSTS)).toBeNull();
      expect(validateJamUrl(null, DEFAULT_HOSTS)).toBeNull();
      expect(validateJamUrl(42, DEFAULT_HOSTS)).toBeNull();
      expect(validateJamUrl({}, DEFAULT_HOSTS)).toBeNull();
    });
  });
});
