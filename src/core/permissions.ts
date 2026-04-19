// HexBot — Permissions system
// Hostmask-based identity, n/m/o/v flags with per-channel overrides.
import type { BotDatabase, ModLogSource } from '../database';
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import type { HandlerContext, UserRecord } from '../types';
import { type Casemapping, ircLower } from '../utils/wildcard';
import { tryLogModAction } from './audit';
import { ACCOUNT_PATTERN_PREFIX, HostmaskMatcher } from './hostmask-matcher';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The database namespace for permissions data. */
const DB_NAMESPACE = '_permissions';

/** All valid flag characters, in descending privilege order, plus modifiers. */
export const VALID_FLAGS = 'nmovd';

/** Owner flag implies all other flags. */
export const OWNER_FLAG = 'n';

/** Master flag — one step below owner, granted most administrative commands. */
export const MASTER_FLAG = 'm';

/**
 * Return true if the record has owner (`n`) or master (`m`) globally. This is
 * the canonical "is-admin" check — owner implies master, so the two are
 * collapsed here. Use this instead of `record.global.includes('n') || ...`
 * at external call sites so the precedence rule stays in one place.
 */
export function hasOwnerOrMaster(record: { global: string }): boolean {
  return record.global.includes(OWNER_FLAG) || record.global.includes(MASTER_FLAG);
}

/**
 * Prefix for account-based identity patterns stored in `UserRecord.hostmasks`.
 * Inspired by Atheme's extended-ban syntax. A pattern `$a:foobar` matches a
 * user whose IRCv3 services account is `foobar`, regardless of their current
 * nick or host — the critical property for a post-cloak world where hostmask
 * matching alone is not strong enough.
 */
// Shared wildcard+specificity scoring lives in `./hostmask-matcher` so the
// contract (account matches outrank hostmask matches, literal chars beat
// wildcards) can be unit-tested without standing up a Permissions instance.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Resolves a nick to its services account name, or returns undefined if the
 * bot hasn't seen account data for that nick yet. Injected by Bot at wire-up
 * time so Permissions can match account patterns without depending directly
 * on ChannelState.
 */
export type AccountLookup = (nick: string) => string | null | undefined;

/** Runtime shape check for a persisted user record. */
function isUserRecord(value: unknown): value is UserRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.handle !== 'string') return false;
  if (!Array.isArray(v.hostmasks) || !v.hostmasks.every((h) => typeof h === 'string')) return false;
  if (typeof v.global !== 'string') return false;
  if (typeof v.channels !== 'object' || v.channels === null) return false;
  for (const flags of Object.values(v.channels as Record<string, unknown>)) {
    if (typeof flags !== 'string') return false;
  }
  if (v.password_hash !== undefined && typeof v.password_hash !== 'string') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Permissions class
// ---------------------------------------------------------------------------

export class Permissions {
  private users: Map<string, UserRecord> = new Map();
  private db: BotDatabase | null;
  private logger: LoggerLike | null;
  private eventBus: BotEventBus | null;
  private casemapping: Casemapping = 'rfc1459';
  private readonly matcher = new HostmaskMatcher();
  private accountLookup: AccountLookup | null = null;

  /**
   * @param initialUsers Optional seed for the in-memory user map. Keys must
   *   be lowercase handles (the same key space `addUser` uses). Lets tests
   *   pre-load a permission matrix in one constructor call instead of
   *   chaining multiple `addUser`/`addHostmask`/`setGlobalFlags` calls.
   */
  constructor(
    db?: BotDatabase | null,
    logger?: LoggerLike | null,
    eventBus?: BotEventBus | null,
    initialUsers?: Iterable<readonly [string, UserRecord]>,
  ) {
    this.db = db ?? null;
    this.logger = logger?.child('permissions') ?? null;
    this.eventBus = eventBus ?? null;
    if (initialUsers) this.users = new Map(initialUsers);
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
    this.matcher.setCasemapping(cm);
  }

  private lowerChannel(name: string): string {
    return ircLower(name, this.casemapping);
  }

  /**
   * Wire up the account lookup so `$a:` patterns can resolve a nick to its
   * services account. Without this, account patterns are inert and only
   * hostmask patterns will match.
   */
  setAccountLookup(lookup: AccountLookup): void {
    this.accountLookup = lookup;
  }

  // -------------------------------------------------------------------------
  // User management
  // -------------------------------------------------------------------------

  /** Add a new user with a handle, initial hostmask, and global flags. */
  addUser(
    handle: string,
    hostmask: string,
    globalFlags: string,
    source?: string,
    transport?: ModLogSource,
  ): void {
    const lower = handle.toLowerCase();
    if (this.users.has(lower)) {
      throw new Error(`User "${handle}" already exists`);
    }

    const flags = this.normalizeFlags(globalFlags);
    this.warnInsecureHostmask(hostmask, flags, handle);

    const record: UserRecord = {
      handle,
      hostmasks: [hostmask],
      global: flags,
      channels: {},
    };
    this.users.set(lower, record);
    this.persist();

    const by = source ?? 'unknown';
    this.recordModAction(
      'adduser',
      null,
      handle,
      by,
      `hostmask=${hostmask} flags=${flags}`,
      transport,
    );
    this.eventBus?.emit('user:added', handle);
  }

  /**
   * Add or replace a user from a bot-link sync frame.
   * Unlike addUser(), does not throw if the user already exists.
   *
   * Emits `user:flagsChanged` so downstream listeners (e.g. chanmod's auto-op
   * reconciler on the leaf) can react to the sync immediately. Safe because
   * only botlink-hub listens to this event for rebroadcast, and a leaf never
   * runs a hub — so there's no echo loop.
   */
  syncUser(
    handle: string,
    hostmasks: string[],
    globalFlags: string,
    channelFlags: Record<string, string>,
    source?: string,
  ): void {
    const lower = handle.toLowerCase();
    const flags = this.normalizeFlags(globalFlags);
    this.users.set(lower, { handle, hostmasks, global: flags, channels: channelFlags });
    this.persist();

    const by = source ?? 'botlink';
    this.logger?.info(`User synced: ${handle} (flags: ${flags}) from ${by}`);
    this.eventBus?.emit('user:flagsChanged', handle, flags, channelFlags);
  }

  /** Remove a user by handle. */
  removeUser(handle: string, source?: string, transport?: ModLogSource): void {
    const lower = handle.toLowerCase();
    if (!this.users.has(lower)) {
      throw new Error(`User "${handle}" not found`);
    }
    this.users.delete(lower);
    this.persist();

    const by = source ?? 'unknown';
    this.recordModAction('deluser', null, handle, by, null, transport);
    this.eventBus?.emit('user:removed', handle);
  }

  /** Add an additional hostmask to an existing user. */
  addHostmask(handle: string, hostmask: string, source?: string): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }

    this.warnInsecureHostmask(hostmask, record.global, handle);

    if (!record.hostmasks.includes(hostmask)) {
      record.hostmasks.push(hostmask);
      this.persist();
    }

    const by = source ?? 'unknown';
    this.logger?.info(`Hostmask added to ${handle}: ${hostmask} by ${by}`);
    this.eventBus?.emit('user:hostmaskAdded', handle, hostmask);
  }

  /** Remove a hostmask from a user. */
  removeHostmask(handle: string, hostmask: string, source?: string): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }

    const idx = record.hostmasks.indexOf(hostmask);
    if (idx === -1) {
      throw new Error(`Hostmask "${hostmask}" not found for user "${handle}"`);
    }

    record.hostmasks.splice(idx, 1);
    this.persist();

    const by = source ?? 'unknown';
    this.logger?.info(`Hostmask removed from ${handle}: ${hostmask} by ${by}`);
    this.eventBus?.emit('user:hostmaskRemoved', handle, hostmask);
  }

  /** Set global flags for a user (replaces existing). */
  setGlobalFlags(handle: string, flags: string, source?: string, transport?: ModLogSource): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }

    record.global = this.normalizeFlags(flags);
    this.persist();

    const by = source ?? 'unknown';
    this.recordModAction('flags', null, handle, by, `global=${record.global}`, transport);
    this.eventBus?.emit('user:flagsChanged', handle, record.global, record.channels);
  }

  /**
   * Store a password hash on a user record. Caller is responsible for hashing
   * the plaintext — this method never receives or logs a plaintext password.
   *
   * Persists and emits `user:passwordChanged` (handle only — never the hash).
   */
  setPasswordHash(handle: string, hash: string, source?: string, transport?: ModLogSource): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }
    record.password_hash = hash;
    this.persist();

    const by = source ?? 'unknown';
    this.recordModAction('chpass', null, handle, by, null, transport);
    this.eventBus?.emit('user:passwordChanged', handle);
  }

  /** Return the stored password hash for a user, or null if none set / user unknown. */
  getPasswordHash(handle: string): string | null {
    const record = this.getUser(handle);
    return record?.password_hash ?? null;
  }

  /** Remove the stored password hash from a user record. */
  clearPasswordHash(handle: string, source?: string): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }
    delete record.password_hash;
    this.persist();

    const by = source ?? 'unknown';
    this.logger?.info(`Password hash cleared for ${handle} by ${by}`);
    this.eventBus?.emit('user:passwordChanged', handle);
  }

  /** Set per-channel flags for a user (replaces existing for that channel). */
  setChannelFlags(
    handle: string,
    channel: string,
    flags: string,
    source?: string,
    transport?: ModLogSource,
  ): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }

    const normalizedChannel = this.lowerChannel(channel);
    const normalized = this.normalizeFlags(flags);
    if (normalized === '') {
      delete record.channels[normalizedChannel];
    } else {
      record.channels[normalizedChannel] = normalized;
    }
    this.persist();

    const by = source ?? 'unknown';
    this.recordModAction('flags', channel, handle, by, `channel=${normalized}`, transport);
    this.eventBus?.emit('user:flagsChanged', handle, record.global, record.channels);
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  /** Get a user record by handle (case-insensitive). */
  getUser(handle: string): UserRecord | null {
    return this.users.get(handle.toLowerCase()) ?? null;
  }

  /** Return all user records. */
  listUsers(): UserRecord[] {
    return Array.from(this.users.values());
  }

  /**
   * Find a user by identity. Walks every stored pattern and matches whichever
   * branch applies:
   *
   * - `$a:<accountpattern>` — matches when `account` is non-null and the
   *   account name satisfies the wildcard pattern. Case-insensitive per
   *   the connected network's CASEMAPPING.
   * - anything else — treated as a hostmask wildcard and matched against
   *   `fullHostmask` (`nick!ident@host`).
   *
   * Passing `undefined`/`null` for `account` disables account-pattern
   * matching — hostmask patterns still match normally. That's the right
   * answer for events without an authoritative account source.
   */
  findByHostmask(fullHostmask: string, account?: string | null): UserRecord | null {
    // Score every matching pattern across every record and return the single
    // most specific winner. First-match-wins would let two users with
    // overlapping patterns race on Map iteration order, so an unprivileged
    // record whose pattern is `*!*@host.isp.net` could eclipse an owner
    // record whose pattern is `alice!*@host.isp.net` if it happened to be
    // stored first. SECURITY.md §3.3 forbids that outcome.
    let best: { record: UserRecord; score: number } | null = null;
    for (const record of this.users.values()) {
      for (const pattern of record.hostmasks) {
        const score = this.matcher.scorePattern(pattern, fullHostmask, account);
        if (score !== null && (best === null || score > best.score)) {
          best = { record, score };
        }
      }
    }
    return best?.record ?? null;
  }

  // -------------------------------------------------------------------------
  // Flag checking
  // -------------------------------------------------------------------------

  /**
   * Check if a user (identified by context) has the required flags.
   * This is the method the dispatcher calls.
   *
   * Flag string format:
   *   `-`       = always true (no requirement)
   *   `+n`      = needs owner
   *   `+o`      = needs op
   *   `+n|+m`   = needs owner OR master
   *
   * Owner (`n`) implies all other flags.
   * Global flags are checked first, then channel-specific.
   */
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean {
    // No flags required — anyone can trigger
    if (requiredFlags === '-' || requiredFlags === '') return true;

    // Build full hostmask from context
    const fullHostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
    // Resolve account: prefer the IRCv3 account-tag (authoritative per-message)
    // and fall back to the channel-state lookup for events that don't carry it.
    // The lookup returns undefined when we've seen no account data for that
    // nick; normalise both to null so findByHostmask treats them the same.
    const account: string | null =
      ctx.account ?? (this.accountLookup ? (this.accountLookup(ctx.nick) ?? null) : null);
    const record = this.findByHostmask(fullHostmask, account);
    if (!record) return false;

    // Parse required flags — support OR with `|`
    const alternatives = requiredFlags.split('|').map((s) => s.trim().replace(/^\+/, ''));

    // Check: does the user have at least one of the required flag sets?
    for (const required of alternatives) {
      if (this.userHasFlags(record, required, ctx.channel)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check flags by user handle (for bot-link command relay).
   * Skips hostmask lookup — the user is already identified by handle.
   */
  checkFlagsByHandle(requiredFlags: string, handle: string, channel: string | null): boolean {
    if (requiredFlags === '-' || requiredFlags === '') return true;
    const record = this.getUser(handle);
    if (!record) return false;
    const alternatives = requiredFlags.split('|').map((s) => s.trim().replace(/^\+/, ''));
    for (const required of alternatives) {
      if (this.userHasFlags(record, required, channel)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Database persistence
  // -------------------------------------------------------------------------

  /** Load all users from the database into the in-memory cache. */
  loadFromDb(): void {
    if (!this.db) return;

    this.users.clear();
    const rows = this.db.list(DB_NAMESPACE);
    for (const row of rows) {
      try {
        const parsed: unknown = JSON.parse(row.value);
        if (isUserRecord(parsed)) {
          this.users.set(parsed.handle.toLowerCase(), parsed);
          /* v8 ignore next 3 */
        } else {
          this.logger?.error(`Invalid user record shape: ${row.key}`);
        }
      } catch {
        this.logger?.error(`Failed to parse user record: ${row.key}`);
      }
    }

    this.logger?.info(`Loaded ${this.users.size} users from database`);
  }

  /**
   * Persist current state to the database.
   *
   * Runs the entire delete-stale + upsert-current cycle inside a single
   * SQLite transaction so a crash, SQLITE_BUSY mid-loop, or disk full
   * can never leave the namespace half-cleaned. Only keys that have
   * actually been removed from memory get deleted (no more full-table
   * rewrite on every single-user mutation), and every memory record
   * uses `set` (ON CONFLICT DO UPDATE) so the live row is always the
   * latest. Write amplification on a 10k-user botnet drops from 20k
   * row-ops per mutation to 1. See stability audit 2026-04-14.
   */
  saveToDb(): void {
    if (!this.db) return;

    const db = this.db;
    const existing = db.list(DB_NAMESPACE);
    const memoryKeys = new Set<string>();
    for (const [key] of this.users) memoryKeys.add(key);

    db.transaction(() => {
      // Delete rows whose key is no longer in memory.
      for (const row of existing) {
        if (!memoryKeys.has(row.key)) {
          db.del(DB_NAMESPACE, row.key);
        }
      }
      // Upsert current state. `set` compiles to an ON CONFLICT DO UPDATE
      // in database.ts, so no stale shadow rows remain.
      for (const [key, record] of this.users) {
        db.set(DB_NAMESPACE, key, JSON.stringify(record));
      }
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  /** Check if a user record has the given flags (single required set). */
  private userHasFlags(record: UserRecord, required: string, channel: string | null): boolean {
    for (const flag of required) {
      if (!this.userHasFlag(record, flag, channel)) {
        return false;
      }
    }
    return true;
  }

  /** Check if a user record has a single flag. */
  private userHasFlag(record: UserRecord, flag: string, channel: string | null): boolean {
    // Owner implies all flags
    if (record.global.includes(OWNER_FLAG)) return true;

    // Check global flags
    if (record.global.includes(flag)) return true;

    // Check channel-specific flags
    if (channel) {
      const channelFlags = record.channels[this.lowerChannel(channel)];
      if (channelFlags) {
        // Owner in channel implies all flags for that channel
        if (channelFlags.includes(OWNER_FLAG)) return true;
        if (channelFlags.includes(flag)) return true;
      }
    }

    return false;
  }

  /** Normalize flags to only valid characters, deduplicated. */
  private normalizeFlags(flags: string): string {
    const unique = new Set<string>();
    for (const ch of flags) {
      if (VALID_FLAGS.includes(ch)) {
        unique.add(ch);
      }
    }
    // Return in canonical order
    return VALID_FLAGS.split('')
      .filter((f) => unique.has(f))
      .join('');
  }

  /**
   * Warn about insecure hostmask patterns for privileged users. Account
   * patterns (`$a:accountname`) skip the warning — they're stronger than any
   * hostmask because they require the user to have identified with services.
   */
  private warnInsecureHostmask(hostmask: string, flags: string, handle: string): void {
    // Check if user has +o or higher
    const hasPrivilege = flags.includes('n') || flags.includes('m') || flags.includes('o');
    if (!hasPrivilege) return;

    // Account patterns are inherently stronger than hostmask patterns — skip.
    if (hostmask.startsWith(ACCOUNT_PATTERN_PREFIX)) return;

    // Check for nick!*@* pattern (only nick portion is specific)
    const bangIdx = hostmask.indexOf('!');
    if (bangIdx === -1) return;

    const afterBang = hostmask.substring(bangIdx + 1);
    if (afterBang === '*@*' || afterBang === '*@*.*') {
      this.logger?.warn(
        `SECURITY: User "${handle}" has privileged flags (${flags}) ` +
          `with insecure hostmask "${hostmask}" — nick-only matching is easily spoofed`,
      );
    }
  }

  /** Auto-persist to database after changes. */
  private persist(): void {
    this.saveToDb();
  }

  /**
   * Write a mod_log row for a permissions mutation. Delegates to
   * `tryLogModAction` so a DB error never prevents the in-memory change
   * from taking effect — operators see a warn and the command still
   * succeeds. Source is `'system'` because Permissions sits below the
   * command handler and doesn't have a transport context to derive from;
   * the upstream `by` string carries whatever attribution the caller
   * managed to thread through.
   */
  private recordModAction(
    action: string,
    channel: string | null,
    target: string,
    by: string,
    detail: string | null,
    transport?: ModLogSource,
  ): void {
    tryLogModAction(
      this.db,
      {
        action,
        // When the caller threads the transport through we preserve it —
        // otherwise fall back to the historical 'system' label so tests
        // and internal seeders (e.g. `ensureOwner`) still produce a row.
        source: transport ?? 'system',
        by,
        channel,
        target,
        reason: detail,
      },
      this.logger,
    );
  }
}
