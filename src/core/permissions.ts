// HexBot — Permissions system
// Hostmask-based identity, n/m/o/v flags with per-channel overrides.
import type { BotDatabase } from '../database';
import type { Logger } from '../logger';
import type { HandlerContext, UserRecord } from '../types';
import { type Casemapping, ircLower, wildcardMatch } from '../utils/wildcard';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The database namespace for permissions data. */
const DB_NAMESPACE = '_permissions';

/** All valid flag characters, in descending privilege order. */
const VALID_FLAGS = 'nmov';

/** Owner flag implies all other flags. */
const OWNER_FLAG = 'n';

// ---------------------------------------------------------------------------
// Permissions class
// ---------------------------------------------------------------------------

export class Permissions {
  private users: Map<string, UserRecord> = new Map();
  private db: BotDatabase | null;
  private logger: Logger | null;
  private casemapping: Casemapping = 'rfc1459';

  constructor(db?: BotDatabase | null, logger?: Logger | null) {
    this.db = db ?? null;
    this.logger = logger?.child('permissions') ?? null;
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  // -------------------------------------------------------------------------
  // User management
  // -------------------------------------------------------------------------

  /** Add a new user with a handle, initial hostmask, and global flags. */
  addUser(handle: string, hostmask: string, globalFlags: string, source?: string): void {
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
    this.logger?.info(`User added: ${handle} (${hostmask}, flags: ${flags}) by ${by}`);
  }

  /** Remove a user by handle. */
  removeUser(handle: string, source?: string): void {
    const lower = handle.toLowerCase();
    if (!this.users.has(lower)) {
      throw new Error(`User "${handle}" not found`);
    }
    this.users.delete(lower);
    this.persist();

    const by = source ?? 'unknown';
    this.logger?.info(`User removed: ${handle} by ${by}`);
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
  }

  /** Set global flags for a user (replaces existing). */
  setGlobalFlags(handle: string, flags: string, source?: string): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }

    record.global = this.normalizeFlags(flags);
    this.persist();

    const by = source ?? 'unknown';
    this.logger?.info(`Global flags for ${handle} set to "${record.global}" by ${by}`);
  }

  /** Set per-channel flags for a user (replaces existing for that channel). */
  setChannelFlags(handle: string, channel: string, flags: string, source?: string): void {
    const record = this.getUser(handle);
    if (!record) {
      throw new Error(`User "${handle}" not found`);
    }

    const normalizedChannel = ircLower(channel, this.casemapping);
    const normalized = this.normalizeFlags(flags);
    if (normalized === '') {
      delete record.channels[normalizedChannel];
    } else {
      record.channels[normalizedChannel] = normalized;
    }
    this.persist();

    const by = source ?? 'unknown';
    this.logger?.info(`Channel flags for ${handle} in ${channel} set to "${normalized}" by ${by}`);
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
   * Find a user by matching a full hostmask (nick!ident@host) against stored patterns.
   * Returns the first fully-matching user record, or null.
   */
  findByHostmask(fullHostmask: string): UserRecord | null {
    for (const record of this.users.values()) {
      for (const pattern of record.hostmasks) {
        if (wildcardMatch(pattern, fullHostmask, true)) {
          return record;
        }
      }
    }
    return null;
  }

  /** Convenience: find a user whose hostmask matches just the nick portion. */
  findByNick(nick: string): UserRecord | null {
    // Build a partial hostmask — only the nick is known
    // This matches patterns like "nick!*@*" or "*!*@*"
    // For a more reliable lookup, use findByHostmask with full nick!ident@host
    for (const record of this.users.values()) {
      for (const pattern of record.hostmasks) {
        // Extract the nick portion of the pattern (before the !)
        const bangIdx = pattern.indexOf('!');
        if (bangIdx === -1) continue;
        const nickPattern = pattern.substring(0, bangIdx);
        if (wildcardMatch(nickPattern, nick, true)) {
          return record;
        }
      }
    }
    return null;
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
    const record = this.findByHostmask(fullHostmask);
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
        const record = JSON.parse(row.value) as UserRecord;
        this.users.set(record.handle.toLowerCase(), record);
      } catch {
        this.logger?.error(`Failed to parse user record: ${row.key}`);
      }
    }

    this.logger?.info(`Loaded ${this.users.size} users from database`);
  }

  /** Persist current state to the database. */
  saveToDb(): void {
    if (!this.db) return;

    // Clear existing records
    const existing = this.db.list(DB_NAMESPACE);
    for (const row of existing) {
      this.db.del(DB_NAMESPACE, row.key);
    }

    // Write current state
    for (const [key, record] of this.users) {
      this.db.set(DB_NAMESPACE, key, JSON.stringify(record));
    }
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
      const channelFlags = record.channels[ircLower(channel, this.casemapping)];
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

  /** Warn about insecure hostmask patterns for privileged users. */
  private warnInsecureHostmask(hostmask: string, flags: string, handle: string): void {
    // Check if user has +o or higher
    const hasPrivilege = flags.includes('n') || flags.includes('m') || flags.includes('o');
    if (!hasPrivilege) return;

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
}
