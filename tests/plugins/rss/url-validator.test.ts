import { describe, expect, it, vi } from 'vitest';

import { isPublicAddress, validateFeedUrl } from '../../../plugins/rss/url-validator';

// dns.lookup is stubbed per-test — every private-range rejection below must
// hold regardless of what DNS says, so we drive the validator with fixed
// fake addresses instead of resolving real hostnames.
vi.mock('node:dns/promises', () => {
  return {
    default: {
      lookup: (...args: unknown[]) => mockLookup(...args),
    },
    lookup: (...args: unknown[]) => mockLookup(...args),
  };
});

type LookupArgs = [hostname: string, opts?: { all?: boolean }];
let mockLookup: (
  ...args: unknown[]
) => Promise<Array<{ address: string; family: number }>> = async () => [];

function stubLookup(result: Array<{ address: string; family: number }>) {
  mockLookup = async (...args: unknown[]) => {
    void (args as LookupArgs);
    return result;
  };
}

describe('isPublicAddress', () => {
  it('accepts routable IPv4', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('203.0.114.5')).toBe(true);
  });

  it('rejects RFC1918 ranges', () => {
    expect(isPublicAddress('10.0.0.1')).toBe(false);
    expect(isPublicAddress('172.16.5.4')).toBe(false);
    expect(isPublicAddress('172.31.255.255')).toBe(false);
    expect(isPublicAddress('192.168.1.1')).toBe(false);
  });

  it('rejects loopback, link-local, this-network, CGNAT', () => {
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('169.254.169.254')).toBe(false); // AWS metadata
    expect(isPublicAddress('0.0.0.0')).toBe(false);
    expect(isPublicAddress('100.64.0.1')).toBe(false);
    expect(isPublicAddress('100.127.255.255')).toBe(false);
  });

  it('rejects TEST-NET, benchmark, multicast', () => {
    expect(isPublicAddress('192.0.2.1')).toBe(false);
    expect(isPublicAddress('198.51.100.7')).toBe(false);
    expect(isPublicAddress('203.0.113.9')).toBe(false);
    expect(isPublicAddress('198.18.0.1')).toBe(false);
    expect(isPublicAddress('224.0.0.1')).toBe(false);
    expect(isPublicAddress('240.0.0.1')).toBe(false);
  });

  it('rejects IPv6 loopback, link-local, ULA, multicast', () => {
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('::')).toBe(false);
    expect(isPublicAddress('fe80::1')).toBe(false);
    expect(isPublicAddress('fc00::1')).toBe(false);
    expect(isPublicAddress('fd12:3456:789a::1')).toBe(false);
    expect(isPublicAddress('ff02::1')).toBe(false);
  });

  it('rejects IPv4-mapped IPv6 pointing at private space', () => {
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
  });

  // Regression: the earlier hand-rolled classifier used a regex that only
  // matched the dotted form (`::ffff:a.b.c.d`), so the hex form walked past
  // every check and was treated as public. ipaddr.js normalizes both.
  it('rejects IPv4-mapped IPv6 in hex form (audit regression)', () => {
    expect(isPublicAddress('::ffff:7f00:1')).toBe(false); // 127.0.0.1
    expect(isPublicAddress('::ffff:a9fe:a9fe')).toBe(false); // 169.254.169.254
    expect(isPublicAddress('::ffff:0a00:1')).toBe(false); // 10.0.0.1
    expect(isPublicAddress('::ffff:c0a8:1')).toBe(false); // 192.168.0.1
  });

  it('rejects IPv6 teredo, 6to4, rfc6052, documentation', () => {
    expect(isPublicAddress('2001::1')).toBe(false); // teredo
    expect(isPublicAddress('2002::1')).toBe(false); // 6to4
    expect(isPublicAddress('64:ff9b::1')).toBe(false); // rfc6052 NAT64
    expect(isPublicAddress('2001:db8::1')).toBe(false); // documentation
    expect(isPublicAddress('100::1')).toBe(false); // discard
  });

  it('rejects garbage that looks like an IP', () => {
    expect(isPublicAddress('not-an-ip')).toBe(false);
    expect(isPublicAddress('999.999.999.999')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
  });

  it('accepts routable IPv6', () => {
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});

describe('validateFeedUrl', () => {
  it('rejects non-http(s) schemes', async () => {
    await expect(validateFeedUrl('file:///etc/passwd')).rejects.toThrow(/scheme/);
    await expect(validateFeedUrl('gopher://example.com/1/')).rejects.toThrow(/scheme/);
  });

  it('rejects http:// by default', async () => {
    await expect(validateFeedUrl('http://example.com/rss')).rejects.toThrow(/scheme/);
  });

  it('allows http:// when allowHttp=true', async () => {
    stubLookup([{ address: '8.8.8.8', family: 4 }]);
    const result = await validateFeedUrl('http://example.com/rss', { allowHttp: true });
    expect(result.url.protocol).toBe('http:');
  });

  it('rejects URLs that resolve to a private IPv4', async () => {
    stubLookup([{ address: '192.168.1.1', family: 4 }]);
    await expect(validateFeedUrl('https://internal.example.com/feed')).rejects.toThrow(/blocked/);
  });

  it('rejects URLs that resolve to AWS metadata', async () => {
    stubLookup([{ address: '169.254.169.254', family: 4 }]);
    await expect(validateFeedUrl('https://metadata.example.com/')).rejects.toThrow(/blocked/);
  });

  it('rejects mixed-resolution hostnames if ANY answer is private', async () => {
    stubLookup([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(validateFeedUrl('https://rebinding.example.com/')).rejects.toThrow(/blocked/);
  });

  it('accepts a public IP literal without touching DNS', async () => {
    // No mock needed — the literal shortcut never calls dns.lookup.
    const result = await validateFeedUrl('https://8.8.8.8/feed');
    expect(result.resolvedAddresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
  });

  it('returns family alongside each resolved address', async () => {
    stubLookup([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ]);
    const result = await validateFeedUrl('https://dual-stack.example.com/feed');
    expect(result.resolvedAddresses).toEqual([
      { address: '2606:4700:4700::1111', family: 6 },
      { address: '8.8.8.8', family: 4 },
    ]);
  });

  it('rejects IP literals inside private ranges', async () => {
    await expect(validateFeedUrl('https://127.0.0.1/feed')).rejects.toThrow(/blocked/);
    await expect(validateFeedUrl('https://10.0.0.1/feed')).rejects.toThrow(/blocked/);
  });

  it('rejects IPv6 literal loopback', async () => {
    await expect(validateFeedUrl('https://[::1]/feed')).rejects.toThrow(/blocked/);
  });

  // Regression: the old validator missed `::ffff:<hex>:<hex>` because its
  // v4-mapped regex only matched the dotted form. An attacker could aim
  // the bot at localhost via `https://[::ffff:7f00:1]/`.
  it('rejects IPv4-mapped IPv6 literal in hex form (audit regression)', async () => {
    await expect(validateFeedUrl('https://[::ffff:7f00:1]/feed')).rejects.toThrow(/blocked/);
    await expect(validateFeedUrl('https://[::ffff:a9fe:a9fe]/feed')).rejects.toThrow(/blocked/);
  });

  it('rejects URLs that embed userinfo', async () => {
    await expect(validateFeedUrl('https://user:pass@example.com/feed')).rejects.toThrow(
      /credentials/i,
    );
    await expect(validateFeedUrl('https://user@example.com/feed')).rejects.toThrow(/credentials/i);
  });

  it('rejects non-web ports by default', async () => {
    // No DNS stub — the port check fires before resolution.
    await expect(validateFeedUrl('https://example.com:22/feed')).rejects.toThrow(/port/);
    await expect(validateFeedUrl('https://example.com:25/feed')).rejects.toThrow(/port/);
    await expect(validateFeedUrl('https://example.com:6667/feed')).rejects.toThrow(/port/);
  });

  it('accepts the default web ports', async () => {
    stubLookup([{ address: '8.8.8.8', family: 4 }]);
    // URL() drops the scheme-default port: https://example.com:443/foo
    // round-trips with .port === ''. That empty string is in DEFAULT_ALLOWED_PORTS.
    // Audit 2026-05-10: 8080/8443 dropped from defaults (admin panels live
    // there). Operators who need them must opt in via `allowedPorts`.
    const cases: Array<{ input: string; expectedPort: string }> = [
      { input: 'https://example.com/feed', expectedPort: '' },
      { input: 'https://example.com:443/feed', expectedPort: '' },
      { input: 'http://example.com:80/feed', expectedPort: '' },
    ];
    for (const { input, expectedPort } of cases) {
      const result = await validateFeedUrl(input, { allowHttp: true });
      expect(result.url.port).toBe(expectedPort);
    }
  });

  it('rejects 8080 / 8443 by default (audit 2026-05-10)', async () => {
    stubLookup([{ address: '8.8.8.8', family: 4 }]);
    await expect(validateFeedUrl('https://example.com:8443/feed')).rejects.toThrow(
      /port not allowed/,
    );
    await expect(validateFeedUrl('https://example.com:8080/feed')).rejects.toThrow(
      /port not allowed/,
    );
  });

  it('honors a caller-supplied allowedPorts set', async () => {
    stubLookup([{ address: '8.8.8.8', family: 4 }]);
    const result = await validateFeedUrl('https://example.com:9000/feed', {
      allowedPorts: new Set(['9000']),
    });
    expect(result.url.port).toBe('9000');
    await expect(
      validateFeedUrl('https://example.com:443/feed', { allowedPorts: new Set(['9000']) }),
    ).rejects.toThrow(/port/);
  });

  it('propagates DNS errors as validation failures', async () => {
    mockLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(validateFeedUrl('https://no-such-host.invalid/')).rejects.toThrow(
      /DNS lookup failed/,
    );
  });

  it('rejects unparseable URLs', async () => {
    await expect(validateFeedUrl('not a url')).rejects.toThrow(/invalid URL/);
  });

  it('rejects when DNS returns an empty record set', async () => {
    stubLookup([]);
    await expect(validateFeedUrl('https://empty.example.com/feed')).rejects.toThrow(
      /no addresses resolved/,
    );
  });

  it('skips records with non-IP families', async () => {
    // Older Node returned `family: 0` for some failure modes. Validator
    // should ignore those rows; if no usable addresses remain, fall through
    // to the "no addresses resolved" error.
    stubLookup([{ address: 'whatever', family: 0 }]);
    await expect(validateFeedUrl('https://weird.example.com/feed')).rejects.toThrow(
      /no addresses resolved/,
    );
  });
});
