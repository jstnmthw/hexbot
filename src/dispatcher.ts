// HexBot — Event dispatcher
// Routes IRC events to registered handlers based on bind type, mask, and flags.
import {
  type FloodCheckResult,
  FloodLimiter,
  type FloodNoticeProvider,
} from './core/flood-limiter';
import type { LoggerLike } from './logger';
import type { BindHandler, BindType, FloodConfig, HandlerContext } from './types';
import { type Casemapping, caseCompare, wildcardMatch } from './utils/wildcard';

// Re-export so existing `import { FloodNoticeProvider, FloodCheckResult } from './dispatcher'`
// call sites keep working after the flood state moved to `core/flood-limiter.ts`.
export type { FloodCheckResult, FloodNoticeProvider };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A registered bind entry. */
export interface BindEntry {
  type: BindType;
  flags: string;
  mask: string;
  handler: BindHandler;
  pluginId: string;
  /** Dispatch count (or timer fires for `time` binds). Surfaced via `.binds`. */
  hits: number;
  /**
   * Consecutive timer-handler errors. Only used on `time` binds.
   * After {@link TIMER_FAILURE_THRESHOLD} consecutive throws, the
   * dispatcher auto-disables the interval so a broken plugin can't
   * produce unbounded log spam. See stability audit 2026-04-14.
   */
  consecutiveFailures?: number;
}

/** Auto-disable a `time` bind after this many consecutive errors. */
const TIMER_FAILURE_THRESHOLD = 10;

/** Minimal bind management interface for consumers that only register/remove binds. */
export interface BindRegistrar {
  bind(type: BindType, flags: string, mask: string, handler: BindHandler, pluginId: string): void;
  unbind(type: BindType, mask: string, handler: BindHandler): void;
  unbindAll(pluginId: string): void;
}

/** Optional permissions interface — if provided, used for flag checking. */
export interface PermissionsProvider {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/**
 * Optional verification provider — gates privileged handlers on NickServ identity.
 * Enforces the `config.identity.require_acc_for` policy at dispatch time so that
 * plugin authors cannot accidentally ship the ACC race condition by omitting a
 * `verifyUser()` call.
 */
export interface VerificationProvider {
  /** True if the bind's required flags are at or above the `require_acc_for` threshold. */
  requiresVerificationForFlags(flags: string): boolean;
  /**
   * Returns the known services account for a nick from the live account map
   * (populated via IRCv3 account-notify / extended-join).
   * - `string`    — nick is identified as this account
   * - `null`      — nick is known NOT to be identified
   * - `undefined` — no account data received yet; caller should fall back to NickServ query
   */
  getAccountForNick(nick: string): string | null | undefined;
  /** Verify a user's identity via NickServ ACC/STATUS (async fallback). */
  verifyUser(nick: string): Promise<{ verified: boolean; account: string | null }>;
}

/** Filter for listBinds(). */
export interface BindFilter {
  type?: BindType;
  pluginId?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Types where only one handler per mask is kept (last one wins). */
const NON_STACKABLE_TYPES: ReadonlySet<BindType> = new Set(['pub', 'msg']);

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

export class EventDispatcher {
  private binds: BindEntry[] = [];
  private timers: Map<BindEntry, ReturnType<typeof setInterval>> = new Map();
  private permissions: PermissionsProvider | null;
  private verification: VerificationProvider | null = null;
  private logger: LoggerLike | null;
  private casemapping: Casemapping = 'rfc1459';
  /**
   * Per-user input flood limiter. Owned by the dispatcher because flood
   * gating sits directly in front of `dispatch()` in the bridge's hot path,
   * but the state and sweep logic live in `FloodLimiter` so this class
   * stays focused on bind routing.
   */
  private floodLimiter: FloodLimiter;

  constructor(permissions?: PermissionsProvider | null, logger?: LoggerLike | null) {
    this.permissions = permissions ?? null;
    this.logger = logger?.child('dispatcher') ?? null;
    this.floodLimiter = new FloodLimiter(this.permissions, this.logger);
  }

  /** Wire in the verification provider (called after services + channel-state are available). */
  setVerification(provider: VerificationProvider): void {
    this.verification = provider;
  }

  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Wire in the flood notice provider (injected by Bot to avoid a direct IRC client dep). */
  setFloodNotice(provider: FloodNoticeProvider): void {
    this.floodLimiter.setNoticeProvider(provider);
  }

  /**
   * Drop all per-key rate-limit state. Called on `bot:disconnected` so a
   * user whose old-session key was flagged isn't instantly rate-limited
   * on their first message after reconnect. See stability audit
   * 2026-04-14.
   */
  clearFloodState(): void {
    this.floodLimiter.reset();
  }

  /**
   * Configure input flood limiting. Call with the `flood` section of bot.json.
   * If not called, flood limiting is disabled.
   */
  setFloodConfig(config: FloodConfig): void {
    this.floodLimiter.setConfig(config);
  }

  /**
   * Gate check for per-user input flood limiting.
   *
   * Call this **once per IRC message** in the bridge before the paired dispatch calls
   * (pub+pubm for channel messages, msg+msgm for private messages). If `blocked` is
   * true, skip both dispatch calls.
   *
   * - `pub` covers channel PRIVMSG (pub + pubm binds share one counter)
   * - `msg` covers private PRIVMSG (msg + msgm binds share one counter)
   * - Users with the `n` (owner) flag bypass flood protection entirely
   * - On the first blocked message per window, `firstBlock` is true — the caller
   *   should send a one-time NOTICE warning (this method handles it automatically
   *   when a `FloodNoticeProvider` is attached)
   */
  floodCheck(floodType: 'pub' | 'msg', key: string, ctx: HandlerContext): FloodCheckResult {
    return this.floodLimiter.check(floodType, key, ctx);
  }

  /**
   * Register a handler for an event type.
   * Non-stackable types (pub, msg) overwrite any existing bind on the same mask.
   */
  bind(type: BindType, flags: string, mask: string, handler: BindHandler, pluginId: string): void {
    // Timer binds are fired directly from `setInterval` and never run
    // through the dispatch path, so any flags the caller supplies are
    // silently ignored. Reject non-'-' flags at bind time so plugin
    // authors can't be misled into thinking their `+m` timer is
    // permission-gated.
    if (type === 'time' && flags !== '-' && flags !== '') {
      this.logger?.warn(
        `Timer bind "${mask}s" from "${pluginId}" has flags="${flags}" — timer binds ignore flags; use "-"`,
      );
    }

    const entry: BindEntry = { type, flags, mask, handler, pluginId, hits: 0 };

    // Non-stackable: remove any existing bind on the same type + mask
    if (NON_STACKABLE_TYPES.has(type)) {
      this.binds = this.binds.filter(
        (b) => !(b.type === type && caseCompare(b.mask, mask, this.casemapping)),
      );
    }

    this.binds.push(entry);

    // Timer binds: set up an interval
    if (type === 'time') {
      // Floor at 10s — anything tighter is almost certainly a plugin bug
      // (the IRC-bot timer use case is "every minute / hour / day", never
      // sub-second) and would burn CPU and queue capacity for no benefit.
      // We raise rather than reject so the bind still functions.
      const MIN_TIMER_MS = 10_000;
      const rawMs = parseInt(mask, 10) * 1000;
      if (!Number.isFinite(rawMs) || rawMs <= 0) {
        this.logger?.error(`Invalid time bind mask: "${mask}" — must be seconds as a string`);
        return;
      }
      const intervalMs = Math.max(rawMs, MIN_TIMER_MS);
      if (rawMs < MIN_TIMER_MS) {
        this.logger?.warn(`Timer interval "${mask}s" raised to 10s minimum`);
      }
      const onTimerFailure = (err: unknown): void => {
        entry.consecutiveFailures = (entry.consecutiveFailures ?? 0) + 1;
        this.logger?.error(
          `Timer handler error (${pluginId}, ${entry.consecutiveFailures}/${TIMER_FAILURE_THRESHOLD}):`,
          err,
        );
        if (entry.consecutiveFailures >= TIMER_FAILURE_THRESHOLD) {
          this.logger?.error(
            `Timer bind "${mask}s" for ${pluginId} auto-disabled after ${TIMER_FAILURE_THRESHOLD} consecutive failures. Reload the plugin to reset.`,
          );
          this.clearTimer(entry);
        }
      };
      const onTimerSuccess = (): void => {
        entry.consecutiveFailures = 0;
      };
      const timer = setInterval(() => {
        entry.hits++;
        const timerCtx: HandlerContext = {
          nick: '',
          ident: '',
          hostname: '',
          channel: null,
          text: '',
          command: '',
          args: '',
          reply: () => {},
          replyPrivate: () => {},
        };
        try {
          const result = handler(timerCtx);
          if (result instanceof Promise) {
            result.then(onTimerSuccess, onTimerFailure);
          } else {
            onTimerSuccess();
          }
        } catch (err) {
          onTimerFailure(err);
        }
      }, intervalMs);
      this.timers.set(entry, timer);
    }
  }

  /** Remove a specific handler. */
  unbind(type: BindType, mask: string, handler: BindHandler): void {
    const idx = this.binds.findIndex(
      (b) => b.type === type && b.mask === mask && b.handler === handler,
    );
    if (idx !== -1) {
      const entry = this.binds[idx];
      this.clearTimer(entry);
      this.binds.splice(idx, 1);
    }
  }

  /** Remove all binds for a plugin (used on unload). */
  unbindAll(pluginId: string): void {
    const remaining: BindEntry[] = [];
    for (const entry of this.binds) {
      if (entry.pluginId === pluginId) {
        this.clearTimer(entry);
      } else {
        remaining.push(entry);
      }
    }
    this.binds = remaining;
  }

  /**
   * Dispatch an event to all matching handlers.
   * Flag checking happens before calling the handler.
   * When a VerificationProvider is attached, privileged handlers are additionally
   * gated on NickServ identity — enforcing the require_acc_for policy automatically.
   * Handler errors are caught — one bad handler won't crash others.
   */
  async dispatch(type: BindType, ctx: HandlerContext): Promise<void> {
    for (const entry of this.binds) {
      if (entry.type !== type) continue;
      if (!this.matchesMask(type, entry.mask, ctx)) continue;
      // Ordering invariant: flag check FIRST, verification gate SECOND,
      // handler call THIRD. Reordering (or slipping a handler invocation
      // between the two checks) would either let an unprivileged user
      // bypass flags via a lost-race short-circuit, or send an ACC
      // round-trip on every anyone-allowed bind. Leave this sequence
      // alone unless a test pins the new ordering. See audit 2026-04-19.
      if (!this.checkFlags(entry.flags, ctx)) {
        this.logger?.debug(
          `flag denied: ${ctx.nick}!${ctx.ident}@${ctx.hostname} → ${type}:${entry.mask} (requires ${entry.flags}, plugin=${entry.pluginId})`,
        );
        continue;
      }

      // ACC verification gate — enforces require_acc_for without plugin authors needing
      // to remember to call verifyUser() themselves.
      if (this.verification && !(await this.checkVerification(entry.flags, ctx))) {
        this.logger?.warn(
          `ACC verification failed for ${ctx.nick} (${entry.pluginId}, ${type}:${entry.mask})`,
        );
        continue;
      }

      entry.hits++;
      try {
        const result = entry.handler(ctx);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        this.logger?.error(`Handler error (${entry.pluginId}, ${type}:${entry.mask}):`, err);
      }
    }
  }

  /**
   * Check ACC verification for the given bind flags and context nick.
   * Returns true (allow) if verification is not required for these flags,
   * or if the user is already known to be identified (from account-notify/extended-join),
   * or if NickServ ACC confirms identity. Returns false (deny) if verification
   * is required and the user is not identified or the query timed out.
   */
  private async checkVerification(flags: string, ctx: HandlerContext): Promise<boolean> {
    const verification = this.verification;
    if (verification === null) return true;
    if (!verification.requiresVerificationForFlags(flags)) return true;

    // Fast path: check the live account map populated by account-notify / extended-join
    const known = verification.getAccountForNick(ctx.nick);
    if (known !== undefined) {
      // We have definitive information — no NickServ round-trip needed
      return known !== null; // null = known not identified
    }

    // Slow path: fall back to NickServ ACC query (pre-IRCv3 or if account data not yet received)
    const result = await verification.verifyUser(ctx.nick);
    return result.verified;
  }

  /** List registered binds, optionally filtered. */
  listBinds(filter?: BindFilter): BindEntry[] {
    let result = this.binds;
    if (filter?.type) {
      result = result.filter((b) => b.type === filter.type);
    }
    if (filter?.pluginId) {
      result = result.filter((b) => b.pluginId === filter.pluginId);
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Internal: mask matching
  // -------------------------------------------------------------------------

  private matchesMask(type: BindType, mask: string, ctx: HandlerContext): boolean {
    const cm = this.casemapping;
    switch (type) {
      case 'pub':
      case 'msg':
        // Exact command match (IRC case-insensitive)
        return caseCompare(ctx.command, mask, cm);

      case 'pubm':
      case 'msgm':
        // Wildcard match against full text
        return wildcardMatch(mask, ctx.text, true, cm);

      case 'join':
      case 'part':
      case 'kick':
      case 'invite':
        // Mask format: "#channel nick!user@host" or "*" for all
        if (mask === '*') return true;
        return wildcardMatch(
          mask,
          `${ctx.channel} ${ctx.nick}!${ctx.ident}@${ctx.hostname}`,
          true,
          cm,
        );

      case 'nick':
        // Wildcard against the nick
        return wildcardMatch(mask, ctx.nick, true, cm);

      case 'mode':
        // Mask format: "#channel +/-mode" or wildcard
        if (mask === '*') return true;
        return wildcardMatch(mask, ctx.text, true, cm);

      case 'raw':
        // Match against the command/numeric
        return wildcardMatch(mask, ctx.command, true, cm);

      case 'notice':
        // Wildcard on text
        return wildcardMatch(mask, ctx.text, true, cm);

      case 'ctcp':
        // Match CTCP type (IRC case-insensitive)
        return caseCompare(ctx.command, mask, cm);

      case 'topic':
        // Mask is a wildcard on channel name, or '*' for all
        if (mask === '*') return true;
        return wildcardMatch(mask, ctx.channel ?? '', true, cm);

      case 'quit':
        // Mask is a wildcard on nick!ident@host, or '*' for all
        if (mask === '*') return true;
        return wildcardMatch(mask, `${ctx.nick}!${ctx.ident}@${ctx.hostname}`, true, cm);

      case 'join_error':
        // Mask matches against the error reason (e.g. 'banned_from_channel'), '*' for all
        if (mask === '*') return true;
        return wildcardMatch(mask, ctx.command, true, cm);

      case 'time':
        // Timer binds are handled by setInterval, not by dispatch
        return false;

      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: flag checking
  // -------------------------------------------------------------------------

  private checkFlags(requiredFlags: string, ctx: HandlerContext): boolean {
    // No flags required — anyone can trigger
    if (requiredFlags === '-' || requiredFlags === '') return true;

    // If no permissions system is attached, allow everything
    if (!this.permissions) return true;

    return this.permissions.checkFlags(requiredFlags, ctx);
  }

  // -------------------------------------------------------------------------
  // Internal: timer cleanup
  // -------------------------------------------------------------------------

  private clearTimer(entry: BindEntry): void {
    const timer = this.timers.get(entry);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(entry);
    }
  }
}
