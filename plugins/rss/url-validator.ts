// rss — feed URL validation and SSRF guard
//
// validateFeedUrl parses a URL, enforces an https-only (or http-opt-in) scheme
// policy, resolves the hostname via DNS, and rejects any address that lives
// inside a private, reserved, or loopback range. This is the only defense
// between a `+m` operator running `!rss add` and the bot fetching a URL that
// targets cloud metadata, the bot-link hub port, or other internal services.
import dns from 'node:dns/promises';
import net from 'node:net';

interface DnsLookupAddress {
  address: string;
  family: number;
}

export interface UrlValidationOpts {
  /** Allow http:// URLs. Default false (https-only). */
  allowHttp?: boolean;
}

export interface ValidatedFeedUrl {
  url: URL;
  resolvedIps: string[];
}

/**
 * Parse and validate a feed URL. Throws Error with an operator-readable
 * message on any failure (bad scheme, DNS failure, private address, etc).
 */
export async function validateFeedUrl(
  rawUrl: string,
  opts: UrlValidationOpts = {},
): Promise<ValidatedFeedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`invalid URL: ${rawUrl}`);
  }

  const allowHttp = opts.allowHttp === true;
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error(`unsupported URL scheme: ${parsed.protocol || '(none)'}`);
  }

  // URL() leaves IPv6 hostnames wrapped in brackets.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('URL has no hostname');

  const resolvedIps: string[] = [];
  if (net.isIP(hostname)) {
    resolvedIps.push(hostname);
  } else {
    let records: DnsLookupAddress[];
    try {
      records = (await dns.lookup(hostname, { all: true })) as DnsLookupAddress[];
    } catch (err) {
      throw new Error(`DNS lookup failed for ${hostname}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    for (const r of records) resolvedIps.push(r.address);
  }

  if (resolvedIps.length === 0) {
    throw new Error(`no addresses resolved for ${hostname}`);
  }

  // Every resolved address must be public; if any one is private, reject the
  // whole hostname. This closes DNS-rebinding style tricks where a record set
  // mixes a public and a private address.
  for (const ip of resolvedIps) {
    if (!isPublicAddress(ip)) {
      throw new Error(`host ${hostname} resolves to blocked address ${ip}`);
    }
  }

  return { url: parsed, resolvedIps };
}

/**
 * Returns true if `ip` is a publicly routable IPv4 or IPv6 address. Any
 * private, loopback, link-local, multicast, or reserved range returns false.
 */
export function isPublicAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return isPublicIPv4(ip);
  if (family === 6) return isPublicIPv6(ip);
  return false;
}

function isPublicIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b, c] = parts;
  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // 10.0.0.0/8
  if (a === 127) return false; // loopback
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return false; // 192.0.0.0/24
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 168) return false; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64.0.0/10 CGN
  if (a >= 224) return false; // multicast (224/4) + reserved (240/4) + broadcast
  return true;
}

function isPublicIPv6(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === '::' || lc === '::1') return false; // unspecified + loopback
  // IPv4-mapped ::ffff:a.b.c.d — evaluate against IPv4 rules.
  const v4mapped = lc.match(/^::ffff:([0-9.]+)$/);
  if (v4mapped) return isPublicIPv4(v4mapped[1]);
  if (lc.startsWith('fe8') || lc.startsWith('fe9') || lc.startsWith('fea') || lc.startsWith('feb'))
    return false; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(lc)) return false; // ULA fc00::/7
  if (lc.startsWith('ff')) return false; // multicast ff00::/8
  if (lc.startsWith('100:')) return false; // discard-only 100::/64
  if (lc.startsWith('2001:db8:')) return false; // documentation
  if (lc.startsWith('2001:0:') || lc.startsWith('2001::')) return false; // teredo
  if (lc.startsWith('64:ff9b::')) return false; // NAT64
  return true;
}
