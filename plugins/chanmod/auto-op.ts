// chanmod — auto-op/halfop/voice on join, with optional NickServ verification
import type { HandlerContext, PluginAPI } from '../../src/types';
import { botCanHalfop, botHasOps, hasAnyFlag, isBotNick } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

export function setupAutoOp(
  api: PluginAPI,
  config: ChanmodConfig,
  _state: SharedState,
): () => void {
  api.bind('join', '-', '*', async (ctx: HandlerContext) => {
    const { nick } = ctx;
    const channel = ctx.channel!;

    // Bot joined — request current channel modes from the server.
    // The MODE reply triggers channel:modesReady, which chains to syncChannelModes
    // (set up in setupModeEnforce). This guarantees channel state is populated before sync.
    if (isBotNick(api, nick)) {
      api.requestChannelModes(channel);
      return;
    }

    const autoOp = api.channelSettings.get(channel, 'auto_op') as boolean;
    if (!autoOp) return;

    const { ident, hostname } = ctx;
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[api.ircLower(channel)] ?? '';
    const allFlags = globalFlags + channelFlags;

    const shouldOp = hasAnyFlag(allFlags, config.op_flags);
    const shouldHalfop =
      !shouldOp && config.halfop_flags.length > 0 && hasAnyFlag(allFlags, config.halfop_flags);
    const shouldVoice = !shouldOp && !shouldHalfop && hasAnyFlag(allFlags, config.voice_flags);

    if (!shouldOp && !shouldHalfop && !shouldVoice) return;

    // NickServ verification if required
    const requireAccFor = api.botConfig.identity.require_acc_for;
    const flagToApply = shouldOp ? '+o' : shouldHalfop ? '+h' : '+v';
    const needsVerification = requireAccFor.includes(flagToApply) && api.services.isAvailable();

    if (needsVerification) {
      api.log(`Verifying ${nick} via NickServ before applying ${flagToApply} in ${channel}`);
      const result = await api.services.verifyUser(nick);
      if (!result.verified) {
        api.log(`Verification failed for ${nick} in ${channel} — not applying ${flagToApply}`);
        if (config.notify_on_fail) {
          api.notice(nick, 'Auto-op: NickServ verification failed. Please identify and rejoin.');
        }
        return;
      }
      api.log(
        `Verified ${nick} (account: ${result.account}) — applying ${flagToApply} in ${channel}`,
      );
    }

    if (shouldOp) {
      if (!botHasOps(api, channel)) {
        api.log(`Cannot auto-op ${nick} in ${channel} — I am not opped`);
        return;
      }
      api.op(channel, nick);
      api.log(`Auto-opped ${nick} in ${channel}`);
    } else if (shouldHalfop) {
      if (!botCanHalfop(api, channel)) {
        api.log(`Cannot auto-halfop ${nick} in ${channel} — I do not have +h or +o`);
        return;
      }
      api.halfop(channel, nick);
      api.log(`Auto-halfopped ${nick} in ${channel}`);
    } else {
      // shouldVoice is always true here — the guard above returned early if all three were false
      if (!botHasOps(api, channel)) {
        api.log(`Cannot auto-voice ${nick} in ${channel} — I am not opped`);
        return;
      }
      api.voice(channel, nick);
      api.log(`Auto-voiced ${nick} in ${channel}`);
    }
  });

  return () => {};
}
