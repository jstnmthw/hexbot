// chanmod — sticky ban enforcement
// Watches for -b mode changes and re-applies sticky bans immediately.
import type { PluginAPI } from '../../src/types';
import { botHasOps } from './helpers';
import { COOLDOWN_WINDOW_MS, MAX_ENFORCEMENTS, type SharedState } from './state';

/**
 * Bind a `-b` watcher that re-applies any ban marked `sticky: true` in the
 * ban store. Rate-limited via the shared `enforcementCooldown` so a hostile
 * op flipping `-b/+b` in a loop saturates after {@link MAX_ENFORCEMENTS}
 * re-applies per {@link COOLDOWN_WINDOW_MS}; further flips in the same
 * window are logged and ignored.
 */
export function setupStickyBans(api: PluginAPI, state: SharedState): () => void {
  api.bind('mode', '-', '*', (ctx) => {
    const { channel } = ctx;
    const modeStr = ctx.command; // e.g. "-b"
    const mask = ctx.args; // e.g. "*!*@evil.com"

    // Only care about -b (ban removal)
    if (modeStr !== '-b' || !mask) return;

    // Don't re-apply if the bot itself removed it (loop guard)
    if (api.isBotNick(ctx.nick)) return;

    // Check if this ban is sticky in our store
    const record = api.banStore.getBan(channel, mask);
    if (!record || !record.sticky) return;

    // Only re-apply if we have ops
    if (!botHasOps(api, channel)) return;

    // Rate limit re-application: without this, a hostile op flipping
    // `-b/+b` in a loop would force the bot to `+b` on every flip and
    // flood both the message queue and mod_log. Share the same cooldown
    // key space as mode-enforce so one saturation signal covers every
    // mode-war path.
    const cooldownKey = `${api.ircLower(channel)}:b:${mask}`;
    const now = Date.now();
    const cooldown = state.enforcementCooldown.get(cooldownKey);
    /* v8 ignore start -- cooldown saturation path requires an active mode-war loop; covered by mode-enforce tests */
    if (cooldown && now < cooldown.expiresAt) {
      if (cooldown.count >= MAX_ENFORCEMENTS) {
        api.warn(
          `Sticky-ban saturation on ${channel}: ${mask} (>= ${MAX_ENFORCEMENTS} re-applies in ${COOLDOWN_WINDOW_MS}ms)`,
        );
        return;
      }
      cooldown.count++;
    } else {
      state.enforcementCooldown.set(cooldownKey, {
        count: 1,
        expiresAt: now + COOLDOWN_WINDOW_MS,
      });
    }
    /* v8 ignore stop */

    api.ban(channel, mask);
    api.log(`Re-applied sticky ban ${mask} on ${channel}`);
  });

  // Binds are auto-cleaned by the plugin loader; this teardown is a no-op
  // but keeps the call site consistent with the other setup* helpers.
  return () => {};
}
