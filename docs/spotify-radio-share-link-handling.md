# How should spotify-radio handle Spotify's actual share-link UX without re-opening the phishing vector?

> **Decision (2026-05-10):** went with **Option C** (accept `spotify.link`
> verbatim, no server-side resolution) after revisiting the threat model.
> `spotify.link` is a vanity domain Spotify owns and CNAMEs at Branch.io,
> so it cannot be spoofed by a third party — only Spotify can configure
> what `spotify.link/<token>` decodes to. The "off-Spotify destination
> via Branch" concern below assumed an attacker-controllable redirector,
> which is not what `spotify.link` is. `spotify.app.link` (Branch's
> shared subdomain) remains rejected. Default `allowed_link_hosts` is
> now `["open.spotify.com", "spotify.link"]`. Option D's resolver was
> not implemented.

## Context

The current Spotify share menu (desktop and mobile, mid-2026) does not give
operators a `https://open.spotify.com/jam/<id>` URL. "Copy link to Jam"
produces a Branch.io short link of the form `https://spotify.link/XXXXX`,
which redirects in-browser to `https://spotify.app.link/XXXXX?_p=...`,
which then either:

1. Tries to deep-link into the Spotify app (`spotify://...`), or
2. Falls back to `https://open.spotify.com/jam/<id>` in the browser.

The `spotify-radio` URL validator (`plugins/spotify-radio/url-validator.ts`)
accepts only `open.spotify.com/jam/<id>` by default. Operators today get
an unconditional rejection, regardless of which of the two short forms
they paste.

### Existing security posture (do not casually overturn)

- `docs/plans/spotify-radio.md:206-209` explicitly documents the
  decision, citing a 2026-04-14 security audit: spotify.link uses
  client-side JavaScript to decode its target, so the bot cannot
  server-side-verify what it actually points to. Accepting it verbatim
  turns `!radio on` into a phishing relay — an operator (or a
  compromised operator account) could announce a `spotify.link` URL
  that resolves to a malicious Spotify-themed page or, worst case, an
  off-Spotify destination via Branch.
- The plugin's contract (README "Security notes") guarantees that what
  appears in the channel is a validated Jam URL, not an opaque
  redirector.
- Operators are `+n` (owner). The threat model isn't "untrusted user
  pastes a malicious link" — it's "the bot must not become a generic
  link-laundering service that strips the smell of a redirector and
  attaches the bot's reputation to it."

### Hexbot constraints

- Node ≥24 — `globalThis.fetch` is already used by the plugin
  (`spotify-client.ts`) with an `AbortController`-based timeout helper.
- `urequest`-style server-side fetching from operator input is
  precedent-setting. Hexbot today does not fetch arbitrary URLs from
  IRC input; the only outbound HTTP is to fixed Spotify endpoints
  (`api.spotify.com`, `accounts.spotify.com`) and Gemini (`ai-chat`).
- The `+n` flag gate already throttles abuse to the operator.

### What's actually needed

A path that lets the operator paste whatever the Spotify share menu
actually produces, while the bot still **announces** only a strict-form
`open.spotify.com/jam/<id>` URL — i.e., the input may be opaque, but the
output is always the canonical, validatable form.

## Options

### Option A: Status quo + better error message

Keep the validator strict; rewrite the rejection text to explain how to
obtain a canonical URL (e.g., paste the spotify.link into a browser with
no Spotify app installed, copy the resulting `open.spotify.com/jam/<id>`
URL from the address bar).

- **Pro**: zero new code, zero new attack surface, posture documented
  in the security audit unchanged.
- **Pro**: the bot's output guarantee is trivially preserved.
- **Con**: real-world UX is bad. The operator must do a multi-step
  workaround every time they start a session, on a workstation that
  has no Spotify app installed (or in a private browser session).
  Many ops will simply not bother.
- **Con**: doesn't actually solve the problem — most operators will
  paste the share-menu URL, get rejected, and either give up or
  pressure the maintainer to weaken the validator.
- **Effort**: S.

### Option B: Server-side resolve + canonicalize, rebroadcast canonical only

Accept `spotify.link` and `spotify.app.link` as **input forms**, but
never as output. On `!radio on <short-url>`:

1. Verify the input host is in a hardcoded short-link allowlist
   (`spotify.link`, `spotify.app.link`).
2. Fetch the URL with manual redirect handling, hard caps:
   - 5s total timeout via `AbortController`.
   - Max 3 redirects.
   - Each `Location` must resolve to a host in the Spotify allowlist
     (`spotify.link`, `spotify.app.link`, `open.spotify.com`). A
     redirect to anything else is a hard fail.
   - Response body capped at 64 KB read.
3. If the final URL after redirects is already
   `https://open.spotify.com/jam/<id>`, run it through the existing
   `validateJamUrl` and use the result.
4. Otherwise, parse the response body for the canonical URL — Branch.io
   pages embed it as `<meta property="og:url" content="https://open.spotify.com/jam/...">`
   (and as a `$canonical_url` in the embedded Branch JSON). Extract
   with a strict regex over the meta tag, then run through
   `validateJamUrl`.
5. **The URL the bot stores in `session.jamUrl` and announces in the
   channel is always the validated `open.spotify.com/jam/<id>` form.**
   The operator's short-link input is never echoed.

Guardrails:

- DNS rebinding protection: re-resolve before fetching each redirect
  hop and refuse private/loopback/link-local addresses (`127.0.0.0/8`,
  `10/8`, `172.16/12`, `192.168/16`, `::1`, `fe80::/10`,
  `169.254.0.0/16`).
- Configurable behind `resolve_short_links: false` default in
  `config.json`. Operator opts in by setting `true` in `plugins.json`.
- All resolution events go to `audit.log` ("share-link-resolved",
  with input host, output canonical URL, redirect count).
- Resolution failures produce a clear, actionable error message
  ("Couldn't resolve that share link to a Jam URL — try pasting the
  https://open.spotify.com/jam/... URL instead").

- **Pro**: solves the actual UX problem.
- **Pro**: maintains the contract — the bot's _output_ is always a
  strict-validated canonical Jam URL. The phishing concern in the
  audit was about announcing opaque short links; this never does.
- **Pro**: server-side decoding closes the "client-side JS only"
  concern from the original audit — the bot now sees what the
  redirector actually points to before deciding.
- **Con**: introduces the first bot feature that fetches an
  IRC-input-derived URL. Sets a precedent — must be designed
  conservatively and audited (host pinning, redirect cap, DNS
  rebinding, body cap, timeout).
- **Con**: depends on Branch.io's HTML containing a parseable canonical
  URL. If Branch changes their template, resolution silently breaks
  and operators fall back to manual canonical-URL paste.
- **Con**: more code to maintain and test.
- **Effort**: M (one new module ~150 lines, ~6 new tests, an opt-in
  config flag).

### Option C: Accept short links verbatim, opt-in, no resolution

Add `spotify.link` (and/or `spotify.app.link`) to a configurable
`allowed_link_hosts`, with the same path-shape regex the validator
already supports — but **rebroadcast the short link as the operator
typed it**, no server-side fetch.

- **Pro**: zero outbound HTTP from operator input — no SSRF surface.
- **Pro**: minimal code (validator already has the spotify.link branch).
- **Con**: explicitly the case the 2026-04-14 audit declined. The bot
  announces an opaque URL whose target it cannot verify. A
  spotify.link (or a stolen Branch link in the same namespace) could
  point anywhere Branch resolves it.
- **Con**: doesn't actually canonicalize, so listeners don't see the
  destination either.
- **Effort**: S.

### Option D: Hybrid — Option B for operator's input, Option A's docs as fallback

Implement Option B as the primary path. If short-link resolution fails
(timeout, parse failure, audit-flagged redirect target), fall back to
Option A's improved error message with the manual workaround. Behind a
single `resolve_short_links` opt-in flag — operators who don't want any
outbound HTTP from `!radio on` get the strict status-quo behavior.

- **Pro**: best of both. Operators who accept the (well-bounded) HTTP
  fetch get a usable plugin; operators who don't get an actionable
  error explaining the workaround.
- **Pro**: gracefully degrades when Branch changes their HTML.
- **Con**: largest of the four options to build and document.
- **Effort**: M (Option B's effort + ~20 lines of fallback prose).

## Recommendation

**Option D**, with `resolve_short_links` defaulting to `false`.

Confidence: high.

The 2026-04-14 audit was right that _announcing an unresolved short
link_ is unacceptable. It did not preclude _resolving_ one server-side
under tight constraints and announcing the canonical result — that
specific design wasn't on the table at audit time.

The defining property to preserve is: **everything the bot announces in
a channel is a strict-form `open.spotify.com/jam/<id>` URL that
`validateJamUrl` accepts.** Option D preserves that absolutely. The
operator's short-link input is treated as a _lookup key_, not as
content to broadcast.

Why Option D over straight Option B:

- Default-off respects the existing audit posture for any operator who
  doesn't opt in. The bot ships with no behavior change.
- The fallback message means even the opt-in path degrades gracefully
  if Branch changes their page template — operators get the manual
  workaround, the bot doesn't silently lose the feature.
- The opt-in flag gives a single place to document the precise threat
  model and what guardrails apply.

Why not Option A alone: it pretends the UX problem isn't real. The
share menu produces short links, and that's what operators will paste.
A plugin that requires a workaround on every session start will be
unused.

Why not Option C: it's exactly the case the original audit declined,
without adding the resolution that closes the gap. No.

### Implementation notes (if Option D is chosen)

1. New module `plugins/spotify-radio/share-link-resolver.ts`:
   `resolveShareLink(url, { fetch, log }) → Promise<string | ResolveError>`.
2. Hardcoded constants — not configurable:
   - Short-link host allowlist: `['spotify.link', 'spotify.app.link']`.
   - Redirect-target host allowlist: above + `'open.spotify.com'`.
   - Max redirects: 3.
   - Total timeout: 5000 ms.
   - Body read cap: 64 KB.
   - User-Agent: `hexbot-spotify-radio/<version> (+share-link-canonicalizer)`.
3. DNS rebinding guard: resolve hostname per-hop, reject private ranges.
4. `og:url` extraction is a strict regex against the meta tag, then
   `validateJamUrl(extracted, ['open.spotify.com'])` — i.e., the
   existing strict validator runs on the _output_ of resolution. No
   short-link host is ever in the validator's `allowedHosts`.
5. New config key `resolve_short_links: boolean` (default `false`),
   documented in README "Configuration reference" and the security
   notes section. README must explicitly state: "Even with this on, the
   bot only ever announces validated `open.spotify.com/jam/<id>` URLs.
   Short links are resolved server-side and discarded."
6. Audit log entry on every resolution attempt
   (`share-link-resolved` / `share-link-resolution-failed`) with
   redirect count and final canonical URL.
7. Tests:
   - Refuses `spotify.link` when flag off (status quo).
   - Resolves redirect chain to `open.spotify.com/jam/<id>` happy path.
   - Refuses redirect to non-Spotify host.
   - Refuses >3 redirects.
   - Refuses redirect to private IP (DNS rebinding).
   - Refuses body >64 KB.
   - Refuses on timeout.
   - Refuses when meta tag absent / malformed.
   - Output of successful resolution passes existing `validateJamUrl`.

### What does NOT change

- The `validateJamUrl` function and its strict
  `/^\/jam\/[A-Za-z0-9]{1,64}\/?$/` regex.
- The default `allowed_link_hosts: ['open.spotify.com']`.
- The bot's contract that everything announced is a validated Jam URL.

The new code sits _before_ `validateJamUrl` in the pipeline, never
in place of it.

## What Eggdrop does

Eggdrop has no Spotify integration, but its long-standing posture on
URLs in user input is informative: TCL `urlcheck`-style scripts are
URL _recorders_, not URL _followers_. Most don't fetch the URL at all
(no SSRF surface), and the few that do (e.g., title-grabbers) are
widely regarded as a security smell because of historical exploits
where attacker-controlled URLs led to internal-network probes or
information disclosure.

The pattern that survived: when an Eggdrop script _must_ fetch a URL,
it (a) restricts the host allowlist, (b) refuses redirects to
non-allowlisted hosts, (c) caps body size and timeout, (d) does not
echo back arbitrary content. Option D's design follows this pattern
exactly.
