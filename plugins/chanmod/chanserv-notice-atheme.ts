// chanmod — Atheme ChanServ NOTICE parser
//
// Parses Atheme FLAGS responses: channel flag strings, not-found errors,
// and unregistered-channel errors. Called from chanserv-notice.ts when
// the configured backend is Atheme.
import type { PluginAPI } from '../../src/types';
import type { AthemeBackend } from './atheme-backend';
import type { ProbeState } from './chanserv-notice';
import { consumeFirstPendingProbe, syncAccessToSettings } from './chanserv-notice';
import { getBotNick } from './helpers';

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

/**
 * Parse an Atheme ChanServ NOTICE and route it to the AthemeBackend.
 * Returns nothing — any state change is pushed to the backend + probe state.
 */
export function handleAthemeNotice(
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
