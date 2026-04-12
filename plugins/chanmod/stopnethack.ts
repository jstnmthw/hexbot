// chanmod — stopnethack: deop suspicious server-granted ops after netsplit rejoins
//
// When a netsplit is detected (via a burst of split-quit messages), the bot
// snapshots the current op set and monitors +o grants for a configurable
// window. Any +o applied to a nick that wasn't opped before the split —
// or that isn't in the permissions database with an op flag, depending on
// config — is treated as a server-side op hack and immediately reversed.
import type { PluginAPI } from '../../src/types';
import { botHasOps, getUserFlags, hasAnyFlag, markIntentional } from './helpers';
import type { ChanmodConfig, SharedState } from './state';

/** Time window within which split-quits count toward netsplit detection. */
const SPLIT_WINDOW_MS = 5000;
/** Number of split-quits within SPLIT_WINDOW_MS that triggers netsplit mode. */
const SPLIT_THRESHOLD = 3;

/** Returns true if a quit message looks like a netsplit (e.g. "hub.net leaf.net"). */
function isSplitQuit(text: string): boolean {
  const parts = text.trim().split(/\s+/);
  if (parts.length !== 2) return false;
  const isDomain = (s: string): boolean => /^[a-zA-Z0-9]([a-zA-Z0-9.-]*)\.[a-zA-Z]{2,}$/.test(s);
  return isDomain(parts[0]) && isDomain(parts[1]);
}

/** Snapshot current ops in all configured channels into state.splitOpsSnapshot. */
function snapshotOps(api: PluginAPI, state: SharedState): void {
  state.splitOpsSnapshot.clear();
  for (const channel of api.botConfig.irc.channels) {
    const ch = api.getChannel(channel);
    if (!ch) continue;
    const ops = new Set<string>();
    for (const [nick, user] of ch.users) {
      if (user.modes.includes('o')) ops.add(nick); // nick key is already lowercased
    }
    if (ops.size > 0) {
      state.splitOpsSnapshot.set(api.ircLower(channel), ops);
    }
  }
}

/**
 * Register quit + mode binds implementing the stopnethack feature.
 * No-op if `config.stopnethack_mode` is 0.
 */
export function setupStopnethack(api: PluginAPI, config: ChanmodConfig, state: SharedState): void {
  if (config.stopnethack_mode <= 0) return;

  // Detect netsplit via burst of split-quit messages
  api.bind('quit', '-', '*', (ctx) => {
    if (!isSplitQuit(ctx.text)) return;

    const now = Date.now();
    if (now - state.splitQuitWindowStart > SPLIT_WINDOW_MS) {
      state.splitQuitCount = 0;
      state.splitQuitWindowStart = now;
    }
    state.splitQuitCount++;

    if (state.splitQuitCount >= SPLIT_THRESHOLD && !state.splitActive) {
      state.splitActive = true;
      state.splitExpiry = now + config.split_timeout_ms;
      api.log(
        `Stopnethack: netsplit detected (${state.splitQuitCount} split-quits) — monitoring +o for ${config.split_timeout_ms / 1000}s`,
      );
      snapshotOps(api, state);
    }
  });

  // Check suspicious +o grants during/after a split
  api.bind('mode', '-', '*', (ctx) => {
    const { channel } = ctx;
    if (ctx.command !== '+o') return;

    // Only act within the split window
    if (!state.splitActive || Date.now() >= state.splitExpiry) {
      if (state.splitActive && Date.now() >= state.splitExpiry) {
        state.splitActive = false; // expire the window
      }
      return;
    }

    const target = ctx.args;
    if (!target || api.isBotNick(target)) return;

    let isLegitimate: boolean;
    if (config.stopnethack_mode === 1) {
      // isoptest: user must be in permissions db with an op-level flag (and no +d)
      const flags = getUserFlags(api, channel, target);
      isLegitimate = hasAnyFlag(flags, config.op_flags) && !flags?.includes('d');
    } else {
      // stopnethack_mode === 2 (wasoptest) — only valid values are 1 and 2
      // wasoptest: user must have had ops before the split
      const snapshot = state.splitOpsSnapshot.get(api.ircLower(channel));
      isLegitimate = snapshot?.has(api.ircLower(target)) ?? false;
    }

    if (!isLegitimate && botHasOps(api, channel)) {
      api.log(
        `Stopnethack: deoping ${target} in ${channel} (mode ${config.stopnethack_mode}, not legitimate)`,
      );
      markIntentional(state, api, channel, target);
      state.scheduleEnforcement(config.enforce_delay_ms, () => {
        api.deop(channel, target);
      });
    }
  });
}
