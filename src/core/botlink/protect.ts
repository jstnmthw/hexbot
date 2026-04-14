// HexBot — Bot link protection frame handler
// Extracted from bot.ts for testability. Handles incoming PROTECT_* frames
// by issuing IRC commands when this bot has ops in the target channel.
//
// Identity resolution notes: every "is this a recognized user?" check uses
// the full nick!ident@host from channel-state plus any known services
// account, NOT a nick-only lookup. A nick-only lookup is spoofable — an
// attacker could adopt an op's nick from a different host and become
// immune to DEOP/KICK (or, worse, be auto-opped). See the §7 finding in
// docs/audits/irc-logic-2026-04-11.md.
import type { Casemapping } from '../../utils/wildcard';
import { ircLower } from '../../utils/wildcard';
import type { ChannelState } from '../channel-state';
import type { IRCCommands } from '../irc-commands';
import type { Permissions } from '../permissions';
import type { LinkFrame } from './protocol';

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

  // Resolve the target's full identity via channel-state so the permission
  // lookup below is hostmask+account based instead of nick-only. Returns null
  // if we can't see the user in the channel — callers interpret that as
  // "unknown nick, treat as untrusted".
  const resolveIdentity = (): { hostmask: string; account: string | null } | null => {
    const user = ch.users.get(ircLower(nick, deps.casemapping));
    if (!user) return null;
    return {
      hostmask: user.hostmask,
      account: deps.channelState.getAccountForNick(nick) ?? null,
    };
  };

  const isRecognized = (): boolean => {
    const identity = resolveIdentity();
    if (!identity) return false;
    return deps.permissions.findByHostmask(identity.hostmask, identity.account) !== null;
  };

  switch (frame.type) {
    case 'PROTECT_OP': {
      if (!hasOps) return undefined;
      // Only op users the local permissions DB recognises by FULL hostmask
      // (or account pattern). A nick-only check would let an imposter who
      // took an op's nick become opped remotely via a compromised leaf.
      if (!isRecognized()) {
        return sendAndReturn(false, `Nick "${nick}" not recognized by hostmask/account`);
      }
      deps.ircCommands.op(channel, nick);
      return sendAndReturn(true);
    }
    case 'PROTECT_DEOP': {
      if (!hasOps) return undefined;
      // Refuse friendly fire — don't deop a user whose full identity matches
      // a recognized record. An imposter on the same nick but a different
      // host won't match, so we WILL deop them. That's the safe default.
      if (isRecognized()) {
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
      // Same logic as DEOP — only the recognized full identity is protected.
      if (isRecognized()) {
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
