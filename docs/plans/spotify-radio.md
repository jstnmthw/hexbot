# Plan: Spotify Radio Plugin

## Summary

A plugin that turns the hexbot into a classic "now playing" IRC radio announcer backed by Spotify. The operator starts a Spotify Jam in their own Spotify client, copies the share link, runs `!radio on <jam-url>` in a channel, and the bot (a) validates and re-broadcasts the Jam link, (b) polls the operator's `GET /v1/me/player/currently-playing` endpoint on an interval, and (c) announces each track transition to the channel with a formatted `[radio] Now playing: Song — Artist • Join: <link>` line. Authentication is a single Spotify refresh token stored in `bot.env`, obtained via a one-time helper script run on the operator's workstation. No container-side OAuth flow, no public HTTP endpoint, no multi-user auth.

## Feasibility

- **Alignment**: Fits the existing plugin model cleanly. One `time` bind drives polling (same pattern as `plugins/rss`), `pub` binds drive commands, `api.say()` drives announcements, `api.config` flows secrets through the `_env` indirection. No core-module changes. No new persistence (the plugin's state model is in-memory only).
- **Dependencies**: Runtime uses Node's built-in `fetch` (Node ≥24, already required by hexbot) — no new npm dependency. The one-time auth helper reuses `node:http` and `node:crypto` from stdlib.
- **Blockers**: None. Platform-level limits (Spotify Jam has no Web API, host-side Premium required for Jam) are accepted as given — see "Out of scope" below.
- **Complexity estimate**: M (one focused day for MVP + auth script + tests)
- **Risk areas**:
  - **Secret handling.** Refresh tokens must never appear in logs, channel messages, error messages, or `ctx.reply()` output. Every log line that touches the HTTP layer needs to be scrubbed.
  - **Dispatcher timer floor.** `time` binds enforce a 10-second minimum interval (DESIGN.md §2.3). Poll interval cannot go below 10s through the bind system. This is fine for radio (tracks are minutes long) — do not work around it with `setInterval`.
  - **Hot-reload cleanup.** In-memory session state and any pending `fetch` must be drained in `teardown()`. hexbot's project review (MEMORY.md → `project_review_2026`) explicitly flagged listener/timer residue as a recurring gap.
  - **URL re-broadcast as a phishing vector.** The bot relays whatever URL the op pastes. A strict allowlist on the URL host+path shape is mandatory — without it, `!radio on` becomes a free spam/phishing vehicle for anyone with `n`.
  - **Access-token lifecycle errors.** A revoked or scope-drifted refresh token fails with 401 on every poll. Endless retries waste API quota and spam logs. The plan specifies bounded retry with forced session-end on repeated 401.
  - **Network flakiness.** Transient 5xx, DNS blips, and 429 rate-limits must not crash the plugin or silently stall the session. Count consecutive failures, stop gracefully after a threshold, announce to the channel.
  - **Rate limits.** Spotify's Web API does not publish exact limits. At 10s polling against a single account, load is trivial, but bounded exponential backoff on 429 is still required.
  - **Track-metadata IRC injection.** Song titles and artist names come from an external service. They must be run through `api.stripFormatting()` before being spliced into announcement strings — defence in depth against IRC control codes in otherwise-innocent track data.

## Dependencies

- [x] `src/types.ts` — `PluginAPI` and `HandlerContext`
- [x] `src/dispatcher.ts` — `pub`, `time` bind types
- [x] `api.say`, `api.stripFormatting`, `api.registerHelp`, `api.permissions.checkFlags`
- [x] `<field>_env` config secret resolution (`src/config.ts`)
- [x] Node ≥24 global `fetch`
- [ ] A new `HEX_SPOTIFY_CLIENT_ID`, `HEX_SPOTIFY_CLIENT_SECRET`, `HEX_SPOTIFY_REFRESH_TOKEN` set of env vars declared in `config/bot.env.example`
- [ ] `scripts/spotify-auth.ts` (one-shot, workstation-side)
- [ ] `pnpm run spotify:auth` script entry in `package.json`

## Out of scope (documented, not built)

- Spotify Jam **creation** or discovery via API — Spotify does not expose it; the operator pastes a pre-made share link.
- Multi-host OAuth flow, per-user token storage, HTTP callback listener.
- Playback control that needs the `user-modify-playback-state` scope (`!radio skip`, `!radio next`, direct Spotify-side queue insertion). MVP is strictly read-only. A post-MVP phase may opt in by re-running `spotify:auth` with an expanded scope.
- Spotify-side listener count — no public API exposes it. Channel userlist size is not the same thing.
- Re-streaming audio — forbidden by Spotify TOS. The bot is metadata only.
- Reverse-engineering private Spotify endpoints (Friend Activity, Jam session state). Public Web API only.
- State persistence across bot restarts — a restart ends the session. Documented, intentional.

**Moved to Post-MVP (below):** eye-catching color styling for announcements, public `!request` intake, host queue management, auto-mark-played with requester attribution, and a backlog of polish features.

## Phases

### Phase 1: Env scaffolding and auth helper script

**Goal:** Operator can obtain a refresh token on their workstation and wire it into `bot.env` before any plugin code runs.

**Why this phase ships first:** the plugin has nothing to do without a working refresh token. Building the auth helper first makes the rest of the plan end-to-end testable from day one.

- [ ] Add the three Spotify env vars to `config/bot.env.example` with comments explaining:
  - They are required only if the `spotify-radio` plugin is enabled.
  - They must belong to the Spotify account that will actually be hosting the Jam and playing music.
  - The refresh token is scope-locked at grant time — re-run the auth script if scopes change.
- [ ] Create `scripts/spotify-auth.ts`:
  - Reads `HEX_SPOTIFY_CLIENT_ID` and `HEX_SPOTIFY_CLIENT_SECRET` from `process.env` (this script is a dev tool, not a plugin — direct `process.env` access is acceptable).
  - Reads a `--code <value>` CLI argument for the headless fallback path.
  - **Loopback listener mode (default):** binds `http.createServer` on `127.0.0.1:8888`, generates a PKCE `code_verifier` + `code_challenge` and a random `state` nonce, prints the Spotify authorize URL (`https://accounts.spotify.com/authorize?...` with `response_type=code`, `redirect_uri=http://127.0.0.1:8888/callback`, `scope=user-read-currently-playing user-read-playback-state`, `state`, `code_challenge`, `code_challenge_method=S256`) and asks the operator to open it in a browser. When the callback request arrives, validate the returned `state`, exchange `code` for tokens at `https://accounts.spotify.com/api/token`, close the listener, and print the refresh token to stdout with a clear banner telling the operator exactly which env var to paste it into.
  - **Headless fallback:** when `--code <value>` is present, skip the listener entirely, POST the code to the token endpoint using the same registered `redirect_uri`, print the refresh token.
  - Timeout: close the listener and exit non-zero after 5 minutes if no callback arrives.
  - **Never log the refresh token anywhere except the final stdout banner** — no debug prints, no error traces that interpolate it.
- [ ] Add `"spotify:auth": "tsx scripts/spotify-auth.ts"` under `scripts` in `package.json`.
- [ ] Verification:
  - Register a test app at developer.spotify.com with `http://127.0.0.1:8888/callback` as a redirect URI.
  - Export `HEX_SPOTIFY_CLIENT_ID` / `HEX_SPOTIFY_CLIENT_SECRET` in the local shell.
  - Run `pnpm run spotify:auth`, complete the flow, confirm a refresh token is printed.
  - Run `pnpm run spotify:auth --code <fake>` with an invalid code and confirm a clean error, not a crash.

### Phase 2: Plugin skeleton and config wiring

**Goal:** A no-op `spotify-radio` plugin that loads, reads its config through the `_env` indirection, logs a startup banner, and unloads cleanly.

- [ ] Create `plugins/spotify-radio/` directory.
- [ ] Create `plugins/spotify-radio/config.json`:
  ```json
  {
    "client_id_env": "HEX_SPOTIFY_CLIENT_ID",
    "client_secret_env": "HEX_SPOTIFY_CLIENT_SECRET",
    "refresh_token_env": "HEX_SPOTIFY_REFRESH_TOKEN",
    "poll_interval_sec": 10,
    "session_ttl_hours": 6,
    "announce_prefix": "[radio]",
    "allowed_link_hosts": ["open.spotify.com", "spotify.link"],
    "max_consecutive_errors": 5
  }
  ```
  Secrets are declared via `_env` fields. `plugins.json` may override `poll_interval_sec`, `session_ttl_hours`, `announce_prefix`, `allowed_link_hosts`, and `max_consecutive_errors` — never the three `_env` fields.
- [ ] Create `plugins/spotify-radio/index.ts` with required exports (`name`, `version`, `description`, `init`, `teardown`), a `PluginConfig` interface mirroring the JSON shape, and a `loadConfig(api)` helper that validates types and asserts secrets are non-empty (same pattern as `plugins/rss/index.ts` `loadConfig`).
- [ ] On missing or empty `client_id` / `client_secret` / `refresh_token`, throw from `init()` with a message that names the env var (not its value): e.g. `HEX_SPOTIFY_REFRESH_TOKEN not set — run 'pnpm run spotify:auth' on your workstation and paste the result into config/bot.env`. hexbot's plugin loader treats an `init()` throw as a load failure and runs `teardown()`, so resources are cleaned.
- [ ] Implement a stub `teardown()` that clears the module-level session variable (defined in phase 4). No-op for now.
- [ ] Verification: Enable plugin in `config/plugins.json`, start bot with `HEX_SPOTIFY_*` set to dummy non-empty values, confirm `[plugin:spotify-radio] Loaded` banner. Start with those vars unset and confirm the load fails with the exact env var name in the error.

### Phase 3: Spotify HTTP client (access token + currently-playing)

**Goal:** A small, self-contained Spotify client module inside the plugin that knows how to mint access tokens from the refresh token and read currently-playing state. Isolated from IRC concerns so it can be unit-tested with a mocked `fetch`.

**File:** `plugins/spotify-radio/spotify-client.ts` (plugin-local helper — not a core module, not exported to other plugins).

**Scope baked into the refresh token:** `user-read-currently-playing user-read-playback-state`.

**Client shape:**

```typescript
interface SpotifyClient {
  getCurrentlyPlaying(): Promise<CurrentlyPlaying | null>;
}

interface CurrentlyPlaying {
  trackId: string; // Spotify track URI or track id — stable key for change detection
  title: string; // Track name
  artist: string; // Comma-joined artist names
  album: string; // Album name (for potential future use; included now for free)
  url: string; // https://open.spotify.com/track/<id> — safe to re-broadcast
  progressMs: number; // from `progress_ms`
  durationMs: number; // from `item.duration_ms`
  isPlaying: boolean; // from `is_playing`
}
```

**Access-token cache:** Module-level `{ accessToken: string; expiresAt: number } | null`. Minted lazily on first call. Re-minted when `Date.now() > expiresAt - 60_000` (refresh one minute before expiry to absorb clock skew and in-flight requests).

**Access-token mint (`refreshAccessToken`):**

- `POST https://accounts.spotify.com/api/token`
- Body: `grant_type=refresh_token&refresh_token=<token>` (form-encoded).
- `Authorization: Basic <base64(client_id:client_secret)>`.
- Parse `{ access_token, expires_in }` (Spotify sometimes also returns a new `refresh_token` — if present, **log a warning and ignore it** for MVP; the operator needs to know rotation happened but we don't support dynamic refresh-token update without restart).
- Non-200 → throw `SpotifyAuthError` with the HTTP status but **not** the response body (the body can contain echoed credentials in some error shapes).

**`getCurrentlyPlaying`:**

- `GET https://api.spotify.com/v1/me/player/currently-playing`
- `Authorization: Bearer <accessToken>`
- `204 No Content` → return `null` (nothing playing — normal, not an error).
- `200` → parse the JSON. If `item` is absent or `item.type !== 'track'` (podcast episode, ad), return `null` for MVP — we only announce tracks.
- `401` → one-shot recovery: force re-mint the access token and retry exactly once. If still `401`, throw `SpotifyAuthError` (the refresh token is dead).
- `429` → read `Retry-After` header (seconds), throw `SpotifyRateLimitError` with that wait time; the poller will honor it.
- Other non-2xx → throw `SpotifyHttpError` with status.
- Network error → wrap and re-throw as `SpotifyNetworkError`.

**Error classes:** A small discriminated union in `spotify-client.ts`. The poll loop branches on the class, not on string matching.

**Logging rule (critical):** The client module must never log access tokens, refresh tokens, or Authorization headers. `api.log` is passed in only for structured, redacted info (request ended, status code, retry triggered). No `console.log` fallbacks, no `err.stack` logs on auth errors.

**Tasks:**

- [ ] Create `plugins/spotify-radio/spotify-client.ts` with the `createSpotifyClient(opts)` factory that takes `{ clientId, clientSecret, refreshToken, log, fetch? }`. The injectable `fetch` parameter is purely for tests (defaults to `globalThis.fetch`).
- [ ] Implement token caching + refresh logic as described.
- [ ] Implement `getCurrentlyPlaying()` with the full error branching.
- [ ] Export the error classes (`SpotifyAuthError`, `SpotifyRateLimitError`, `SpotifyHttpError`, `SpotifyNetworkError`).
- [ ] Verification: unit tests in `tests/plugins/spotify-radio/spotify-client.test.ts`. See test plan for cases.

### Phase 4: Session state and URL validation

**Goal:** The in-memory session model, plus a bulletproof Jam URL validator.

**Module-level state (in `index.ts`, reset in `teardown()`):**

```typescript
interface RadioSession {
  channel: string;
  jamUrl: string;
  startedAt: number; // ms epoch
  ttlMs: number;
  lastTrackId: string | null; // for change detection
  consecutiveErrors: number; // reset on any successful poll
  lastPollAt: number;
}

let session: RadioSession | null = null;
let spotify: SpotifyClient | null = null;
let cfg: PluginConfig | null = null;
```

Single-session-for-the-whole-bot is intentional for MVP. Multi-channel concurrent sessions would change the poll loop design; document in "Future work" not here.

**URL validator (`validateJamUrl(raw, allowedHosts): string | null`):**

- Trim input. Reject if empty.
- Parse with `new URL(raw)`. Catch parse errors → reject.
- Reject unless `url.protocol === 'https:'`.
- Reject unless `url.hostname` (lowercased) is in `allowedHosts` (configured default: `open.spotify.com`, `spotify.link`).
- **Path-shape allowlist:**
  - For `open.spotify.com`: pathname must match `/^\/jam\/[A-Za-z0-9]{1,64}(\/.*)?$/` (Jam share links look like `/jam/<id>`; trailing query strings are allowed and preserved).
  - For `spotify.link`: pathname must match `/^\/[A-Za-z0-9]{1,32}$/` (short-link shape; cannot further validate without following the redirect, which we deliberately do not do — following arbitrary operator-pasted URLs would be another phishing vector).
- Reject any URL containing `\r`, `\n`, `\0` (belt-and-braces; the IRC bridge already strips these, but the allowed character classes above do it naturally).
- On accept, return the normalized URL string (`url.toString()`). On reject, return `null`.

The validator is a pure function. Test it exhaustively.

**Tasks:**

- [ ] Add `RadioSession` interface and module-level state variables.
- [ ] Write `validateJamUrl(raw, allowedHosts)` — pure, no side effects, extractable for unit tests.
- [ ] Flesh out `teardown()`: null out `session`, `spotify`, `cfg`. No dangling timers to clear because the poll loop is driven by a `time` bind (auto-removed on unload).
- [ ] Verification: covered by unit tests in the next phase.

### Phase 5: Commands (`!radio`, `!listen`)

**Goal:** The user-facing IRC surface. Permission-gated on/off, public status/listen.

**Bind strategy.** `pub` binds are non-stackable — one handler per exact command mask. Use one `pub '-' '!radio'` handler that dispatches subcommands internally and enforces `n` flag only on mutating subcommands via `api.permissions.checkFlags('n', ctx)`. This keeps the bare `!radio` (status) and `!listen` readable by everyone while still gating `on`/`off` to owner.

**Command grammar:**

| Command           | Flags | Behavior                                                                                                                                                                                                                                                                                                                              |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `!radio`          | —     | Print session status: `Radio is off.` or `Radio on since <when> — join: <url> — Now playing: <song — artist>`. Uses `api.notice(ctx.nick, ...)` to avoid spamming the channel.                                                                                                                                                        |
| `!radio on <url>` | `n`   | Validate URL, refuse with a reason if bad. If a session is already active, refuse with `Radio already on in <channel>; run !radio off first.`. Otherwise: set `session`, call `api.say(channel, ...)` with the opening announcement, prime the poller by capturing `lastTrackId = null` so the next poll announces the current track. |
| `!radio off`      | `n`   | If no session, notice `Radio is not on.`. Otherwise clear `session`, announce `[radio] Session ended.` to the channel, log `[spotify-radio] Session ended by <nick> (manual)`.                                                                                                                                                        |
| `!listen`         | —     | Alias for bare `!radio` status, but prints **to the channel** (not via notice) so others can see where to join.                                                                                                                                                                                                                       |

**Status message formatting:**

- Always prefix with the configured `announce_prefix` (default `[radio]`).
- Apply `api.stripFormatting()` to track title, artist, and album before splicing.
- Cap combined track title + artist at ~200 chars before the bot's own prefix so the line never overflows IRC's 512-byte budget even after the network prepends `:nick!ident@host`.
- Track URL in announcements is the `open.spotify.com/track/<id>` form returned by the API — not the pasted Jam URL.

**Logging policy (matches `plugins/rss` `logCmd`):**

- `!radio on/off` attempts log at `debug`.
- Successes log at `info` with `who` = `nick!ident@host` (unredacted is fine — these are hostmasks, not secrets).
- Permission rejections log at `debug` and send a notice to the invoker.
- Never log the refresh token, access token, or client secret at any level.

**Tasks:**

- [ ] Register `pub '-' '!radio'` bind in `init()` with an async handler that parses the subcommand and dispatches.
- [ ] Register `pub '-' '!listen'` bind for the public-channel status alias.
- [ ] Implement `handleRadioOn(api, ctx, rawUrl)`:
  - Single-session guard.
  - URL validation via `validateJamUrl`.
  - Construct the `RadioSession` with `startedAt = Date.now()` and `ttlMs = cfg.session_ttl_hours * 3600_000`.
  - Announce opening line to `ctx.channel`.
  - Log success.
- [ ] Implement `handleRadioOff(api, ctx, reason)` where `reason` is `'manual'`, `'ttl'`, or `'error'` — shared helper used by the command handler, the TTL expiry path, and the error-threshold path.
- [ ] Implement `handleRadioStatus(api, ctx, public)` that prints to channel when `public=true` and via notice otherwise.
- [ ] Register `!radio` and `!listen` help entries via `api.registerHelp`.
- [ ] Verification: see the command-routing test in the test plan.

### Phase 6: Poll loop and announce-on-change

**Goal:** While a session is active, poll Spotify every `poll_interval_sec` seconds, detect track changes, announce them, and honor the TTL and error budget.

**Driver.** Single `api.bind('time', '-', '10', handler)` — 10s is the dispatcher floor. If the operator configures `poll_interval_sec > 10`, the tick still fires every 10s but only runs the poll body when `Date.now() - session.lastPollAt >= cfg.poll_interval_sec * 1000`. (Same idiom as `plugins/rss` with `getLastPoll` — single bind, per-target due-time check.) If they configure `poll_interval_sec < 10`, log a warning at load and clamp to 10.

**Tick handler body (pseudocode):**

```
if !session || !spotify: return
now = Date.now()

// TTL expiry
if now - session.startedAt >= session.ttlMs:
  announce "[radio] Session TTL reached. Radio off."
  handleRadioOff('ttl')
  return

// Rate pacing
if now - session.lastPollAt < cfg.poll_interval_sec * 1000: return
session.lastPollAt = now

try:
  current = await spotify.getCurrentlyPlaying()
  session.consecutiveErrors = 0

  if current === null:
    // Nothing playing — not an error. Don't announce, don't update lastTrackId.
    return

  if current.trackId !== session.lastTrackId:
    session.lastTrackId = current.trackId
    announceTrack(api, session, current)

catch SpotifyAuthError as e:
  // Refresh token is dead — no point retrying.
  api.error('[spotify-radio] Auth failed — refresh token likely revoked. Session ended.')
  announce "[radio] Authentication with Spotify failed. Radio off."
  handleRadioOff('error')
catch SpotifyRateLimitError as e:
  // Push next allowed poll forward by Retry-After. Count as a soft error.
  session.lastPollAt = now + (e.retryAfterSec * 1000)
  session.consecutiveErrors += 1
catch SpotifyNetworkError | SpotifyHttpError as e:
  session.consecutiveErrors += 1
  api.warn('[spotify-radio] Poll failed', { status: e.status })
  if session.consecutiveErrors >= cfg.max_consecutive_errors:
    announce "[radio] Too many errors talking to Spotify. Radio off."
    handleRadioOff('error')
```

**Announcement formatter:**

```
const prefix = cfg.announce_prefix                                  // e.g. "[radio]"
const title  = api.stripFormatting(current.title).slice(0, 120)
const artist = api.stripFormatting(current.artist).slice(0, 80)
const line   = `${prefix} Now playing: ${title} — ${artist} • ${current.url}`
api.say(session.channel, line)
```

**Rule:** the first tick after `!radio on` always has `lastTrackId === null`, so whatever is currently playing is announced immediately as the opening track. If nothing is playing yet, nothing is announced — the next real track change triggers the first announcement.

**`progress_ms`/`duration_ms` optimization — deliberately deferred.** The API data supports skipping polls mid-song (remaining = duration − progress), which could drop call volume by ~30x. At 10s cadence against a single account Spotify's unpublished rate limit is not a concern, and the optimization adds branching complexity to the test matrix. Revisit only if real-world usage hits 429s.

**Tasks:**

- [ ] Register the 10s `time` bind in `init()`.
- [ ] Implement the tick handler with full branch coverage per the pseudocode.
- [ ] Implement `announceTrack(api, session, current)` that composes the line and calls `api.say`.
- [ ] Ensure `handleRadioOff('ttl' | 'error')` is reachable from the tick handler and does the same cleanup as the manual path.
- [ ] Verification: integration-style test that drives the tick handler through a fake clock against a mocked Spotify client (see test plan).

### Phase 7: README and operator docs

**Goal:** An operator who has never seen the plugin can go from zero to a working radio session in under ten minutes.

**File:** `plugins/spotify-radio/README.md`.

Required sections:

1. **What it does** — one paragraph. Emphasize: this announces tracks and re-broadcasts a Jam link; it does not create Jams and it cannot stream audio.
2. **Prerequisites** — Spotify Premium (for hosting a Jam), a hexbot with `n`-flag access, ability to run `pnpm` on a workstation.
3. **Setup (workstation side):**
   - Register an app at https://developer.spotify.com/dashboard.
   - Add `http://127.0.0.1:8888/callback` to the app's redirect URIs.
   - Copy client ID and client secret.
   - On your local workstation: `HEX_SPOTIFY_CLIENT_ID=... HEX_SPOTIFY_CLIENT_SECRET=... pnpm run spotify:auth`.
   - Complete the browser flow; copy the refresh token from the terminal output.
4. **Setup (bot side):**
   - Add the three `HEX_SPOTIFY_*` values to `config/bot.env` on the bot host.
   - Enable `spotify-radio` in `config/plugins.json`.
   - Restart (or `.reload spotify-radio`).
5. **Usage:** `!radio on <jam-url>`, `!radio off`, `!radio`, `!listen`. Example output.
6. **Operating it:**
   - How to start a Spotify Jam from the official Spotify client (link to Spotify's own doc, don't re-document).
   - How to copy the Jam share link.
   - Reminder that the link dies when the host ends the Jam in the Spotify app; run `!radio off` when wrapping up.
   - Session TTL (default 6h) safety net — tell them what it is and how to change it.
7. **Troubleshooting:**
   - "Auth failed" → token revoked, re-run `pnpm run spotify:auth` on your workstation, update `bot.env`, reload.
   - "Scope missing" → same fix; tokens are scope-locked at grant time.
   - "Nothing happens when I run !radio on" → check plugin is loaded, check you have the `n` flag, check the URL matches the allowlist.
8. **Limitations & design notes:**
   - No Jam API → link is manual.
   - No listener count.
   - No audio streaming.
   - One session at a time (MVP).
   - State does not persist across bot restarts — restarting the bot ends the session.
9. **Security notes:**
   - The refresh token is a long-lived credential equivalent to giving the bot read access to your playback state. Treat it like any other `HEX_*_PASSWORD`.
   - Revoke anytime at https://www.spotify.com/account/apps/.
   - Never paste the refresh token into IRC, plugins.json, or a commit.

**Tasks:**

- [ ] Write `plugins/spotify-radio/README.md` per the structure above.
- [ ] Add a brief note in `docs/SECURITY.md` section 6 (config secrets list) that names the three new `HEX_SPOTIFY_*` vars — so anyone auditing secrets sees them in the same place as the existing ones.
- [ ] Verification: Read it cold. Can a second pair of eyes follow it end-to-end without asking for help?

## Config changes

### New plugin config (`plugins/spotify-radio/config.json`)

```json
{
  "client_id_env": "HEX_SPOTIFY_CLIENT_ID",
  "client_secret_env": "HEX_SPOTIFY_CLIENT_SECRET",
  "refresh_token_env": "HEX_SPOTIFY_REFRESH_TOKEN",
  "poll_interval_sec": 10,
  "session_ttl_hours": 6,
  "announce_prefix": "[radio]",
  "allowed_link_hosts": ["open.spotify.com", "spotify.link"],
  "max_consecutive_errors": 5
}
```

### Optional override in `config/plugins.json`

```json
{
  "spotify-radio": {
    "enabled": true,
    "channels": ["#radio"],
    "config": {
      "poll_interval_sec": 15,
      "session_ttl_hours": 4,
      "announce_prefix": "[hexradio]"
    }
  }
}
```

The `channels` array restricts the plugin's bind handlers to those channels (standard hexbot plugin scoping). Secret `_env` fields are **not** overridable from `plugins.json` — only code-side `config.json` may declare them.

### New env vars in `config/bot.env` (and `bot.env.example`)

```
# Spotify radio plugin — Spotify Web API credentials.
# Required only if the spotify-radio plugin is enabled.
# Obtain by registering an app at https://developer.spotify.com/dashboard,
# adding http://127.0.0.1:8888/callback as a redirect URI, then running
# `pnpm run spotify:auth` on your workstation (NOT inside the container).
# The refresh token must belong to the Spotify account that will be hosting
# the Jam and playing music — not the bot operator's account if those differ.
HEX_SPOTIFY_CLIENT_ID=
HEX_SPOTIFY_CLIENT_SECRET=
HEX_SPOTIFY_REFRESH_TOKEN=
```

## Database changes

**None.** The plugin has no persistent state. Session state is in-memory and intentionally dies on restart/reload. This is a deliberate simplification for MVP — document clearly in the README so operators aren't surprised.

## Test plan

All tests use Vitest. No real network traffic. No real Spotify calls. All tests live under `tests/plugins/spotify-radio/`.

### `spotify-client.test.ts`

Unit tests for `plugins/spotify-radio/spotify-client.ts`. Injects a stub `fetch` via the factory's `fetch` parameter.

- `refreshAccessToken` — success returns `{ accessToken, expiresAt }` with `expiresAt` ≈ `now + expires_in*1000`.
- `refreshAccessToken` — 400/401 from token endpoint throws `SpotifyAuthError`, does **not** include the response body in the error message (grep the thrown error to prove it).
- Access-token cache — two consecutive `getCurrentlyPlaying` calls only mint one token when the cached token is still valid.
- Access-token cache — second call re-mints when the cached token is within 60s of expiry.
- `getCurrentlyPlaying` — 204 returns `null`.
- `getCurrentlyPlaying` — 200 with `item.type === 'track'` returns a populated `CurrentlyPlaying`.
- `getCurrentlyPlaying` — 200 with `item.type === 'episode'` returns `null` (MVP ignores podcasts).
- `getCurrentlyPlaying` — 401 triggers one refresh-and-retry; if the retry also 401s, throws `SpotifyAuthError`.
- `getCurrentlyPlaying` — 429 with `Retry-After: 30` throws `SpotifyRateLimitError` with `retryAfterSec === 30`.
- `getCurrentlyPlaying` — fetch rejection throws `SpotifyNetworkError`.
- **Secret redaction** — spy on the provided `log`/`error` functions across all tests; assert no call argument contains the test refresh token, client secret, or access token string. This is the most important assertion in the file.

### `url-validator.test.ts`

Pure-function tests for `validateJamUrl`.

- Accept: `https://open.spotify.com/jam/abc123`
- Accept: `https://open.spotify.com/jam/abc123?si=xyz`
- Accept: `https://spotify.link/ABcd1234`
- Reject: empty string
- Reject: garbage (`not a url`)
- Reject: `http://` (non-HTTPS)
- Reject: `https://evil.com/open.spotify.com/jam/abc`
- Reject: `https://open.spotify.com/track/abc123` (wrong path prefix)
- Reject: `https://open.spotify.com/jam/` (missing id)
- Reject: `https://open.spotify.com/jam/abc%0D%0AFOO` (encoded newline smuggled in)
- Reject: URL with `\r` / `\n` / `\0` injected directly
- Reject: `https://OPEN.spotify.com/jam/abc123` unless hostname is lowercased during comparison (verify the case-folding behavior explicitly)
- Reject: any hostname not in the configured allowlist
- **Fuzz-style:** 50 randomly generated URLs from a hostile generator, all must return `null` (deterministic seed for reproducibility).

### `command-routing.test.ts`

Integration-style tests using hexbot's existing `tests/helpers/mock-irc.ts` and a mocked `SpotifyClient`.

- `!radio` bare → prints `Radio is off.` via notice when no session.
- `!radio on <valid-url>` as owner → session created, opening announcement on channel, `spotify.getCurrentlyPlaying` called on next tick.
- `!radio on <valid-url>` as non-owner → rejection notice, no session.
- `!radio on <invalid-url>` as owner → rejection notice with reason, no session.
- `!radio on <valid-url>` when a session already exists → refusal.
- `!radio off` as owner with session → session cleared, `[radio] Session ended.` announced on channel.
- `!radio off` as owner with no session → notice only, no channel spam.
- `!listen` → prints status **to channel** (not notice).
- Plugin reload mid-session → `teardown()` clears `session`, `init()` starts clean; the old `time` bind is gone (no dangling announcements).

### `poll-loop.test.ts`

Drive the tick handler directly with a fake clock (`vi.useFakeTimers()`) and a scripted mock `SpotifyClient`.

- Fresh session, mock returns track A → `[radio] Now playing: A — ArtistA` announced once, `session.lastTrackId === 'A'`.
- Next tick, mock still returns track A → no announcement.
- Next tick, mock returns track B → announcement, `lastTrackId === 'B'`.
- Next tick, mock returns `null` (nothing playing) → no announcement, `lastTrackId` unchanged.
- Next tick, mock returns track A again → announcement (lastTrackId was B, now A).
- `SpotifyRateLimitError` with `retryAfterSec = 30` → `lastPollAt` pushed forward, `consecutiveErrors` incremented; subsequent ticks within the 30s skip the poll body.
- `SpotifyNetworkError` ×5 (= `max_consecutive_errors`) → session ends, error announcement on channel, `session === null`.
- `SpotifyAuthError` on first tick → session ends immediately, error announcement, no retry.
- Session TTL reached → session ends with `ttl` reason, TTL announcement on channel.
- Track-announce formatting: title containing `\x02` (bold) and `\x03,04` (color) renders as plain text after `stripFormatting`.

### `auth-script.test.ts` (lighter)

Tests for `scripts/spotify-auth.ts` — pure-function extraction of the token-exchange body builder and response parser so they can be unit-tested without booting an HTTP listener. The listener itself is smoke-tested manually as part of Phase 1 verification; automating full loopback HTTP + mock token endpoint is more scaffolding than MVP deserves.

- `buildAuthorizeUrl({ clientId, state, codeChallenge })` — returns a URL with the expected query params.
- `parseTokenResponse({ access_token, refresh_token, expires_in })` — returns a typed record.
- `parseTokenResponse` on error response — throws without echoing the response body.

### What is NOT tested automatically

- Real Spotify HTTP. Manual smoke test in Phase 1.
- The loopback listener in `spotify-auth.ts` (see above).
- Jam link liveness — cannot be tested without a real Spotify session.

## Open questions

These are things that would benefit from a user decision before building, but the plan is buildable under the default assumption stated in each item.

1. **Single-session-bot-wide vs single-session-per-channel.** MVP default: one session per bot, regardless of how many channels the plugin is scoped to. Simpler state, simpler mental model, matches the "one DJ" story. If you'd prefer per-channel sessions (two channels, two different Jams), that's doable but the session map, `!radio` status, and poll loop all get more complex. **Default: bot-wide single session. Confirm?**

2. **Should the opening `!radio on` announcement include the current track if one is playing, or only the Jam link?** Default: Jam link immediately, track announcement comes on the next tick (1–10s later) once the poller fires. That's simpler. The alternative is to call `getCurrentlyPlaying` inline during `!radio on` so the opening message already has the track name. Slightly nicer UX, slightly more branching. **Default: two-message opening (link first, first track on next tick). Confirm?**

3. **`announce_prefix` styling.** MVP default is plain `[radio]`. hexbot plugins generally avoid emoji (the rss plugin uses bold IRC formatting `\x02[name]\x02`). Should the Spotify plugin match rss and bold the prefix? Default: yes, `\x02[radio]\x02`. **Confirm?**

4. **What happens on `!radio on` mid-session from a different channel?** MVP default (bot-wide single session) refuses. Alternative: auto-close the existing session, open the new one. Refusing is safer — prevents accidental hijack. **Default: refuse. Confirm?**

5. **Retry-After clamping.** Spotify's `Retry-After` is usually small (seconds) but spec-wise can be anything. Should the poller clamp it to e.g. 5 minutes max so a buggy or hostile response can't pause the session indefinitely? Default: yes, clamp to `min(retryAfterSec, 300)`. **Confirm?**

None of these are blockers for Phase 1 (auth script) or Phase 2 (skeleton). They only need answers before Phase 5 (commands) or Phase 6 (poll loop). Raise them with the operator when we get there if the defaults don't feel right.

## Post-MVP roadmap

Everything in this section ships after Phases 1–7 are green. Each phase here is independently buildable on top of the MVP code, introduces no new npm dependencies, and — critically — **introduces no new Spotify OAuth scopes**. The Web API `search` and `tracks` endpoints accept any valid user access token, so the existing `user-read-currently-playing user-read-playback-state` token minted in Phase 1 is sufficient for every feature below.

**Design decisions locked during planning (do not revisit without cause):**

- **Queue integration model:** logical queue only. Bot tracks requests in memory; the host plays them manually in their Spotify client and the existing poll loop auto-detects the play. No `user-modify-playback-state` scope is added, so the bot cannot and does not push tracks into Spotify's own queue. Safer, simpler, and Jam-compatible.
- **Queue persistence:** in-memory. Dies on reload, teardown, and `!radio off` — same lifecycle as `RadioSession`. No DB schema.
- **Request matching:** accept either a canonical `open.spotify.com/track/<id>` URL (deterministic) or free text (top Spotify `search` hit). No confirmation loop.
- **Announcement style:** bold prefix plus accent colors. No background-color maximalism.

### Phase 8: Eye-catching announcement styling

**Goal:** Replace the plain `[radio] Now playing: …` line with a bold, accent-colored announcement so track transitions stand out from normal channel chatter without color-bombing the channel.

**Why this phase ships first in the post-MVP run.** It is cosmetic-only, has no dependency on queue or request code, and every later phase reuses the shared formatter. Locking the visual language here means Phases 9–11 don't each reinvent it.

**Color palette (mIRC codes):**

| Element              | Code          | Notes                                |
| -------------------- | ------------- | ------------------------------------ |
| Prefix `[radio]`     | `\x02`…`\x02` | Bold, no color — matches rss plugin  |
| Label `Now playing:` | `\x0311`      | Light cyan — leading accent          |
| Track title          | `\x02\x0308`  | Bold yellow — the focal element      |
| Separator `—`        | `\x0315`      | Light grey — recedes                 |
| Artist               | `\x0307`      | Orange                               |
| Track URL            | `\x0314`      | Grey — informational, deprioritized  |
| Requester suffix     | `\x0313`      | Pink — added in Phase 11             |
| Reset                | `\x0F`        | Explicitly closes every colored span |

Every colored span is terminated with `\x0F`. This is defence against clients that render unterminated color state across the rest of the line — an unterminated color in one segment should not bleed into the next.

**Helper module:** `plugins/spotify-radio/format.ts` (plugin-local, pure, no `api` dependency).

```typescript
export function formatNowPlaying(opts: {
  prefix: string;
  title: string;
  artist: string;
  url: string;
  requestedBy?: string; // added in Phase 11
}): string;

export function formatOpening(prefix: string, jamUrl: string): string;
export function formatSessionEnded(prefix: string, reason: 'manual' | 'ttl' | 'error'): string;
export function formatQueued(
  prefix: string,
  title: string,
  artist: string,
  nick: string,
  position: number,
): string; // Phase 9
export function formatQueueLine(index: number, req: QueuedRequest): string; // Phase 10
export function formatHistoryLine(index: number, req: QueuedRequest): string; // Phase 10
export function formatSessionSummary(
  prefix: string,
  played: number,
  requested: number,
  durationMs: number,
): string; // Phase 11
```

Every format function owns its own color codes; the poll-loop and command code should never hand-splice ANSI. This keeps tests focused on one module and call sites readable.

**Safety rules (non-negotiable):**

- Every string that originates from Spotify (`title`, `artist`, `album`) or from a requester (`nick`) **must** pass through `api.stripFormatting()` at the call site **before** being handed to the formatter. Otherwise a maliciously-named track could inject its own color codes and break the layout.
- The formatter applies `slice(0, N)` length caps (120 chars title, 80 chars artist, 16 chars nick) **after** `stripFormatting` so caps count visible characters, not hidden control bytes.
- The formatter is pure: no `api.*`, no logging, no `Date.now()`. Every output is deterministic given its inputs.

**Tasks:**

- [ ] Create `plugins/spotify-radio/format.ts` with `formatNowPlaying`, `formatOpening`, `formatSessionEnded` (the Phase 9/10/11 formatters land in their own phases).
- [ ] Rewire Phase 6 `announceTrack` to call `formatNowPlaying`.
- [ ] Rewire Phase 5 `handleRadioOn` opening line to call `formatOpening`.
- [ ] Rewire Phase 5 `handleRadioOff` to call `formatSessionEnded`.
- [ ] Unit tests in `tests/plugins/spotify-radio/format.test.ts`:
  - Byte-exact snapshot per formatter variant.
  - Title/artist containing `\x02`, `\x03,04`, `\x0F` (post-`stripFormatting` shouldn't reach the formatter — but test what happens if it does, so injection can't cross layers silently).
  - Length caps count visible characters.
  - Every colored segment is terminated (grep the output for unbalanced `\x03` without a following `\x0F`).

### Phase 9: Public `!request` intake

**Goal:** Any user in the channel can run `!request <text-or-url>` while a session is active. The bot resolves the input to a Spotify track and appends it to an in-memory queue for the host to play.

**Preconditions enforced by the handler (in order):**

1. A session must be active. Otherwise → notice `Requests are only open while radio is on.`
2. `cfg.requests_enabled` must be `true`. Operator kill switch without needing to unload the plugin.
3. `session.requestsMuted` (introduced in Phase 10) must be `false`. Per-session kill switch for the host.

**New config fields (`plugins/spotify-radio/config.json`):**

```json
{
  "requests_enabled": true,
  "max_queue_size": 50,
  "max_pending_per_nick": 3,
  "request_cooldown_sec": 60
}
```

All four are overridable from `plugins.json`. `loadConfig` validates ranges (`max_queue_size` ∈ [1, 500], `max_pending_per_nick` ∈ [1, 20], `request_cooldown_sec` ∈ [0, 3600]).

**Queue state (module-level, reset in `teardown()` and on every `handleRadioOff`):**

```typescript
interface QueuedRequest {
  id: number; // monotonic, starts at 1 per session
  trackId: string; // bare Spotify track id (no spotify:track: prefix)
  title: string;
  artist: string;
  url: string; // https://open.spotify.com/track/<id>
  requestedBy: string; // nick at request time
  requestedAt: number; // ms epoch
  status: 'pending' | 'played' | 'removed';
  playedAt?: number;
}

let requestQueue: QueuedRequest[] = [];
let nextRequestId = 1;
let lastRequestAt = new Map<string, number>(); // nick → ms epoch
```

Single list filtered by `status`. `!radio history` (Phase 10) walks the same array filtered to `played`. Simpler than maintaining parallel pending/history arrays.

**Spotify client extensions.** Add two methods to the Phase 3 `SpotifyClient`:

```typescript
interface SpotifyClient {
  getCurrentlyPlaying(): Promise<CurrentlyPlaying | null>;
  getTrack(id: string): Promise<TrackSummary | null>; // GET /v1/tracks/<id>
  searchTrack(query: string): Promise<TrackSummary | null>; // GET /v1/search?type=track&limit=1&q=...
}

interface TrackSummary {
  trackId: string;
  title: string;
  artist: string;
  url: string;
}
```

Both methods share the existing token cache and error classes. 401 retry logic, 429 `Retry-After` handling, network-error wrapping — all reused. The same "never log secrets" rule applies.

**Resolution pipeline (`resolveRequestInput`, in `plugins/spotify-radio/request.ts`):**

1. Trim; reject empty → `{ error: 'usage' }`.
2. Cap at 200 chars. Strip `\r`, `\n`, `\0`.
3. If the input matches `/^https:\/\/open\.spotify\.com\/track\/([A-Za-z0-9]{22})(\?.*)?$/`, capture the id and call `client.getTrack(id)`.
4. Otherwise call `client.searchTrack(cleaned)`.
5. `null` result → `{ error: 'no_match', query: cleaned }`.
6. Otherwise return the `TrackSummary` — note that every field in the returned record comes from Spotify's response, so no requester-controlled string ends up in the queue, the announcement, or the logs.

**Queue insertion (`enqueueRequest`, pure synchronous function on the module state):**

- Queue full? `requestQueue.filter(r => r.status === 'pending').length >= cfg.max_queue_size` → `{ error: 'full' }`.
- Nick on cooldown? `Date.now() - (lastRequestAt.get(nick) ?? 0) < cfg.request_cooldown_sec * 1000` → `{ error: 'cooldown', remainingSec }`.
- Nick at pending cap? More than `cfg.max_pending_per_nick` pending from this nick → `{ error: 'pending_cap' }`.
- Duplicate pending trackId? → `{ error: 'duplicate', existingPosition }`.
- All checks pass → push, stamp `lastRequestAt`, return `{ ok: true, request, position }`.

Dedupe is pending-only. Once a track plays, someone can request it again (encouraging rotation).

**Channel confirmation line (`formatQueued`, lands in Phase 9 so the formatter grows here):**

```
\x02[radio]\x02 \x0309Queued:\x0F \x02\x0308Still D.R.E\x0F \x0315—\x0F \x0207Dr. Dre\x0F \x0315(#3, requested by \x0313nick\x0F\x0315)\x0F
```

Channel-visible (not a notice) so other listeners see queue activity in real time.

**Tasks:**

- [ ] Extend `SpotifyClient` with `getTrack` and `searchTrack`; unit tests mirror the Phase 3 pattern.
- [ ] Add new config fields to `config.json` and `PluginConfig`; extend `loadConfig` with range checks.
- [ ] Extend module-level state and `teardown()`.
- [ ] Create `plugins/spotify-radio/request.ts` with `resolveRequestInput` and `enqueueRequest`.
- [ ] Register `pub '-' '!request'` bind; handler composes resolve + enqueue + announce.
- [ ] Add `formatQueued` to `format.ts`.
- [ ] `api.registerHelp` entry for `!request`.
- [ ] Tests: see the post-MVP test plan below.

### Phase 10: Host queue management and listener peek commands

**Goal:** Host can inspect, curate, and pause the queue; listeners get lightweight public peek commands.

**Session extension (add one field to `RadioSession`):**

```typescript
requestsMuted: boolean; // defaults to false; set via !radio requests off/on
```

**New commands (all registered via the existing single `pub '-' '!radio'` dispatcher from Phase 5, plus two new top-level binds for the public aliases):**

| Command               | Flags | Visibility     | Behavior                                                                                  |
| --------------------- | ----- | -------------- | ----------------------------------------------------------------------------------------- |
| `!radio queue`        | —     | notice invoker | Top 10 pending with `#id  title — artist  (nick)`. Readable by anyone — it's just a peek. |
| `!radio played <id>`  | `n`   | notice invoker | Mark a pending request as `played` (fallback when auto-detect missed it).                 |
| `!radio drop <id>`    | `n`   | notice invoker | Mark a pending request as `removed`.                                                      |
| `!radio clear`        | `n`   | notice invoker | Mark all pending requests as `removed`; played history is preserved.                      |
| `!radio requests off` | `n`   | notice invoker | Set `session.requestsMuted = true`.                                                       |
| `!radio requests on`  | `n`   | notice invoker | Clear `session.requestsMuted`.                                                            |
| `!radio history`      | —     | notice invoker | Last 10 played tracks with requester attribution where present.                           |
| `!queue`              | —     | **channel**    | Public alias; prints top 5 to the channel so everyone sees what's coming.                 |
| `!np`                 | —     | **channel**    | Channel-visible "now playing" (different from bare `!radio`, which notices the invoker).  |

**Tasks:**

- [ ] Extend the Phase 5 `!radio` subcommand dispatcher with the seven new subcommands.
- [ ] Register `pub '-' '!queue'` and `pub '-' '!np'` binds.
- [ ] Add `formatQueueLine` and `formatHistoryLine` to `format.ts` (dim `#id` in grey, title in bold yellow, artist in orange, nick in pink).
- [ ] Register `api.registerHelp` entries for every new command.
- [ ] Tests: see the post-MVP test plan below.

### Phase 11: Auto-mark-played and requester attribution

**Goal:** When the host plays a queued track, the poll loop auto-marks that request as `played` and the channel announcement credits the requester.

**Match rules (extend the Phase 6 tick handler, right after the `current.trackId !== session.lastTrackId` check):**

1. Find the oldest `requestQueue` entry with `status === 'pending'` and `trackId === current.trackId`.
2. If found: mutate `req.status = 'played'`, `req.playedAt = Date.now()`; pass `req.requestedBy` to `announceTrack`.
3. If not found: announce with no attribution (host is DJing off-list, which is expected and fine).

**Announcement signature change.** `announceTrack(api, session, current, requestedBy?)`. The optional `requestedBy` forwards to `formatNowPlaying`; when present, the formatter appends the pink-accent attribution segment.

**Session-end summary.** `handleRadioOff` now posts a final summary line via `formatSessionSummary(prefix, playedCount, requestedCount, durationMs)`:

```
\x02[radio]\x02 \x0312Session ended.\x0F \x0315Played\x0F \x0208 42\x0F \x0315tracks over\x0F \x0208 2h14m\x0F\x0315, 12 requested.\x0F
```

Counts come from `requestQueue.filter(r => r.status === 'played')`; duration from `Date.now() - session.startedAt`.

**Edge cases (documented and handled):**

- **Two pending requests for the same track (different nicks).** Oldest wins this attribution. The second stays pending — if the host plays the same track again later in the session, the second gets attributed on the second play; otherwise it sits until `!radio off` or a manual drop.
- **Host plays a track that's in played history but not currently pending.** Not a match (only `status === 'pending'` counts). Regular announcement, no attribution.
- **Poll missed the play entirely** (the track finished during a 429 backoff window). Request stays pending. Host can recover with `!radio played <id>`.
- **Host plays an entirely unrelated track.** No match, no attribution, regular colored announcement.

**Tasks:**

- [ ] Extend `announceTrack` signature with the optional `requestedBy` parameter.
- [ ] Extend the poll-loop tick handler with the pending-request lookup and status mutation.
- [ ] Extend `handleRadioOff` to post the session summary line.
- [ ] Add `formatSessionSummary` to `format.ts`.
- [ ] Tests: see the post-MVP test plan below.

### Phase 12: Backlog (not committed)

Nice-to-haves to revisit after Phases 8–11 ship and operators report real-world feedback. Each item is small enough to be its own PR. Listed here so they aren't forgotten, not as a commitment.

- **`!lastplayed <nick>`** — show the most recent track `<nick>` requested that actually played. Good for "what was that song" recovery.
- **`!skip` vote.** Listeners run `!skip`; at a threshold the bot notices the host to advance. The bot can't actually skip (would need the elevated scope) — this is a social signal, not playback control.
- **Top artists / top requesters (session only).** `!radio top` aggregates from the queue history.
- **Banned-term list.** Config-driven keyword blocklist for `!request` plus host-side `!radio ban <term>` / `!radio unban` (session-only overrides). Cleans up noisy channels.
- **Clean-mode filter.** Skip tracks whose Spotify metadata has `explicit: true`. Config flag, off by default.
- **DJ shoutouts.** `!radio shoutout <msg>` (host-only) posts a one-off colored line to the channel. Pure cosmetic.
- **Low-confidence confirm flow.** If `searchTrack` returns a weak match, notice the requester with `Did you mean "<X>"? Reply !yes within 30s.` — stateful per-nick conversation, opt-in per config.
- **Session persistence across restarts.** Write `requestQueue` and `RadioSession` to SQLite so reloads don't nuke an in-progress show. Non-trivial — defer until someone actually asks.
- **Per-channel concurrent sessions.** Sibling of MVP open question #1. Real design work (session map, dispatcher scoping, poll loop fan-out), not drop-in.
- **Web dashboard / REST.** Explicitly ruled out — hexbot is an IRC bot. Listed only to make the refusal visible.
- **Expanded-scope opt-in.** Re-run `spotify:auth` with `user-modify-playback-state` added; unlock a real `!radio skip` and optional "push requests into host's Spotify queue" mode. Gated behind a config flag that defaults off. The logical queue from Phase 9 remains the source of truth.

### Post-MVP test plan

All tests follow the MVP conventions: Vitest, no real network, mocked `SpotifyClient`, no real Spotify traffic. Test files live under `tests/plugins/spotify-radio/`.

**`format.test.ts`** (Phase 8)

- Byte-exact snapshot of `formatNowPlaying`, `formatOpening`, `formatSessionEnded('manual'|'ttl'|'error')`, `formatSessionSummary`, `formatQueued`, `formatQueueLine`, `formatHistoryLine`.
- `formatNowPlaying` with `requestedBy` appends the attribution segment; without it, no trailing segment.
- Every colored span is terminated with `\x0F` (scan output for unbalanced color starts).
- Title/artist/nick with embedded `\x02`, `\x03,04`, `\x0F` does not bleed into later segments — the reset tokens hold.
- Length caps (120 title, 80 artist, 16 nick) count visible characters, not control bytes.

**`spotify-client.test.ts`** (Phase 9 extensions — extends the Phase 3 test file)

- `searchTrack` with a result → returns a populated `TrackSummary`.
- `searchTrack` with an empty `tracks.items` → returns `null`.
- `getTrack` with 200 → returns a populated `TrackSummary`.
- `getTrack` with 404 → returns `null`.
- Both methods reuse the token cache (no extra mint on back-to-back calls).
- 429 on `searchTrack` → `SpotifyRateLimitError` with `retryAfterSec`.
- Secret-redaction assertion: test refresh token, client secret, and access token never appear in any logged argument across any of the new tests.

**`request.test.ts`** (Phase 9)

- `resolveRequestInput` with a canonical `open.spotify.com/track/<22>` URL → calls `getTrack`, returns canonical metadata.
- `resolveRequestInput` with free text → calls `searchTrack`, returns the top hit.
- `resolveRequestInput` with empty input → `{ error: 'usage' }`.
- `resolveRequestInput` with 250-char input → truncates to 200, proceeds.
- `resolveRequestInput` with `\r\n\0` injected → characters stripped before search.
- `resolveRequestInput` with zero results → `{ error: 'no_match', query }`.
- `enqueueRequest` inserts and returns position; duplicate trackId returns `{ error: 'duplicate', existingPosition }`; cooldown returns `{ error: 'cooldown', remainingSec }`; full queue returns `{ error: 'full' }`; pending cap returns `{ error: 'pending_cap' }`.
- `enqueueRequest` after a played entry with the same trackId: no longer a duplicate (dedupe is pending-only).
- `lastRequestAt` map is populated on successful enqueue and does **not** advance on failed enqueue.

**`queue-commands.test.ts`** (Phase 10)

- `!radio queue` with 3 pending → 3 notice lines to invoker.
- `!radio queue` with 0 pending → notice `Queue is empty.`.
- `!radio played <id>` as owner with matching pending → marks played, notice confirms.
- `!radio played <id>` as non-owner → rejected.
- `!radio played <id>` with nonexistent id → `No such request.`
- `!radio drop <id>` as owner → marks removed; subsequent `!radio queue` omits it.
- `!radio clear` as owner with 5 pending → all 5 marked removed, notice includes count.
- `!radio requests off` then `!request` → rejected with `Requests are paused.`.
- `!radio requests on` → requests work again.
- `!queue` with 5 pending → prints top 5 to the channel (not notice).
- `!np` with active session and a current track → prints to channel.
- `!np` with no session → prints `Radio is off.` to channel.

**`auto-mark-played.test.ts`** (Phase 11 — extends the MVP `poll-loop.test.ts`)

- Pending request for track A + poll returns track A → announcement includes `(requested by nick)`, request transitions to `played`, `playedAt` stamped.
- Pending request for track A + poll returns track B → request stays pending, announcement has no attribution.
- Two pending requests for track A from different nicks + poll returns track A → first-requested wins, second remains pending.
- Sequence: track A (pending) → B → A again → first A attributed, second A has no attribution (no more pending A).
- Session-end summary with 10 played, 6 requested, duration 1h23m → output matches `formatSessionSummary` byte-exact.
- Plugin reload mid-session (extends MVP test): `teardown()` clears `requestQueue`, `nextRequestId`, `lastRequestAt`, `session`; `init()` starts clean.

## Post-MVP config changes (cumulative)

### New fields in `plugins/spotify-radio/config.json`

```json
{
  "requests_enabled": true,
  "max_queue_size": 50,
  "max_pending_per_nick": 3,
  "request_cooldown_sec": 60
}
```

### `plugins.json` override example (post-MVP)

```json
{
  "spotify-radio": {
    "enabled": true,
    "channels": ["#radio"],
    "config": {
      "poll_interval_sec": 10,
      "requests_enabled": true,
      "max_queue_size": 30,
      "max_pending_per_nick": 2,
      "request_cooldown_sec": 45
    }
  }
}
```

## Post-MVP database changes

**Still none.** The queue, per-nick cooldowns, and session summary all live in module state and die with the session. Persistence is explicitly deferred to the Phase 12 backlog and requires its own planning round.
