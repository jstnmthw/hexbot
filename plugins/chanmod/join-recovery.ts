// chanmod — ChanServ-assisted join error recovery
//
// When the bot fails to join a channel (banned, invite-only, bad key, full),
// this module asks ChanServ for help and retries. Implements the Eggdrop
// need-unban / need-invite / need-key pattern with exponential backoff.
//
// Key insight: ChanServ INVITE bypasses +i and +l. On Atheme it also
// bypasses +k, but on Anope/Rizon it does NOT — so for +k we also send
// ChanServ MODE -k to strip the key. An attacker who sets +k +i +l +b
// and kicks the bot is defeated with UNBAN + MODE -k + INVITE + rejoin.
import type { PluginAPI } from '../../src/types';
import type { ProbeState } from './chanserv-notice';
import { markProbePending } from './chanserv-notice';
import type { ProtectionChain } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

// ---------------------------------------------------------------------------
// Per-channel backoff state
// ---------------------------------------------------------------------------

interface JoinRecoveryState {
  lastAttempt: number;
  backoffMs: number; // starts at 30_000, doubles each attempt, caps at 300_000
  /** Timer that resets backoff after sustained channel presence. */
  resetTimer: ReturnType<typeof setTimeout> | null;
}

const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;

/** How long the bot must stay in the channel before backoff resets (5 minutes). */
const SUSTAINED_PRESENCE_MS = 300_000;

/** Delay after ChanServ request before retrying join (services processing time). */
const SERVICES_DELAY_MS = 3_000;
/** Delay before retrying join with configured key (no services involved). */
const KEY_RETRY_DELAY_MS = 1_000;
/** Wait for ChanServ access probe to complete before retrying (probe timeout is 10s). */
const PROBE_WAIT_MS = 11_000;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface JoinRecoveryOptions {
  api: PluginAPI;
  chain: ProtectionChain;
  state: SharedState;
  config: ChanmodConfig;
  probeState?: ProbeState;
}

export function setupJoinRecovery(opts: JoinRecoveryOptions): () => void {
  const { api, chain, state, config, probeState } = opts;

  // Channels where we've already sent an access probe (prevent duplicate probes)
  const probedChannels = new Set<string>();

  // In-memory backoff state — resets on restart (intentional: ban state may
  // have changed since last run).
  const recoveryState = new Map<string, JoinRecoveryState>();

  // --- Handle join errors ---

  api.bind('join_error', '-', '*', (ctx) => {
    const { channel } = ctx;
    const error = ctx.command;
    const chanKey = api.ircLower(channel);

    // If the chain has no access for this channel and we haven't probed yet,
    // trigger a proactive ChanServ access probe. The probe response (via
    // chanserv-notice handler) will set the access level. We schedule a
    // deferred retry so the probe has time to complete before we give up.
    //
    // Only probe when chanserv_access was never explicitly set (still at
    // default 'none'). If the user set it to 'none' via .chanset, respect that.
    const accessNeverSet = !api.channelSettings.isSet(channel, 'chanserv_access');
    if (
      error !== 'need_registered_nick' &&
      chain.getAccess(channel) === 'none' &&
      accessNeverSet &&
      !probedChannels.has(chanKey) &&
      probeState
    ) {
      probedChannels.add(chanKey);
      const isAnope = config.chanserv_services_type === 'anope';
      markProbePending(api, probeState, channel, config.chanserv_services_type);
      if (isAnope) {
        markProbePending(api, probeState, channel, 'anope-info');
      }
      chain.verifyAccess(channel);
      api.log(`Cannot join ${channel}: probing ChanServ access before recovery attempt`);

      // Retry the same join_error after the probe timeout (10s + 1s buffer)
      state.scheduleCycle(PROBE_WAIT_MS, () => {
        if (chain.getAccess(channel) !== 'none') {
          api.log(`ChanServ access detected for ${channel} — retrying join recovery`);
          dispatchRecovery(api, chain, state, recoveryState, channel, chanKey, error);
        } else {
          api.debug(`ChanServ probe for ${channel} returned no access — cannot recover`);
        }
      });
      return;
    }

    dispatchRecovery(api, chain, state, recoveryState, channel, chanKey, error);
  });

  // --- Delayed backoff reset on successful join ---
  //
  // Don't wipe backoff immediately — an attacker with ops could cycle
  // ban→rejoin indefinitely, generating unlimited ChanServ requests.
  // Instead, schedule a delayed reset after sustained channel presence.
  // If the bot is banned again before the timer fires, the timer is
  // cancelled and backoff continues escalating.

  api.bind('join', '-', '*', (ctx) => {
    if (!api.isBotNick(ctx.nick)) return;
    const chanKey = api.ircLower(ctx.channel);
    probedChannels.delete(chanKey);

    const rs = recoveryState.get(chanKey);
    if (!rs) return;

    // Cancel any previous reset timer (e.g., from a prior join in the same cycle)
    if (rs.resetTimer) clearTimeout(rs.resetTimer);

    // Schedule backoff reset after sustained presence.
    // Guard: verify this timer is still current before acting — if a re-ban
    // arrived in the same event loop tick (timers phase fires before I/O poll),
    // getOrCreateState may have nulled rs.resetTimer after clearTimeout lost
    // the race against an already-dequeued callback.
    const timer = setTimeout(() => {
      if (rs.resetTimer !== timer) return;
      recoveryState.delete(chanKey);
      api.debug(`Join recovery backoff reset for ${ctx.channel} (sustained presence)`);
    }, SUSTAINED_PRESENCE_MS);
    rs.resetTimer = timer;
    state.cycleTimers.add(timer);
  });

  return () => {
    for (const rs of recoveryState.values()) {
      if (rs.resetTimer) clearTimeout(rs.resetTimer);
    }
    recoveryState.clear();
    probedChannels.clear();
  };
}

// ---------------------------------------------------------------------------
// Recovery dispatch
// ---------------------------------------------------------------------------

function dispatchRecovery(
  api: PluginAPI,
  chain: ProtectionChain,
  state: SharedState,
  recoveryState: Map<string, JoinRecoveryState>,
  channel: string,
  chanKey: string,
  error: string,
): void {
  switch (error) {
    case 'banned_from_channel':
      handleBanned(api, chain, state, recoveryState, channel, chanKey);
      break;
    case 'invite_only_channel':
      handleInviteOnly(api, chain, state, recoveryState, channel, chanKey);
      break;
    case 'bad_channel_key':
      handleBadKey(api, chain, state, recoveryState, channel, chanKey);
      break;
    case 'channel_is_full':
      handleFull(api, chain, state, recoveryState, channel, chanKey);
      break;
    case 'need_registered_nick':
      api.log(`Cannot join ${channel}: need registered nick — NickServ identification is separate`);
      break;
  }
}

// ---------------------------------------------------------------------------
// Error handlers
// ---------------------------------------------------------------------------

/**
 * Banned from channel (+b) — UNBAN first, then INVITE (bypasses +i/+l) and
 * remove key (strips attacker's +k). Handles the full attacker stack: +b +k +i +l.
 */
function handleBanned(
  api: PluginAPI,
  chain: ProtectionChain,
  state: SharedState,
  recoveryState: Map<string, JoinRecoveryState>,
  channel: string,
  chanKey: string,
): void {
  if (!chain.canUnban(channel)) {
    api.debug(`Cannot join ${channel}: banned — no ChanServ access to unban`);
    return;
  }

  const rs = getOrCreateState(recoveryState, chanKey);
  if (!checkCooldown(api, rs, channel)) return;

  api.log(
    `Cannot join ${channel}: banned — requesting UNBAN + INVITE (backoff: ${rs.backoffMs / 1000}s)`,
  );
  chain.requestUnban(channel);

  // Also request INVITE (bypasses +i/+l) and remove key (strips attacker +k)
  if (chain.canInvite(channel)) chain.requestInvite(channel);
  if (chain.canRemoveKey(channel)) chain.requestRemoveKey(channel);

  advanceBackoff(rs);

  state.scheduleCycle(SERVICES_DELAY_MS, () => {
    api.join(channel, api.getChannelKey(channel));
  });
}

/**
 * Invite only (+i) — request INVITE (also bypasses +k and +l).
 */
function handleInviteOnly(
  api: PluginAPI,
  chain: ProtectionChain,
  state: SharedState,
  recoveryState: Map<string, JoinRecoveryState>,
  channel: string,
  chanKey: string,
): void {
  if (!chain.canInvite(channel)) {
    api.debug(`Cannot join ${channel}: invite only — no ChanServ access to invite`);
    return;
  }

  const rs = getOrCreateState(recoveryState, chanKey);
  if (!checkCooldown(api, rs, channel)) return;

  api.log(
    `Cannot join ${channel}: invite only — requesting ChanServ INVITE (backoff: ${rs.backoffMs / 1000}s)`,
  );
  chain.requestInvite(channel);
  advanceBackoff(rs);

  state.scheduleCycle(SERVICES_DELAY_MS, () => {
    api.join(channel, api.getChannelKey(channel));
  });
}

/**
 * Bad channel key (+k) — Ask the backend to strip the key, then INVITE + rejoin.
 * ChanServ INVITE alone does NOT bypass +k on Anope/Rizon (unlike Atheme).
 * Fall back to configured key only without backend access.
 */
function handleBadKey(
  api: PluginAPI,
  chain: ProtectionChain,
  state: SharedState,
  recoveryState: Map<string, JoinRecoveryState>,
  channel: string,
  chanKey: string,
): void {
  if (chain.canRemoveKey(channel)) {
    const rs = getOrCreateState(recoveryState, chanKey);
    if (!checkCooldown(api, rs, channel)) return;

    api.log(
      `Cannot join ${channel}: bad key — requesting remove key + INVITE (backoff: ${rs.backoffMs / 1000}s)`,
    );
    chain.requestRemoveKey(channel);
    if (chain.canInvite(channel)) chain.requestInvite(channel);
    advanceBackoff(rs);

    state.scheduleCycle(SERVICES_DELAY_MS, () => {
      api.join(channel, api.getChannelKey(channel));
    });
    return;
  }

  // No backend access — try configured key from bot.json
  const key = api.getChannelKey(channel);
  if (!key) {
    api.debug(`Cannot join ${channel}: bad key — no backend access and no key configured`);
    return;
  }

  const rs = getOrCreateState(recoveryState, chanKey);
  if (!checkCooldown(api, rs, channel)) return;

  api.log(`Cannot join ${channel}: bad key — retrying with configured key`);
  advanceBackoff(rs);

  state.scheduleCycle(KEY_RETRY_DELAY_MS, () => {
    api.join(channel, key);
  });
}

/**
 * Channel full (+l) — ChanServ INVITE bypasses +l. Without ChanServ access,
 * the periodic rejoin handles it naturally.
 */
function handleFull(
  api: PluginAPI,
  chain: ProtectionChain,
  state: SharedState,
  recoveryState: Map<string, JoinRecoveryState>,
  channel: string,
  chanKey: string,
): void {
  if (!chain.canInvite(channel)) {
    api.log(
      `Cannot join ${channel}: channel is full — no ChanServ access, waiting for periodic rejoin`,
    );
    return;
  }

  const rs = getOrCreateState(recoveryState, chanKey);
  if (!checkCooldown(api, rs, channel)) return;

  api.log(
    `Cannot join ${channel}: channel is full — requesting ChanServ INVITE (backoff: ${rs.backoffMs / 1000}s)`,
  );
  chain.requestInvite(channel);
  advanceBackoff(rs);

  state.scheduleCycle(SERVICES_DELAY_MS, () => {
    api.join(channel, api.getChannelKey(channel));
  });
}

// ---------------------------------------------------------------------------
// Backoff helpers
// ---------------------------------------------------------------------------

function getOrCreateState(map: Map<string, JoinRecoveryState>, chanKey: string): JoinRecoveryState {
  let rs = map.get(chanKey);
  if (!rs) {
    rs = { lastAttempt: 0, backoffMs: INITIAL_BACKOFF_MS, resetTimer: null };
    map.set(chanKey, rs);
  }
  // Cancel any pending sustained-presence reset — the bot was banned again
  // before the timer fired, so backoff should continue escalating.
  if (rs.resetTimer) {
    clearTimeout(rs.resetTimer);
    rs.resetTimer = null;
  }
  return rs;
}

function checkCooldown(api: PluginAPI, rs: JoinRecoveryState, channel: string): boolean {
  const now = Date.now();
  const elapsed = now - rs.lastAttempt;
  if (rs.lastAttempt > 0 && elapsed < rs.backoffMs) {
    const remaining = Math.ceil((rs.backoffMs - elapsed) / 1000);
    api.log(`Join recovery for ${channel} on cooldown (next attempt in ${remaining}s)`);
    return false;
  }
  return true;
}

function advanceBackoff(rs: JoinRecoveryState): void {
  rs.lastAttempt = Date.now();
  rs.backoffMs = Math.min(rs.backoffMs * 2, MAX_BACKOFF_MS);
}
