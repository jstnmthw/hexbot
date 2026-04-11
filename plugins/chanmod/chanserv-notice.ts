// chanmod — ChanServ notice router + shared probe state
//
// Owns the probe-state registry (pending FLAGS/ACCESS/INFO/GETKEY probes),
// binds a single 'notice' handler, and dispatches ChanServ responses to
// either the Atheme or Anope parser in the sibling files.
//
// Backend-specific parsing lives in:
//   - chanserv-notice-atheme.ts  (Atheme FLAGS responses)
//   - chanserv-notice-anope.ts   (Anope ACCESS LIST, GETKEY, INFO responses)
import type { PluginAPI } from '../../src/types';
import type { AnopeBackend } from './anope-backend';
import type { AthemeBackend } from './atheme-backend';
import { handleAnopeNotice } from './chanserv-notice-anope';
import { handleAthemeNotice } from './chanserv-notice-atheme';
import type { BackendAccess } from './protection-backend';
import type { ChanmodConfig } from './state';

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
  /** Channels with pending Anope INFO probes (founder detection). Value = channel name. */
  pendingInfoProbes: Map<string, string>;
  /** Channel that the current multi-line INFO response is about (set on "Information for channel #xxx:"). */
  activeInfoChannel: string | null;
  /** Timeout timers for probe responses. */
  probeTimers: ReturnType<typeof setTimeout>[];
  /** Channels with pending GETKEY probes. Value = channel name. Callback fires with the key. */
  pendingGetKey: Map<string, (key: string | null) => void>;
}

export function createProbeState(): ProbeState {
  return {
    pendingAthemeProbes: new Map(),
    pendingAnopeProbes: new Map(),
    pendingInfoProbes: new Map(),
    activeInfoChannel: null,
    probeTimers: [],
    pendingGetKey: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Setup — bind the notice handler and dispatch to the right parser
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

  api.bind('notice', '-', '*', (ctx) => {
    // Only process notices from ChanServ (PM — channel is null)
    if (ctx.channel !== null) return;
    if (api.ircLower(ctx.nick) !== api.ircLower(csNick)) return;

    const text = ctx.text;

    if (isAtheme) {
      handleAthemeNotice(api, backend as AthemeBackend, probeState, text);
    } else {
      handleAnopeNotice(api, backend as AnopeBackend, probeState, text);
    }
  });

  return () => {
    probeState.pendingAthemeProbes.clear();
    probeState.pendingAnopeProbes.clear();
    probeState.pendingInfoProbes.clear();
    probeState.pendingGetKey.clear();
    probeState.activeInfoChannel = null;
    for (const t of probeState.probeTimers) clearTimeout(t);
    probeState.probeTimers.length = 0;
  };
}

// ---------------------------------------------------------------------------
// Mark a channel as having a pending probe
// ---------------------------------------------------------------------------

/** Call when a FLAGS/ACCESS/INFO probe is sent, so the notice handler knows to expect a response. */
export function markProbePending(
  api: PluginAPI,
  probeState: ProbeState,
  channel: string,
  backendType: 'atheme' | 'anope' | 'anope-info',
): void {
  const key = api.ircLower(channel);
  const probes =
    backendType === 'atheme'
      ? probeState.pendingAthemeProbes
      : backendType === 'anope-info'
        ? probeState.pendingInfoProbes
        : probeState.pendingAnopeProbes;
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
// Shared helpers — used by both backend parsers
// ---------------------------------------------------------------------------

/**
 * After the backend processes a FLAGS/ACCESS response and auto-detects an access
 * level, sync the detected tier to channelSettings so .chaninfo and other code
 * sees the correct value.
 */
export function syncAccessToSettings(
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

/** Consume and return the first (oldest) pending probe channel. */
export function consumeFirstPendingProbe(probes: Map<string, string>): string | undefined {
  const first = probes.entries().next();
  if (first.done) return undefined;
  probes.delete(first.value[0]);
  return first.value[1];
}
