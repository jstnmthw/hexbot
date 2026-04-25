// chanmod — Anope ChanServ NOTICE parser
//
// Parses Anope ACCESS LIST responses (XOP + numeric), GETKEY replies, and
// INFO responses (founder detection). Called from chanserv-notice.ts when
// the configured backend is Anope.
//
// -------- Race windows worth knowing about --------
//
// 1. INFO ↔ ACCESS LIST interleave. ChanServ emits ACCESS LIST and INFO
//    as separate multi-line replies with no correlation id. The parser
//    tracks `probeState.activeInfoChannel` — set when the INFO header
//    arrives and cleared on the "For more verbose information" trailer.
//    If a second INFO response starts before the first completes (two
//    nearly-simultaneous `.chanset` probes on different channels, or a
//    manual `/cs INFO` from an operator), the trailer clears the wrong
//    channel. Mitigation: we only set `activeInfoChannel` when the
//    header's channel matches a channel we asked about, so stray INFOs
//    from operator traffic are ignored.
//
// 2. Deferred "no access" commit. When ACCESS LIST returns empty we defer
//    the `'none'` commit in `probeState.deferredAnopeNoAccess` until
//    INFO finishes ruling out implicit founder status — otherwise we'd
//    churn the chanset through `founder → none → founder`. During the
//    defer window an operator can run `.chanset chanserv_access founder`
//    and we must not clobber that write. The snapshot comparison at the
//    flush point (line ~178) is the guard: if the current chanset no
//    longer matches what we snapshotted when the defer was recorded, we
//    skip the flush. The race is real but one-sided — the worst outcome
//    is the deferred commit being dropped, which is intentional.
//
// 3. GETKEY callback expiry. `requestRemoveKey` in AnopeBackend registers
//    a pending callback with a 10s timeout. If the key arrives AFTER the
//    timeout cleanup has fired, the late NOTICE is still routed through
//    `resolveGetKey` but there's no callback to invoke — the response is
//    silently dropped. This is intentional: operators retrying on a
//    failed rejoin should drive a fresh probe rather than race with a
//    stale one.
import type { PluginAPI } from '../../src/types';
import type { AnopeNoticeBackend, ProbeState } from './chanserv-notice';
import {
  consumeFirstPendingProbe,
  resolveProbeForBot,
  syncAccessToSettings,
} from './chanserv-notice';
import { getBotNick } from './helpers';

/** Match numeric format: "  <num>  <nick/mask>  <level>" — e.g. "  1  hexbot  5" */
const ANOPE_ACCESS_RE = /^\s*\d+\s+(\S+)\s+(-?\d+)/;
/** Match XOP format (Rizon/Anope with XOP levels): "  <num>  <XOP>  <nick>" — e.g. "  1  SOP  d3m0n" */
const ANOPE_XOP_ACCESS_RE = /^\s*\d+\s+(QOP|SOP|AOP|HOP|VOP)\s+(\S+)/i;
/**
 * Map Anope XOP keyword → equivalent numeric level. These are Anope's
 * default level conventions: QOP (Channel Operator/founder-equivalent),
 * SOP (SuperOp), AOP (AutoOp), HOP (HalfOp), VOP (VoiceOp). The numeric
 * levels mirror what Anope itself reports for the XOP tiers in `ACCESS LIST`,
 * so `levelToTier()` (in anope-backend.ts) can apply a single mapping.
 */
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
const ANOPE_END_OF_LIST_RE = /end of .*access list/i;
const ANOPE_EMPTY_LIST_RE = /^#\S+\s+access list is empty/i;
// Anope GETKEY success: "Key for channel \x02#chan\x02 is \x02thekey\x02."
// eslint-disable-next-line no-control-regex
const ANOPE_GETKEY_OK_RE = /^Key for channel \x02?(#[^\s\x02]+)\x02? is \x02?(.+?)\x02?\.?$/i;
// Anope GETKEY no-key: "Channel \x02#chan\x02 has no key."
// eslint-disable-next-line no-control-regex
const ANOPE_GETKEY_NONE_RE = /^Channel \x02?(#[^\s\x02]+)\x02? has no key/i;
// "Information for channel #xxx:" — start of multi-line INFO response
// eslint-disable-next-line no-control-regex
const ANOPE_INFO_HEADER_RE = /^Information for channel \x02?(#[^\s:\x02]+)\x02?:?\s*$/i;
const ANOPE_INFO_FOUNDER_RE = /^\s*Founder:\s*(\S+)/i;
const ANOPE_INFO_END_RE = /^For more verbose information/i;

/**
 * Parse an Anope ChanServ NOTICE and route it to the AnopeBackend.
 * Handles ACCESS LIST (XOP + numeric), GETKEY, and INFO (founder) responses.
 */
export function handleAnopeNotice(
  api: PluginAPI,
  backend: AnopeNoticeBackend,
  probeState: ProbeState,
  text: string,
): void {
  const botNick = getBotNick(api);
  const accessProbes = probeState.pendingAnopeProbes;

  const applyAccess = (
    channel: string,
    level: number,
    sync: boolean,
    why: string,
    source: 'ACCESS' | 'INFO' = 'ACCESS',
  ): void => {
    api.debug(`ChanServ ${source} response for ${channel}: ${why}`);
    backend.handleAccessResponse(channel, level);
    if (sync) syncAccessToSettings(api, backend, channel);
  };

  // XOP format: "  1  SOP  hexbot"
  let m = ANOPE_XOP_ACCESS_RE.exec(text);
  if (m) {
    const xop = m[1].toUpperCase();
    const level = XOP_TO_LEVEL[xop] ?? 0;
    const channel = resolveProbeForBot(api, botNick, m[2], accessProbes);
    if (channel) applyAccess(channel, level, true, `${xop} (level=${level})`);
    return;
  }

  // Numeric format: "  1  hexbot  5"
  m = ANOPE_ACCESS_RE.exec(text);
  if (m) {
    const level = parseInt(m[2], 10);
    const channel = resolveProbeForBot(api, botNick, m[1], accessProbes);
    if (channel) applyAccess(channel, level, true, `level=${level}`);
    return;
  }

  // "End of access list." — bot wasn't listed
  if (ANOPE_END_OF_LIST_RE.test(text)) {
    const channel = consumeFirstPendingProbe(accessProbes);
    if (channel) deferOrApplyNoAccess(api, probeState, channel, 'not in access list', applyAccess);
    return;
  }

  // "#channel access list is empty."
  if (ANOPE_EMPTY_LIST_RE.test(text)) {
    const channel = consumeFirstPendingProbe(accessProbes);
    if (channel) deferOrApplyNoAccess(api, probeState, channel, 'access list empty', applyAccess);
    return;
  }

  // "Channel #xxx isn't registered" — resolve the probe for that specific channel.
  const notReg = ANOPE_NOT_REGISTERED_RE.exec(text);
  if (notReg) {
    const key = api.ircLower(notReg[1]);
    if (accessProbes.delete(key)) {
      applyAccess(notReg[1], 0, false, 'channel not registered');
    }
    return;
  }

  // Generic denial — resolve the oldest pending probe as no-access.
  if (ANOPE_DENIED_RE.test(text)) {
    const channel = consumeFirstPendingProbe(accessProbes);
    if (channel) applyAccess(channel, 0, false, `denied (${text.trim()})`);
    return;
  }

  // --- GETKEY response parsing ---

  const getkeyOk = ANOPE_GETKEY_OK_RE.exec(text);
  if (getkeyOk) {
    resolveGetKey(api, probeState, getkeyOk[1], getkeyOk[2]);
    return;
  }

  const getkeyNone = ANOPE_GETKEY_NONE_RE.exec(text);
  if (getkeyNone) {
    resolveGetKey(api, probeState, getkeyNone[1], null);
    return;
  }

  // --- INFO response parsing (founder detection) ---

  const infoHeader = ANOPE_INFO_HEADER_RE.exec(text);
  if (infoHeader) {
    const channel = infoHeader[1];
    // Only enter the multi-line INFO state if we asked about this channel;
    // otherwise an operator's manual `/cs INFO #x` would trigger the founder
    // parser below and corrupt our access table for #x.
    if (probeState.pendingInfoProbes.has(api.ircLower(channel))) {
      probeState.activeInfoChannel = channel;
    }
    return;
  }

  if (probeState.activeInfoChannel) {
    const founderMatch = ANOPE_INFO_FOUNDER_RE.exec(text);
    if (founderMatch) {
      const channel = probeState.activeInfoChannel;
      const key = api.ircLower(channel);
      if (api.ircLower(founderMatch[1]) === api.ircLower(botNick)) {
        probeState.pendingInfoProbes.delete(key);
        probeState.activeInfoChannel = null;
        // Founder result supersedes any deferred 'none' commit from ACCESS LIST.
        probeState.deferredAnopeNoAccess.delete(key);
        applyAccess(channel, 10000, true, 'bot is founder', 'INFO');
      }
      return;
    }

    if (ANOPE_INFO_END_RE.test(text)) {
      const channel = probeState.activeInfoChannel;
      const key = api.ircLower(channel);
      probeState.pendingInfoProbes.delete(key);
      probeState.activeInfoChannel = null;
      api.debug(`ChanServ INFO response for ${channel}: bot is not founder`);
      // Flush a deferred 'none' commit now that INFO has ruled out founder —
      // unless the operator wrote a manual `.chanset chanserv_access …`
      // during the defer window. In that case the snapshot no longer matches
      // current, and flushing would clobber the override and desync backend
      // state from the chanset.
      const entry = probeState.deferredAnopeNoAccess.get(key);
      if (entry !== undefined) {
        probeState.deferredAnopeNoAccess.delete(key);
        const current = api.channelSettings.getString(channel, 'chanserv_access');
        if (current !== entry.chansetSnapshot) {
          api.debug(
            `ChanServ INFO for ${channel}: skipping deferred flush — chanset moved ` +
              `${JSON.stringify(entry.chansetSnapshot)} → ${JSON.stringify(current)} during race`,
          );
        } else {
          applyAccess(channel, 0, false, entry.why);
        }
      }
      return;
    }
  }
}

/**
 * When ACCESS LIST returns "no access" for a channel, defer the `'none'`
 * commit if INFO is still pending — INFO might still report the bot as
 * implicit founder, and we don't want to churn backend/chanset state
 * (`'founder' → 'none' → 'founder'`) or emit a misleading "downgrading"
 * warn for a tier that was never actually wrong. If INFO is not pending
 * (not registered, services down, etc.) commit immediately.
 */
function deferOrApplyNoAccess(
  api: PluginAPI,
  probeState: ProbeState,
  channel: string,
  why: string,
  applyAccess: (
    channel: string,
    level: number,
    sync: boolean,
    why: string,
    source?: 'ACCESS' | 'INFO',
  ) => void,
): void {
  const key = api.ircLower(channel);
  if (probeState.pendingInfoProbes.has(key)) {
    const chansetSnapshot = api.channelSettings.getString(channel, 'chanserv_access');
    probeState.deferredAnopeNoAccess.set(key, { why, chansetSnapshot });
    api.debug(
      `ChanServ ACCESS response for ${channel}: ${why} — deferring commit until INFO probe resolves`,
    );
    return;
  }
  applyAccess(channel, 0, false, why);
}

/** Resolve a pending GETKEY callback for a channel, logging the outcome. */
function resolveGetKey(
  api: PluginAPI,
  probeState: ProbeState,
  channel: string,
  key: string | null,
): void {
  const chanKey = api.ircLower(channel);
  const callback = probeState.pendingGetKey.get(chanKey);
  if (!callback) return;
  probeState.pendingGetKey.delete(chanKey);
  api.debug(`ChanServ GETKEY response for ${channel}: ${key === null ? 'no key set' : 'got key'}`);
  callback(key);
}
