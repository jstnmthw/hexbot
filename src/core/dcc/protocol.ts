// HexBot — DCC CHAT wire-protocol helpers
//
// Pure parsing/serialising functions for the DCC CTCP payloads. Kept apart
// from `dcc.ts` so tests can exercise them in isolation and the session
// implementation doesn't have to scroll past them.

/**
 * Shorter idle timeout used while the session is awaiting a password. Keeps
 * stalled prompts from squatting on a DCC port.
 */
export const DCC_PROMPT_TIMEOUT_MS = 30_000;

/**
 * Convert a dotted IPv4 string to a 32-bit unsigned decimal integer,
 * as required by the DCC CTCP protocol.
 *
 * @example ipToDecimal('1.2.3.4') === 16909060
 */
export function ipToDecimal(ip: string): number {
  const parts = ip.split('.');
  if (parts.length !== 4) return 0;
  let result = 0;
  for (const part of parts) {
    const byte = parseInt(part, 10);
    if (!Number.isFinite(byte) || byte < 0 || byte > 255) return 0;
    result = (result << 8) | byte;
  }
  // Treat as unsigned 32-bit
  return result >>> 0;
}

export interface DccChatPayload {
  subtype: string; // e.g. 'CHAT'
  ip: number;
  port: number;
  token: number; // 0 if not present (active DCC)
}

/**
 * Parse a DCC CTCP payload string into its components.
 * Returns null on parse failure or if subtype is not 'CHAT'.
 *
 * Active DCC:  "CHAT chat <ip> <port>"
 * Passive DCC: "CHAT chat 0 0 <token>"
 */
export function parseDccChatPayload(args: string): DccChatPayload | null {
  const parts = args.trim().split(/\s+/);
  // Minimum: "CHAT chat <ip> <port>" = 4 tokens
  if (parts.length < 4) return null;

  const subtype = parts[0].toUpperCase();
  if (subtype !== 'CHAT') return null;

  const ip = parseInt(parts[2], 10);
  const port = parseInt(parts[3], 10);
  const token = parts[4] !== undefined ? parseInt(parts[4], 10) : 0;

  if (!Number.isFinite(ip) || !Number.isFinite(port)) return null;

  return { subtype, ip, port, token };
}

/** Returns true if the DCC request is passive (port=0 with a token).
 *  Some clients (e.g. mIRC) send their real IP with port=0; others send ip=0.
 *  Port=0 is the universal passive-DCC indicator. */
export function isPassiveDcc(_ip: number, port: number): boolean {
  return port === 0;
}
