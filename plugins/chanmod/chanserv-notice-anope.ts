// chanmod — Anope ChanServ NOTICE parser
//
// Parses Anope ACCESS LIST responses (XOP + numeric), GETKEY replies, and
// INFO responses (founder detection). Called from chanserv-notice.ts when
// the configured backend is Anope.
import type { PluginAPI } from '../../src/types';
import type { AnopeBackend } from './anope-backend';
import type { ProbeState } from './chanserv-notice';
import { consumeFirstPendingProbe, syncAccessToSettings } from './chanserv-notice';
import { getBotNick } from './helpers';

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

/**
 * Parse an Anope ChanServ NOTICE and route it to the AnopeBackend.
 * Handles ACCESS LIST (XOP + numeric), GETKEY, and INFO (founder) responses.
 */
export function handleAnopeNotice(
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

  // "#channel access list is empty." — Rizon/Anope sends this when the list has no entries
  if (text.match(/^#\S+\s+access list is empty/i)) {
    const channel = consumeFirstPendingProbe(probeState.pendingAnopeProbes);
    if (channel) {
      api.debug(`ChanServ ACCESS response for ${channel}: access list empty`);
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
    return;
  }

  // --- GETKEY response parsing ---

  // Anope GETKEY success: "Key for channel \x02#chan\x02 is \x02thekey\x02."
  // eslint-disable-next-line no-control-regex
  const getkeyMatch = /^Key for channel \x02?(#[^\s\x02]+)\x02? is \x02?(.+?)\x02?\.?$/i.exec(text);
  if (getkeyMatch) {
    const channel = getkeyMatch[1];
    const retrievedKey = getkeyMatch[2];
    const chanKey = api.ircLower(channel);
    const callback = probeState.pendingGetKey.get(chanKey);
    if (callback) {
      probeState.pendingGetKey.delete(chanKey);
      api.debug(`ChanServ GETKEY response for ${channel}: got key`);
      callback(retrievedKey);
    }
    return;
  }

  // Anope GETKEY no-key: "Channel \x02#chan\x02 has no key."
  // eslint-disable-next-line no-control-regex
  const noKeyMatch = /^Channel \x02?(#[^\s\x02]+)\x02? has no key/i.exec(text);
  if (noKeyMatch) {
    const channel = noKeyMatch[1];
    const chanKey = api.ircLower(channel);
    const callback = probeState.pendingGetKey.get(chanKey);
    if (callback) {
      probeState.pendingGetKey.delete(chanKey);
      api.debug(`ChanServ GETKEY response for ${channel}: no key set`);
      callback(null);
    }
    return;
  }

  // --- INFO response parsing (founder detection) ---

  // "Information for channel #xxx:" — start of multi-line INFO response
  // \x02 is IRC bold — Anope may wrap the channel name in bold markers.
  // eslint-disable-next-line no-control-regex
  const infoHeader = /^Information for channel \x02?(#[^\s:\x02]+)\x02?:?\s*$/i.exec(text);
  if (infoHeader) {
    const channel = infoHeader[1];
    const key = api.ircLower(channel);
    if (probeState.pendingInfoProbes.has(key)) {
      probeState.activeInfoChannel = channel;
    }
    return;
  }

  // "Founder: <nick>" — if bot is the founder, resolve INFO probe as founder level
  if (probeState.activeInfoChannel) {
    const founderMatch = /^\s*Founder:\s*(\S+)/i.exec(text);
    if (founderMatch) {
      const founder = founderMatch[1];
      const channel = probeState.activeInfoChannel;
      const key = api.ircLower(channel);
      if (api.ircLower(founder) === api.ircLower(botNick)) {
        probeState.pendingInfoProbes.delete(key);
        probeState.activeInfoChannel = null;
        api.debug(`ChanServ INFO response for ${channel}: bot is founder`);
        backend.handleAccessResponse(channel, 10000);
        syncAccessToSettings(api, backend, channel);
      }
      return;
    }

    // "For more verbose information..." — end of INFO response, clean up
    if (/^For more verbose information/i.test(text)) {
      const channel = probeState.activeInfoChannel;
      const key = api.ircLower(channel);
      probeState.pendingInfoProbes.delete(key);
      probeState.activeInfoChannel = null;
      api.debug(`ChanServ INFO response for ${channel}: bot is not founder`);
      return;
    }
  }
}
