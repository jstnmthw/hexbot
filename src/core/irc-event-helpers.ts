// HexBot — IRC event helpers
// Small pure helpers used by the IRC bridge to extract and sanitize fields
// from raw irc-framework event objects. Kept separate so the bridge can stay
// focused on event-to-dispatcher translation.
import { sanitize } from '../utils/sanitize';

/**
 * Read a field from a raw irc-framework event object, coerce to string, and
 * strip injection characters (`\r`, `\n`, NUL). Collapses the
 * `sanitize(String(event.X ?? ''))` triple-call that was repeated ~50 times
 * across the bridge's event handlers.
 */
export function sanitizeField(event: Record<string, unknown>, key: string): string {
  return sanitize(String(event[key] ?? ''));
}

/**
 * Pull the IRCv3 `account-tag` off an irc-framework event object, if the
 * server attached one. Returns:
 *   - `undefined` — tag not present (cap not negotiated, or server didn't send it)
 *   - `null`      — tag present but the sender is not identified
 *   - `string`    — the authoritative services account name
 *
 * irc-framework exposes `account` at the top level of the emitted event
 * (see `messaging.js` handler) and mirrors the raw IRCv3 tag map on
 * `event.tags`. We check the top-level field first and fall back to the
 * tag map for robustness against future event-shape changes.
 */
export function extractAccountTag(event: Record<string, unknown>): string | null | undefined {
  const direct = event.account;
  if (direct === '*' || direct === null) return null;
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const tags = event.tags;
  if (tags !== null && typeof tags === 'object' && 'account' in tags) {
    const tagAccount = (tags as Record<string, unknown>).account;
    if (tagAccount === '*' || tagAccount === null) return null;
    if (typeof tagAccount === 'string' && tagAccount.length > 0) return tagAccount;
  }
  return undefined;
}
