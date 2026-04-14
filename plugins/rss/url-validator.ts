// rss — feed URL validation and SSRF guard
//
// validateFeedUrl parses a URL, enforces an https-only (or http-opt-in) scheme
// policy, resolves the hostname via DNS, and rejects any address that lives
// outside the IPv4/IPv6 unicast (publicly routable) range. This is the only
// defense between a `+m` operator running `!rss add` and the bot fetching a
// URL that targets cloud metadata, the bot-link hub port, or other internal
// services.
//
// Classification is delegated to `ipaddr.js` instead of hand-rolled prefix
// regexes. The earlier audit (docs/audits/rss-2026-04-14.md) documented two
// bypass classes in the old classifier:
//   1. IPv4-mapped IPv6 in hex form (`::ffff:7f00:1`) walked past the
//      dotted-only regex and was treated as public.
//   2. Several notation edge cases (`::ffff:0:7f00:1`, `::127.0.0.1`) had
//      similar gaps.
// `ipaddr.js` normalizes every case, and we default-deny anything whose
// `.range()` is not `unicast` — the only public-routable label in both the
// IPv4 and IPv6 range taxonomies.
import ipaddr from 'ipaddr.js';
import dns from 'node:dns/promises';
import net from 'node:net';

/** Ports the validator will connect to by default. Operators can override via opts. */
export const DEFAULT_ALLOWED_PORTS: ReadonlySet<string> = new Set([
  '', // no explicit port → scheme default (443 / 80)
  '80',
  '443',
  '8080',
  '8443',
]);

export interface UrlValidationOpts {
  /** Allow http:// URLs. Default false (https-only). */
  allowHttp?: boolean;
  /**
   * Allowed TCP ports. Defaults to {@link DEFAULT_ALLOWED_PORTS}. An empty
   * string entry means "scheme default port".
   */
  allowedPorts?: ReadonlySet<string>;
}

/** A DNS- or literal-resolved address, with the family needed to pin a socket. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface ValidatedFeedUrl {
  url: URL;
  /** Every address the hostname resolved to — all guaranteed to be public. */
  resolvedAddresses: ResolvedAddress[];
}

/**
 * Parse and validate a feed URL. Throws Error with an operator-readable
 * message on any failure (bad scheme, DNS failure, private address, etc).
 *
 * On success, the returned `resolvedAddresses` are the exact IPs the fetcher
 * MUST pin to — they close the TOCTOU window between validation and the
 * actual HTTP connect, which otherwise lets a rebinding DNS server slip a
 * private address past the check.
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

  // Userinfo in URLs is a secret-handling foot-gun: the password lands in
  // the KV store, audit log, and server access logs. If a private feed
  // needs auth, operators should thread a separate `_env` credential.
  if (parsed.username || parsed.password) {
    throw new Error('URL credentials are not supported — configure auth out-of-band');
  }

  const allowHttp = opts.allowHttp === true;
  if (parsed.protocol !== 'https:' && !(allowHttp && parsed.protocol === 'http:')) {
    throw new Error(`unsupported URL scheme: ${parsed.protocol || '(none)'}`);
  }

  const allowedPorts = opts.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
  if (!allowedPorts.has(parsed.port)) {
    throw new Error(`port not allowed: ${parsed.port || '(default)'}`);
  }

  // URL() leaves IPv6 hostnames wrapped in brackets.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (!hostname) throw new Error('URL has no hostname');

  const resolvedAddresses: ResolvedAddress[] = [];
  const literalFamily = net.isIP(hostname);
  if (literalFamily === 4 || literalFamily === 6) {
    resolvedAddresses.push({ address: hostname, family: literalFamily });
  } else {
    let records: { address: string; family: number }[];
    try {
      records = (await dns.lookup(hostname, { all: true })) as {
        address: string;
        family: number;
      }[];
    } catch (err) {
      throw new Error(`DNS lookup failed for ${hostname}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    for (const r of records) {
      if (r.family !== 4 && r.family !== 6) continue;
      resolvedAddresses.push({ address: r.address, family: r.family });
    }
  }

  if (resolvedAddresses.length === 0) {
    throw new Error(`no addresses resolved for ${hostname}`);
  }

  // Every resolved address must be public; if any one is private, reject the
  // whole hostname. This closes DNS-rebinding style tricks where a record set
  // mixes a public and a private address.
  for (const r of resolvedAddresses) {
    if (!isPublicAddress(r.address)) {
      throw new Error(`host ${hostname} resolves to blocked address ${r.address}`);
    }
  }

  return { url: parsed, resolvedAddresses };
}

/**
 * Returns true if `ip` is a publicly routable IPv4 or IPv6 address.
 *
 * Delegates to `ipaddr.js` so every notation class (including the hex form
 * of IPv4-mapped IPv6, which was the bypass in the earlier hand-rolled
 * classifier) is normalized before the range check. Any address whose
 * `.range()` is not `unicast` — loopback, private, linkLocal, multicast,
 * uniqueLocal, teredo, 6to4, rfc6052, discard, reserved, unspecified,
 * carrierGradeNat, benchmarking — is treated as non-public.
 */
export function isPublicAddress(ip: string): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(ip);
  } catch {
    return false;
  }
  if (addr.kind() === 'ipv6') {
    const v6 = addr as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      return v6.toIPv4Address().range() === 'unicast';
    }
  }
  return addr.range() === 'unicast';
}
