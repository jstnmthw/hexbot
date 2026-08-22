// HexBot — IRC event helpers
// Small pure helpers used by the IRC bridge to extract and sanitize fields
// from raw irc-framework event objects. Kept separate so the bridge can stay
// focused on event-to-dispatcher translation.
import { sanitize } from '../utils/sanitize';
import { stripFormatting } from '../utils/strip-formatting';

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
 *
 * The tag value is server-controlled and irc-framework unescapes IRCv3 tag
 * escapes (`\r`/`\n`) back into real control bytes, so — like every other
 * inbound field — it is stripped of line separators, NUL, and mIRC/terminal
 * control codes before it enters `ctx.account`, the account map, `$a:`
 * matching, or any log/reply that renders it. A value that sanitizes to
 * empty is treated as "not identified" (null) rather than a blank account.
 */
export function extractAccountTag(event: Record<string, unknown>): string | null | undefined {
  const direct = event.account;
  if (direct === '*' || direct === null) return null;
  if (typeof direct === 'string' && direct.length > 0) return cleanAccount(direct);

  const tags = event.tags;
  if (tags !== null && typeof tags === 'object' && 'account' in tags) {
    const tagAccount = (tags as Record<string, unknown>).account;
    if (tagAccount === '*' || tagAccount === null) return null;
    if (typeof tagAccount === 'string' && tagAccount.length > 0) return cleanAccount(tagAccount);
  }
  return undefined;
}

/** Strip control/formatting bytes from a raw account-tag value; empty → null. */
function cleanAccount(raw: string): string | null {
  const cleaned = stripFormatting(sanitize(raw));
  return cleaned.length > 0 ? cleaned : null;
}
