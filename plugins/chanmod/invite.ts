// chanmod — invite handling: accept invites from flagged users
import type { PluginAPI } from '../../src/types';
import { hasAnyFlag } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

/**
 * Register the INVITE bind. When `invite` is enabled per-channel, accept
 * IRC INVITEs from identified users with the `n`/`m`/`o` flag and auto-join
 * the invited channel. The dispatcher flag mask (`+n|+m|+o`) is load-bearing
 * here — it gates on NickServ-verified identity before the handler runs so
 * an attacker who races an admin's nick cannot trick the bot into joining.
 */
export function setupInvite(
  api: PluginAPI,
  _config: ChanmodConfig,
  _state: SharedState,
): () => void {
  // Bind with an op-trust flag set so the dispatcher's VerificationProvider
  // gate fires on invite — an attacker who races an admin's nick before
  // NickServ identifies can no longer `/invite` the bot into arbitrary
  // channels. The handler still runs the per-channel flag check below;
  // the bind flag only guarantees the inviter's identity is verified
  // before we reach the body.
  api.bind('invite', '+n|+m|+o', '*', (ctx) => {
    const { channel } = ctx;

    const enabled = api.channelSettings.getFlag(channel, 'invite');
    if (!enabled) return;

    // Use the hostmask from the INVITE message directly — the IRC protocol
    // includes nick!ident@host so no channel state lookup is needed.
    const fullHostmask = api.buildHostmask(ctx);
    const user = api.permissions.findByHostmask(fullHostmask, ctx.account);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[api.ircLower(channel)] ?? '';
    const flags = globalFlags + channelFlags;

    // Accept from global owner/master or channel op
    if (!hasAnyFlag(flags, ['n', 'm', 'o'])) return;

    // Skip if already in channel
    if (api.getChannel(channel)) return;

    api.join(channel);
    api.log(`INVITE from ${ctx.nick}: joining ${channel}`);
  });

  return () => {};
}
