// HexBot — Mock IRC client for testing
// Captures outgoing messages and can simulate incoming events.
import { EventEmitter } from 'node:events';

import type { LifecycleIRCClient } from '../../src/core/connection-lifecycle';

/** A captured outgoing message. */
export interface OutgoingMessage {
  type: 'say' | 'notice' | 'action' | 'join' | 'part' | 'mode' | 'raw' | 'quit' | 'ctcpResponse';
  target?: string;
  message?: string;
  args?: string[];
}

/**
 * Mock irc-framework Client that captures outgoing messages
 * and can simulate incoming IRC events.
 */
export class MockIRCClient extends EventEmitter implements LifecycleIRCClient {
  public messages: OutgoingMessage[] = [];
  public connected = true;
  public network = { supports: (_feature: string): string | boolean => false };
  public user = {
    nick: 'testbot',
    username: 'testbot',
    host: 'localhost',
    away: false,
    toggleModes: () => {},
  };

  say(target: string, message: string): void {
    this.messages.push({ type: 'say', target, message });
  }

  notice(target: string, message: string): void {
    this.messages.push({ type: 'notice', target, message });
  }

  action(target: string, message: string): void {
    this.messages.push({ type: 'action', target, message });
  }

  join(channel: string, key?: string): void {
    this.messages.push({ type: 'join', target: channel, message: key });
  }

  part(channel: string, message?: string): void {
    this.messages.push({ type: 'part', target: channel, message });
  }

  mode(target: string, mode: string, ...params: string[]): void {
    this.messages.push({ type: 'mode', target, message: mode, args: params });
  }

  raw(line: string): void {
    this.messages.push({ type: 'raw', message: line });
  }

  ctcpResponse(target: string, type: string, ...params: string[]): void {
    this.messages.push({
      type: 'ctcpResponse',
      target,
      message: `${type} ${params.join(' ')}`.trim(),
    });
  }

  changeNick(nick: string): void {
    this.user.nick = nick;
  }

  quit(message?: string): void {
    this.messages.push({ type: 'quit', message });
    this.connected = false;
  }

  connect(): void {
    this.connected = true;
  }

  /**
   * Simulate an incoming IRC event by emitting it on the underlying
   * EventEmitter. `event` matches the irc-framework event names that
   * `IRCBridge` listens for ('privmsg', 'join', 'mode', 'ctcp request',
   * 'irc error', 'unknown command', etc.); `data` is the event payload
   * shape that the bridge destructures.
   */
  simulateEvent(event: string, data: Record<string, unknown>): void {
    this.emit(event, data);
  }

  /** Clear all captured messages — useful between scenarios in a single test. */
  clearMessages(): void {
    this.messages = [];
  }

  // Override is needed so MockIRCClient typechecks against the
  // LifecycleIRCClient surface (which expects removeListener), even though
  // we just delegate to EventEmitter's implementation.
  override removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}
