// HexBot — Bot Link shared types
//
// Pure type declarations used by both hub and leaf sides of the link
// protocol. Moved out of `protocol.ts` so importing a `LinkFrame` or
// `LinkPermissions` doesn't imply reaching into a file named "protocol".
import type { Socket } from 'node:net';

import type { CommandContext, CommandEntry, PreExecuteHook } from '../../command-handler';
import type { UserRecord } from '../../types';

/** A link protocol frame — JSON object with a `type` discriminator. */
export interface LinkFrame {
  type: string;
  [key: string]: unknown;
}

/** A user on the cross-bot party line (used in PARTY_WHOM_REPLY). */
export interface PartyLineUser {
  handle: string;
  nick: string;
  botname: string;
  connectedAt: number;
  idle: number;
}

/** Minimal permissions interface needed by BotLink for command relay flag checks. */
export interface LinkPermissions {
  getUser(handle: string): UserRecord | null;
  findByHostmask(fullHostmask: string): UserRecord | null;
  checkFlagsByHandle(requiredFlags: string, handle: string, channel: string | null): boolean;
}

/** Minimal command handler interface needed by BotLink for command relay. */
export interface CommandRelay {
  execute(commandString: string, ctx: CommandContext): Promise<void>;
  getCommand(name: string): CommandEntry | undefined;
  setPreExecuteHook(hook: PreExecuteHook | null): void;
}

/** Factory for creating TCP connections (override in tests). */
export type SocketFactory = (port: number, host: string) => Socket;
