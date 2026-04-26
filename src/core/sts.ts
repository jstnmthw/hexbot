// HexBot — IRCv3 Strict Transport Security (STS)
//
// STS is the IRCv3 equivalent of HTTP HSTS: once a client has seen a valid
// STS directive from a server, it MUST refuse to downgrade that connection
// to plaintext until the advertised duration expires. This module owns:
//
// 1. Parsing `sts` cap values from the CAP LS line (`port=6697,duration=N`
//    on plaintext; `duration=N` on TLS).
// 2. Persisting per-host policies in the `_sts` SQLite namespace so
//    subsequent connections inherit the same protection.
// 3. Enforcing the policy at connect time — if a host has an active
//    directive and the config tries to use plaintext, we either upgrade
//    (when a port is known) or abort startup.
//
// Without STS, an attacker who downgrades the connection (e.g. via a MitM
// DNS hijack or a "captive-portal" intercept) sees every SASL PLAIN
// credential, every message, and every op action in cleartext. The
// SASL PLAIN guard at startup is the first line of defense; STS closes
// the second.
import type { BotDatabase } from '../database';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed directive from a single `sts=` cap value. */
export interface STSDirective {
  /** Seconds the policy is valid for. `0` means "forget the policy". */
  duration: number;
  /** TLS port to reconnect on, when received over plaintext. */
  port?: number;
}

/** Persisted STS record in the `_sts` namespace. */
export interface STSRecord {
  /** Lowercase hostname the policy applies to. */
  host: string;
  /** Duration advertised in seconds. Retained for audit/display. */
  duration: number;
  /** Expiry timestamp in ms since epoch. */
  expiresAt: number;
  /** TLS port to use on reconnect; may be absent when policy was set on TLS. */
  port?: number;
}

export const STS_DB_NAMESPACE = '_sts';

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse an `sts=` cap value into a typed directive. Accepts both plaintext
 * form (`port=6697,duration=2592000`) and TLS form (`duration=2592000`).
 * Returns null if the value is missing both fields or contains a negative
 * duration — those are treated as "no policy" per the IRCv3 spec.
 */
export function parseSTSDirective(rawValue: string | undefined): STSDirective | null {
  if (typeof rawValue !== 'string' || rawValue.length === 0) return null;

  let duration: number | undefined;
  let port: number | undefined;

  for (const pair of rawValue.split(',')) {
    const [rawKey, rawVal] = pair.split('=');
    if (!rawKey) continue;
    const key = rawKey.trim().toLowerCase();
    const val = (rawVal ?? '').trim();
    if (key === 'duration') {
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n >= 0) duration = n;
    } else if (key === 'port') {
      const n = parseInt(val, 10);
      if (Number.isFinite(n) && n > 0 && n < 65536) port = n;
    }
    // Unknown keys are ignored per IRCv3 forward-compat rule.
  }

  if (duration === undefined) return null;
  return port === undefined ? { duration } : { duration, port };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Persistent STS policy store backed by the `_sts` kv namespace.
 *
 * Keys are lowercased hostnames so lookups are consistent regardless of
 * how the user capitalises `irc.host` in their config.
 */
export class STSStore {
  constructor(private readonly db: BotDatabase) {}

  /** Return the active policy for `host`, or null if none / expired. */
  get(host: string, now: number = Date.now()): STSRecord | null {
    const key = host.toLowerCase();
    const raw = this.db.get(STS_DB_NAMESPACE, key);
    if (!raw) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    /* v8 ignore next */
    if (typeof parsed !== 'object' || parsed === null) return null;
    const v = parsed as Record<string, unknown>;
    /* v8 ignore next */
    if (typeof v.expiresAt !== 'number' || typeof v.duration !== 'number') return null;
    if (v.expiresAt <= now) {
      // Expired — prune lazily so we stop returning it.
      this.db.del(STS_DB_NAMESPACE, key);
      return null;
    }
    const result: STSRecord = {
      host: key,
      duration: v.duration,
      expiresAt: v.expiresAt,
    };
    // Re-validate the persisted port before handing it to the reconnect
    // path. The directive parser rejects out-of-range ports when writing,
    // but a corrupted row (migration bug, manual DB edit) would otherwise
    // skip that check and feed a nonsense port into TLS connect. Drop the
    // port silently so a subsequent valid directive can re-seed it.
    if (typeof v.port === 'number' && Number.isInteger(v.port) && v.port > 0 && v.port < 65536) {
      result.port = v.port;
    }
    return result;
  }

  /**
   * Apply an incoming directive for `host`. A directive with `duration=0`
   * deletes any existing policy (IRCv3 spec: clients MUST treat zero as
   * "forget the policy"). Otherwise we compute `expiresAt = now + duration`
   * and persist the record.
   */
  put(host: string, directive: STSDirective, now: number = Date.now()): STSRecord | null {
    const key = host.toLowerCase();
    if (directive.duration === 0) {
      this.db.del(STS_DB_NAMESPACE, key);
      return null;
    }
    const record: STSRecord = {
      host: key,
      duration: directive.duration,
      expiresAt: now + directive.duration * 1000,
    };
    if (directive.port !== undefined) record.port = directive.port;
    this.db.set(STS_DB_NAMESPACE, key, JSON.stringify(record));
    return record;
  }

  /** Delete any cached policy for `host`. Used by admin commands / tests. */
  delete(host: string): void {
    this.db.del(STS_DB_NAMESPACE, host.toLowerCase());
  }
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

/**
 * Outcome of `enforceSTS` applied to an effective (host, tls, port) triple.
 * `kind` is always one of:
 *   - `'allow'`  — no active policy; proceed with the config as-is
 *   - `'upgrade'` — policy exists and we are about to use plaintext;
 *                   the caller MUST set `tls=true` and use the returned port
 *   - `'refuse'` — policy exists but we can't salvage a TLS target
 *                  (e.g. user explicitly set tls=false and we have no port);
 *                  the caller MUST abort startup
 */
export type STSEnforcement =
  | { kind: 'allow' }
  | { kind: 'upgrade'; tls: true; port: number; expiresAt: number }
  | { kind: 'refuse'; reason: string; expiresAt: number };

/**
 * Check a (host, tls, port) triple against the stored STS policy. The caller
 * applies the returned override before handing options to irc-framework.
 * Pure function — only touches the store for reads.
 */
export function enforceSTS(
  store: STSStore,
  host: string,
  currentTls: boolean,
  currentPort: number,
  now: number = Date.now(),
): STSEnforcement {
  const policy = store.get(host, now);
  if (!policy) return { kind: 'allow' };

  if (currentTls) {
    // Already TLS — the policy is satisfied and the caller continues as-is.
    // (We still hand back `allow` to keep the caller uniform.)
    return { kind: 'allow' };
  }

  // Plaintext under an active policy — prefer an automatic upgrade using
  // the recorded TLS port. If no port was ever recorded (unusual: the
  // policy was ingested on a TLS connection but the config later regressed
  // to plaintext) we can't know which port to jump to, so we refuse.
  if (typeof policy.port === 'number') {
    return { kind: 'upgrade', tls: true, port: policy.port, expiresAt: policy.expiresAt };
  }

  return {
    kind: 'refuse',
    reason:
      `STS policy for ${host} is active until ${new Date(policy.expiresAt).toISOString()} ` +
      `but the recorded directive had no port and the current config uses plaintext. ` +
      `Set irc.tls=true and irc.port to the TLS endpoint, or delete the policy from the ${STS_DB_NAMESPACE} namespace.`,
    expiresAt: policy.expiresAt,
  };
}
