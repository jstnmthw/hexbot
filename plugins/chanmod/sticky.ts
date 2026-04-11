// chanmod — sticky ban enforcement
// Watches for -b mode changes and re-applies sticky bans immediately.
import type { PluginAPI } from '../../src/types';
import { botHasOps } from './helpers';

export function setupStickyBans(api: PluginAPI): void {
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

    api.ban(channel, mask);
    api.log(`Re-applied sticky ban ${mask} on ${channel}`);
  });
}
