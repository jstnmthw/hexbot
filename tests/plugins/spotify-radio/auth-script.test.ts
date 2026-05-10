import { describe, expect, it } from 'vitest';

import {
  buildAuthorizeUrl,
  isControlSafe,
  parseTokenResponse,
} from '../../../scripts/spotify-auth';

describe('spotify-auth helpers', () => {
  describe('buildAuthorizeUrl', () => {
    it('returns the Spotify authorize URL with every required query parameter', () => {
      const url = new URL(buildAuthorizeUrl({ clientId: 'CID', state: 'STATE' }));
      expect(url.origin + url.pathname).toBe('https://accounts.spotify.com/authorize');
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('CID');
      expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8888/callback');
      expect(url.searchParams.get('state')).toBe('STATE');
      expect(url.searchParams.get('scope')).toBe(
        'user-read-currently-playing user-read-playback-state',
      );
    });

    it('URL-encodes special characters in client_id and state', () => {
      const url = new URL(buildAuthorizeUrl({ clientId: 'a&b', state: 'x y' }));
      expect(url.searchParams.get('client_id')).toBe('a&b');
      expect(url.searchParams.get('state')).toBe('x y');
    });
  });

  describe('parseTokenResponse', () => {
    it('returns a typed record on a well-formed response', () => {
      const got = parseTokenResponse({
        access_token: 'AT',
        refresh_token: 'RT',
        expires_in: 3600,
      });
      expect(got).toEqual({ accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600 });
    });

    it('throws when access_token is missing', () => {
      expect(() => parseTokenResponse({ refresh_token: 'RT', expires_in: 3600 })).toThrow(
        /access_token/,
      );
    });

    it('throws when refresh_token is missing', () => {
      expect(() => parseTokenResponse({ access_token: 'AT', expires_in: 3600 })).toThrow(
        /refresh_token/,
      );
    });

    it('throws when expires_in is missing', () => {
      expect(() => parseTokenResponse({ access_token: 'AT', refresh_token: 'RT' })).toThrow(
        /expires_in/,
      );
    });

    it('throws on a non-object body', () => {
      expect(() => parseTokenResponse('string body')).toThrow();
      expect(() => parseTokenResponse(null)).toThrow();
    });

    it('does not echo the response body in the thrown error', () => {
      const body = {
        // A real-world hostile response shape that mirrors back the
        // submitted credential — the thrown error must not include this.
        error: 'invalid_grant',
        error_description: 'client_secret=super-secret-sentinel',
      };
      try {
        parseTokenResponse(body);
        throw new Error('expected throw');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        expect(msg).not.toContain('super-secret-sentinel');
        expect(msg).not.toContain('client_secret');
        expect(msg).not.toContain('error_description');
      }
    });
  });

  describe('isControlSafe', () => {
    it('accepts plain ASCII', () => {
      expect(isControlSafe('AQABBBccDDee_-')).toBe(true);
    });

    it('rejects \\r, \\n, \\0', () => {
      expect(isControlSafe('foo\rbar')).toBe(false);
      expect(isControlSafe('foo\nbar')).toBe(false);
      expect(isControlSafe('foo\0bar')).toBe(false);
    });
  });
});
