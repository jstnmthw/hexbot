// n0xb0t — Eggdrop-style event dispatcher
// Routes IRC events to registered handlers based on bind type, mask, and flags.

import { wildcardMatch } from './utils/wildcard.js';
import type { BindType, BindHandler, HandlerContext } from './types.js';

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
}

/** Optional permissions interface — if provided, used for flag checking. */
export interface PermissionsProvider {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
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
const NON_STACKABLE_TYPES: ReadonlySet<BindType> = new Set([
  'pub', 'msg',
]);

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

export class EventDispatcher {
  private binds: BindEntry[] = [];
  private timers: Map<BindEntry, ReturnType<typeof setInterval>> = new Map();
  private permissions: PermissionsProvider | null;

  constructor(permissions?: PermissionsProvider | null) {
    this.permissions = permissions ?? null;
  }

  /**
   * Register a handler for an event type.
   * Non-stackable types (pub, msg) overwrite any existing bind on the same mask.
   */
  bind(
    type: BindType,
    flags: string,
    mask: string,
    handler: BindHandler,
    pluginId: string
  ): void {
    const entry: BindEntry = { type, flags, mask, handler, pluginId, hits: 0 };

    // Non-stackable: remove any existing bind on the same type + mask
    if (NON_STACKABLE_TYPES.has(type)) {
      this.binds = this.binds.filter(
        (b) => !(b.type === type && b.mask.toLowerCase() === mask.toLowerCase())
      );
    }

    this.binds.push(entry);

    // Timer binds: set up an interval
    if (type === 'time') {
      const intervalMs = parseInt(mask, 10) * 1000;
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        console.error(`[dispatcher] Invalid time bind mask: "${mask}" — must be seconds as a string`);
        return;
      }
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
            result.catch((err) => {
              console.error(`[dispatcher] Timer handler error (${pluginId}):`, err);
            });
          }
        } catch (err) {
          console.error(`[dispatcher] Timer handler error (${pluginId}):`, err);
        }
      }, intervalMs);
      this.timers.set(entry, timer);
    }
  }

  /** Remove a specific handler. */
  unbind(type: BindType, mask: string, handler: BindHandler): void {
    const idx = this.binds.findIndex(
      (b) => b.type === type && b.mask === mask && b.handler === handler
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
   * Handler errors are caught — one bad handler won't crash others.
   */
  async dispatch(type: BindType, ctx: HandlerContext): Promise<void> {
    for (const entry of this.binds) {
      if (entry.type !== type) continue;
      if (!this.matchesMask(type, entry.mask, ctx)) continue;
      if (!this.checkFlags(entry.flags, ctx)) continue;

      entry.hits++;
      try {
        const result = entry.handler(ctx);
        if (result instanceof Promise) {
          await result;
        }
      } catch (err) {
        console.error(`[dispatcher] Handler error (${entry.pluginId}, ${type}:${entry.mask}):`, err);
      }
    }
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
    switch (type) {
      case 'pub':
      case 'msg':
        // Exact command match (case-insensitive)
        return ctx.command.toLowerCase() === mask.toLowerCase();

      case 'pubm':
      case 'msgm':
        // Wildcard match against full text
        return wildcardMatch(mask, ctx.text, true);

      case 'join':
      case 'part':
      case 'kick':
        // Mask format: "#channel nick!user@host" or "*" for all
        if (mask === '*') return true;
        return wildcardMatch(mask, `${ctx.channel} ${ctx.nick}!${ctx.ident}@${ctx.hostname}`, true);

      case 'nick':
        // Wildcard against the nick
        return wildcardMatch(mask, ctx.nick, true);

      case 'mode':
        // Mask format: "#channel +/-mode" or wildcard
        if (mask === '*') return true;
        return wildcardMatch(mask, ctx.text, true);

      case 'raw':
        // Match against the command/numeric
        return wildcardMatch(mask, ctx.command, true);

      case 'notice':
        // Wildcard on text
        return wildcardMatch(mask, ctx.text, true);

      case 'ctcp':
        // Match CTCP type
        return ctx.command.toLowerCase() === mask.toLowerCase();

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
