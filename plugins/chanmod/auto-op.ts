// chanmod — auto-op/halfop/voice on join, with optional NickServ verification
import type { PluginAPI, PublicUserRecord } from '../../src/types';
import type { ProbeState } from './chanserv-notice';
import { markProbePending } from './chanserv-notice';
import { botCanHalfop, botHasOps, hasAnyFlag } from './helpers';
import type { ProtectionChain } from './protection-backend';
import { toBackendAccess } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

/** Desired prefix mode for a user based on their flags, or null for nothing. */
type DesiredMode = 'o' | 'h' | 'v' | null;

/**
 * Decide which prefix mode auto-op would apply to a user with the given
 * concatenated (global + channel) flags. Extracted so the join handler and
 * the flag-change reconciler share one decision path.
 */
function computeDesiredMode(allFlags: string, config: ChanmodConfig): DesiredMode {
  // 'd' (deop) flag suppresses auto-op and auto-halfop.
  // Voice still works but requires an explicit voice flag (n does not imply v).
  const deop = allFlags.includes('d');
  if (!deop && hasAnyFlag(allFlags, config.op_flags)) return 'o';
  if (!deop && config.halfop_flags.length > 0 && hasAnyFlag(allFlags, config.halfop_flags)) {
    return 'h';
  }
  const voiceMatch = deop
    ? config.voice_flags.some((f) => allFlags.includes(f))
    : hasAnyFlag(allFlags, config.voice_flags);
  return voiceMatch ? 'v' : null;
}

/**
 * Apply `desired` to `nick` in `channel`, with NickServ verification when
 * `require_acc_for` demands it. Used by both the join handler and the
 * flag-change reconciler.
 *
 * When `knownAccount` is defined (non-empty string), it came from IRCv3
 * extended-join / account-tag / account-notify — the server has already
 * vouched for the identity and we can skip the NickServ ACC round-trip.
 * `null` means the server explicitly said the nick is NOT identified; we
 * reject the grant without ever asking NickServ.
 *
 * Returns once the grant is queued (or skipped). Errors are logged, not thrown.
 */
async function grantMode(
  api: PluginAPI,
  config: ChanmodConfig,
  channel: string,
  nick: string,
  desired: 'o' | 'h' | 'v',
  knownAccount: string | null | undefined = undefined,
): Promise<void> {
  const requireAccFor = api.botConfig.identity.require_acc_for;
  const flagToApply = desired === 'o' ? '+o' : desired === 'h' ? '+h' : '+v';
  const needsVerification = requireAccFor.includes(flagToApply) && api.services.isAvailable();

  if (needsVerification) {
    // Fast path: IRCv3 account data is authoritative and means we do not
    // have to wait on NickServ. null = server says "not identified" — the
    // only correct response is to refuse the grant (this closes the race
    // the audit flagged even without the dispatcher verification gate).
    if (knownAccount === null) {
      api.log(
        `Skipping ${flagToApply} for ${nick} in ${channel} — IRCv3 account-tag says not identified`,
      );
      if (config.notify_on_fail) {
        api.notice(nick, 'Auto-op: NickServ verification failed. Please identify and rejoin.');
      }
      return;
    }
    if (typeof knownAccount === 'string' && knownAccount.length > 0) {
      api.log(
        `Verified ${nick} via IRCv3 account-tag (${knownAccount}) — applying ${flagToApply} in ${channel}`,
      );
    } else {
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
  }

  if (desired === 'o') {
    if (!botHasOps(api, channel)) {
      api.log(`Cannot auto-op ${nick} in ${channel} — I am not opped`);
      return;
    }
    api.op(channel, nick);
    api.log(`Auto-opped ${nick} in ${channel}`);
  } else if (desired === 'h') {
    if (!botCanHalfop(api, channel)) {
      api.log(`Cannot auto-halfop ${nick} in ${channel} — I do not have +h or +o`);
      return;
    }
    api.halfop(channel, nick);
    api.log(`Auto-halfopped ${nick} in ${channel}`);
  } else {
    if (!botHasOps(api, channel)) {
      api.log(`Cannot auto-voice ${nick} in ${channel} — I am not opped`);
      return;
    }
    api.voice(channel, nick);
    api.log(`Auto-voiced ${nick} in ${channel}`);
  }
}

/**
 * Reconcile a single known user's prefix modes in a channel against what
 * auto-op would grant now. Used when flags change for an already-joined user.
 *
 * Upgrades: grants missing desired mode.
 * Downgrades: revokes higher prefix modes the current flags no longer justify.
 *   The bot is authoritative for its own known users — that's the whole
 *   point of this path, otherwise a .flags change wouldn't take effect
 *   until the user rejoined.
 */
async function reconcileUserInChannel(
  api: PluginAPI,
  config: ChanmodConfig,
  user: PublicUserRecord,
  channel: string,
  nick: string,
  currentModes: string,
): Promise<void> {
  const globalFlags = user.global;
  const channelFlags = user.channels[api.ircLower(channel)] ?? '';
  const allFlags = globalFlags + channelFlags;
  const desired = computeDesiredMode(allFlags, config);

  // Downgrades first — revoke any prefix mode the user holds that their
  // current flags don't justify. Skip the mode we're about to grant.
  if (desired !== 'o' && currentModes.includes('o')) {
    if (botHasOps(api, channel)) {
      api.deop(channel, nick);
      api.log(`Auto-deopped ${nick} in ${channel} — flags no longer grant +o`);
    }
  }
  if (desired !== 'h' && desired !== 'o' && currentModes.includes('h')) {
    if (botCanHalfop(api, channel)) {
      api.dehalfop(channel, nick);
      api.log(`Auto-dehalfopped ${nick} in ${channel} — flags no longer grant +h`);
    }
  }
  if (desired === null && currentModes.includes('v')) {
    if (botHasOps(api, channel)) {
      api.devoice(channel, nick);
      api.log(`Auto-devoiced ${nick} in ${channel} — flags no longer grant +v`);
    }
  }

  // Upgrade: grant desired mode if the user doesn't already carry it.
  if (desired && !currentModes.includes(desired)) {
    await grantMode(api, config, channel, nick, desired);
  }
}

export function setupAutoOp(
  api: PluginAPI,
  config: ChanmodConfig,
  _state: SharedState,
  chain?: ProtectionChain,
  probeState?: ProbeState,
): () => void {
  api.bind('join', '-', '*', async (ctx) => {
    const { nick, channel } = ctx;

    // Bot joined — request current channel modes from the server.
    // The MODE reply triggers channel:modesReady, which chains to syncChannelModes
    // (set up in setupModeEnforce). This guarantees channel state is populated before sync.
    if (api.isBotNick(nick)) {
      api.requestChannelModes(channel);

      // Set and verify ChanServ access level for the protection chain
      if (chain) {
        const access = toBackendAccess(api.channelSettings.getString(channel, 'chanserv_access'));
        if (access !== 'none') {
          for (const b of chain.getBackends()) {
            b.setAccess(channel, access);
          }
        }
        if (probeState) {
          markProbePending(api, probeState, channel, config.chanserv_services_type);
          // Anope: also mark an INFO probe for founder detection (ACCESS LIST
          // doesn't include implicit founder status on Rizon/Anope)
          if (config.chanserv_services_type === 'anope') {
            markProbePending(api, probeState, channel, 'anope-info');
          }
        }
        chain.verifyAccess(channel);
      }

      // Warn when takeover detection is on but no ChanServ access after probe completes.
      // Deferred: wait for the probe to finish (or timeout) before warning.
      // Deduped per channel per bot session so rejoins don't re-nag.
      const takeoverOn = api.channelSettings.getFlag(channel, 'takeover_detection');
      const accessExplicit = api.channelSettings.isSet(channel, 'chanserv_access');
      if (takeoverOn && !accessExplicit) {
        const channelKey = api.ircLower(channel);
        // Check after 5s — by then the probe should have completed or timed out
        _state.cycles.schedule(5000, () => {
          const access = chain?.getAccess(channel) ?? 'none';
          if (access === 'none' && !_state.takeoverWarnedChannels.has(channelKey)) {
            _state.takeoverWarnedChannels.add(channelKey);
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

    const fullHostmask = api.buildHostmask(ctx);
    const user = api.permissions.findByHostmask(fullHostmask);
    if (!user) return;

    const globalFlags = user.global;
    const channelFlags = user.channels[api.ircLower(channel)] ?? '';
    const allFlags = globalFlags + channelFlags;
    const desired = computeDesiredMode(allFlags, config);
    if (!desired) return;

    await grantMode(api, config, channel, nick, desired, ctx.account);
  });

  // React to .adduser / .flags / .addhostmask so mode changes take effect
  // immediately for already-joined users instead of waiting for a rejoin.
  api.onPermissionsChanged((handle) => {
    reconcileHandleAcrossChannels(api, config, handle).catch((err) => {
      api.error(`onPermissionsChanged reconciler failed for ${handle}:`, err);
    });
  });

  // When the bot joins a channel that already has users, those users come in
  // via NAMES (userlist), not as individual `join` events — so the join bind
  // above never sees them. Hook onModesReady (fires after self-join +
  // requestChannelModes round-trips) to reconcile everyone already present.
  api.onModesReady((channel) => {
    reconcileAllUsersInChannel(api, config, channel).catch((err) => {
      api.error(`onModesReady reconciler failed for ${channel}:`, err);
    });
  });

  return () => {};
}

/**
 * Walk every configured channel and, for each user whose hostmask matches
 * the changed handle, reconcile their prefix modes against current flags.
 * Called from the onPermissionsChanged hook whenever a user record is added
 * or their flags/hostmasks change.
 */
async function reconcileHandleAcrossChannels(
  api: PluginAPI,
  config: ChanmodConfig,
  handle: string,
): Promise<void> {
  const lowerHandle = handle.toLowerCase();
  for (const channel of api.botConfig.irc.channels) {
    if (!api.channelSettings.getFlag(channel, 'auto_op')) continue;

    const ch = api.getChannel(channel);
    if (!ch) continue;

    for (const chanUser of ch.users.values()) {
      if (api.isBotNick(chanUser.nick)) continue;
      const hostmask = api.buildHostmask(chanUser);
      const record = api.permissions.findByHostmask(hostmask);
      if (!record) continue;
      if (record.handle.toLowerCase() !== lowerHandle) continue;

      await reconcileUserInChannel(api, config, record, channel, chanUser.nick, chanUser.modes);
    }
  }
}

/**
 * Reconcile every known user currently in `channel` against their current
 * flags. Called from onModesReady so that when the bot joins a channel with
 * users already present, flagged users get their auto-op mode without
 * needing to part and rejoin. Only matching bot-user records are touched;
 * unknown users are left alone.
 */
async function reconcileAllUsersInChannel(
  api: PluginAPI,
  config: ChanmodConfig,
  channel: string,
): Promise<void> {
  if (!api.channelSettings.getFlag(channel, 'auto_op')) return;

  const ch = api.getChannel(channel);
  if (!ch) return;

  for (const chanUser of ch.users.values()) {
    if (api.isBotNick(chanUser.nick)) continue;
    const hostmask = api.buildHostmask(chanUser);
    const record = api.permissions.findByHostmask(hostmask);
    if (!record) continue;

    await reconcileUserInChannel(api, config, record, channel, chanUser.nick, chanUser.modes);
  }
}
