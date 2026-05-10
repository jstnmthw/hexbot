# Quality Report — spotify-radio plugin

_Scanned: 3 source files (1,164 lines) and 6 test files (1,747 lines) under `plugins/spotify-radio/` and `tests/plugins/spotify-radio/`._
_Date: 2026-05-02_

## Summary

The plugin is in good structural shape overall. `spotify-client.ts` and
`url-validator.ts` are tightly scoped, well-commented, and read cleanly;
the test suite is unusually thorough and uses isolated closure-per-test
construction, which is the gold standard. The one real readability
finding is `index.ts` at 640 lines — it bundles three subsystems
(lifecycle/commands, poll loop, config loading) under banner dividers.
Splitting config out of `index.ts` would shrink the entry point to a
comfortable size without changing behavior.

## High Priority

_None._

The plugin has no bugs, mixed concerns at the function level, or
readability disasters that warrant urgent attention.

## Medium Priority

### `plugins/spotify-radio/index.ts` — 640-line entry point bundles three subsystems

- [ ] **Extract config loading into `plugins/spotify-radio/config.ts`**

**Problem:** The file mixes three distinct subsystems under banner
dividers: lifecycle + commands (`init`, `teardown`, `routeRadio`,
`handleStatus`, `handleOn`, `handleOff`, `endSession`), the poll loop
(`registerPollLoop`, `tickPollLoop`, `handlePollError`, `announceTrack`),
and config validation (`loadConfig`, `readSecret`, `readInt`,
`readString`, `readHostList`). Each subsystem reads cleanly on its own,
but together they make the file too tall for a reader to hold the whole
plugin in their head, and they obscure that `loadConfig` plus the four
`read*` helpers are pure stateless code that doesn't touch the closure
at all.

**Evidence:**

- Lines 528–630 — `loadConfig` and the four `read*` helpers; pure, no
  closure access, ~100 lines
- Lines 369–457 — poll loop subsystem; ~90 lines, reads four closure
  variables (`cfg`, `session`, `spotify`) and one helper (`endSession`)
- Lines 121–367 — factory closure with lifecycle, commands, and session
  management; ~250 lines

**Suggested split:** Move `PluginConfig`, `loadConfig`, and the four
`read*` helpers into `plugins/spotify-radio/config.ts`. The factory then
imports `loadConfig` and the type. Drops `index.ts` to ~540 lines and
gives the config validators a natural home. Optional follow-up: the
poll-loop functions (`tickPollLoop`, `handlePollError`, `announceTrack`)
could also move into `poll-loop.ts` as pure functions taking
`(api, session, cfg, spotifyClient)` plus an `endSession` callback —
but that's a bigger lift and the closure access pattern argues for
leaving them in place.

**Risk:** Low — `loadConfig` is already exported and has no closure
access; relocating it is a pure type-and-import shuffle. The existing
`plugin-init.test.ts` already imports `loadConfig` directly, so the
test surface is unchanged.

---

## Low Priority / Cosmetic

- [ ] `plugins/spotify-radio/index.ts:511` — `logCmd` takes a positional
      `outcome: 'attempt' | 'rejected'` argument. Call sites read as
      `logCmd(api, ctx, 'on', 'rejected', 'missing url')` — the third and
      fourth positional strings invite a transposition bug. An options
      object (`{ outcome, reason }`) would self-document. Tiny win.
- [ ] `tests/plugins/spotify-radio/{plugin-init,spotify-client}.test.ts` —
      the `assertNoSecrets`/`assertNoSecretsInCalls` helpers are duplicated
      with the same logic but different secret lists. A shared
      `tests/helpers/assert-no-secrets.ts` taking a secrets array would
      remove the copy. Test-only, no production impact.
- [ ] `tests/plugins/spotify-radio/{command-routing,poll-loop,plugin-init}.test.ts` —
      each test file has its own `bootConfig` factory with the same eight
      fields. A shared `tests/plugins/spotify-radio/helpers.ts` exporting
      `defaultBootConfig()` would centralize the shape, but each file
      currently customizes a key or two, so this is a judgment call —
      consolidate only if the shape changes again.
- [ ] `plugins/spotify-radio/index.ts:336` — `endSession` mutates
      `session = null` before its early-return guard
      (`if (!closingChannel) return;`). The ordering is correct but reads
      as suspect on first pass. Capturing `closingChannel` first and
      nulling `session` only when there's something to clean up would make
      the intent clearer.

---

## Patterns to address across the codebase

None for this scope. The findings are localized to `index.ts` and a
couple of test ergonomics. Nothing here suggests a systemic plugin
pattern problem.

---

## What looks good

- **`spotify-client.ts`** — 423 lines but every function is small and
  focused, with a hard line between closure-bound code and pure
  helpers (banner at line 280). The error-class hierarchy is the
  right shape for the consumer-side `instanceof` dispatch in
  `handlePollError`. The `safeDrain`-on-error pattern is exactly
  the right defensive choice and is documented inline.
- **`url-validator.ts`** — A textbook trust-boundary function: short,
  pure, every rule named, regex constants at the top, all reject paths
  return null with no exceptions thrown. The `unknown`-typed input
  parameter and the explicit `username !== ''` userinfo check show real
  threat-model awareness.
- **Test isolation** — Every test file constructs a fresh
  `createSpotifyRadio()` and a fresh `createMockPluginAPI()` per case.
  No shared mutable state between tests. This is the pattern other
  plugins should emulate.
- **Banner-based section dividers in `index.ts`** — Even at 640 lines,
  the `// ---- Lifecycle ----`-style banners make it easy to navigate.
  The medium-priority finding is about the file _being_ multi-subsystem,
  not about the dividers being unclear.
- **`spotify-client.test.ts` factories** (`makeRecorder`, `makeLog`,
  `clientWithSequencedFetch`, `trackBody`, `tokenResponse`) — at 590
  lines this could easily be a god test file, but the helper layer
  keeps each `it` block readable.
- **`INTERNALS` symbol seam** — well-documented, narrowly scoped to
  test usage, not reachable via global registry. Clean.
