// Type declarations for irc-framework (no official @types package)

declare module 'irc-framework' {
  import { EventEmitter } from 'node:events';

  interface ConnectOptions {
    host: string;
    port: number;
    tls?: boolean;
    nick: string;
    username?: string;
    gecos?: string;
    auto_reconnect?: boolean;
    auto_reconnect_max_wait?: number;
    auto_reconnect_max_retries?: number;
    account?: {
      account: string;
      password: string;
    };
    /** Abort connection if IRC registration doesn't complete within this time (ms). */
    connection_timeout?: number;
    [key: string]: unknown;
  }

  interface IrcUser {
    nick: string;
    username: string;
    host: string;
    away: boolean;
    toggleModes(mode: string): void;
  }

  interface NetworkInfo {
    cap: {
      negotiating: boolean;
      requested: string[];
      enabled: string[];
      available: Map<string, string>;
    };
    supports(feature: string): string | boolean;
  }

  class Client extends EventEmitter {
    constructor(options?: Partial<ConnectOptions>);

    user: IrcUser;
    network: NetworkInfo;
    connected: boolean;

    connect(options?: Partial<ConnectOptions>): void;
    quit(message?: string): void;
    changeNick(nick: string): void;
    say(target: string, message: string): void;
    notice(target: string, message: string): void;
    action(target: string, message: string): void;
    join(channel: string, key?: string): void;
    part(channel: string, message?: string): void;
    mode(target: string, mode: string, ...params: string[]): void;
    raw(line: string): void;
    ctcpRequest(target: string, type: string, ...params: string[]): void;
    ctcpResponse(target: string, type: string, ...params: string[]): void;
    whois(nick: string): void;
    who(target: string): void;

    // Event overloads for common events
    on(event: 'registered', listener: (event: { nick: string }) => void): this;
    on(event: 'connected', listener: (event: { nick: string }) => void): this;
    on(event: 'privmsg', listener: (event: IrcMessageEvent) => void): this;
    on(event: 'action', listener: (event: IrcMessageEvent) => void): this;
    on(event: 'notice', listener: (event: IrcMessageEvent) => void): this;
    on(event: 'join', listener: (event: IrcJoinEvent) => void): this;
    on(event: 'part', listener: (event: IrcPartEvent) => void): this;
    on(event: 'kick', listener: (event: IrcKickEvent) => void): this;
    on(event: 'nick', listener: (event: IrcNickEvent) => void): this;
    on(event: 'mode', listener: (event: IrcModeEvent) => void): this;
    on(event: 'ctcp request', listener: (event: IrcCtcpEvent) => void): this;
    on(event: 'close', listener: () => void): this;
    on(event: 'reconnecting', listener: () => void): this;
    on(event: 'socket error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: unknown[]) => void): this;
  }

  interface IrcMessageEvent {
    nick: string;
    ident: string;
    hostname: string;
    target: string;
    message: string;
    reply(message: string): void;
    type?: string;
  }

  interface IrcJoinEvent {
    nick: string;
    ident: string;
    hostname: string;
    channel: string;
  }

  interface IrcPartEvent {
    nick: string;
    ident: string;
    hostname: string;
    channel: string;
    message: string;
  }

  interface IrcKickEvent {
    nick: string;
    ident: string;
    hostname: string;
    channel: string;
    kicked: string;
    message: string;
  }

  interface IrcNickEvent {
    nick: string;
    new_nick: string;
    ident: string;
    hostname: string;
  }

  interface IrcModeEvent {
    nick: string;
    ident: string;
    hostname: string;
    target: string;
    modes: Array<{
      mode: string;
      param?: string;
    }>;
  }

  interface IrcCtcpEvent {
    nick: string;
    ident: string;
    hostname: string;
    target: string;
    type: string;
    message: string;
  }
}
