import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Pre-warm the chanmod module so its TS-transform cost (~250ms for 6.5k lines
// across 25 sub-modules) is billed to file-load instead of the first test's
// beforeEach. Without this the first test consistently exceeds the 300ms
// slow-test threshold under full-suite worker contention.
import '../../../plugins/chanmod/index';
import { makeChanmodPluginOverrides } from '../../helpers/chanmod-plugin-config';
import { type MockBot, createMockBot } from '../../helpers/mock-bot';
import { flush, giveBotOps, tick } from '../../helpers/plugin-test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_PATH = resolve('./plugins/chanmod/index.ts');

/** Get ChanServ messages from the mock client. */
function csMessages(bot: MockBot): string[] {
  return bot.client.messages
    .filter((m) => m.type === 'say' && m.target === 'ChanServ')
    .map((m) => m.message ?? '');
}

// Use fake timers for all tests (includes Date so Date.now() advances with vi.advanceTimersByTime)
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Join error recovery tests
// ---------------------------------------------------------------------------

describe('chanmod join-error recovery', () => {
  let bot: MockBot;

  beforeEach(async () => {
    bot = createMockBot({ botNick: 'hexbot' });
    giveBotOps(bot, '#test');
    await bot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
    await flush();
    // Set chanserv_access so the protection chain knows it can unban/invite
    bot.channelSettings.set('#test', 'chanserv_access', 'founder');
    bot.client.clearMessages();
  });

  afterEach(() => {
    bot.cleanup();
  });

  // -------------------------------------------------------------------------
  // banned_from_channel
  // -------------------------------------------------------------------------

  describe('banned_from_channel (474)', () => {
    it('requests ChanServ UNBAN + INVITE and retries join', async () => {
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'Cannot join channel (+b)',
      });
      await flush();

      const msgs = csMessages(bot);
      expect(msgs.some((m) => m.toUpperCase().includes('UNBAN'))).toBe(true);
      // Also sends INVITE (bypass +i/+l) and MODE -k (strip attacker key)
      expect(msgs.some((m) => m.toUpperCase().includes('INVITE'))).toBe(true);
      expect(msgs.some((m) => m.toUpperCase().includes('MODE') && m.includes('-k'))).toBe(true);

      // After services delay (3s), should retry join
      await tick(3100);

      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBeGreaterThanOrEqual(1);
      expect(joins[joins.length - 1].target).toBe('#test');
    });

    it('does nothing without ChanServ access', async () => {
      bot.channelSettings.set('#test', 'chanserv_access', 'none');
      bot.client.clearMessages();

      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'Cannot join channel (+b)',
      });
      await flush();

      expect(csMessages(bot)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // invite_only_channel
  // -------------------------------------------------------------------------

  describe('invite_only_channel (473)', () => {
    it('requests ChanServ INVITE and retries join', async () => {
      bot.client.simulateEvent('irc error', {
        error: 'invite_only_channel',
        channel: '#test',
        reason: 'Cannot join channel (+i)',
      });
      await flush();

      expect(csMessages(bot).some((m) => m.toUpperCase().includes('INVITE'))).toBe(true);

      await tick(3100);

      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBeGreaterThanOrEqual(1);
    });

    it('does nothing without ChanServ access', async () => {
      bot.channelSettings.set('#test', 'chanserv_access', 'none');
      bot.client.clearMessages();

      bot.client.simulateEvent('irc error', {
        error: 'invite_only_channel',
        channel: '#test',
        reason: 'Cannot join channel (+i)',
      });
      await flush();

      expect(csMessages(bot)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // bad_channel_key
  // -------------------------------------------------------------------------

  describe('bad_channel_key (475)', () => {
    it('requests MODE -k via backend to strip key, then INVITE + rejoin', async () => {
      // Bot has founder access — should use requestRemoveKey (MODE -k)
      bot.client.simulateEvent('irc error', {
        error: 'bad_channel_key',
        channel: '#test',
        reason: 'Cannot join channel (+k)',
      });
      await flush();

      const msgs = csMessages(bot);
      // Should send MODE -k to strip the key
      expect(msgs.some((m) => m.toUpperCase().includes('MODE') && m.includes('-k'))).toBe(true);
      // Also sends INVITE to bypass any other restrictions
      expect(msgs.some((m) => m.toUpperCase().includes('INVITE'))).toBe(true);

      await tick(3100);

      // Rejoin after key is removed
      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBeGreaterThanOrEqual(1);
    });

    it('falls back to configured key without ChanServ access', async () => {
      const keyedBot = createMockBot({ botNick: 'hexbot' });
      (keyedBot.botConfig.irc.channels as unknown[]) = [{ name: '#keyed', key: 'secret123' }];

      giveBotOps(keyedBot, '#keyed');
      await keyedBot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
      await flush();
      // No ChanServ access — force key-based fallback
      keyedBot.channelSettings.set('#keyed', 'chanserv_access', 'none');
      keyedBot.client.clearMessages();

      keyedBot.client.simulateEvent('irc error', {
        error: 'bad_channel_key',
        channel: '#keyed',
        reason: 'Cannot join channel (+k)',
      });

      await tick(1100);

      // Should use raw JOIN with key (IRCCommands.join uses raw() for keyed joins)
      const joinRaw = keyedBot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.startsWith('JOIN #keyed'),
      );
      expect(joinRaw.length).toBeGreaterThanOrEqual(1);
      expect(joinRaw[0].message).toBe('JOIN #keyed secret123');

      keyedBot.cleanup();
    });

    it('does nothing without ChanServ access and no key configured', async () => {
      bot.channelSettings.set('#test', 'chanserv_access', 'none');
      bot.client.clearMessages();

      bot.client.simulateEvent('irc error', {
        error: 'bad_channel_key',
        channel: '#test',
        reason: 'Cannot join channel (+k)',
      });
      await flush();
      await tick(1100);

      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBe(0);
      expect(csMessages(bot)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // channel_is_full
  // -------------------------------------------------------------------------

  describe('channel_is_full (471)', () => {
    it('requests ChanServ INVITE when access is available (INVITE bypasses +l)', async () => {
      bot.client.simulateEvent('irc error', {
        error: 'channel_is_full',
        channel: '#test',
        reason: 'Cannot join channel (+l)',
      });
      await flush();

      expect(csMessages(bot).some((m) => m.toUpperCase().includes('INVITE'))).toBe(true);

      await tick(3100);

      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBeGreaterThanOrEqual(1);
    });

    it('does not attempt recovery without ChanServ access', async () => {
      bot.channelSettings.set('#test', 'chanserv_access', 'none');
      bot.client.clearMessages();

      bot.client.simulateEvent('irc error', {
        error: 'channel_is_full',
        channel: '#test',
        reason: 'Cannot join channel (+l)',
      });
      await flush();
      await tick(5000);

      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBe(0);
      expect(csMessages(bot)).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Exponential backoff
  // -------------------------------------------------------------------------

  describe('exponential backoff', () => {
    it('enforces cooldown between recovery attempts', async () => {
      // First attempt — should work
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot).length).toBeGreaterThan(0);
      bot.client.clearMessages();

      // Second attempt immediately — should be on cooldown (backoff is 60s after first)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot)).toHaveLength(0);
    });

    it('does not immediately reset backoff on successful join', async () => {
      // First attempt — advances backoff to 60s
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();
      bot.client.clearMessages();

      // Simulate successful join — does NOT wipe backoff immediately
      bot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      await flush();
      bot.client.clearMessages();

      // Immediate re-ban — should be on cooldown (backoff is 60s)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      // No UNBAN/INVITE recovery messages — backoff still active
      const recovery = csMessages(bot).filter(
        (m) =>
          m.includes('UNBAN') || m.includes('INVITE') || (m.includes('MODE') && m.includes('-k')),
      );
      expect(recovery).toHaveLength(0);
    });

    it('resets backoff after sustained channel presence (5 minutes)', async () => {
      // First attempt — advances backoff to 60s
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();
      bot.client.clearMessages();

      // Simulate successful join — schedules delayed reset
      bot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      await flush();

      // Wait 5 minutes (sustained presence) — backoff should reset
      await tick(300_100);

      // Next attempt should work immediately (backoff was cleared)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot).length).toBeGreaterThan(0);
    });

    it('cancels sustained-presence reset timer if banned again', async () => {
      // First attempt — advances backoff to 60s
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();
      bot.client.clearMessages();

      // Successful join → schedules 5-min reset
      bot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      await flush();

      // Wait 60s (past first backoff) then ban again — cancel the reset timer
      await tick(61_000);
      bot.client.clearMessages();
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();
      // This attempt should succeed (60s cooldown elapsed)
      const recovery1 = csMessages(bot).filter((m) => m.includes('UNBAN'));
      expect(recovery1.length).toBeGreaterThan(0);
      bot.client.clearMessages();

      // Successful join again
      bot.client.simulateEvent('join', {
        nick: 'hexbot',
        ident: 'bot',
        hostname: 'bot.host',
        channel: '#test',
      });
      await flush();
      bot.client.clearMessages();

      // Immediate re-ban — backoff should be 240s now (escalated from 120s)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      // Should be on cooldown — backoff escalated, no recovery messages
      const recovery2 = csMessages(bot).filter(
        (m) =>
          m.includes('UNBAN') || m.includes('INVITE') || (m.includes('MODE') && m.includes('-k')),
      );
      expect(recovery2).toHaveLength(0);
    });

    it('doubles backoff on each attempt, caps at 300s', async () => {
      // Initial backoff: 30s. After first attempt it becomes 60s.
      // After second: 120s. After third: 240s. After fourth: 300s (cap).

      // 1st attempt (backoff starts at 30s, advances to 60s)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();
      bot.client.clearMessages();

      // Advance past 60s backoff
      await tick(61_000);

      // 2nd attempt (backoff advances to 120s)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot).length).toBeGreaterThan(0);
      bot.client.clearMessages();

      // Advance past 120s backoff
      await tick(121_000);

      // 3rd attempt (backoff advances to 240s)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot).length).toBeGreaterThan(0);
      bot.client.clearMessages();

      // Advance past 240s backoff
      await tick(241_000);

      // 4th attempt (backoff advances to 300s — the cap)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot).length).toBeGreaterThan(0);
      bot.client.clearMessages();

      // Advance past 300s cap
      await tick(301_000);

      // 5th attempt — still at 300s cap (not 600s)
      bot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#test',
        reason: 'banned',
      });
      await flush();

      expect(csMessages(bot).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Proactive access probe
  // -------------------------------------------------------------------------

  describe('proactive access probe', () => {
    it('probes ChanServ when access is unknown and retries after probe completes', async () => {
      // Create a bot where chanserv_access is never explicitly set for #probe
      const probeBot = createMockBot({ botNick: 'hexbot' });
      (probeBot.botConfig.irc.channels as unknown[]) = ['#probe'];
      giveBotOps(probeBot, '#probe');
      await probeBot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
      await flush();
      // Do NOT set chanserv_access — it remains at default 'none' (unset)
      probeBot.client.clearMessages();

      probeBot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#probe',
        reason: 'Cannot join channel (+b)',
      });
      await flush();

      // Should have sent a probe (FLAGS or ACCESS LIST) — not an UNBAN yet
      const msgs = probeBot.client.messages.filter(
        (m) => m.type === 'say' && m.target === 'ChanServ',
      );
      // Probe messages (FLAGS/ACCESS/INFO) but no UNBAN
      expect(msgs.some((m) => m.message?.toUpperCase().includes('UNBAN'))).toBe(false);
      expect(msgs.length).toBeGreaterThan(0);

      // Simulate the probe completing and setting access to founder
      probeBot.channelSettings.set('#probe', 'chanserv_access', 'founder');
      probeBot.client.clearMessages();

      // After PROBE_WAIT_MS (11s), the deferred retry should fire
      await tick(11_100);

      // Now should have sent UNBAN (access was detected)
      const retryMsgs = probeBot.client.messages.filter(
        (m) => m.type === 'say' && m.target === 'ChanServ',
      );
      expect(retryMsgs.some((m) => m.message?.toUpperCase().includes('UNBAN'))).toBe(true);

      probeBot.cleanup();
    });

    it('does nothing after probe if access remains none', async () => {
      const probeBot = createMockBot({ botNick: 'hexbot' });
      (probeBot.botConfig.irc.channels as unknown[]) = ['#noaccess'];
      giveBotOps(probeBot, '#noaccess');
      await probeBot.pluginLoader.load(PLUGIN_PATH, makeChanmodPluginOverrides());
      await flush();
      probeBot.client.clearMessages();

      probeBot.client.simulateEvent('irc error', {
        error: 'banned_from_channel',
        channel: '#noaccess',
        reason: 'Cannot join channel (+b)',
      });
      await flush();
      probeBot.client.clearMessages();

      // After PROBE_WAIT_MS, access is still none — no recovery
      await tick(11_100);

      const msgs = probeBot.client.messages.filter(
        (m) => m.type === 'say' && m.target === 'ChanServ',
      );
      expect(msgs.some((m) => m.message?.toUpperCase().includes('UNBAN'))).toBe(false);

      probeBot.cleanup();
    });
  });

  // -------------------------------------------------------------------------
  // need_registered_nick — log only
  // -------------------------------------------------------------------------

  describe('need_registered_nick (477)', () => {
    it('does not attempt recovery', async () => {
      bot.client.simulateEvent('unknown command', {
        command: '477',
        params: ['hexbot', '#test', 'You need to identify to a registered nick'],
      });
      await flush();
      await tick(5000);

      expect(csMessages(bot)).toHaveLength(0);
      const joins = bot.client.messages.filter((m) => m.type === 'join');
      expect(joins.length).toBe(0);
    });
  });
});
