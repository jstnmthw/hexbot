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
 */
export function buildSocksOptions(proxy: ProxyConfig): SocksOptions {
  return {
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username ? { user: proxy.username } : {}),
    ...(proxy.password ? { pass: proxy.password } : {}),
  };
}
