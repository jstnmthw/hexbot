// chanmod — invite handling: accept invites from flagged users
import type { PluginAPI } from '../../src/types';
import { hasAnyFlag } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

export function setupInvite(
  api: PluginAPI,
  _config: ChanmodConfig,
  _state: SharedState,
): () => void {
  api.bind('invite', '-', '*', (ctx) => {
    const { channel } = ctx;

    const enabled = api.channelSettings.getFlag(channel, 'invite');
    if (!enabled) return;

    // Use the hostmask from the INVITE message directly — the IRC protocol
    // includes nick!ident@host so no channel state lookup is needed.
    const fullHostmask = api.buildHostmask(ctx);
    const user = api.permissions.findByHostmask(fullHostmask);
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
