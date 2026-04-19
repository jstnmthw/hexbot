// HexBot — DCC IRC mirror helpers
// Translate inbound irc-framework notice/privmsg events into formatted
// lines suitable for the DCC console and fan them out via the caller's
// `announce(line)` callback. Extracted from DCCManager so the guard-chain
// and field-extraction logic can be unit-tested without constructing a
// full manager + session map.
//
// All three helpers are pure modulo the `announce` callback: they do not
// read or mutate any session state themselves. DCCManager owns the fanout.
import type { PluginServices } from '../../types';
import { toEventObject } from '../../utils/irc-event';
import { sanitize } from '../../utils/sanitize';

/**
 * Minimal services view used by {@link mirrorNotice} — callable via both
 * the real `Services` implementation and a lightweight test mock.
 */
export interface NickServFilter {
  isNickServVerificationReply(nick: string, message: string): boolean;
}

/**
 * Extracted mirror event: already filtered to non-channel traffic, with
 * all fields coerced to strings. Returns `null` when the target begins
 * with `#` or `&` (channel) — both notice and privmsg paths share the
 * same pre-filter.
 */
export interface MirrorEvent {
  nick: string;
  target: string;
  message: string;
}

/**
 * Extract the `{nick, target, message}` triple from an irc-framework event
 * envelope and drop channel-scoped traffic up front. Returns `null` when
 * the target is a channel so both mirror paths can share the same
 * pre-filter.
 */
export function extractMirrorEvent(raw: unknown): MirrorEvent | null {
  const e = toEventObject(raw);
  const target = String(e.target ?? '');
  if (/^[#&]/.test(target)) return null;
  return {
    nick: String(e.nick ?? ''),
    target,
    message: String(e.message ?? ''),
  };
}

/**
 * Forward a raw IRC notice to all DCC sessions via `announce`, skipping
 * channel notices and NickServ ACC/STATUS replies (internal
 * permission-verification chatter that shouldn't reach operator
 * consoles).
 */
export function mirrorNotice(
  services: Pick<PluginServices, 'isNickServVerificationReply'> | NickServFilter,
  announce: (line: string) => void,
  raw: unknown,
): void {
  const event = extractMirrorEvent(raw);
  if (!event) return;
  if (services.isNickServVerificationReply(event.nick, event.message)) return;
  announce(`-${sanitize(event.nick)}- ${sanitize(event.message)}`);
}

/**
 * Forward a raw IRC PRIVMSG to all DCC sessions via `announce`, skipping
 * channel messages.
 */
export function mirrorPrivmsg(announce: (line: string) => void, raw: unknown): void {
  const event = extractMirrorEvent(raw);
  if (!event) return;
  announce(`<${sanitize(event.nick)}> ${sanitize(event.message)}`);
}
