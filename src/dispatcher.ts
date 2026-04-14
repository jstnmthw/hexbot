// HexBot — Event dispatcher
// Routes IRC events to registered handlers based on bind type, mask, and flags.
import type { LoggerLike } from './logger';
import type {
  BindHandler,
  BindType,
  FloodConfig,
  FloodWindowConfig,
  HandlerContext,
} from './types';
import { SlidingWindowCounter } from './utils/sliding-window';
import { type Casemapping, caseCompare, wildcardMatch } from './utils/wildcard';

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

/**
 * Narrow interface for sending flood-warning NOTICEs.
 * Injected by the bot to avoid a direct dep on the IRC client.
 */
export interface FloodNoticeProvider {
  sendNotice(nick: string, message: string): void;
}

/** Result from floodCheck(). */
export interface FloodCheckResult {
  /** True if the user is currently rate-limited and this message should be dropped. */
  blocked: boolean;
  /**
   * True only on the first blocked message per window — the caller should
   * send a one-time warning notice if this is true.
   * Always false when blocked is false.
   */
  firstBlock: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Types where only one handler per mask is kept (last one wins). */
const NON_STACKABLE_TYPES: ReadonlySet<BindType> = new Set(['pub', 'msg']);

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

const FLOOD_DEFAULTS: Required<FloodWindowConfig> = { count: 5, window: 10 };

export class EventDispatcher {
  private binds: BindEntry[] = [];
  private timers: Map<BindEntry, ReturnType<typeof setInterval>> = new Map();
  private permissions: PermissionsProvider | null;
  private verification: VerificationProvider | null = null;
  private logger: LoggerLike | null;
  private casemapping: Casemapping = 'rfc1459';

  private floodNotice: FloodNoticeProvider | null = null;
  private floodConfig: {
    pub: Required<FloodWindowConfig>;
    msg: Required<FloodWindowConfig>;
  } | null = null;
  private pubFlood = new SlidingWindowCounter();
  private msgFlood = new SlidingWindowCounter();
  /** Tracks which hostmask keys have already received the one-time flood warning this window. */
  private floodWarned = new Set<string>();
  private lastFloodSweep = 0;

  constructor(permissions?: PermissionsProvider | null, logger?: LoggerLike | null) {
    this.permissions = permissions ?? null;
    this.logger = logger?.child('dispatcher') ?? null;
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
    this.floodNotice = provider;
  }

  /**
   * Drop all per-key rate-limit state. Called on `bot:disconnected` so a
   * user whose old-session key was flagged isn't instantly rate-limited
   * on their first message after reconnect. See stability audit
   * 2026-04-14.
   */
  clearFloodState(): void {
    this.pubFlood.reset();
    this.msgFlood.reset();
    this.floodWarned.clear();
  }

  /**
   * Configure input flood limiting. Call with the `flood` section of bot.json.
   * If not called, flood limiting is disabled.
   */
  setFloodConfig(config: FloodConfig): void {
    this.floodConfig = {
      pub: { ...FLOOD_DEFAULTS, ...config.pub },
      msg: { ...FLOOD_DEFAULTS, ...config.msg },
    };
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
    this._maybeSweep();

    if (!this.floodConfig) return { blocked: false, firstBlock: false };

    // Owner bypass — n-flagged users are never flood-limited
    if (this.permissions?.checkFlags('n', ctx)) return { blocked: false, firstBlock: false };

    const cfg = this.floodConfig[floodType];
    const counter = floodType === 'pub' ? this.pubFlood : this.msgFlood;
    const windowMs = cfg.window * 1000;

    const exceeded = counter.check(key, windowMs, cfg.count);

    if (!exceeded) {
      // Window has room — clear any stale warned state so next flood gets a fresh notice
      this.floodWarned.delete(key);
      return { blocked: false, firstBlock: false };
    }

    // User is flooding
    if (!this.floodWarned.has(key)) {
      this.floodWarned.add(key);
      this.floodNotice?.sendNotice(
        ctx.nick,
        'You are sending commands too quickly. Please slow down.',
      );
      this.logger?.warn(`[dispatcher] flood: ${key} (${floodType}) — blocked`);
      return { blocked: true, firstBlock: true };
    }

    return { blocked: true, firstBlock: false };
  }

  /**
   * Prune stale keys from the flood counters and clear the one-time warning
   * set every 5 minutes. Cheap when invoked from the hot path because we
   * short-circuit on the timestamp check; extracted from `floodCheck` so the
   * caller reads top-to-bottom without a mid-function maintenance block.
   */
  private _maybeSweep(): void {
    const now = Date.now();
    if (now - this.lastFloodSweep <= 300_000) return;
    this.lastFloodSweep = now;
    if (this.floodConfig) {
      this.pubFlood.sweep(this.floodConfig.pub.window * 1000);
      this.msgFlood.sweep(this.floodConfig.msg.window * 1000);
    }
    this.floodWarned.clear();
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
