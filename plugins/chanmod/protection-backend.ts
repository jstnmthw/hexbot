// chanmod — ProtectionBackend interface and ProtectionChain escalation wrapper
import type { PluginAPI } from '../../src/types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** ChanServ access tier — determines which commands the bot can use. */
export type BackendAccess = 'none' | 'op' | 'superop' | 'founder';

/** Runtime list of valid {@link BackendAccess} values — the single source of truth. */
export const BACKEND_ACCESS_VALUES = ['none', 'op', 'superop', 'founder'] as const;

/** Type guard for {@link BackendAccess} — replaces ad-hoc `as BackendAccess` casts. */
export function isBackendAccess(value: unknown): value is BackendAccess {
  return typeof value === 'string' && (BACKEND_ACCESS_VALUES as readonly string[]).includes(value);
}

/** Narrow an untrusted string (e.g. from channelSettings) to a {@link BackendAccess}. */
export function toBackendAccess(value: unknown): BackendAccess {
  return isBackendAccess(value) ? value : 'none';
}

/** Ordered access tiers for comparison. */
const ACCESS_ORDER: Record<BackendAccess, number> = {
  none: 0,
  op: 1,
  superop: 2,
  founder: 3,
};

/** Returns true if `actual` is at least `required`. */
export function accessAtLeast(actual: BackendAccess, required: BackendAccess): boolean {
  return ACCESS_ORDER[actual] >= ACCESS_ORDER[required];
}

/** Returns the higher of two access levels. */
export function maxAccess(a: BackendAccess, b: BackendAccess): BackendAccess {
  return ACCESS_ORDER[a] >= ACCESS_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// ProtectionBackend interface
// ---------------------------------------------------------------------------

/**
 * Abstract protection backend — implemented by Atheme, Anope, and (future) Botnet.
 *
 * Each backend encapsulates one source of channel protection authority.
 * The takeover logic never calls backends directly — it always goes through
 * ProtectionChain, which tries backends in priority order.
 */
export interface ProtectionBackend {
  /** Backend identifier — 'atheme' | 'anope' | 'botnet' | future backends. */
  readonly name: string;
  /** Priority in the escalation chain (lower = tried first). Botnet: 1, ChanServ: 2. */
  readonly priority: number;

  // Capability queries — return true if the backend CAN perform the action for this channel.
  canOp(channel: string): boolean;
  canDeop(channel: string): boolean;
  canUnban(channel: string): boolean;
  canInvite(channel: string): boolean;
  canRecover(channel: string): boolean;
  canClearBans(channel: string): boolean;
  /** Remove channel key (+k). Used for join recovery. */
  canRemoveKey(channel: string): boolean;
  /** Persistent ban enforcement (ChanServ AKICK). Botnet returns false. */
  canAkick(channel: string): boolean;

  /** True if the access level for this channel was auto-detected (not manually set). */
  isAutoDetected(channel: string): boolean;

  // Action requests — fire-and-forget commands to the backend.
  requestOp(channel: string, nick?: string): void;
  requestDeop(channel: string, nick: string): void;
  requestUnban(channel: string): void;
  requestInvite(channel: string): void;
  /** Full channel recovery. Atheme: RECOVER. Anope: synthetic multi-step. */
  requestRecover(channel: string): void;
  requestClearBans(channel: string): void;
  /** Remove the channel key (+k). Used for join recovery when an attacker sets +k. */
  requestRemoveKey(channel: string): void;
  requestAkick(channel: string, mask: string, reason?: string): void;

  /** Verify actual access level (called on bot join). */
  verifyAccess(channel: string): void;
  /** Get the effective (possibly downgraded) access level for a channel. */
  getAccess(channel: string): BackendAccess;
  /** Set the configured access level for a channel. */
  setAccess(channel: string, level: BackendAccess): void;
}

// ---------------------------------------------------------------------------
// ProtectionChain — escalation wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps multiple ProtectionBackend instances and dispatches requests
 * to the highest-priority backend that can handle them.
 *
 * Priority is ascending (lower number = tried first). Backends are
 * sorted on registration so iteration order is always correct.
 */
export class ProtectionChain {
  private backends: ProtectionBackend[] = [];
  private api: PluginAPI;

  constructor(api: PluginAPI) {
    this.api = api;
  }

  /** Register a backend. Backends are tried in priority order (ascending). */
  addBackend(backend: ProtectionBackend): void {
    this.backends.push(backend);
    this.backends.sort((a, b) => a.priority - b.priority);
  }

  /** Returns the list of registered backends (for testing/debug). */
  getBackends(): readonly ProtectionBackend[] {
    return this.backends;
  }

  // --- Capability queries (any backend can → true) ---

  canOp(channel: string): boolean {
    return this.backends.some((b) => b.canOp(channel));
  }

  canDeop(channel: string): boolean {
    return this.backends.some((b) => b.canDeop(channel));
  }

  canUnban(channel: string): boolean {
    return this.backends.some((b) => b.canUnban(channel));
  }

  canInvite(channel: string): boolean {
    return this.backends.some((b) => b.canInvite(channel));
  }

  canRecover(channel: string): boolean {
    return this.backends.some((b) => b.canRecover(channel));
  }

  canClearBans(channel: string): boolean {
    return this.backends.some((b) => b.canClearBans(channel));
  }

  canRemoveKey(channel: string): boolean {
    return this.backends.some((b) => b.canRemoveKey(channel));
  }

  canAkick(channel: string): boolean {
    return this.backends.some((b) => b.canAkick(channel));
  }

  isAutoDetected(channel: string): boolean {
    return this.backends.some((b) => b.isAutoDetected(channel));
  }

  // --- Action requests (dispatch to first capable backend) ---

  requestOp(channel: string, nick?: string): boolean {
    for (const b of this.backends) {
      if (b.canOp(channel)) {
        b.requestOp(channel, nick);
        this.api.log(`ProtectionChain: ${b.name} handling requestOp for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestOp for ${channel}`);
    return false;
  }

  requestDeop(channel: string, nick: string): boolean {
    for (const b of this.backends) {
      if (b.canDeop(channel)) {
        b.requestDeop(channel, nick);
        this.api.log(`ProtectionChain: ${b.name} handling requestDeop for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestDeop for ${channel}`);
    return false;
  }

  requestUnban(channel: string): boolean {
    for (const b of this.backends) {
      if (b.canUnban(channel)) {
        b.requestUnban(channel);
        this.api.log(`ProtectionChain: ${b.name} handling requestUnban for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestUnban for ${channel}`);
    return false;
  }

  requestInvite(channel: string): boolean {
    for (const b of this.backends) {
      if (b.canInvite(channel)) {
        b.requestInvite(channel);
        this.api.log(`ProtectionChain: ${b.name} handling requestInvite for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestInvite for ${channel}`);
    return false;
  }

  requestRecover(channel: string): boolean {
    for (const b of this.backends) {
      if (b.canRecover(channel)) {
        b.requestRecover(channel);
        this.api.log(`ProtectionChain: ${b.name} handling requestRecover for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestRecover for ${channel}`);
    return false;
  }

  requestClearBans(channel: string): boolean {
    for (const b of this.backends) {
      if (b.canClearBans(channel)) {
        b.requestClearBans(channel);
        this.api.log(`ProtectionChain: ${b.name} handling requestClearBans for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestClearBans for ${channel}`);
    return false;
  }

  requestRemoveKey(channel: string): boolean {
    for (const b of this.backends) {
      if (b.canRemoveKey(channel)) {
        b.requestRemoveKey(channel);
        this.api.log(`ProtectionChain: ${b.name} handling requestRemoveKey for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestRemoveKey for ${channel}`);
    return false;
  }

  requestAkick(channel: string, mask: string, reason?: string): boolean {
    for (const b of this.backends) {
      if (b.canAkick(channel)) {
        b.requestAkick(channel, mask, reason);
        this.api.log(`ProtectionChain: ${b.name} handling requestAkick for ${channel}`);
        return true;
      }
    }
    this.api.warn(`ProtectionChain: no backend can requestAkick for ${channel}`);
    return false;
  }

  // --- Access queries ---

  /** Returns the highest access level across all backends for a channel. */
  getAccess(channel: string): BackendAccess {
    let best: BackendAccess = 'none';
    for (const b of this.backends) {
      best = maxAccess(best, b.getAccess(channel));
    }
    return best;
  }

  /** Set access level on a specific backend by name. */
  setAccess(channel: string, backendName: string, level: BackendAccess): void {
    const b = this.backends.find((be) => be.name === backendName);
    if (b) b.setAccess(channel, level);
  }

  /** Trigger access verification on all backends for a channel.
   *  Always probes regardless of current access level — enables auto-detection. */
  verifyAccess(channel: string): void {
    for (const b of this.backends) {
      b.verifyAccess(channel);
    }
  }
}
