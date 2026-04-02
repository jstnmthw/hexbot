// HexBot — Bot link protection frame handler
// Extracted from bot.ts for testability. Handles incoming PROTECT_* frames
// by issuing IRC commands when this bot has ops in the target channel.
import type { Casemapping } from '../utils/wildcard';
import { ircLower } from '../utils/wildcard';
import type { LinkFrame } from './botlink';
import type { ChannelState } from './channel-state';
import type { IRCCommands } from './irc-commands';
import type { Permissions } from './permissions';

export interface ProtectHandlerDeps {
  channelState: ChannelState;
  permissions: Permissions;
  ircCommands: IRCCommands;
  botNick: string;
  casemapping?: Casemapping;
  sendAck: (ack: LinkFrame) => void;
}

/**
 * Handle an incoming PROTECT_* frame.
 * Returns the ACK frame if one was generated, or undefined if the frame was
 * ignored (wrong type, missing channel, bot doesn't have ops, etc.).
 */
export function handleProtectFrame(
  frame: LinkFrame,
  deps: ProtectHandlerDeps,
): LinkFrame | undefined {
  if (!frame.type.startsWith('PROTECT_') || frame.type === 'PROTECT_ACK') return undefined;

  const channel = String(frame.channel ?? '');
  const nick = String(frame.nick ?? '');
  const ref = String(frame.ref ?? '');
  const requestedBy = String(frame.requestedBy ?? '');

  if (!channel || !nick) return undefined;

  const ch = deps.channelState.getChannel(channel);
  if (!ch) return undefined;
  const botUser = ch.users.get(ircLower(deps.botNick, deps.casemapping));
  const hasOps = botUser?.modes.includes('o') ?? false;

  const buildAck = (success: boolean, message?: string): LinkFrame => {
    const ack: LinkFrame = { type: 'PROTECT_ACK', ref, success };
    if (message) ack.message = message;
    return ack;
  };

  const sendAndReturn = (success: boolean, message?: string): LinkFrame => {
    const ack = buildAck(success, message);
    deps.sendAck(ack);
    return ack;
  };

  switch (frame.type) {
    case 'PROTECT_OP': {
      if (!hasOps) return undefined;
      if (!deps.permissions.findByNick(nick)) {
        return sendAndReturn(false, `Nick "${nick}" not in permissions DB`);
      }
      deps.ircCommands.op(channel, nick);
      return sendAndReturn(true);
    }
    case 'PROTECT_DEOP': {
      if (!hasOps) return undefined;
      // Guard: don't deop recognized users with op flags (prevent friendly fire from compromised leaf)
      if (deps.permissions.findByNick(nick)) {
        return sendAndReturn(false, `Nick "${nick}" is a recognized user — refusing DEOP`);
      }
      deps.ircCommands.deop(channel, nick);
      return sendAndReturn(true);
    }
    case 'PROTECT_UNBAN': {
      if (!hasOps) return undefined;
      deps.ircCommands.mode(channel, '-b', nick);
      return sendAndReturn(true);
    }
    case 'PROTECT_INVITE': {
      if (!hasOps) return undefined;
      deps.ircCommands.invite(channel, nick);
      return sendAndReturn(true);
    }
    case 'PROTECT_KICK': {
      if (!hasOps) return undefined;
      // Guard: don't kick recognized users with op flags (prevent friendly fire from compromised leaf)
      if (deps.permissions.findByNick(nick)) {
        return sendAndReturn(false, `Nick "${nick}" is a recognized user — refusing KICK`);
      }
      const reason = String(frame.reason ?? `Requested by ${requestedBy}`);
      deps.ircCommands.kick(channel, nick, reason);
      return sendAndReturn(true);
    }
    default:
      return undefined;
  }
}
