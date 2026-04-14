// chanmod — Atheme ChanServ NOTICE parser
//
// Parses Atheme FLAGS responses: channel flag strings, not-found errors,
// and unregistered-channel errors. Called from chanserv-notice.ts when
// the configured backend is Atheme.
import type { PluginAPI } from '../../src/types';
import type { AthemeBackend } from './atheme-backend';
import type { ProbeState } from './chanserv-notice';
import { resolveProbeForBot, syncAccessToSettings } from './chanserv-notice';
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
  const probes = probeState.pendingAthemeProbes;

  const applyFlags = (channel: string, flags: string, sync: boolean): void => {
    api.debug(`ChanServ FLAGS response for ${channel}: ${flags}`);
    backend.handleFlagsResponse(channel, flags);
    if (sync) syncAccessToSettings(api, backend, channel);
  };

  // "2 hexbot +flags" — numeric access list entry
  let m = ATHEME_FLAGS_RE.exec(text);
  if (m) {
    const channel = resolveProbeForBot(api, botNick, m[2], probes);
    if (channel) applyFlags(channel, m[3], true);
    return;
  }

  // "Flags for <nick> in <channel> are <flags>." — channel-named response
  m = ATHEME_FLAGS_ALT_RE.exec(text);
  if (m) {
    const channel = resolveProbeForBot(api, botNick, m[1], probes, m[2]);
    if (channel) applyFlags(channel, m[3], true);
    return;
  }

  // "<nick> was not found on the access list of <channel>." — no-access error
  m = ATHEME_NOT_FOUND_RE.exec(text);
  if (m) {
    const channel = resolveProbeForBot(api, botNick, m[1], probes, m[2]);
    if (channel) applyFlags(channel, '(none)', false);
    return;
  }

  // "The channel #xxx is not registered." — unregistered error
  m = ATHEME_NOT_REGISTERED_RE.exec(text);
  if (m) {
    const key = api.ircLower(m[1]);
    if (probes.delete(key)) {
      applyFlags(m[1], '(none)', false);
    }
  }
}
