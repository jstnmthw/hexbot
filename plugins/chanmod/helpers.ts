// chanmod — shared utility functions
import type { PluginAPI } from '../../src/types';
import { INTENTIONAL_TTL_MS, type SharedState } from './state';

export function getBotNick(api: PluginAPI): string {
  return api.botConfig.irc.nick;
}

export function isBotNick(api: PluginAPI, nick: string): boolean {
  return api.ircLower(nick) === api.ircLower(getBotNick(api));
}

export function botHasOps(api: PluginAPI, channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = api.ircLower(getBotNick(api));
  const botUser = ch.users.get(botNick);
  return botUser?.modes?.includes('o') ?? false;
}

export function botCanHalfop(api: PluginAPI, channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = api.ircLower(getBotNick(api));
  const botUser = ch.users.get(botNick);
  const modes = botUser?.modes ?? '';
  return modes.includes('o') || modes.includes('h');
}

export function isValidNick(nick: string): boolean {
  return nick.length > 0 && !/[\r\n\s]/.test(nick);
}

export function markIntentional(
  state: SharedState,
  api: PluginAPI,
  channel: string,
  nick: string,
): void {
  const key = `${api.ircLower(channel)}:${api.ircLower(nick)}`;
  state.intentionalModeChanges.set(key, Date.now() + INTENTIONAL_TTL_MS);
}

export function wasIntentional(
  state: SharedState,
  api: PluginAPI,
  channel: string,
  nick: string,
): boolean {
  const key = `${api.ircLower(channel)}:${api.ircLower(nick)}`;
  const expiry = state.intentionalModeChanges.get(key);
  if (expiry && Date.now() < expiry) {
    state.intentionalModeChanges.delete(key);
    return true;
  }
  state.intentionalModeChanges.delete(key);
  return false;
}

/** Owner flag — implies all other privileges. */
const OWNER_FLAG = 'n';

/**
 * Returns true if `flags` grants any of the `required` flags.
 * Owner flag (n) implies all privileges, mirroring permissions.ts semantics.
 */
export function hasAnyFlag(flags: string | null, required: Iterable<string>): boolean {
  if (!flags) return false;
  if (flags.includes(OWNER_FLAG)) return true;
  for (const f of required) {
    if (flags.includes(f)) return true;
  }
  return false;
}

export function getUserFlags(api: PluginAPI, channel: string, nick: string): string | null {
  const hostmask = api.getUserHostmask(channel, nick);
  if (!hostmask) return null;
  /* v8 ignore next */
  const fullHostmask = hostmask.includes('!') ? hostmask : `${nick}!${hostmask}`;
  const user = api.permissions.findByHostmask(fullHostmask);
  if (!user) return null;
  const globalFlags = user.global;
  const channelFlags = user.channels[api.ircLower(channel)] ?? '';
  return globalFlags + channelFlags;
}

/**
 * Build a ban mask from a full hostmask (nick!ident@host).
 *   Type 1: *!*@host
 *   Type 2: *!*ident@host
 *   Type 3: *!*ident@*.domain  (wildcard first component; falls back if < 3 parts)
 * Cloaked hosts (containing '/') always use exact host: *!*@host
 */
export function buildBanMask(hostmask: string, banType: number): string | null {
  const bangIdx = hostmask.indexOf('!');
  const atIdx = hostmask.lastIndexOf('@');
  if (atIdx === -1) return null;

  const host = hostmask.substring(atIdx + 1);
  if (!host) return null;

  if (host.includes('/')) return `*!*@${host}`;

  if (banType === 1) return `*!*@${host}`;

  const ident = bangIdx !== -1 && bangIdx < atIdx ? hostmask.substring(bangIdx + 1, atIdx) : '*';

  if (banType === 2) return `*!*${ident}@${host}`;

  const parts = host.split('.');
  if (parts.length > 2) return `*!*${ident}@*.${parts.slice(1).join('.')}`;
  return `*!*${ident}@${host}`;
}

/** Parse a mode string like "+nt" into a Set of mode chars. */
export function parseModesSet(modeStr: string): Set<string> {
  const set = new Set<string>();
  for (const ch of modeStr) {
    if (ch !== '+' && ch !== '-') set.add(ch);
  }
  return set;
}

/** Format a ban expiry for display. */
export function formatExpiry(expires: number): string {
  if (expires === 0) return 'permanent';
  const diff = expires - Date.now();
  if (diff <= 0) return 'expired';
  const mins = Math.ceil(diff / 60_000);
  if (mins < 60) return `expires in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `expires in ${hrs}h ${rem}m` : `expires in ${hrs}h`;
}
