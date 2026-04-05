// chanmod — ChanServ notice handler
//
// Parses ChanServ NOTICE responses (FLAGS for Atheme, ACCESS LIST for Anope)
// and routes them to the appropriate backend's handler method. This completes
// the verifyAccess() round-trip: the backend sends a probe, ChanServ responds
// via NOTICE, and this handler delivers the parsed result back to the backend.
import type { HandlerContext, PluginAPI } from '../../src/types';
import type { AnopeBackend } from './anope-backend';
import type { AthemeBackend } from './atheme-backend';
import { getBotNick } from './helpers';
import type { BackendAccess } from './protection-backend';
import type { ChanmodConfig } from './state';

// ---------------------------------------------------------------------------
// Atheme FLAGS response patterns
// ---------------------------------------------------------------------------

// Atheme responds to `FLAGS #channel nick` with:
//   "2 nick +flags"           (entry number, nick, flag string)
// or for no access:
//   "nick was not found on the access list of #channel."
//   "The channel \x02#channel\x02 is not registered."

/** Match: "<num> <nick> <flags>" — e.g. "2 hexbot +AOehiortv" */
const ATHEME_FLAGS_RE = /^(\d+)\s+(\S+)\s+(\+\S+)$/;
/** Match: "Flags for <nick> in <channel> are <flags>." — alternate format */
const ATHEME_FLAGS_ALT_RE = /^Flags for (\S+) in (\S+) are (\+\S+)/;
/** Match no-access error: "<nick> was not found on the access list of <channel>." */
const ATHEME_NOT_FOUND_RE = /^(\S+) was not found on the access list of (#\S+?)\.?$/;
/** Match "The channel #xxx is not registered." — captures the channel name.
 *  \x02 is IRC bold (ChanServ often bolds channel names). */
// eslint-disable-next-line no-control-regex
const ATHEME_NOT_REGISTERED_RE = /channel\s+\x02?(#\S+?)\x02?\s+is\s+not\s+registered/i;

// ---------------------------------------------------------------------------
// Anope ACCESS LIST response patterns
// ---------------------------------------------------------------------------

// Anope responds to `ACCESS #channel LIST` with one or more lines:
//   "  <num>  <nick/mask>  <level>  [last-seen]"
// End of list:
//   "End of access list."

/** Match numeric format: "  <num>  <nick/mask>  <level>" — e.g. "  1  hexbot  5" */
const ANOPE_ACCESS_RE = /^\s*\d+\s+(\S+)\s+(-?\d+)/;
/** Match XOP format (Rizon/Anope with XOP levels): "  <num>  <XOP>  <nick>" — e.g. "  1  SOP  d3m0n" */
const ANOPE_XOP_ACCESS_RE = /^\s*\d+\s+(QOP|SOP|AOP|HOP|VOP)\s+(\S+)/i;
/** Map Anope XOP keyword → equivalent numeric level. */
const XOP_TO_LEVEL: Record<string, number> = {
  QOP: 10000,
  SOP: 10,
  AOP: 5,
  HOP: 4,
  VOP: 3,
};
/** Match "Channel #xxx isn't registered" / "is not registered" — captures the channel name.
 *  \x02 is IRC bold (ChanServ often bolds channel names). */
// eslint-disable-next-line no-control-regex
const ANOPE_NOT_REGISTERED_RE = /channel\s+\x02?(#\S+?)\x02?\s+(?:isn't|is not)\s+registered/i;
/** Match generic "access denied" / "permission denied" / "not authorized" / "must be identified" responses. */
const ANOPE_DENIED_RE =
  /(?:access denied|permission denied|not authorized|must be identified|must have a registered)/i;

/** Timeout for ChanServ probe responses (10 seconds). */
const PROBE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Pending probe tracking
// ---------------------------------------------------------------------------

export interface ProbeState {
  /** Channels with pending Atheme FLAGS probes. Value = channel name (original case). */
  pendingAthemeProbes: Map<string, string>;
  /** Channels with pending Anope ACCESS LIST probes. Value = channel name. */
  pendingAnopeProbes: Map<string, string>;
  /** Timeout timers for probe responses. */
  probeTimers: ReturnType<typeof setTimeout>[];
}

export function createProbeState(): ProbeState {
  return {
    pendingAthemeProbes: new Map(),
    pendingAnopeProbes: new Map(),
    probeTimers: [],
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface ChanServNoticeOptions {
  api: PluginAPI;
  config: ChanmodConfig;
  backend: AthemeBackend | AnopeBackend;
  probeState: ProbeState;
}

/**
 * Bind a notice handler that routes ChanServ responses to the backend.
 * Returns a teardown function.
 */
export function setupChanServNotice(opts: ChanServNoticeOptions): () => void {
  const { api, config, backend, probeState } = opts;
  const csNick = config.chanserv_nick;
  const isAtheme = backend.name === 'atheme';

  api.bind('notice', '-', '*', (ctx: HandlerContext) => {
    // Only process notices from ChanServ (PM — channel is null)
    if (ctx.channel !== null) return;
    if (api.ircLower(ctx.nick) !== api.ircLower(csNick)) return;

    const text = ctx.text;
    api.debug(`ChanServ notice: ${text}`);

    if (isAtheme) {
      handleAthemeNotice(api, backend as AthemeBackend, probeState, text);
    } else {
      handleAnopeNotice(api, backend as AnopeBackend, probeState, text);
    }
  });

  return () => {
    probeState.pendingAthemeProbes.clear();
    probeState.pendingAnopeProbes.clear();
    for (const t of probeState.probeTimers) clearTimeout(t);
    probeState.probeTimers.length = 0;
  };
}

// ---------------------------------------------------------------------------
// Mark a channel as having a pending probe
// ---------------------------------------------------------------------------

/** Call when a FLAGS/ACCESS probe is sent, so the notice handler knows to expect a response. */
export function markProbePending(
  api: PluginAPI,
  probeState: ProbeState,
  channel: string,
  backendType: 'atheme' | 'anope',
): void {
  const key = api.ircLower(channel);
  const probes =
    backendType === 'atheme' ? probeState.pendingAthemeProbes : probeState.pendingAnopeProbes;
  probes.set(key, channel);

  // Set a timeout — if ChanServ doesn't respond, clean up and log
  const timer = setTimeout(() => {
    if (probes.has(key)) {
      probes.delete(key);
      api.debug(
        `ChanServ access probe for ${channel} timed out — no services response (access remains 'none')`,
      );
    }
    // Self-clean: remove this timer from the list after it fires
    const idx = probeState.probeTimers.indexOf(timer);
    if (idx !== -1) probeState.probeTimers.splice(idx, 1);
  }, PROBE_TIMEOUT_MS);
  probeState.probeTimers.push(timer);
}

// ---------------------------------------------------------------------------
// Sync auto-detected access back to channelSettings
// ---------------------------------------------------------------------------

/**
 * After the backend processes a FLAGS/ACCESS response and auto-detects an access
 * level, sync the detected tier to channelSettings so .chaninfo and other code
 * sees the correct value.
 */
function syncAccessToSettings(
  api: PluginAPI,
  backend: AthemeBackend | AnopeBackend,
  channel: string,
): void {
  const access: BackendAccess = backend.getAccess(channel);
  if (access !== 'none' && backend.isAutoDetected(channel)) {
    // Write to channelSettings without triggering the onChange → setAccess loop
    // (the onChange handler in index.ts syncs chanserv_access → backend, but we're
    // going the other direction: backend → channelSettings)
    const current = api.channelSettings.getString(channel, 'chanserv_access');
    if (current !== access) {
      api.channelSettings.set(channel, 'chanserv_access', access);
    }
  }
}

// ---------------------------------------------------------------------------
// Atheme notice parsing
// ---------------------------------------------------------------------------

function handleAthemeNotice(
  api: PluginAPI,
  backend: AthemeBackend,
  probeState: ProbeState,
  text: string,
): void {
  const botNick = getBotNick(api);

  // Try "2 hexbot +flags" format
  let m = ATHEME_FLAGS_RE.exec(text);
  if (m) {
    const nick = m[2];
    const flags = m[3];
    if (api.ircLower(nick) === api.ircLower(botNick)) {
      const channel = consumeFirstPendingProbe(probeState.pendingAthemeProbes);
      if (channel) {
        api.debug(`ChanServ FLAGS response for ${channel}: ${nick} ${flags}`);
        backend.handleFlagsResponse(channel, flags);
        syncAccessToSettings(api, backend, channel);
      }
    }
    return;
  }

  // Try "Flags for <nick> in <channel> are <flags>." format
  m = ATHEME_FLAGS_ALT_RE.exec(text);
  if (m) {
    const nick = m[1];
    const channel = m[2];
    const flags = m[3];
    if (api.ircLower(nick) === api.ircLower(botNick)) {
      const key = api.ircLower(channel);
      probeState.pendingAthemeProbes.delete(key);
      api.debug(`ChanServ FLAGS response for ${channel}: ${nick} ${flags}`);
      backend.handleFlagsResponse(channel, flags);
      syncAccessToSettings(api, backend, channel);
    }
    return;
  }

  // Try no-access error: "<nick> was not found on the access list of <channel>."
  m = ATHEME_NOT_FOUND_RE.exec(text);
  if (m) {
    const nick = m[1];
    const channel = m[2];
    if (api.ircLower(nick) === api.ircLower(botNick)) {
      const key = api.ircLower(channel);
      probeState.pendingAthemeProbes.delete(key);
      api.debug(`ChanServ FLAGS response for ${channel}: not on access list`);
      backend.handleFlagsResponse(channel, '(none)');
    }
    return;
  }

  // Unregistered-channel error: "The channel #xxx is not registered."
  m = ATHEME_NOT_REGISTERED_RE.exec(text);
  if (m) {
    const channel = m[1];
    const key = api.ircLower(channel);
    if (probeState.pendingAthemeProbes.delete(key)) {
      api.debug(`ChanServ FLAGS response for ${channel}: channel not registered`);
      backend.handleFlagsResponse(channel, '(none)');
    }
  }
}

// ---------------------------------------------------------------------------
// Anope notice parsing
// ---------------------------------------------------------------------------

function handleAnopeNotice(
  api: PluginAPI,
  backend: AnopeBackend,
  probeState: ProbeState,
  text: string,
): void {
  const botNick = getBotNick(api);

  // Try XOP format first (Rizon): "  <num>  <XOP-name>  <nick>"
  let m = ANOPE_XOP_ACCESS_RE.exec(text);
  if (m) {
    const xop = m[1].toUpperCase();
    const nick = m[2];
    const level = XOP_TO_LEVEL[xop] ?? 0;
    if (api.ircLower(nick) === api.ircLower(botNick)) {
      const channel = consumeFirstPendingProbe(probeState.pendingAnopeProbes);
      if (channel) {
        api.debug(`ChanServ ACCESS response for ${channel}: ${nick} ${xop} (level=${level})`);
        backend.handleAccessResponse(channel, level);
        syncAccessToSettings(api, backend, channel);
      }
    }
    return;
  }

  // Try numeric format: "  <num>  <nick/mask>  <level>"
  m = ANOPE_ACCESS_RE.exec(text);
  if (m) {
    const nick = m[1];
    const level = parseInt(m[2], 10);
    if (api.ircLower(nick) === api.ircLower(botNick)) {
      const channel = consumeFirstPendingProbe(probeState.pendingAnopeProbes);
      if (channel) {
        api.debug(`ChanServ ACCESS response for ${channel}: ${nick} level=${level}`);
        backend.handleAccessResponse(channel, level);
        syncAccessToSettings(api, backend, channel);
      }
    }
    return;
  }

  // "End of access list." — if we still have a pending probe, the bot wasn't in the list
  if (text.match(/end of .*access list/i)) {
    const channel = consumeFirstPendingProbe(probeState.pendingAnopeProbes);
    if (channel) {
      api.debug(`ChanServ ACCESS response for ${channel}: not in access list`);
      backend.handleAccessResponse(channel, 0);
    }
    return;
  }

  // "Channel #xxx isn't registered" — resolve the probe for that specific channel.
  const notReg = ANOPE_NOT_REGISTERED_RE.exec(text);
  if (notReg) {
    const channel = notReg[1];
    const key = api.ircLower(channel);
    if (probeState.pendingAnopeProbes.delete(key)) {
      api.debug(`ChanServ ACCESS response for ${channel}: channel not registered`);
      backend.handleAccessResponse(channel, 0);
    }
    return;
  }

  // Generic denial — resolve the oldest pending probe as no-access.
  if (ANOPE_DENIED_RE.test(text)) {
    const channel = consumeFirstPendingProbe(probeState.pendingAnopeProbes);
    if (channel) {
      api.debug(`ChanServ ACCESS response for ${channel}: denied (${text.trim()})`);
      backend.handleAccessResponse(channel, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume and return the first (oldest) pending probe channel. */
function consumeFirstPendingProbe(probes: Map<string, string>): string | undefined {
  const first = probes.entries().next();
  if (first.done) return undefined;
  probes.delete(first.value[0]);
  return first.value[1];
}
