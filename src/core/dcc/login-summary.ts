// HexBot — DCC login-summary queries
//
// Pure helpers on top of `mod_log` — no new schema or parallel state. The
// DCC banner calls `buildLoginSummary()` on a successful auth to warn the
// operator about any failed attempts against their handle since their
// previous successful login. The REPL calls `buildReplStartupSummary()` at
// boot to surface aggregate failure activity across all handles.
//
// Both helpers are intentionally small and read-only so they can be
// snapshot-tested against an in-memory database without any DCC scaffolding.
import type { BotDatabase, ModLogEntry } from '../../database';

/** Summary of failed auth activity against a single handle. */
export interface LoginSummary {
  /** Count of auth-fail rows against this handle since the anchor. */
  failedSince: number;
  /** Most recent auth-fail row, if any. */
  mostRecent: { timestamp: number; peer: string } | null;
  /** Count of auth-lockout rows against this handle since the anchor. */
  lockoutsSince: number;
  /** Previous login timestamp (unix seconds), or null if none. */
  prevLoginTs: number | null;
  /** True when prevLoginTs is null and we fell back to bot-start. */
  usedBootFallback: boolean;
}

/**
 * Build a login summary for `handle` covering the window since the
 * previous `login/success` row for the same handle. If there is no prior
 * login (first-ever auth, or retention-swept), `bootTs` (unix seconds) is
 * used as the anchor and `usedBootFallback` is set so the banner can
 * reword the line to "since bot start".
 *
 * `justWrittenLoginId` is the id of the `login/success` row just inserted
 * for the current session — passed through the `beforeId` cursor so the
 * row we literally just wrote is excluded from the "previous login"
 * lookup. Pass `null` when no login row was written (e.g. the db is null
 * or the write degraded).
 */
export function buildLoginSummary(
  db: BotDatabase,
  handle: string,
  bootTs: number,
  justWrittenLoginId: number | null,
): LoginSummary {
  const prevLogin = db.getModLog({
    action: 'login',
    source: 'dcc',
    by: handle,
    outcome: 'success',
    beforeId: justWrittenLoginId ?? undefined,
    limit: 1,
  })[0];

  const prevLoginTs = prevLogin?.timestamp ?? null;
  const usedBootFallback = prevLoginTs === null;
  const anchorTs = prevLoginTs ?? bootTs;

  const failFilter = {
    action: 'auth-fail',
    source: 'dcc',
    target: handle,
    sinceTimestamp: anchorTs,
  } as const;

  const failedSince = db.countModLog(failFilter);
  const recent = failedSince > 0 ? db.getModLog({ ...failFilter, limit: 1 })[0] : undefined;
  const mostRecent = recent ? extractPeer(recent) : null;

  const lockoutsSince = db.countModLog({
    action: 'auth-lockout',
    source: 'dcc',
    target: handle,
    sinceTimestamp: anchorTs,
  });

  return {
    failedSince,
    mostRecent,
    lockoutsSince,
    prevLoginTs,
    usedBootFallback,
  };
}

function extractPeer(row: ModLogEntry): { timestamp: number; peer: string } {
  const peer =
    row.metadata && typeof row.metadata === 'object' && typeof row.metadata.peer === 'string'
      ? row.metadata.peer
      : '?';
  return { timestamp: row.timestamp, peer };
}

/** Aggregate summary shown above the REPL prompt on startup. */
export interface ReplStartupSummary {
  failures: number;
  lockouts: number;
  handles: Set<string>;
}

/**
 * Render the one-line REPL startup warning, or `null` when there is
 * nothing to warn about. Kept as a pure function (separate from the
 * query helper and the REPL wiring) so tests can snapshot it without
 * spinning up readline on process.stdin.
 */
export function buildReplStartupLine(summary: ReplStartupSummary): string | null {
  if (summary.failures === 0) return null;
  const lockoutTail = summary.lockouts > 0 ? ` — ${summary.lockouts} lockout(s)` : '';
  return `⚠ ${summary.failures} DCC auth failure(s) across ${summary.handles.size} handle(s) since bot start${lockoutTail}`;
}

/**
 * Aggregate failed DCC auth activity since `bootTs` (unix seconds). No
 * `login` row is ever written for the REPL — it has no authentication —
 * so this is a "since bot start" window rather than "since previous REPL
 * login".
 */
export function buildReplStartupSummary(db: BotDatabase, bootTs: number): ReplStartupSummary {
  const failRows = db.getModLog({
    action: 'auth-fail',
    source: 'dcc',
    sinceTimestamp: bootTs,
  });
  const lockouts = db.countModLog({
    action: 'auth-lockout',
    source: 'dcc',
    sinceTimestamp: bootTs,
  });
  const handles = new Set<string>();
  for (const row of failRows) {
    if (row.target) handles.add(row.target);
  }
  return { failures: failRows.length, lockouts, handles };
}
