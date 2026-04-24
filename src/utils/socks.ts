// HexBot — SOCKS proxy options builder
import type { ProxyConfig } from '../types';

/** Shape expected by irc-framework's `socks` connect option. */
export interface SocksOptions {
  host: string;
  port: number;
  user?: string;
  pass?: string;
}

/**
 * Build the `socks` options object expected by irc-framework from a ProxyConfig.
 *
 * Credentials are both-or-neither: if only one of `username` / `password` is
 * set, both are dropped. Sending a half-filled pair to a SOCKS5 proxy either
 * triggers a protocol error or silently sends an empty second field (which
 * some proxies treat as "no auth" and log anonymously — confusing when
 * debugging a failed connect).
 *
 * Remote DNS is the SOCKS5 default when the destination is a hostname string,
 * and irc-framework passes the raw `host` config through to the proxy's
 * CONNECT destination — so hostnames resolve at the proxy and never on the
 * local resolver.
 */
export function buildSocksOptions(proxy: ProxyConfig): SocksOptions {
  const hasUser = Boolean(proxy.username);
  const hasPass = Boolean(proxy.password);
  const includeCreds = hasUser && hasPass;
  return {
    host: proxy.host,
    port: proxy.port,
    ...(includeCreds ? { user: proxy.username, pass: proxy.password } : {}),
  };
}
