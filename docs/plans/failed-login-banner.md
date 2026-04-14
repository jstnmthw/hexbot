# Failed-Login Banner — Implementation Plan

## Goal

When an operator successfully authenticates to DCC CHAT, surface any failed
login attempts against their handle since their previous successful login —
count, most recent peer, and whether a rate-limit lockout tripped. Do the
same, in aggregate, at REPL startup. The source of truth is `mod_log`; no
new schema or parallel state.

## Design decisions (confirmed)

- **Audience**: shown to every handle that logs in, regardless of flags. The
  target of a brute-force is the most motivated observer.
- **REPL**: no per-user login event exists. On REPL start, show one aggregate
  line: `N DCC auth failures across M handles since <anchor>`. No "login" row
  is written for REPL.
- **Detail level**: single line, `count + most recent peer + time`. Full
  history stays in `.modlog action=auth-fail`.
- **Lockouts**: if any `auth-lockout` rows exist in the window, add a second
  line — a lockout is a qualitatively different signal from scattered typos.
- **Anchor**: the _previous_ `login/success` row for this handle in `mod_log`.
  First-ever login (or retention-swept) falls back to "since bot start" using
  the bot's process start timestamp, and the line phrasing shifts accordingly.

## Files touched

| File                                           | Change                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `src/core/dcc/index.ts`                        | Write `login`/`success` row in `onAuthSuccess()`; pass login summary into `showBanner()`                     |
| `src/core/dcc/banner.ts`                       | New `BannerLoginSummary` type + optional field on `BannerRenderOptions`; render warning lines                |
| `src/core/dcc/login-summary.ts` _(new)_        | Pure query helper: `buildLoginSummary(db, handle, now)` returns the summary structure                        |
| `src/repl.ts`                                  | On start, call a sibling helper `buildReplStartupSummary(db, bootTs)` and print a one-liner above the prompt |
| `src/core/commands/modlog-commands.ts`         | Teach the `.modlog` rendering to recognise `action='login'` so the new rows read cleanly                     |
| `tests/core/dcc/login-summary.test.ts` _(new)_ | Unit tests against an in-memory DB                                                                           |
| `tests/core/dcc/banner.test.ts`                | Snapshot tests extended with the new warning-line cases                                                      |
| `tests/core/dcc/dcc.test.ts`                   | Assert that successful auth writes exactly one `login/success` row                                           |
| `tests/repl.test.ts`                           | Assert the startup summary line shape                                                                        |

No DESIGN.md changes. No config surface. No migration.

## Data model (in mod_log, no schema change)

New `login` action row written on DCC auth success:

```ts
{
  action: 'login',
  source: 'dcc',
  by: session.handle,       // actor = subject for self-authentication
  target: session.handle,   // target-indexed lookups still work
  outcome: 'success',
  metadata: { peer: session.rateLimitKey },
}
```

Existing `auth-fail` rows are already target-indexed on `<handle>`, so
counting them in a window is one `countModLog()` call.

## Login-summary shape

```ts
// src/core/dcc/login-summary.ts
export interface LoginSummary {
  /** Count of auth-fail rows against this handle since the anchor. */
  failedSince: number;
  /** Most recent auth-fail row, if any. */
  mostRecent: { timestamp: number; peer: string } | null;
  /** Count of auth-lockout rows against this handle since the anchor. */
  lockoutsSince: number;
  /** Previous login timestamp (seconds), or null if this is the first. */
  prevLoginTs: number | null;
  /** True when prevLoginTs is null and we fell back to bot-start. */
  usedBootFallback: boolean;
}

export function buildLoginSummary(
  db: BotDatabase,
  handle: string,
  bootTs: number,
  justWrittenLoginId: number,
): LoginSummary;
```

Implementation:

1. Fetch the previous login row:
   ```ts
   db.getModLog({
     action: 'login',
     source: 'dcc',
     by: handle,
     outcome: 'success',
     beforeId: justWrittenLoginId,
     limit: 1,
   })[0] ?? null;
   ```
   The `beforeId` cursor (already supported in `ModLogFilter`) is the clean
   way to exclude the row we literally just wrote.
2. `anchorTs = prevLogin?.timestamp ?? bootTs`.
3. `failedSince = db.countModLog({ action: 'auth-fail', source: 'dcc', target: handle, sinceTimestamp: anchorTs })`.
4. `mostRecent = db.getModLog({ …same filter…, limit: 1 })[0]` → pull `peer`
   out of `metadata` (already parsed).
5. `lockoutsSince = db.countModLog({ action: 'auth-lockout', source: 'dcc', target: handle, sinceTimestamp: anchorTs })`.

All five are indexed reads over `mod_log_ts`; even with tens of thousands of
rows, the whole call is sub-millisecond. Login is rare — cost is noise.

### REPL variant

```ts
export function buildReplStartupSummary(
  db: BotDatabase,
  bootTs: number,
): { failures: number; lockouts: number; handles: Set<string> };
```

Queries `auth-fail` / `auth-lockout` with no `target`, since boot. The REPL
line is printed only when `failures > 0`.

## Banner wiring

### New type in `banner.ts`

```ts
export interface BannerLoginSummary {
  failedSince: number;
  mostRecent: { timestamp: number; peer: string } | null;
  lockoutsSince: number;
  usedBootFallback: boolean;
}

export interface BannerRenderOptions {
  // …existing fields…
  loginSummary?: BannerLoginSummary | null;
}
```

### Rendering

Inserted after the "owner-only notice" block and before the stats table, so
it sits in the most prominent part of the banner without shoving the logo
around. Shown only when `failedSince > 0` OR `lockoutsSince > 0`.

```
⚠ 3 failed login attempts since your last login
  └ most recent: 14:02:51 from 198.51.100.7:53214
⚠ rate-limit triggered 1 time(s) in that window
```

- The warning prefix uses the same `red()` helper the owner-notice line
  already uses — consistent visual weight.
- Timestamp formatted via the existing locale pipeline in `renderBanner`;
  peer printed verbatim (already scrubbed by `scrubModLogField` at write
  time in `database.ts`).
- Boot-fallback variant swaps "since your last login" →
  "since bot start" so the line is never misleading.

### DCCSession.showBanner()

`showBanner()` currently builds its render options inline. Extract the call
site so it fetches the login summary from the manager, which holds the
`db`:

```ts
private showBanner(): void {
  const summary = this.manager.getLoginSummaryForHandle(
    this.handle,
    this.lastWrittenLoginId,
  );
  renderBanner({ …existing…, loginSummary: summary }, (line) => this.writeLine(line));
}
```

`onAuthSuccess()` (the only non-test caller of `showBanner()`) is updated
to:

1. Write the `login/success` row via `tryLogModAction`, capturing the
   returned row id through a small change to `tryLogModAction` (or
   `db.lastInsertRowid` — see "Open implementation details" below).
2. Stash the id on the session as `lastWrittenLoginId` (private field).
3. Call `showBanner()` as before.

The preview script (`renderBannerPreview`) and `startActiveForTesting()`
pass `loginSummary: null` — they bypass the real auth pipeline, so
synthesising a summary there would be noise.

## REPL wiring

In `BotREPL.start()`, after `createInterface` but before the first prompt:

```ts
const summary = buildReplStartupSummary(this.bot.db, this.bot.startedAt);
if (summary.failures > 0) {
  const anchor = formatAnchor(this.bot.startedAt);
  this.print(
    `⚠ ${summary.failures} DCC auth failure(s) across ${summary.handles.size} handle(s) since ${anchor}` +
      (summary.lockouts > 0 ? ` — ${summary.lockouts} lockout(s)` : ''),
  );
}
```

No `login` row is written for REPL — that would be fiction, since REPL has
no authentication.

## `.modlog` rendering

`src/core/commands/modlog-commands.ts` formats action names in its pager
output. Add `'login'` to whatever friendly-name table exists there (or
grep for `'auth-fail'` and add the parallel case). One-liner.

## Tests

### `tests/core/dcc/login-summary.test.ts` (new)

Use `:memory:` SQLite and the real `BotDatabase`. Cases:

1. No prior login, no failures → `failedSince=0, prevLoginTs=null, usedBootFallback=true`.
2. Prior login at T0, 3 failures between T0 and now, 1 lockout →
   `failedSince=3, lockoutsSince=1, mostRecent.peer` = the most recent write.
3. Prior login at T0, failures exist but all _before_ T0 → `failedSince=0`.
4. Prior login at T0, the row we just wrote at T1 is _not_ counted as a
   failure and _not_ returned as the previous login (cursor works).
5. `auth-fail` rows for a _different_ handle are excluded.
6. Retention-swept history → fallback to `bootTs` and `usedBootFallback=true`.

### `tests/core/dcc/banner.test.ts` (extended)

Snapshot the banner with:

- `loginSummary: null` (no change from current behaviour — regression guard).
- `failedSince=3, lockoutsSince=0, mostRecent` present.
- `failedSince=5, lockoutsSince=2` — both warning lines.
- `usedBootFallback=true` → phrasing reads "since bot start".

### `tests/core/dcc/dcc.test.ts` (extended)

- On successful auth, assert exactly one new `action='login', source='dcc',
by=handle, target=handle, outcome='success'` row lands in `mod_log` and
  no other spurious rows.
- On failed auth, assert no `login` row is written.

### `tests/repl.test.ts` (extended)

- Seed `mod_log` with two `auth-fail` rows after the fake `bootTs`, start
  the REPL, assert the summary line is printed before the first prompt.
- With zero failures, assert nothing extra is printed.

## Open implementation details (resolve while coding, not blockers)

1. **Capturing the new row id.** `BotDatabase.logModAction()` currently
   returns `void`. Two options:
   a. Change the return type to `number | null` (the `lastInsertRowid`).
   Low-risk — all existing call sites ignore the return value and TS
   will happily widen `void` → `number | null`.
   b. Expose a `db.lastModLogId()` helper.

   Prefer (a); it's more honest about what just happened, and the caller
   chain for `login` rows is the only place that needs it today.

2. **Cursor filter.** `ModLogFilter.beforeId` already exists (src/database.ts,
   the `.modlog` pager uses it). Re-use it verbatim; no new filter field.

3. **Boot timestamp source.** `Bot` already tracks startup time for the
   stats banner's `uptime` — reuse that `startedAt` rather than minting a
   new field. If it's not already exposed on the `Bot` public surface, add
   a `readonly startedAt: number` getter.

4. **Peer trimming.** `scrubModLogField` already strips control codes on
   write, but a peer like `very.long.hostname:65535` can still overflow
   one banner line on narrow terminals. The render helper should truncate
   at ~40 chars with an ellipsis.

## Rollout order

1. Add `beforeId` usage test in `login-summary.test.ts` (pin behaviour).
2. Implement `src/core/dcc/login-summary.ts` + tests → green.
3. Change `logModAction` return type → fix the `none`-returning callers (all
   of them ignore it today, so this is just a type widening).
4. Wire `onAuthSuccess` → write `login` row → capture id → call
   `showBanner` with the summary. Extend `dcc.test.ts`.
5. Extend `banner.ts` + tests → green.
6. Wire REPL startup summary + tests → green.
7. Update `.modlog` action-name rendering.
8. `pnpm test` + manual DCC session against local ngIRCd to eyeball the
   banner line.

## Non-goals

- No "last login from" line in the banner (Eggdrop-style). Can be a follow-up;
  the `login` row makes it a one-liner later.
- No botlink leaf auth integration — botlink has its own auth-failure
  tracking and its own audit shape. Same idea could be applied there, but
  scope is DCC + REPL surface only.
- No per-handle reset of the `DCCAuthTracker` lockout counter. That tracker
  remains a pure rate-limiter.
- No config surface. The warning always shows when there's something to show.
