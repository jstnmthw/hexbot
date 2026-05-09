// spotify-radio — Jam URL validator.
//
// Pure function. The only barrier between an op pasting a URL into
// `!radio on` and the bot rebroadcasting that URL to the channel; the
// strictness here is the only thing keeping !radio from becoming a free
// spam/phishing vehicle for anyone with the +n flag.
//
// Acceptance rules (all must pass):
//   1. URL parses (`new URL(...)`) and uses the `https:` protocol.
//   2. Hostname (case-folded) is in the operator's `allowed_link_hosts`.
//   3. Pathname matches a host-specific allowlist regex — only the
//      Jam-share form is accepted.
//   4. No control bytes (`\r`, `\n`, `\0`) anywhere in the input.
//
// On accept the validator strips every query parameter except `si`
// (Spotify's tracking/attribution token, harmless and required for some
// share links to render correctly), then returns the normalized URL
// string. On reject it returns null — the command handler renders a
// reason from a separate code path.

/**
 * Strict regex for the path of a Spotify open.spotify.com Jam share link.
 *
 * Format: `/socialsession/<id>` with an optional single trailing slash.
 * The id is 1–64 ASCII alphanumerics. Spotify's marketing name for the
 * feature is still "Jam", but the canonical web URL the share-link
 * redirector lands on is `/socialsession/<id>` — the older `/jam/<id>`
 * shape is no longer emitted by current clients.
 */
const SOCIAL_SESSION_PATH = /^\/socialsession\/[A-Za-z0-9]{1,64}\/?$/;

/**
 * Loose regex for `spotify.link` short links — these are NOT in the
 * default `allowed_link_hosts` because their target is decoded by
 * client-side JavaScript and cannot be server-side validated. Operators
 * may opt them in via `plugins.json` if they accept the phishing risk.
 */
const SPOTIFY_LINK_PATH = /^\/[A-Za-z0-9]{1,32}$/;

const FORBIDDEN_CHARS = /[\r\n\0]/;

/**
 * Validate and normalize a Jam share URL.
 *
 * @param raw raw input from the operator command line. Typed as
 *            `unknown` because this function IS the trust boundary —
 *            the IRC bridge hands strings, but a future caller (REPL,
 *            DCC, bot-link relay) could legitimately pass anything,
 *            and the validator's contract is "give me a defined answer
 *            for any input".
 * @param allowedHosts lowercase-canonicalized allowlist (the plugin loader
 *                     does this in `loadConfig`).
 * @returns normalized URL string on accept, `null` on reject.
 */
export function validateJamUrl(raw: unknown, allowedHosts: readonly string[]): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (FORBIDDEN_CHARS.test(trimmed)) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;

  // Reject any URL carrying credentials in the userinfo position. The
  // bot would otherwise rebroadcast a URL that flashes user:pw@host in
  // every IRC client that follows it.
  if (parsed.username !== '' || parsed.password !== '') return null;

  const hostname = parsed.hostname.toLowerCase();
  if (!allowedHosts.includes(hostname)) return null;

  if (hostname === 'open.spotify.com') {
    if (!SOCIAL_SESSION_PATH.test(parsed.pathname)) return null;
  } else if (hostname === 'spotify.link') {
    if (!SPOTIFY_LINK_PATH.test(parsed.pathname)) return null;
  } else {
    // The operator added a host we don't know how to validate the path
    // shape for. Refuse — better to require a code change than to relay
    // an unknown URL shape.
    return null;
  }

  // Strip every query param except `si`. Iterate over a snapshot of the
  // keys so deleting during iteration is safe across runtimes.
  const keysToDelete: string[] = [];
  for (const key of parsed.searchParams.keys()) {
    if (key !== 'si') keysToDelete.push(key);
  }
  for (const key of keysToDelete) parsed.searchParams.delete(key);

  // Hash fragments aren't sent to the server but get echoed back in
  // some clients — drop them to keep the rebroadcast deterministic.
  parsed.hash = '';

  return parsed.toString();
}
