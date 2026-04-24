// chanmod — auto-op/halfop/voice on join, with optional NickServ verification
import type { PluginAPI, PluginModActor, PublicUserRecord } from '../../src/types';
import type { ProbeState } from './chanserv-notice';
import { markProbePending } from './chanserv-notice';
import { botCanHalfop, botHasOps, hasAnyFlag } from './helpers';
import type { ProtectionChain } from './protection-backend';
import { toBackendAccess } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

/** Flags that must go through the hard-gate verification inside grantMode. */
const GRANT_FLAGS = ['+o', '+h', '+v'] as const;

/**
 * Hand-rolled actor used by auto-op paths that run without a triggering
 * user `ctx` (join reconciliation, identify/deidentify reconcilers,
 * revoke-on-deidentify sweeps). `source='plugin'` and `plugin='chanmod'`
 * are forced by the plugin-api factory's `resolveActor` either way — we
 * set them here for readability. Keeps `mod_log.by` meaningful instead
 * of NULL for the swath of chanmod rows that do not originate from a
 * bound command handler. See audit 2026-04-24.
 */
const AUTO_OP_ACTOR: PluginModActor = Object.freeze({
  by: 'auto-op',
  source: 'plugin',
  plugin: 'chanmod',
});

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
 * Apply `desired` to `nick` in `channel`. For `+o/+h/+v` grants this
 * function applies a HARD GATE regardless of `require_acc_for`: no grant
 * is ever issued unless the caller's identity is vouched for by either
 * (a) an IRCv3 account-tag that resolves to a non-empty account, OR
 * (b) a completed NickServ `verifyUser` that returned `verified:true`.
 *
 * This closes the race the audit flagged: the join bind uses flag `-`,
 * which bypasses the dispatcher's verification gate, so an operator who
 * does not include `+o` in `require_acc_for` was previously opping a
 * nick-squatter on hostmask alone. See audit 2026-04-24 CRITICAL.
 *
 * When `knownAccount` is a non-empty string, it came from IRCv3
 * extended-join / account-tag / account-notify — authoritative and
 * skips the NickServ ACC round-trip. `null` means the server
 * explicitly said "not identified"; we refuse the grant. `undefined`
 * means no account data was attached to the event — fall through to
 * `verifyUser()`.
 *
 * Returns once the grant is queued (or skipped). Errors are logged,
 * not thrown.
 */
async function grantMode(
  api: PluginAPI,
  config: ChanmodConfig,
  channel: string,
  nick: string,
  desired: 'o' | 'h' | 'v',
  knownAccount: string | null | undefined = undefined,
): Promise<void> {
  const flagToApply: '+o' | '+h' | '+v' = desired === 'o' ? '+o' : desired === 'h' ? '+h' : '+v';
  const safeNick = api.stripFormatting(nick);

  // Hard gate — required for prefix-mode grants whenever services
  // ARE available, regardless of `require_acc_for`. The previous
  // conditional-on-config behaviour is the vulnerability; see audit
  // 2026-04-24 CRITICAL.
  //
  // When services are entirely unavailable (`services.type === 'none'`),
  // there's no way for the bot to distinguish an identified user from a
  // nick-squatter — so we fall through to hostmask-only matching. The
  // operator has explicitly opted out of services; the startup warning
  // in `warnAutoOpMisconfig` alerts them that this mode is weaker than
  // a services-gated deployment. This keeps auto-op usable on
  // services-free networks without blessing it as secure.
  if (api.services.isAvailable()) {
    // null = server explicitly said "not identified". Refuse.
    if (knownAccount === null) {
      api.log(
        `Skipping ${flagToApply} for ${safeNick} in ${channel} — IRCv3 account-tag says not identified`,
      );
      if (config.notify_on_fail) {
        api.notice(nick, 'Auto-op: NickServ verification failed. Please identify and rejoin.');
      }
      return;
    }

    if (typeof knownAccount === 'string' && knownAccount.length > 0) {
      // Account-tag is authoritative. Accept without a NickServ
      // round-trip — the server has already vouched for the identity.
      api.log(
        `Verified ${safeNick} via IRCv3 account-tag (${api.stripFormatting(knownAccount)}) — applying ${flagToApply} in ${channel}`,
      );
    } else {
      // No account-tag attached to the event. Must wait for NickServ.
      api.log(`Verifying ${safeNick} via NickServ before applying ${flagToApply} in ${channel}`);
      const result = await api.services.verifyUser(nick);
      if (!result.verified) {
        api.log(`Verification failed for ${safeNick} in ${channel} — not applying ${flagToApply}`);
        if (config.notify_on_fail) {
          api.notice(nick, 'Auto-op: NickServ verification failed. Please identify and rejoin.');
        }
        return;
      }
      api.log(
        `Verified ${safeNick} (account: ${result.account ? api.stripFormatting(result.account) : 'unknown'}) — applying ${flagToApply} in ${channel}`,
      );
    }
  } else {
    // Services unavailable — legacy hostmask-only behaviour. Startup
    // warning in warnAutoOpMisconfig + this debug log make the
    // degraded posture visible.
    api.debug(
      `Granting ${flagToApply} for ${safeNick} in ${channel} on hostmask alone — services unavailable`,
    );
  }

  if (desired === 'o') {
    if (!botHasOps(api, channel)) {
      api.log(`Cannot auto-op ${safeNick} in ${channel} — I am not opped`);
      return;
    }
    api.op(channel, nick, AUTO_OP_ACTOR);
    api.log(`Auto-opped ${safeNick} in ${channel}`);
  } else if (desired === 'h') {
    if (!botCanHalfop(api, channel)) {
      api.log(`Cannot auto-halfop ${safeNick} in ${channel} — I do not have +h or +o`);
      return;
    }
    api.halfop(channel, nick, AUTO_OP_ACTOR);
    api.log(`Auto-halfopped ${safeNick} in ${channel}`);
  } else {
    if (!botHasOps(api, channel)) {
      api.log(`Cannot auto-voice ${safeNick} in ${channel} — I am not opped`);
      return;
    }
    api.voice(channel, nick, AUTO_OP_ACTOR);
    api.log(`Auto-voiced ${safeNick} in ${channel}`);
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

  const safeNick = api.stripFormatting(nick);

  // Downgrades first — revoke any prefix mode the user holds that their
  // current flags don't justify. Skip the mode we're about to grant.
  if (desired !== 'o' && currentModes.includes('o')) {
    if (botHasOps(api, channel)) {
      api.deop(channel, nick, AUTO_OP_ACTOR);
      api.log(`Auto-deopped ${safeNick} in ${channel} — flags no longer grant +o`);
    }
  }
  if (desired !== 'h' && desired !== 'o' && currentModes.includes('h')) {
    if (botCanHalfop(api, channel)) {
      api.dehalfop(channel, nick, AUTO_OP_ACTOR);
      api.log(`Auto-dehalfopped ${safeNick} in ${channel} — flags no longer grant +h`);
    }
  }
  if (desired === null && currentModes.includes('v')) {
    if (botHasOps(api, channel)) {
      api.devoice(channel, nick, AUTO_OP_ACTOR);
      api.log(`Auto-devoiced ${safeNick} in ${channel} — flags no longer grant +v`);
    }
  }

  // Upgrade: grant desired mode if the user doesn't already carry it.
  if (desired && !currentModes.includes(desired)) {
    await grantMode(api, config, channel, nick, desired);
  }
}

/**
 * Audit-defence-in-depth: log a loud `[security]` warning if auto-op is
 * enabled (globally or per-channel via chanset) but `require_acc_for`
 * does not include the grant flags. The hard gate inside `grantMode()`
 * neutralises the attack — this warning exists so operators SEE the
 * misconfig and fix the config layer too, instead of silently relying
 * on the in-code gate. See audit 2026-04-24 CRITICAL.
 */
function warnAutoOpMisconfig(api: PluginAPI, config: ChanmodConfig): void {
  // Auto-op is a per-channel setting; treat it as "enabled" for warning
  // purposes when the default is true OR any configured channel has it
  // explicitly set. (The channelSettings layer doesn't expose a "scan
  // all" API to plugins, so we settle for the default + the configured
  // startup channels here — good enough for a misconfig warning.)
  let anyAutoOpEnabled = config.auto_op;
  if (!anyAutoOpEnabled) {
    for (const ch of api.botConfig.irc.channels) {
      if (api.channelSettings.getFlag(ch, 'auto_op')) {
        anyAutoOpEnabled = true;
        break;
      }
    }
  }
  if (!anyAutoOpEnabled) return;

  const requireAccFor = api.botConfig.identity.require_acc_for ?? [];
  const missing = GRANT_FLAGS.filter((f) => !requireAccFor.includes(f));
  if (missing.length === 0) return;

  api.warn(
    `[security] auto-op is enabled but require_acc_for is missing ${missing.join(', ')}. ` +
      `The grantMode() hard gate still requires NickServ verification for prefix-mode grants, ` +
      `but operators should add these flags to identity.require_acc_for in bot.json for ` +
      `defence in depth (the dispatcher gate blocks unverified ops from ever reaching the ` +
      `handler; the grantMode gate is the second layer). See docs/SECURITY.md §3.2.`,
  );
}

export function setupAutoOp(
  api: PluginAPI,
  config: ChanmodConfig,
  _state: SharedState,
  chain?: ProtectionChain,
  probeState?: ProbeState,
): () => void {
  warnAutoOpMisconfig(api, config);

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

    // Wrap grantMode: a NickServ outage (verifyUser rejection, ACC timeout)
    // must not leak out of this join handler as an unhandled rejection —
    // the dispatcher catches it, but then every other join on the same
    // tick loses its auto-op. Fail quietly per-user instead. See stability
    // audit 2026-04-14.
    try {
      await grantMode(api, config, channel, nick, desired, ctx.account);
    } catch (err) {
      api.error(`auto-op grantMode threw for ${nick} in ${channel}:`, err);
    }
  });

  // React to .adduser / .flags / .addhostmask so mode changes take effect
  // immediately for already-joined users instead of waiting for a rejoin.
  api.onPermissionsChanged((handle) => {
    reconcileHandleAcrossChannels(api, config, handle).catch((err) => {
      api.error(`onPermissionsChanged reconciler failed for ${handle}:`, err);
    });
  });

  // React to late authentication / deauthentication for already-joined users.
  // `channel-state.onAccount` emits these on IRCv3 account-notify transitions,
  // and `services.verifyUser` emits `user:identified` from its resolve path —
  // both flows end up here. The reconciler looks up each per-channel user
  // against the *current* identification (the channel-state account map is
  // already updated by the time these events fire) so a deidentifying
  // `$a:accountname`-only user naturally loses their auto-granted prefix
  // modes. See docs/services-identify-before-join.md.
  api.onUserIdentified((nick) => {
    reconcileNickInAllChannels(api, config, nick).catch((err) => {
      api.error(`onUserIdentified reconciler failed for ${nick}:`, err);
    });
  });
  api.onUserDeidentified((nick) => {
    reconcileNickInAllChannels(api, config, nick).catch((err) => {
      api.error(`onUserDeidentified reconciler failed for ${nick}:`, err);
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
 * Reconcile a single `nick`'s prefix modes in every configured channel they
 * are currently present in. Used by the identify/deidentify event handlers.
 *
 * Resolution uses the live account lookup (not the old account) because
 * what we want is the user's flags *right now*: on identify the new
 * account is already in the channel-state map, on deidentify the map
 * holds null. When the resolve yields no record — typically the
 * deidentify case where the user only matched via `$a:accountname` —
 * strip every auto-granted prefix mode the user currently carries, since
 * we can no longer defend any of them on this user.
 *
 * Channels with `auto_op` off are skipped, matching the other reconcilers.
 */
async function reconcileNickInAllChannels(
  api: PluginAPI,
  config: ChanmodConfig,
  nick: string,
): Promise<void> {
  for (const channel of api.botConfig.irc.channels) {
    if (!api.channelSettings.getFlag(channel, 'auto_op')) continue;
    const ch = api.getChannel(channel);
    if (!ch) continue;
    const chanUser = Array.from(ch.users.values()).find(
      (u) => api.ircLower(u.nick) === api.ircLower(nick),
    );
    if (!chanUser) continue;
    const hostmask = api.buildHostmask(chanUser);
    // Pass the per-channel accountName explicitly so `$a:` patterns can
    // resolve against the current account — findByHostmask does not fall
    // back to the channel-state account lookup on its own.
    const record = api.permissions.findByHostmask(hostmask, chanUser.accountName);
    if (record) {
      await reconcileUserInChannel(api, config, record, channel, chanUser.nick, chanUser.modes);
      continue;
    }
    // No record matches under current identification. If the user carries
    // any auto-grantable prefix mode, revoke it — we cannot justify the
    // mode against any flagged record any more.
    revokeAutoGrants(api, channel, chanUser.nick, chanUser.modes);
  }
}

/** Strip any +o/+h/+v the user carries, within the bot's current privileges. */
function revokeAutoGrants(
  api: PluginAPI,
  channel: string,
  nick: string,
  currentModes: string,
): void {
  const safeNick = api.stripFormatting(nick);
  if (currentModes.includes('o') && botHasOps(api, channel)) {
    api.deop(channel, nick, AUTO_OP_ACTOR);
    api.log(`Auto-deopped ${safeNick} in ${channel} — no longer identified to a flagged account`);
  }
  if (currentModes.includes('h') && botCanHalfop(api, channel)) {
    api.dehalfop(channel, nick, AUTO_OP_ACTOR);
    api.log(
      `Auto-dehalfopped ${safeNick} in ${channel} — no longer identified to a flagged account`,
    );
  }
  if (currentModes.includes('v') && botHasOps(api, channel)) {
    api.devoice(channel, nick, AUTO_OP_ACTOR);
    api.log(`Auto-devoiced ${safeNick} in ${channel} — no longer identified to a flagged account`);
  }
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
