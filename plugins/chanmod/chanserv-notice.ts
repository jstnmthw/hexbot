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
import { handleAnopeNotice } from './chanserv-notice-anope';
import { handleAthemeNotice } from './chanserv-notice-atheme';
import type { BackendAccess } from './protection-backend';
import type { ChanmodConfig } from './state';

// ---------------------------------------------------------------------------
// Narrow backend role interfaces — what the ChanServ notice parsers need.
// The concrete `AthemeBackend` / `AnopeBackend` classes satisfy these
// structurally. Tests can pass plain objects without casting.
// ---------------------------------------------------------------------------

/** Common shape the shared `syncAccessToSettings` helper needs. */
export interface NoticeBackendCommon {
  getAccess(channel: string): BackendAccess;
  isAutoDetected(channel: string): boolean;
}

/** Narrow interface `handleAthemeNotice` depends on. */
export interface AthemeNoticeBackend extends NoticeBackendCommon {
  readonly name: 'atheme';
  handleFlagsResponse(channel: string, flags: string): void;
}

/** Narrow interface `handleAnopeNotice` depends on. */
export interface AnopeNoticeBackend extends NoticeBackendCommon {
  readonly name: 'anope';
  handleAccessResponse(channel: string, level: number): void;
}

export type NoticeBackend = AthemeNoticeBackend | AnopeNoticeBackend;

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
  /**
   * Timeout timers for probe responses. Using a Set (instead of an array)
   * so self-removal on fire is O(1); see audit finding W-CM3.
   */
  probeTimers: Set<ReturnType<typeof setTimeout>>;
  /** Channels with pending GETKEY probes. Value = channel name. Callback fires with the key. */
  pendingGetKey: Map<string, (key: string | null) => void>;
}

export function createProbeState(): ProbeState {
  return {
    pendingAthemeProbes: new Map(),
    pendingAnopeProbes: new Map(),
    pendingInfoProbes: new Map(),
    activeInfoChannel: null,
    probeTimers: new Set(),
    pendingGetKey: new Map(),
  };
}

// ---------------------------------------------------------------------------
// Setup — bind the notice handler and dispatch to the right parser
// ---------------------------------------------------------------------------

export interface ChanServNoticeOptions {
  api: PluginAPI;
  config: ChanmodConfig;
  backend: NoticeBackend;
  probeState: ProbeState;
}

/**
 * Bind a notice handler that routes ChanServ responses to the backend.
 * Returns a teardown function.
 */
function isAthemeBackend(b: NoticeBackend): b is AthemeNoticeBackend {
  return b.name === 'atheme';
}

export function setupChanServNotice(opts: ChanServNoticeOptions): () => void {
  const { api, config, backend, probeState } = opts;
  const csNick = config.chanserv_nick;

  api.bind('notice', '-', '*', (ctx) => {
    // Only process notices from ChanServ (PM — channel is null)
    if (ctx.channel !== null) return;
    if (api.ircLower(ctx.nick) !== api.ircLower(csNick)) return;

    const text = ctx.text;

    if (isAthemeBackend(backend)) {
      handleAthemeNotice(api, backend, probeState, text);
    } else {
      handleAnopeNotice(api, backend, probeState, text);
    }
  });

  return () => {
    probeState.pendingAthemeProbes.clear();
    probeState.pendingAnopeProbes.clear();
    probeState.pendingInfoProbes.clear();
    probeState.pendingGetKey.clear();
    probeState.activeInfoChannel = null;
    for (const t of probeState.probeTimers) clearTimeout(t);
    probeState.probeTimers.clear();
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
    probeState.probeTimers.delete(timer);
  }, PROBE_TIMEOUT_MS);
  probeState.probeTimers.add(timer);
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
  backend: NoticeBackendCommon,
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

/**
 * Common "bot nick matched → consume a pending probe → apply" sequence used
 * by both Atheme and Anope parsers. When `channel` is provided, the probe is
 * consumed by exact channel key; otherwise the oldest pending probe is
 * popped. Returns the resolved channel name (for logging) or undefined when
 * the match was for a different nick or no probe was pending.
 */
export function resolveProbeForBot(
  api: PluginAPI,
  botNick: string,
  nick: string,
  probes: Map<string, string>,
  channel?: string,
): string | undefined {
  if (api.ircLower(nick) !== api.ircLower(botNick)) return undefined;
  if (channel) {
    const key = api.ircLower(channel);
    return probes.delete(key) ? channel : undefined;
  }
  return consumeFirstPendingProbe(probes);
}
