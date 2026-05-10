// chanmod — Shared base class for ChanServ-family protection backends
//
// Anope and Atheme share ~70% of their scaffolding: access-tier storage,
// auto-detect tracking, and the common capability/request plumbing. This
// base class collects all of that so the concrete subclasses only declare
// the pieces that genuinely differ (synthetic RECOVER for Anope, FLAGS vs
// ACCESS LIST probes, GETKEY vs MODE -k, subscriber-specific response
// parsers). Lift-and-dedupe only — no behavior change.
import type { PluginAPI } from '../../src/types';
import { getBotNick } from './helpers';
import { type BackendAccess, type ProtectionBackend, accessAtLeast } from './protection-backend';

/**
 * Base class for ChanServ-based protection backends. Concrete subclasses
 * override:
 *   - `name` (identifier — 'atheme', 'anope', ...)
 *   - `requestRecover`, `requestClearBans`, `requestRemoveKey`,
 *     `requestAkick` (where syntax differs from the common shape),
 *     and any capability query whose access tier isn't the default
 *   - `verifyAccess` plus the backend-specific response parser
 *
 * Defaults mirror Atheme semantics because they're the most permissive of
 * the common ChanServ dialects; Anope overrides `canAkick` to superop.
 */
export abstract class ChanServBackendBase implements ProtectionBackend {
  abstract readonly name: string;
  // Priority 2 sits behind a future Botnet backend (priority 1, in-bot
  // protection that can act without round-tripping through services) but
  // ahead of any operator-driven manual fallback. ProtectionChain sorts
  // ascending — see protection-backend.ts.
  readonly priority = 2;

  protected readonly accessLevels = new Map<string, BackendAccess>();
  protected readonly autoDetectedChannels = new Set<string>();

  constructor(
    protected readonly api: PluginAPI,
    protected readonly chanservNick: string,
  ) {}

  // ---------------------------------------------------------------------------
  // Access management
  // ---------------------------------------------------------------------------

  getAccess(channel: string): BackendAccess {
    return this.accessLevels.get(this.api.ircLower(channel)) ?? 'none';
  }

  setAccess(channel: string, level: BackendAccess): void {
    const key = this.api.ircLower(channel);
    const prev = this.accessLevels.get(key);
    this.accessLevels.set(key, level);
    // Clear auto-detected flag only when the value actually changes; the
    // onChange round-trip from syncAccessToSettings writes the same value
    // back and we need to preserve the flag across that no-op write.
    if (this.autoDetectedChannels.has(key) && level !== prev) {
      this.autoDetectedChannels.delete(key);
    }
  }

  isAutoDetected(channel: string): boolean {
    return this.autoDetectedChannels.has(this.api.ircLower(channel));
  }

  // ---------------------------------------------------------------------------
  // Capability queries — Atheme-flavored defaults; Anope overrides canAkick.
  // ---------------------------------------------------------------------------

  canOp(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canDeop(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'superop');
  }

  canUnban(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canInvite(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canRecover(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'founder');
  }

  canClearBans(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'founder');
  }

  canRemoveKey(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  canAkick(channel: string): boolean {
    return accessAtLeast(this.getAccess(channel), 'op');
  }

  // ---------------------------------------------------------------------------
  // Action requests — common ChanServ forms; subclasses override where syntax
  // diverges (RECOVER, CLEAR, key removal, AKICK enforcement).
  // ---------------------------------------------------------------------------

  requestOp(channel: string, nick?: string): void {
    const target = nick ?? getBotNick(this.api);
    this.sendChanServ(`OP ${channel} ${target}`);
  }

  requestDeop(channel: string, nick: string): void {
    this.sendChanServ(`DEOP ${channel} ${nick}`);
  }

  requestUnban(channel: string): void {
    this.sendChanServ(`UNBAN ${channel}`);
  }

  requestInvite(channel: string): void {
    this.sendChanServ(`INVITE ${channel}`);
  }

  requestAkick(channel: string, mask: string, reason?: string): void {
    // Defense-in-depth shape guards for AKICK interpolation. Current
    // callers pass hard-coded reasons and masks built by `buildBanMask()`
    // (which validates shape), so these checks are belt-and-braces for
    // a future caller that wires user input through.
    if (/\s/.test(mask)) {
      this.api.warn(`AKICK mask "${mask}" contains whitespace — refusing to send`);
      return;
    }
    // 100-char reason cap — every major IRCd truncates AKICK reasons well
    // below this; the slice prevents a runaway reason from pushing the
    // command past the 510-byte server limit.
    const safeReason = reason ? reason.slice(0, 100) : undefined;
    const cmd = safeReason
      ? `AKICK ${channel} ADD ${mask} ${safeReason}`
      : `AKICK ${channel} ADD ${mask}`;
    this.sendChanServ(cmd);
  }

  abstract requestRecover(channel: string): void;
  abstract requestClearBans(channel: string): void;
  abstract requestRemoveKey(channel: string): void;
  abstract verifyAccess(channel: string): void;

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  protected sendChanServ(command: string): void {
    this.api.say(this.chanservNick, command);
  }
}
