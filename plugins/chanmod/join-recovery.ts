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
import type { HandlerContext, PluginAPI } from '../../src/types';
import type { ProbeState } from './chanserv-notice';
import { markProbePending } from './chanserv-notice';
import { isBotNick } from './helpers';
import type { ProtectionChain } from './protection-backend';
import type { ChanmodConfig, SharedState } from './state';

// ---------------------------------------------------------------------------
// Per-channel backoff state
// ---------------------------------------------------------------------------

interface JoinRecoveryState {
  lastAttempt: number;
  backoffMs: number; // starts at 30_000, doubles each attempt, caps at 300_000
}

const INITIAL_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 300_000;

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

  api.bind('join_error', '-', '*', (ctx: HandlerContext) => {
    if (!ctx.channel) return;
    const channel = ctx.channel;
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

  // --- Reset backoff on successful join ---

  api.bind('join', '-', '*', (ctx: HandlerContext) => {
    if (!isBotNick(api, ctx.nick)) return;
    if (!ctx.channel) return;
    const chanKey = api.ircLower(ctx.channel);
    if (recoveryState.has(chanKey)) {
      recoveryState.delete(chanKey);
      api.debug(`Join recovery backoff reset for ${ctx.channel}`);
    }
    probedChannels.delete(chanKey);
  });

  return () => {
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
    rs = { lastAttempt: 0, backoffMs: INITIAL_BACKOFF_MS };
    map.set(chanKey, rs);
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
