// HexBot — SOCKS proxy options builder
import type { Socket } from 'node:net';

import type { ProxyConfig } from '../types';

/**
 * Default end-to-end SOCKS5 connect timeout in milliseconds. A black-holed
 * proxy (firewall drops the SYN, route-blackhole, half-open NAT) will
 * otherwise leave the TCP connect hanging indefinitely — irc-framework's
 * registration timeout (45s) is a backstop, but a proxy-side hang lets
 * the bot wait the full registration window before realising the connect
 * never landed. 30s is short enough to fail fast and long enough for a
 * legitimately slow Tor-class proxy to complete handshake.
 */
export const SOCKS5_CONNECT_TIMEOUT_MS = 30_000;

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

/**
 * Arm a connect-timeout watchdog on a SOCKS-tunnelled socket.
 *
 * irc-framework hands us the socket via the `socket connected` event AFTER
 * the SOCKS handshake has completed (or timed out by SocksClient's own
 * internal mechanism, which is also unset here). At that point the socket
 * is already alive but no IRC bytes have flowed yet. Without `setTimeout`,
 * a peer that ACKed the SOCKS handshake but then black-holes IRC traffic
 * (NAT timeout, connection-tracker eviction) leaves the socket dangling
 * until the OS keepalive fires, typically ~75 minutes on Linux defaults.
 *
 * Wiring `socket.setTimeout(SOCKS5_CONNECT_TIMEOUT_MS)` plus a `'timeout'`
 * handler that calls `socket.destroy(...)` ensures the upstream
 * irc-framework `'socket close'` path runs and the reconnect driver
 * picks up the failure. The timeout is cleared as soon as IRC registration
 * completes — caller is responsible for invoking the returned disarm
 * function on `'registered'`.
 *
 * Returns a disarm function that callers MUST invoke once registration
 * succeeds. Calling disarm twice is a no-op.
 */
export function armSocksConnectTimeout(
  socket: Socket,
  timeoutMs: number = SOCKS5_CONNECT_TIMEOUT_MS,
): () => void {
  let armed = true;
  socket.setTimeout(timeoutMs);
  const onTimeout = (): void => {
    if (!armed) return;
    socket.destroy(new Error('SOCKS5 connect timeout'));
  };
  socket.once('timeout', onTimeout);
  return () => {
    if (!armed) return;
    armed = false;
    socket.setTimeout(0);
    socket.removeListener('timeout', onTimeout);
  };
}
