// HexBot — SOCKS proxy options builder
import type { ProxyConfig } from '../types';

/**
 * Build the `socks` options object expected by irc-framework from a ProxyConfig.
 */
export function buildSocksOptions(proxy: ProxyConfig): Record<string, unknown> {
  return {
    host: proxy.host,
    port: proxy.port,
    ...(proxy.username ? { user: proxy.username } : {}),
    ...(proxy.password ? { pass: proxy.password } : {}),
  };
}
