import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { LinkFrame } from '../../src/core/botlink';
import { type ProtectHandlerDeps, handleProtectFrame } from '../../src/core/botlink-protect';
import { type MockBot, createMockBot } from '../helpers/mock-bot';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupChannel(bot: MockBot, channel: string, botOpped: boolean): void {
  // Simulate bot joining the channel via the IRC event pipeline
  bot.client.simulateEvent('join', {
    nick: bot.client.user.nick,
    ident: 'bot',
    hostname: 'bot.host',
    channel,
  });

  if (botOpped) {
    bot.client.simulateEvent('mode', {
      target: channel,
      modes: [{ mode: '+o', param: bot.client.user.nick }],
    });
  }
}

function addUserToChannel(
  bot: MockBot,
  channel: string,
  nick: string,
  opts?: { ident?: string; hostname?: string },
): void {
  bot.client.simulateEvent('join', {
    nick,
    ident: opts?.ident ?? 'user',
    hostname: opts?.hostname ?? 'user.host',
    channel,
  });
}

function makeDeps(bot: MockBot): ProtectHandlerDeps {
  const acks: LinkFrame[] = [];
  return {
    channelState: bot.channelState,
    permissions: bot.permissions,
    ircCommands: bot.ircCommands,
    botNick: bot.client.user.nick,
    sendAck: (ack) => acks.push(ack),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleProtectFrame', () => {
  let bot: MockBot;

  beforeEach(() => {
    bot = createMockBot();
  });

  afterEach(() => {
    bot.cleanup();
  });

  describe('PROTECT_OP — permissions DB guard', () => {
    it('refuses to op a nick not in the permissions DB', () => {
      setupChannel(bot, '#test', true);
      addUserToChannel(bot, '#test', 'unknown');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_OP',
          channel: '#test',
          nick: 'unknown',
          requestedBy: 'leaf1',
          ref: 'ref-1',
        },
        deps,
      );

      // Should send a failure ACK
      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
      expect(result!.message).toContain('not in permissions DB');

      // Should NOT have issued a MODE +o
      const opMsgs = bot.client.messages.filter(
        (m) =>
          (m.type === 'mode' && m.message === '+o') ||
          (m.type === 'raw' && m.message?.includes('+o')),
      );
      expect(opMsgs).toHaveLength(0);
    });

    it('ops a nick that IS in the permissions DB', () => {
      setupChannel(bot, '#test', true);
      bot.permissions.addUser('trusted', 'trusted!*@*', 'o', 'test');
      addUserToChannel(bot, '#test', 'trusted');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_OP',
          channel: '#test',
          nick: 'trusted',
          requestedBy: 'leaf1',
          ref: 'ref-2',
        },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);

      // Should have issued MODE +o (via client.mode(), captured as type: 'mode')
      const opMsgs = bot.client.messages.filter(
        (m) => m.type === 'mode' && m.message === '+o' && m.args?.includes('trusted'),
      );
      expect(opMsgs.length).toBeGreaterThan(0);
    });

    it('does nothing when bot does not have ops', () => {
      setupChannel(bot, '#test', false);
      bot.permissions.addUser('trusted', 'trusted!*@*', 'o', 'test');
      addUserToChannel(bot, '#test', 'trusted');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_OP',
          channel: '#test',
          nick: 'trusted',
          requestedBy: 'leaf1',
          ref: 'ref-3',
        },
        deps,
      );

      // No ACK, no mode change — silently ignored
      expect(result).toBeUndefined();
      expect(acks).toHaveLength(0);
      expect(bot.client.messages).toHaveLength(0);
    });
  });

  describe('PROTECT_UNBAN', () => {
    it('sends -b for the target mask when bot has ops', () => {
      setupChannel(bot, '#test', true);

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_UNBAN',
          channel: '#test',
          nick: '*!*@evil.host',
          requestedBy: 'leaf1',
          ref: 'unban-1',
        },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);

      // Should have sent MODE #test -b *!*@evil.host (via client.raw())
      const unbanMsgs = bot.client.messages.filter(
        (m) =>
          m.type === 'raw' && m.message?.includes('-b') && m.message?.includes('*!*@evil.host'),
      );
      expect(unbanMsgs.length).toBeGreaterThan(0);
    });

    it('does nothing when bot does not have ops', () => {
      setupChannel(bot, '#test', false);

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_UNBAN',
          channel: '#test',
          nick: '*!*@evil.host',
          requestedBy: 'leaf1',
          ref: 'unban-2',
        },
        deps,
      );

      expect(result).toBeUndefined();
      expect(acks).toHaveLength(0);
    });
  });

  describe('PROTECT_DEOP — permission guard', () => {
    it('refuses to deop a recognized user', () => {
      setupChannel(bot, '#test', true);
      bot.permissions.addUser('trusted', 'trusted!*@*', 'o', 'test');
      addUserToChannel(bot, '#test', 'trusted');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        { type: 'PROTECT_DEOP', channel: '#test', nick: 'trusted', ref: 'deop-1' },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
      expect(result!.message).toContain('recognized user');
    });

    it('does nothing when bot does not have ops', () => {
      setupChannel(bot, '#test', false);
      addUserToChannel(bot, '#test', 'hostile');

      const deps = makeDeps(bot);
      const result = handleProtectFrame(
        { type: 'PROTECT_DEOP', channel: '#test', nick: 'hostile', ref: 'deop-no-ops' },
        deps,
      );
      expect(result).toBeUndefined();
    });

    it('deops an unrecognized nick', () => {
      setupChannel(bot, '#test', true);
      addUserToChannel(bot, '#test', 'hostile');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        { type: 'PROTECT_DEOP', channel: '#test', nick: 'hostile', ref: 'deop-2' },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
    });
  });

  describe('PROTECT_KICK — permission guard', () => {
    it('refuses to kick a recognized user', () => {
      setupChannel(bot, '#test', true);
      bot.permissions.addUser('trusted', 'trusted!*@*', 'o', 'test');
      addUserToChannel(bot, '#test', 'trusted');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        { type: 'PROTECT_KICK', channel: '#test', nick: 'trusted', ref: 'kick-g1' },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(false);
      expect(result!.message).toContain('recognized user');
    });

    it('does nothing when bot does not have ops', () => {
      setupChannel(bot, '#test', false);
      addUserToChannel(bot, '#test', 'hostile');

      const deps = makeDeps(bot);
      const result = handleProtectFrame(
        { type: 'PROTECT_KICK', channel: '#test', nick: 'hostile', ref: 'kick-no-ops' },
        deps,
      );
      expect(result).toBeUndefined();
    });
  });

  describe('edge cases', () => {
    it('ignores PROTECT_ACK frames', () => {
      const deps = makeDeps(bot);
      const result = handleProtectFrame({ type: 'PROTECT_ACK', ref: 'x', success: true }, deps);
      expect(result).toBeUndefined();
    });

    it('ignores when bot nick not in channel user list (stale state)', () => {
      // Channel exists but bot is not in its user list — botUser is undefined
      if (!bot.channelState.getChannel('#test')) {
        bot.client.simulateEvent('join', {
          nick: 'someone_else',
          ident: 'u',
          hostname: 'h',
          channel: '#test',
        });
      }
      // Don't add the bot to the channel — so botUser lookup returns undefined
      const deps = makeDeps(bot);
      const result = handleProtectFrame(
        { type: 'PROTECT_OP', channel: '#test', nick: 'foo', ref: 'x' },
        deps,
      );
      // hasOps is false (via ?? false), so silently ignored
      expect(result).toBeUndefined();
    });

    it('ignores unknown PROTECT_* subtypes via default branch', () => {
      setupChannel(bot, '#test', true);
      const deps = makeDeps(bot);
      const result = handleProtectFrame(
        { type: 'PROTECT_UNKNOWN', channel: '#test', nick: 'foo', ref: 'x' },
        deps,
      );
      expect(result).toBeUndefined();
    });

    it('ignores frames for unknown channels', () => {
      const deps = makeDeps(bot);
      const result = handleProtectFrame(
        { type: 'PROTECT_OP', channel: '#nonexistent', nick: 'foo', ref: 'x' },
        deps,
      );
      expect(result).toBeUndefined();
    });

    it('ignores frames with missing channel or nick', () => {
      const deps = makeDeps(bot);
      // Empty string values
      expect(
        handleProtectFrame({ type: 'PROTECT_OP', channel: '', nick: 'foo', ref: 'x' }, deps),
      ).toBeUndefined();
      expect(
        handleProtectFrame({ type: 'PROTECT_OP', channel: '#test', nick: '', ref: 'x' }, deps),
      ).toBeUndefined();
      // Completely absent fields (exercises ?? fallbacks — malformed wire data)
      expect(handleProtectFrame({ type: 'PROTECT_OP' }, deps)).toBeUndefined();
    });

    it('handles frames with undefined fields (malformed wire data)', () => {
      setupChannel(bot, '#test', true);
      bot.permissions.addUser('trusted', 'trusted!*@*', 'o', 'test');
      addUserToChannel(bot, '#test', 'trusted');

      const deps = makeDeps(bot);
      // No ref, no requestedBy — exercises ?? fallbacks
      const result = handleProtectFrame(
        { type: 'PROTECT_OP', channel: '#test', nick: 'trusted' },
        deps,
      );
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
      expect(result!.ref).toBe('');
    });

    it('handles PROTECT_KICK with no reason field', () => {
      setupChannel(bot, '#test', true);
      addUserToChannel(bot, '#test', 'hostile');

      const deps = makeDeps(bot);
      // No reason, no requestedBy — exercises ?? fallbacks
      const result = handleProtectFrame(
        { type: 'PROTECT_KICK', channel: '#test', nick: 'hostile' },
        deps,
      );
      expect(result).toBeDefined();
      expect(result!.success).toBe(true);
    });

    it('PROTECT_INVITE requires ops', () => {
      setupChannel(bot, '#test', false);

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_INVITE',
          channel: '#test',
          nick: 'friend',
          requestedBy: 'leaf1',
          ref: 'inv-1',
        },
        deps,
      );

      // Without ops, INVITE is ignored
      expect(result).toBeUndefined();
      expect(bot.client.messages).toHaveLength(0);
    });

    it('PROTECT_INVITE succeeds with ops', () => {
      setupChannel(bot, '#test', true);

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_INVITE',
          channel: '#test',
          nick: 'friend',
          requestedBy: 'leaf1',
          ref: 'inv-2',
        },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);

      const invites = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.includes('INVITE'),
      );
      expect(invites.length).toBeGreaterThan(0);
    });

    it('PROTECT_KICK includes custom reason', () => {
      setupChannel(bot, '#test', true);
      addUserToChannel(bot, '#test', 'hostile');

      const acks: LinkFrame[] = [];
      const deps: ProtectHandlerDeps = {
        channelState: bot.channelState,
        permissions: bot.permissions,
        ircCommands: bot.ircCommands,
        botNick: bot.client.user.nick,
        sendAck: (ack) => acks.push(ack),
      };

      const result = handleProtectFrame(
        {
          type: 'PROTECT_KICK',
          channel: '#test',
          nick: 'hostile',
          requestedBy: 'leaf1',
          reason: 'Takeover response',
          ref: 'kick-1',
        },
        deps,
      );

      expect(result).toBeDefined();
      expect(result!.success).toBe(true);

      const kicks = bot.client.messages.filter(
        (m) => m.type === 'raw' && m.message?.includes('KICK') && m.message?.includes('hostile'),
      );
      expect(kicks.length).toBeGreaterThan(0);
      expect(kicks[0].message).toContain('Takeover response');
    });
  });
});
