import { describe, expect, it } from 'vitest';

import { parseHostmask } from '../../src/utils/irc-event';

describe('parseHostmask', () => {
  it('splits nick!ident@host into ident/hostname', () => {
    expect(parseHostmask('alice!aident@ahost')).toEqual({
      ident: 'aident',
      hostname: 'ahost',
    });
  });

  it('returns empty ident/hostname when the `!` separator is missing', () => {
    // The partial-fallback that used to return `{ident:'', hostname:'host'}`
    // for `nick@host` tempted callers into constructing `*!*@host`-style ban
    // masks that quietly omitted the ident component. Reject both fields.
    expect(parseHostmask('alice@host')).toEqual({ ident: '', hostname: '' });
  });

  it('returns empty ident/hostname when `@` is missing', () => {
    expect(parseHostmask('alice!ident')).toEqual({ ident: '', hostname: '' });
  });

  it('returns empty ident/hostname for an empty string', () => {
    expect(parseHostmask('')).toEqual({ ident: '', hostname: '' });
  });
});
