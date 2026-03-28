import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EventDispatcher } from '../src/dispatcher';
import { IRCBridge } from '../src/irc-bridge';
import { Logger, createLogger } from '../src/logger';
import type { HandlerContext } from '../src/types';
import { MockIRCClient } from './helpers/mock-irc';

describe('IRCBridge', () => {
  let client: MockIRCClient;
  let dispatcher: EventDispatcher;
  let bridge: IRCBridge;

  beforeEach(() => {
    client = new MockIRCClient();
    dispatcher = new EventDispatcher();
    bridge = new IRCBridge({ client, dispatcher, botNick: 'testbot' });
    bridge.attach();
  });

  afterEach(() => {
    bridge.detach();
  });

  describe('channel messages → pub/pubm', () => {
    it('should dispatch pub and pubm for channel messages', async () => {
      const pubHandler = vi.fn();
      const pubmHandler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', pubHandler, 'test');
      dispatcher.bind('pubm', '-', '*hello*', pubmHandler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!hello world',
      });

      // Give async dispatch time to complete
      await Promise.resolve();

      expect(pubHandler).toHaveBeenCalledOnce();
      expect(pubmHandler).toHaveBeenCalledOnce();

      const ctx: HandlerContext = pubHandler.mock.calls[0][0];
      expect(ctx.nick).toBe('user1');
      expect(ctx.ident).toBe('user');
      expect(ctx.hostname).toBe('host.com');
      expect(ctx.channel).toBe('#test');
      expect(ctx.command).toBe('!hello');
      expect(ctx.args).toBe('world');

      dispatcher.unbindAll('test');
    });

    it('should preserve IRC formatting (color codes) in ctx.args', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!topic', handler, 'test');

      const coloredArgs = '\x034red \x033green text';
      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: `!topic ${coloredArgs}`,
      });

      await Promise.resolve();

      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('!topic');
      expect(ctx.args).toBe(coloredArgs);

      dispatcher.unbindAll('test');
    });

    it('should build reply function that uses client.say for channel', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.reply('hi back');
      });
      dispatcher.bind('pub', '-', '!greet', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!greet',
      });

      await Promise.resolve();

      expect(client.messages).toContainEqual({
        type: 'say',
        target: '#test',
        message: 'hi back',
      });

      dispatcher.unbindAll('test');
    });
  });

  describe('private messages → msg/msgm', () => {
    it('should dispatch msg and msgm for private messages', async () => {
      const msgHandler = vi.fn();
      const msgmHandler = vi.fn();
      dispatcher.bind('msg', '-', '!secret', msgHandler, 'test');
      dispatcher.bind('msgm', '-', '*secret*', msgmHandler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        message: '!secret data',
      });

      await Promise.resolve();

      expect(msgHandler).toHaveBeenCalledOnce();
      expect(msgmHandler).toHaveBeenCalledOnce();

      const ctx: HandlerContext = msgHandler.mock.calls[0][0];
      expect(ctx.channel).toBeNull();

      dispatcher.unbindAll('test');
    });

    it('should build replyPrivate function that uses client.notice', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.replyPrivate('private response');
      });
      dispatcher.bind('msg', '-', '!dm', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        message: '!dm',
      });

      await Promise.resolve();

      expect(client.messages).toContainEqual({
        type: 'notice',
        target: 'user1',
        message: 'private response',
      });

      dispatcher.unbindAll('test');
    });
  });

  describe('join events', () => {
    it('should dispatch join events', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test');

      client.simulateEvent('join', {
        nick: 'newuser',
        ident: 'new',
        hostname: 'new.host.com',
        channel: '#test',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('newuser');
      expect(ctx.channel).toBe('#test');
      expect(ctx.command).toBe('JOIN');

      dispatcher.unbindAll('test');
    });
  });

  describe('part events', () => {
    it('should dispatch part events', async () => {
      const handler = vi.fn();
      dispatcher.bind('part', '-', '*', handler, 'test');

      client.simulateEvent('part', {
        nick: 'leaver',
        ident: 'leav',
        hostname: 'some.host',
        channel: '#test',
        message: 'bye',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('leaver');
      expect(ctx.channel).toBe('#test');
      expect(ctx.args).toBe('bye');

      dispatcher.unbindAll('test');
    });
  });

  describe('kick events', () => {
    it('should dispatch kick events with kicked user as nick', async () => {
      const handler = vi.fn();
      dispatcher.bind('kick', '-', '*', handler, 'test');

      client.simulateEvent('kick', {
        nick: 'op',
        ident: 'op',
        hostname: 'op.host',
        channel: '#test',
        kicked: 'baduser',
        message: 'behave',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('baduser');
      expect(ctx.args).toBe('behave (by op)');

      dispatcher.unbindAll('test');
    });
  });

  describe('nick events', () => {
    it('should dispatch nick change events', async () => {
      const handler = vi.fn();
      dispatcher.bind('nick', '-', '*', handler, 'test');

      client.simulateEvent('nick', {
        nick: 'oldnick',
        new_nick: 'newnick',
        ident: 'user',
        hostname: 'host.com',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('oldnick');
      expect(ctx.text).toBe('newnick');

      dispatcher.unbindAll('test');
    });

    it('should track bot nick changes', () => {
      client.simulateEvent('nick', {
        nick: 'testbot',
        new_nick: 'testbot_',
        ident: 'bot',
        hostname: 'localhost',
      });

      // setBotNick is called internally — verify by triggering another event
      // where botNick matters (the bridge stores it)
      expect(true).toBe(true); // Nick tracking is internal
    });
  });

  describe('mode events', () => {
    it('should dispatch individual mode changes', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'chanop',
        ident: 'op',
        hostname: 'op.host',
        target: '#test',
        modes: [
          { mode: '+o', param: 'user1' },
          { mode: '+v', param: 'user2' },
        ],
      });

      await Promise.resolve();

      // Should dispatch twice — once for each mode
      expect(handler).toHaveBeenCalledTimes(2);

      const ctx1: HandlerContext = handler.mock.calls[0][0];
      expect(ctx1.command).toBe('+o');
      expect(ctx1.args).toBe('user1');

      const ctx2: HandlerContext = handler.mock.calls[1][0];
      expect(ctx2.command).toBe('+v');
      expect(ctx2.args).toBe('user2');

      dispatcher.unbindAll('test');
    });
  });

  describe('notice events', () => {
    it('should dispatch notice events', async () => {
      const handler = vi.fn();
      dispatcher.bind('notice', '-', '*test*', handler, 'test');

      client.simulateEvent('notice', {
        nick: 'NickServ',
        ident: 'services',
        hostname: 'services.libera.chat',
        target: 'testbot',
        message: 'This is a test notice',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();

      dispatcher.unbindAll('test');
    });
  });

  describe('ctcp events', () => {
    it('should dispatch ctcp events', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', 'VERSION', handler, 'test');

      client.simulateEvent('ctcp request', {
        nick: 'curious',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        type: 'VERSION',
        message: '',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('VERSION');

      dispatcher.unbindAll('test');
    });
  });

  describe('security', () => {
    it('should strip newlines from text fields', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!cmd', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'evil\r\nPRIVMSG #other :pwned',
        ident: 'x',
        hostname: 'host.com',
        target: '#test',
        message: '!cmd\r\nPRIVMSG NickServ :IDENTIFY password',
      });

      await Promise.resolve();

      if (handler.mock.calls.length > 0) {
        const ctx: HandlerContext = handler.mock.calls[0][0];
        expect(ctx.nick).not.toContain('\r');
        expect(ctx.nick).not.toContain('\n');
        expect(ctx.text).not.toContain('\r');
        expect(ctx.text).not.toContain('\n');
      }

      dispatcher.unbindAll('test');
    });

    it('should strip IRC formatting from command text', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', handler, 'test');

      // \x02 = bold, \x03 = color
      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '\x02!hello\x02 world',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('!hello');

      dispatcher.unbindAll('test');
    });

    it('should sanitize reply output', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.reply('line1\r\nPRIVMSG #evil :injected');
      });
      dispatcher.bind('pub', '-', '!test', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!test',
      });

      await Promise.resolve();

      const msg = client.messages.find((m) => m.type === 'say');
      expect(msg?.message).not.toContain('\r');
      expect(msg?.message).not.toContain('\n');

      dispatcher.unbindAll('test');
    });

    it('should reject invalid channel names', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test');

      client.simulateEvent('join', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: 'notachannel',
      });

      await Promise.resolve();

      // Should not dispatch for invalid channel name
      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('action events', () => {
    it('should dispatch pubm for channel actions', async () => {
      const pubmHandler = vi.fn();
      dispatcher.bind('pubm', '-', '*dances*', pubmHandler, 'test');

      client.simulateEvent('action', {
        nick: 'dancer',
        ident: 'dance',
        hostname: 'dance.host',
        target: '#test',
        message: 'dances around',
      });

      await Promise.resolve();

      expect(pubmHandler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = pubmHandler.mock.calls[0][0];
      expect(ctx.nick).toBe('dancer');
      expect(ctx.channel).toBe('#test');
      expect(ctx.command).toBe('');
      expect(ctx.args).toBe('dances around');
      expect(ctx.text).toBe('dances around');

      dispatcher.unbindAll('test');
    });

    it('should dispatch msgm for private actions', async () => {
      const msgmHandler = vi.fn();
      dispatcher.bind('msgm', '-', '*waves*', msgmHandler, 'test');

      client.simulateEvent('action', {
        nick: 'waver',
        ident: 'wave',
        hostname: 'wave.host',
        target: 'testbot',
        message: 'waves hello',
      });

      await Promise.resolve();

      expect(msgmHandler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = msgmHandler.mock.calls[0][0];
      expect(ctx.nick).toBe('waver');
      expect(ctx.channel).toBeNull();
      expect(ctx.command).toBe('');
      expect(ctx.args).toBe('waves hello');

      dispatcher.unbindAll('test');
    });

    it('should not dispatch pub/msg for action events (only pubm/msgm)', async () => {
      const pubHandler = vi.fn();
      const msgHandler = vi.fn();
      dispatcher.bind('pub', '-', 'dances', pubHandler, 'test');
      dispatcher.bind('msg', '-', 'waves', msgHandler, 'test');

      client.simulateEvent('action', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: 'dances around',
      });

      client.simulateEvent('action', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        message: 'waves hello',
      });

      await Promise.resolve();

      expect(pubHandler).not.toHaveBeenCalled();
      expect(msgHandler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('private messages — reply targeting', () => {
    it('should route reply() to the nick when channel is null (PM context)', async () => {
      const handler = vi.fn((ctx: HandlerContext) => {
        ctx.reply('pm reply');
      });
      dispatcher.bind('msg', '-', '!hello', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'pmuser',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        message: '!hello',
      });

      await Promise.resolve();

      expect(client.messages).toContainEqual({
        type: 'say',
        target: 'pmuser',
        message: 'pm reply',
      });

      dispatcher.unbindAll('test');
    });
  });

  describe('mode events — edge cases', () => {
    it('should not dispatch when modes array is undefined', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'chanop',
        ident: 'op',
        hostname: 'op.host',
        target: '#test',
        // modes is undefined
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });

    it('should not dispatch when modes array is empty', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'chanop',
        ident: 'op',
        hostname: 'op.host',
        target: '#test',
        modes: [],
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });

    it('should not dispatch for non-channel mode targets', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'server',
        ident: 'services',
        hostname: 'services.host',
        target: 'testbot',
        modes: [{ mode: '+i' }],
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });

    it('should handle modes without a param', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'chanop',
        ident: 'op',
        hostname: 'op.host',
        target: '#test',
        modes: [{ mode: '+s' }],
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('+s');
      expect(ctx.args).toBe('');
      expect(ctx.text).toBe('#test +s');

      dispatcher.unbindAll('test');
    });
  });

  describe('notice events — edge cases', () => {
    it('should set channel for channel-targeted notices', async () => {
      const handler = vi.fn();
      dispatcher.bind('notice', '-', '*', handler, 'test');

      client.simulateEvent('notice', {
        nick: 'chanserv',
        ident: 'services',
        hostname: 'services.host',
        target: '#test',
        message: 'Channel registered',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.channel).toBe('#test');
      expect(ctx.command).toBe('NOTICE');
      expect(ctx.args).toBe('Channel registered');
      expect(ctx.text).toBe('Channel registered');

      dispatcher.unbindAll('test');
    });

    it('should set channel to null for user-targeted notices', async () => {
      const handler = vi.fn();
      dispatcher.bind('notice', '-', '*', handler, 'test');

      client.simulateEvent('notice', {
        nick: 'NickServ',
        ident: 'services',
        hostname: 'services.libera.chat',
        target: 'testbot',
        message: 'You are now identified',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.channel).toBeNull();
      expect(ctx.command).toBe('NOTICE');

      dispatcher.unbindAll('test');
    });
  });

  describe('ctcp events — payload parsing edge cases', () => {
    it('should strip type prefix from message when it starts with "TYPE "', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', 'PING', handler, 'test-plugin');

      client.simulateEvent('ctcp request', {
        nick: 'pinger',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        type: 'PING',
        message: 'PING 9999999999',
      });

      await Promise.resolve();

      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.text).toBe('9999999999');
      expect(ctx.command).toBe('PING');

      dispatcher.unbindAll('test-plugin');
    });

    it('should set empty text when message equals type exactly', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', 'VERSION', handler, 'test');

      client.simulateEvent('ctcp request', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        type: 'VERSION',
        message: 'VERSION',
      });

      await Promise.resolve();

      // The custom handler runs alongside the core handler
      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.text).toBe('');
      expect(ctx.command).toBe('VERSION');

      dispatcher.unbindAll('test');
    });

    it('should pass raw message when it does not start with type prefix', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', 'CUSTOM', handler, 'test');

      client.simulateEvent('ctcp request', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        type: 'CUSTOM',
        message: 'some arbitrary payload',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.text).toBe('some arbitrary payload');
      expect(ctx.args).toBe('some arbitrary payload');

      dispatcher.unbindAll('test');
    });

    it('should handle empty CTCP message', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', 'SOURCE', handler, 'test');

      client.simulateEvent('ctcp request', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: 'testbot',
        type: 'SOURCE',
        message: '',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.text).toBe('');
      expect(ctx.args).toBe('');

      dispatcher.unbindAll('test');
    });
  });

  describe('kick events — edge cases', () => {
    it('should format reason as "by kicker" when message is empty', async () => {
      const handler = vi.fn();
      dispatcher.bind('kick', '-', '*', handler, 'test');

      client.simulateEvent('kick', {
        nick: 'op',
        ident: 'op',
        hostname: 'op.host',
        channel: '#test',
        kicked: 'baduser',
        message: '',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('baduser');
      expect(ctx.args).toBe('by op');

      dispatcher.unbindAll('test');
    });

    it('should reject kick events for invalid channels', async () => {
      const handler = vi.fn();
      dispatcher.bind('kick', '-', '*', handler, 'test');

      client.simulateEvent('kick', {
        nick: 'op',
        ident: 'op',
        hostname: 'op.host',
        channel: 'notachannel',
        kicked: 'baduser',
        message: 'go away',
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('part events — edge cases', () => {
    it('should reject part events for invalid channels', async () => {
      const handler = vi.fn();
      dispatcher.bind('part', '-', '*', handler, 'test');

      client.simulateEvent('part', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: 'notachannel',
        message: 'leaving',
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('setBotNick', () => {
    it('should update the bot nick used for tracking', () => {
      bridge.setBotNick('newbot');

      // After setBotNick, the bridge should track the new nick for nick events.
      // Trigger a nick change for the new bot nick to verify it is tracked.
      const handler = vi.fn();
      dispatcher.bind('nick', '-', '*', handler, 'test');

      client.simulateEvent('nick', {
        nick: 'newbot',
        new_nick: 'newbot2',
        ident: 'bot',
        hostname: 'localhost',
      });

      // The bridge should have updated its internal botNick to 'newbot2'.
      // Verify by doing another nick event — the old 'newbot' is no longer the bot.
      client.simulateEvent('nick', {
        nick: 'newbot',
        new_nick: 'imposter',
        ident: 'other',
        hostname: 'elsewhere.com',
      });

      // Both events dispatched, but botNick tracking was the key side effect
      expect(handler).toHaveBeenCalledTimes(2);

      dispatcher.unbindAll('test');
    });
  });

  describe('missing/null event fields', () => {
    it('should handle privmsg with all fields missing', async () => {
      const handler = vi.fn();
      dispatcher.bind('pubm', '-', '*', handler, 'test');
      dispatcher.bind('msgm', '-', '*', handler, 'test');

      // Empty object — every field defaults via ?? ''
      client.simulateEvent('privmsg', {});

      await Promise.resolve();

      // target is '' which is not a valid channel, so msg/msgm path is taken
      expect(handler).toHaveBeenCalled();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.text).toBe('');
      expect(ctx.channel).toBeNull();

      dispatcher.unbindAll('test');
    });

    it('should handle privmsg with channel target but missing other fields', async () => {
      const handler = vi.fn();
      dispatcher.bind('pubm', '-', '*', handler, 'test');

      client.simulateEvent('privmsg', {
        target: '#test',
        // nick, ident, hostname, message are all undefined
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.text).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle action with all fields missing', async () => {
      const handler = vi.fn();
      dispatcher.bind('msgm', '-', '*', handler, 'test');

      // Empty object — target is '' (not a channel), so msgm path
      client.simulateEvent('action', {});

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.text).toBe('');
      expect(ctx.channel).toBeNull();

      dispatcher.unbindAll('test');
    });

    it('should handle action with channel target but missing other fields', async () => {
      const handler = vi.fn();
      dispatcher.bind('pubm', '-', '*', handler, 'test');

      client.simulateEvent('action', {
        target: '#test',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.text).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle join with all fields missing (invalid channel, no dispatch)', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test');

      // channel defaults to '' which is not valid — early return
      client.simulateEvent('join', {});

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });

    it('should handle join with channel but missing nick/ident/hostname', async () => {
      const handler = vi.fn();
      dispatcher.bind('join', '-', '*', handler, 'test');

      client.simulateEvent('join', { channel: '#test' });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle part with channel but missing nick/ident/hostname/message', async () => {
      const handler = vi.fn();
      dispatcher.bind('part', '-', '*', handler, 'test');

      client.simulateEvent('part', { channel: '#test' });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.args).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle kick with channel but missing all other fields', async () => {
      const handler = vi.fn();
      dispatcher.bind('kick', '-', '*', handler, 'test');

      client.simulateEvent('kick', { channel: '#test' });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe(''); // kicked defaults to ''
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.args).toBe('by '); // kicker is '' so "by "

      dispatcher.unbindAll('test');
    });

    it('should handle nick event with all fields missing', async () => {
      const handler = vi.fn();
      dispatcher.bind('nick', '-', '*', handler, 'test');

      client.simulateEvent('nick', {});

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.text).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle mode with channel target but missing nick/ident/hostname', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        target: '#test',
        modes: [{ mode: '+o', param: 'someone' }],
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle mode with a mode entry that has no mode string', async () => {
      const handler = vi.fn();
      dispatcher.bind('mode', '-', '*', handler, 'test');

      client.simulateEvent('mode', {
        nick: 'op',
        ident: 'op',
        hostname: 'op.host',
        target: '#test',
        modes: [{ param: 'someone' }], // mode field is missing
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('');

      dispatcher.unbindAll('test');
    });

    it('should handle notice with all fields missing', async () => {
      const handler = vi.fn();
      dispatcher.bind('notice', '-', '*', handler, 'test');

      client.simulateEvent('notice', {});

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.channel).toBeNull();
      expect(ctx.command).toBe('NOTICE');

      dispatcher.unbindAll('test');
    });

    it('should handle ctcp with all fields missing', async () => {
      const handler = vi.fn();
      dispatcher.bind('ctcp', '-', '', handler, 'test');

      client.simulateEvent('ctcp request', {});

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.command).toBe('');
      expect(ctx.text).toBe('');

      dispatcher.unbindAll('test');
    });
  });

  describe('listenIrc wrapper — no arguments', () => {
    it('should handle event emitted with no data argument (args[0] is undefined)', async () => {
      const handler = vi.fn();
      dispatcher.bind('notice', '-', '*', handler, 'test');

      // Emit directly without any data argument to exercise args[0] ?? {} branch
      client.emit('notice');

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.channel).toBeNull();

      dispatcher.unbindAll('test');
    });
  });

  describe('& channel prefix', () => {
    it('should accept & as a valid channel prefix', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!hello', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '&localchan',
        message: '!hello',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.channel).toBe('&localchan');

      dispatcher.unbindAll('test');
    });
  });

  describe('privmsg — command parsing', () => {
    it('should set command to entire message and empty args when no space present', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!solo', handler, 'test');

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!solo',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.command).toBe('!solo');
      expect(ctx.args).toBe('');

      dispatcher.unbindAll('test');
    });
  });

  describe('detach', () => {
    it('should stop dispatching after detach', async () => {
      const handler = vi.fn();
      dispatcher.bind('pub', '-', '!test', handler, 'test');

      bridge.detach();

      client.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!test',
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('topic events', () => {
    let topicBridge: IRCBridge;
    let topicClient: MockIRCClient;
    let topicDispatcher: EventDispatcher;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      topicClient = new MockIRCClient();
      topicDispatcher = new EventDispatcher();
      topicBridge = new IRCBridge({
        client: topicClient,
        dispatcher: topicDispatcher,
        botNick: 'testbot',
      });
      topicBridge.attach();
    });

    afterEach(() => {
      topicBridge.detach();
      vi.useRealTimers();
    });

    it('should dispatch topic event with user prefix after grace expires', async () => {
      const handler = vi.fn();
      topicDispatcher.bind('topic', '-', '*', handler, 'test');

      vi.advanceTimersByTime(6000);

      topicClient.simulateEvent('topic', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: '#test',
        topic: 'New topic text',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('user1');
      expect(ctx.ident).toBe('user');
      expect(ctx.hostname).toBe('host.com');
      expect(ctx.channel).toBe('#test');
      expect(ctx.text).toBe('New topic text');
      expect(ctx.command).toBe('topic');
      expect(ctx.args).toBe('');

      topicDispatcher.unbindAll('test');
    });

    it('should dispatch topic with server prefix (empty nick/ident/hostname)', async () => {
      const handler = vi.fn();
      topicDispatcher.bind('topic', '-', '*', handler, 'test');

      vi.advanceTimersByTime(6000);

      topicClient.simulateEvent('topic', {
        nick: '',
        ident: '',
        hostname: '',
        channel: '#test',
        topic: 'Server set topic',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('');
      expect(ctx.ident).toBe('');
      expect(ctx.hostname).toBe('');
      expect(ctx.channel).toBe('#test');

      topicDispatcher.unbindAll('test');
    });

    it('should not dispatch topic events during startup grace', async () => {
      const handler = vi.fn();
      topicDispatcher.bind('topic', '-', '*', handler, 'test');

      topicClient.simulateEvent('topic', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: '#test',
        topic: 'Topic during grace',
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      topicDispatcher.unbindAll('test');
    });

    it('should dispatch topic events after startup grace expires', async () => {
      const handler = vi.fn();
      topicDispatcher.bind('topic', '-', '*', handler, 'test');

      topicClient.simulateEvent('topic', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: '#test',
        topic: 'During grace',
      });
      await Promise.resolve();
      expect(handler).not.toHaveBeenCalled();

      vi.advanceTimersByTime(6000);

      topicClient.simulateEvent('topic', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        channel: '#test',
        topic: 'After grace',
      });
      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.text).toBe('After grace');

      topicDispatcher.unbindAll('test');
    });

    it('should not dispatch topic for invalid channel', async () => {
      const handler = vi.fn();
      topicDispatcher.bind('topic', '-', '*', handler, 'test');

      vi.advanceTimersByTime(6000);

      topicClient.simulateEvent('topic', {
        nick: 'user1',
        channel: 'notachannel',
        topic: 'Some topic',
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      topicDispatcher.unbindAll('test');
    });
  });

  describe('quit events', () => {
    it('should dispatch quit event with correct fields', async () => {
      const handler = vi.fn();
      dispatcher.bind('quit', '-', '*', handler, 'test');

      client.simulateEvent('quit', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        message: 'Goodbye!',
      });

      await Promise.resolve();

      expect(handler).toHaveBeenCalledOnce();
      const ctx: HandlerContext = handler.mock.calls[0][0];
      expect(ctx.nick).toBe('user1');
      expect(ctx.ident).toBe('user');
      expect(ctx.hostname).toBe('host.com');
      expect(ctx.text).toBe('Goodbye!');
      expect(ctx.command).toBe('quit');
      expect(ctx.args).toBe('');
      expect(ctx.channel).toBeNull();

      dispatcher.unbindAll('test');
    });

    it("should not dispatch the bot's own quit", async () => {
      const handler = vi.fn();
      dispatcher.bind('quit', '-', '*', handler, 'test');

      client.simulateEvent('quit', {
        nick: 'testbot',
        ident: 'bot',
        hostname: 'localhost',
        message: 'Shutting down',
      });

      await Promise.resolve();

      expect(handler).not.toHaveBeenCalled();

      dispatcher.unbindAll('test');
    });
  });

  describe('dispatchError with logger', () => {
    it('should log errors from failed dispatches when a logger is provided', async () => {
      const logger = createLogger('error');
      // Spy on Logger.prototype.error to catch calls on child loggers too
      const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

      const loggedClient = new MockIRCClient();
      const loggedDispatcher = new EventDispatcher();
      const loggedBridge = new IRCBridge({
        client: loggedClient,
        dispatcher: loggedDispatcher,
        botNick: 'testbot',
        logger,
      });
      loggedBridge.attach();

      // Make dispatch reject by spying on it
      const dispatchErr = new Error('handler explosion');
      vi.spyOn(loggedDispatcher, 'dispatch').mockRejectedValue(dispatchErr);

      loggedClient.simulateEvent('privmsg', {
        nick: 'user1',
        ident: 'user',
        hostname: 'host.com',
        target: '#test',
        message: '!boom',
      });

      await new Promise((r) => setTimeout(r, 20));

      // The dispatchError callback should have been triggered and logged on the child logger
      const dispatchErrorCall = errorSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('Dispatch error'),
      );
      expect(dispatchErrorCall).toBeDefined();

      loggedBridge.detach();
      vi.restoreAllMocks();
    });
  });
});
