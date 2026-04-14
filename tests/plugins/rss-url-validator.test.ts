import { describe, expect, it, vi } from 'vitest';

import { isPublicAddress, validateFeedUrl } from '../../plugins/rss/url-validator';

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
    expect(result.resolvedIps).toEqual(['8.8.8.8']);
  });

  it('rejects IP literals inside private ranges', async () => {
    await expect(validateFeedUrl('https://127.0.0.1/feed')).rejects.toThrow(/blocked/);
    await expect(validateFeedUrl('https://10.0.0.1/feed')).rejects.toThrow(/blocked/);
  });

  it('rejects IPv6 literal loopback', async () => {
    await expect(validateFeedUrl('https://[::1]/feed')).rejects.toThrow(/blocked/);
  });

  it('propagates DNS errors as validation failures', async () => {
    mockLookup = async () => {
      throw new Error('ENOTFOUND');
    };
    await expect(validateFeedUrl('https://no-such-host.invalid/')).rejects.toThrow(
      /DNS lookup failed/,
    );
  });
});
