// chanmod — auto-op/halfop/voice on join, with optional NickServ verification
import type { HandlerContext, PluginAPI } from '../../src/types';
import type { ProbeState } from './chanserv-notice';
import { markProbePending } from './chanserv-notice';
import { botCanHalfop, botHasOps, hasAnyFlag, isBotNick } from './helpers';
import type { BackendAccess } from './protection-backend';
import type { ProtectionChain } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

export function setupAutoOp(
  api: PluginAPI,
  config: ChanmodConfig,
  _state: SharedState,
  chain?: ProtectionChain,
  probeState?: ProbeState,
): () => void {
  api.bind('join', '-', '*', async (ctx: HandlerContext) => {
    const { nick } = ctx;
    const channel = ctx.channel!;

    // Bot joined — request current channel modes from the server.
    // The MODE reply triggers channel:modesReady, which chains to syncChannelModes
    // (set up in setupModeEnforce). This guarantees channel state is populated before sync.
    if (isBotNick(api, nick)) {
      api.requestChannelModes(channel);

      // Set and verify ChanServ access level for the protection chain
      if (chain) {
        const accessStr = api.channelSettings.getString(channel, 'chanserv_access');
        const validLevels = new Set(['none', 'op', 'superop', 'founder']);
        const access: BackendAccess = validLevels.has(accessStr)
          ? (accessStr as BackendAccess)
          : 'none';
        if (access !== 'none') {
          for (const b of chain.getBackends()) {
            b.setAccess(channel, access);
          }
        }
        if (probeState) {
          markProbePending(api, probeState, channel, config.chanserv_services_type);
        }
        chain.verifyAccess(channel);
      }

      // Warn when takeover detection is on but no ChanServ access after probe completes.
      // Deferred: wait for the probe to finish (or timeout) before warning.
      const takeoverOn = api.channelSettings.getFlag(channel, 'takeover_detection');
      const accessExplicit = api.channelSettings.isSet(channel, 'chanserv_access');
      if (takeoverOn && !accessExplicit) {
        // Check after 5s — by then the probe should have completed or timed out
        _state.scheduleCycle(5000, () => {
          const access = chain?.getAccess(channel) ?? 'none';
          if (access === 'none') {
            api.warn(
              `Takeover detection enabled for ${channel} but chanserv_access is 'none' — bot cannot self-recover. Set via: .chanset ${channel} chanserv_access op`,
            );
          }
        });
      }
      return;
    }

    const autoOp = api.channelSettings.getFlag(channel, 'auto_op');
    if (!autoOp) return;

    const { ident, hostname } = ctx;
    const fullHostmask = `${nick}!${ident}@${hostname}`;
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[api.ircLower(channel)] ?? '';
    const allFlags = globalFlags + channelFlags;

    // 'd' (deop) flag suppresses auto-op and auto-halfop.
    // Voice still works but requires an explicit voice flag (n does not imply v).
    const deop = allFlags.includes('d');
    const shouldOp = !deop && hasAnyFlag(allFlags, config.op_flags);
    const shouldHalfop =
      !shouldOp &&
      !deop &&
      config.halfop_flags.length > 0 &&
      hasAnyFlag(allFlags, config.halfop_flags);
    const shouldVoice =
      !shouldOp &&
      !shouldHalfop &&
      (deop
        ? config.voice_flags.some((f) => allFlags.includes(f))
        : hasAnyFlag(allFlags, config.voice_flags));

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
