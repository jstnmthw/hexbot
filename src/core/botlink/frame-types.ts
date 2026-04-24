// HexBot — Bot Link frame-type constants
//
// Central `FrameType` const-map to prevent typos in frame-type comparisons
// across hub, leaf, and handler code. The string literals here are also
// listed in `KNOWN_FRAME_TYPES` in `protocol.ts` for decode-time validation;
// keep the two in sync when adding a new frame type.

export const FrameType = {
  // Handshake + heartbeat
  HELLO_CHALLENGE: 'HELLO_CHALLENGE',
  HELLO: 'HELLO',
  WELCOME: 'WELCOME',
  AUTH_OK: 'AUTH_OK',
  AUTH_FAILED: 'AUTH_FAILED',
  ERROR: 'ERROR',
  PING: 'PING',
  PONG: 'PONG',
  // Permission sync
  ADDUSER: 'ADDUSER',
  SETFLAGS: 'SETFLAGS',
  DELUSER: 'DELUSER',
  SYNC_START: 'SYNC_START',
  SYNC_END: 'SYNC_END',
  // Channel state sync
  BOTJOIN: 'BOTJOIN',
  BOTPART: 'BOTPART',
  CHAN: 'CHAN',
  // Ban / exempt list sync
  CHAN_BAN_ADD: 'CHAN_BAN_ADD',
  CHAN_BAN_DEL: 'CHAN_BAN_DEL',
  CHAN_BAN_SYNC: 'CHAN_BAN_SYNC',
  CHAN_EXEMPT_SYNC: 'CHAN_EXEMPT_SYNC',
  // Command / message relay
  CMD: 'CMD',
  CMD_RESULT: 'CMD_RESULT',
  BSAY: 'BSAY',
  ANNOUNCE: 'ANNOUNCE',
  // Party line
  PARTY_JOIN: 'PARTY_JOIN',
  PARTY_PART: 'PARTY_PART',
  PARTY_CHAT: 'PARTY_CHAT',
  PARTY_WHOM: 'PARTY_WHOM',
  PARTY_WHOM_REPLY: 'PARTY_WHOM_REPLY',
  // Protection requests
  PROTECT_OP: 'PROTECT_OP',
  PROTECT_DEOP: 'PROTECT_DEOP',
  PROTECT_KICK: 'PROTECT_KICK',
  PROTECT_UNBAN: 'PROTECT_UNBAN',
  PROTECT_INVITE: 'PROTECT_INVITE',
  PROTECT_TAKEOVER: 'PROTECT_TAKEOVER',
  PROTECT_REGAIN: 'PROTECT_REGAIN',
  PROTECT_ACK: 'PROTECT_ACK',
  // Console relay
  RELAY_REQUEST: 'RELAY_REQUEST',
  RELAY_ACCEPT: 'RELAY_ACCEPT',
  RELAY_INPUT: 'RELAY_INPUT',
  RELAY_OUTPUT: 'RELAY_OUTPUT',
  RELAY_END: 'RELAY_END',
} as const;

export type FrameTypeName = (typeof FrameType)[keyof typeof FrameType];
