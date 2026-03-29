// hexbot — Mock IRC client for testing
// Captures outgoing messages and can simulate incoming events.
import { EventEmitter } from 'node:events';

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
export class MockIRCClient extends EventEmitter {
  public messages: OutgoingMessage[] = [];
  public connected = true;
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

  quit(message?: string): void {
    this.messages.push({ type: 'quit', message });
    this.connected = false;
  }

  connect(): void {
    this.connected = true;
  }

  /** Simulate an incoming IRC event. */
  simulateEvent(event: string, data: Record<string, unknown>): void {
    this.emit(event, data);
  }

  /** Clear all captured messages. */
  clearMessages(): void {
    this.messages = [];
  }

  // Stub methods for removeListener compatibility
  override removeListener(event: string, listener: (...args: unknown[]) => void): this {
    return super.removeListener(event, listener);
  }
}
