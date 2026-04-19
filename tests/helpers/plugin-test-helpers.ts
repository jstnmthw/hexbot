// HexBot — Shared plugin test helpers
// Consolidates the small dispatch/tick/simulate helpers that nearly every
// plugin test file used to redefine. Behavior is bit-identical to the
// previous per-file copies; any test needing a custom variant should keep
// its local definition rather than import from here.
import { vi } from 'vitest';

import type { MockBot } from './mock-bot';

/** Flush microtasks — sufficient for synchronous handlers dispatched via async dispatch(). */
export async function flush(): Promise<void> {
  await Promise.resolve();
}

/** Advance fake timers (enforcement delays, async handlers). */
export async function tick(ms = 20): Promise<void> {
  // Drain async event handler chain before advancing fake timers
  await new Promise<void>((r) => setImmediate(r));
  await vi.advanceTimersByTimeAsync(ms);
}

/** Simulate a JOIN event on the mock IRC client. */
export function simulateJoin(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

/** Simulate a PRIVMSG event on the mock IRC client. */
export function simulatePrivmsg(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
  message: string,
): void {
  bot.client.simulateEvent('privmsg', { nick, ident, hostname, target: channel, message });
}

/** Simulate a MODE event on the mock IRC client. */
export function simulateMode(
  bot: MockBot,
  setter: string,
  channel: string,
  mode: string,
  param: string,
): void {
  bot.client.simulateEvent('mode', {
    nick: setter,
    ident: 'ident',
    hostname: 'host',
    target: channel,
    modes: [{ mode, param }],
  });
}

/** Add a user to channel-state so getUserHostmask works. */
export function addToChannel(
  bot: MockBot,
  nick: string,
  ident: string,
  hostname: string,
  channel: string,
): void {
  bot.client.simulateEvent('join', { nick, ident, hostname, channel });
}

/** Simulate the bot joining a channel with ops (via ChanServ +o). */
export function giveBotOps(bot: MockBot, channel: string): void {
  const nick = bot.client.user.nick;
  bot.client.simulateEvent('join', { nick, ident: 'bot', hostname: 'bot.host', channel });
  bot.client.simulateEvent('mode', {
    nick: 'ChanServ',
    ident: 'ChanServ',
    hostname: 'services.',
    target: channel,
    modes: [{ mode: '+o', param: nick }],
  });
}
