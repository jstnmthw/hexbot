// chanmod — topic recovery: snapshot known-good topics and restore after takeover
import type { HandlerContext, PluginAPI } from '../../src/types';
import type { ChanmodConfig, SharedState } from './state';
import { THREAT_NORMAL, getThreatLevel } from './takeover-detect';

/**
 * Set up topic recovery binds.
 *
 * Tracks the "known-good" topic per channel:
 * - At threat level 0 (Normal): every topic change updates the snapshot
 * - At elevated threat: the snapshot is frozen (topic changes are vandalism)
 *
 * After recovery (bot opped during elevated threat), if `protect_topic` is
 * enabled and the current topic differs from the snapshot, restore it.
 * The actual restoration is triggered from mode-enforce.ts when the bot
 * receives +o — this module just manages the snapshot.
 */
export function setupTopicRecovery(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
): () => void {
  // Track topic changes — update snapshot only at threat level 0
  api.bind('topic', '-', '*', (ctx: HandlerContext) => {
    const channel = ctx.channel!;
    if (!ctx.text) return;

    const threatLevel = getThreatLevel(api, config, state, channel);
    if (threatLevel === THREAT_NORMAL) {
      // Normal operation — update the known-good snapshot
      state.knownGoodTopics.set(api.ircLower(channel), {
        topic: ctx.text,
        setAt: Date.now(),
      });
    }
    // At elevated threat: snapshot is frozen — do nothing
  });

  return () => {
    state.knownGoodTopics.clear();
  };
}

/**
 * Restore the known-good topic after recovery.
 * Called from mode-enforce.ts when the bot is opped during elevated threat.
 *
 * @returns true if a topic was restored
 */
export function restoreTopicIfNeeded(
  api: PluginAPI,
  config: ChanmodConfig,
  state: SharedState,
  channel: string,
): boolean {
  const protectTopic = api.channelSettings.getFlag(channel, 'protect_topic');
  if (!protectTopic) return false;

  const chanKey = api.ircLower(channel);
  const snapshot = state.knownGoodTopics.get(chanKey);
  if (!snapshot) return false;

  const ch = api.getChannel(channel);
  /* v8 ignore next -- guard for race: channel parted between recovery trigger and execution */
  if (!ch) return false;

  const currentTopic = ch.topic ?? '';
  if (currentTopic === snapshot.topic) return false;

  api.topic(channel, snapshot.topic);
  api.log(`Topic recovery: restored pre-attack topic in ${channel}`);
  return true;
}
