// HexBot — Internal event bus
// Typed EventEmitter for bot-level events (separate from the IRC dispatcher).
import { EventEmitter } from 'node:events';

// ---------------------------------------------------------------------------
// Event definitions
// ---------------------------------------------------------------------------

export interface BotEvents {
  'bot:connected': [];
  'bot:disconnected': [reason: string];
  'bot:error': [error: Error];
  'plugin:loaded': [pluginId: string];
  'plugin:unloaded': [pluginId: string];
  'plugin:reloaded': [pluginId: string];
  'mod:op': [channel: string, nick: string, by: string];
  'mod:kick': [channel: string, nick: string, by: string, reason: string];
  'mod:ban': [channel: string, mask: string, by: string];
  'user:identified': [nick: string, handle: string];
  'user:added': [handle: string];
  'user:removed': [handle: string];
  'user:flagsChanged': [handle: string, globalFlags: string, channelFlags: Record<string, string>];
  'user:hostmaskAdded': [handle: string, hostmask: string];
  'user:hostmaskRemoved': [handle: string, hostmask: string];
  'channel:userJoined': [channel: string, nick: string];
  'channel:userLeft': [channel: string, nick: string];
  'channel:modeChanged': [channel: string, nick: string, mode: string];
  'channel:modesReady': [channel: string];
  'botlink:connected': [botname: string];
  'botlink:disconnected': [botname: string, reason: string];
  'botlink:syncComplete': [botname: string];
  'auth:ban': [ip: string, failures: number, banDurationMs: number];
  'auth:unban': [ip: string];
}

// ---------------------------------------------------------------------------
// Typed event bus
// ---------------------------------------------------------------------------

export class BotEventBus extends EventEmitter {
  override emit<K extends keyof BotEvents>(event: K, ...args: BotEvents[K]): boolean;
  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof BotEvents>(event: K, listener: (...args: BotEvents[K]) => void): this;
  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }

  override once<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void,
  ): this;
  override once(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.once(event, listener);
  }

  override off<K extends keyof BotEvents>(
    event: K,
    listener: (...args: BotEvents[K]) => void,
  ): this;
  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    return super.off(event, listener);
  }
}
