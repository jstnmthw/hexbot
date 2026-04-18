// chanmod — shared utility functions
import type { PluginAPI } from '../../src/types';
import { INTENTIONAL_TTL_MS, type SharedState } from './state';

/** Configured bot nick from bot.json (desired nick, not necessarily the current nick during recovery). */
export function getBotNick(api: PluginAPI): string {
  return api.botConfig.irc.nick;
}

/** True if the bot currently holds `+o` in `channel` per tracked channel state. */
export function botHasOps(api: PluginAPI, channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = api.ircLower(getBotNick(api));
  const botUser = ch.users.get(botNick);
  return botUser?.modes.includes('o') ?? false;
}

/** True if the bot can apply halfop modes — holds either `+o` or `+h` in `channel`. */
export function botCanHalfop(api: PluginAPI, channel: string): boolean {
  const ch = api.getChannel(channel);
  if (!ch) return false;
  const botNick = api.ircLower(getBotNick(api));
  const botUser = ch.users.get(botNick);
  const modes = botUser?.modes ?? '';
  return modes.includes('o') || modes.includes('h');
}

/**
 * Validate a candidate nick against RFC 2812 nickname rules (plus a 50-char
 * cap — modern networks vary but 50 is a safe ceiling).
 *
 * First char: letter or one of the "special" chars `[]\` ` _^{|}`.
 * Remaining:  letters, digits, specials, or `-`.
 *
 * Used to reject shell-injection-style input before it reaches `kick`/`mode`
 * payloads. Networks with stricter NICKLEN (via ISUPPORT) will reject long
 * nicks themselves; this only catches structurally invalid input.
 */
export function isValidNick(nick: string): boolean {
  return /^[a-zA-Z[\]\\`_^{|}][a-zA-Z0-9[\]\\`_^{|}\\-]{0,49}$/.test(nick);
}

/**
 * Threshold above which `markIntentional` triggers an inline sweep of
 * expired entries before recording the new one. A wildcard ban on a
 * populated channel can spike this map to thousands of entries between
 * the 60s periodic prune ticks, so we prune opportunistically past the
 * cap. See audit finding W-CM2 (2026-04-14).
 */
const INTENTIONAL_INLINE_SWEEP_AT = 10_000;

/**
 * Record a (channel, nick) as a bot-initiated mode change with a short TTL.
 * Prevents the bot's own `!deop`/`!devoice`/punishment deops from triggering
 * re-enforcement (which would fight itself into a mode war). Paired with
 * {@link wasIntentional}, which consumes the marker on read.
 */
export function markIntentional(
  state: SharedState,
  api: PluginAPI,
  channel: string,
  nick: string,
): void {
  if (state.intentionalModeChanges.size >= INTENTIONAL_INLINE_SWEEP_AT) {
    const now = Date.now();
    for (const [k, expiresAt] of state.intentionalModeChanges) {
      if (now >= expiresAt) state.intentionalModeChanges.delete(k);
    }
  }
  const key = `${api.ircLower(channel)}:${api.ircLower(nick)}`;
  state.intentionalModeChanges.set(key, Date.now() + INTENTIONAL_TTL_MS);
}

/**
 * Check and consume an intentional-mode-change marker. Returns `true` if a
 * non-expired marker existed for the pair (the entry is deleted either way
 * so a single event consumes a single marker).
 */
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

/**
 * Resolve the concatenated (global + channel-local) flag string for `nick`
 * in `channel`. Returns `null` when the nick is unknown or not in channel
 * state — callers treat "no flags" and "unknown user" identically for
 * authorization purposes.
 */
export function getUserFlags(api: PluginAPI, channel: string, nick: string): string | null {
  const hostmask = api.getUserHostmask(channel, nick);
  if (!hostmask) return null;
  const user = api.permissions.findByHostmask(hostmask);
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

/**
 * Modes that require parameters and must use dedicated chanset settings
 * (channel_key for +k, channel_limit for +l) instead of the channel_modes string.
 */
export const PARAM_MODES = new Set(['k', 'l']);

/**
 * Structured result of parsing an additive/subtractive mode string.
 * Modes in `add` should be ensured set; modes in `remove` should be ensured unset.
 * Modes not mentioned in either set are left alone.
 */
export interface ParsedChannelModes {
  add: Set<string>;
  remove: Set<string>;
}

/**
 * Parse an mode string like "+nt-s" into structured add/remove sets.
 *
 * - Must start with `+` or `-`; any other leading character yields empty sets.
 * - Characters after `+` go into `add`, characters after `-` go into `remove`.
 * - A mode cannot be in both sets — last occurrence wins (e.g. "+n-n" → remove: {n}).
 * - Parameter modes (from `paramModes` arg) are stripped from both sets with a warning.
 * - Empty string → both sets empty.
 */
export function parseChannelModes(
  modeStr: string,
  paramModes: Set<string> = PARAM_MODES,
): ParsedChannelModes {
  const add = new Set<string>();
  const remove = new Set<string>();

  if (!modeStr) return { add, remove };
  if (modeStr[0] !== '+' && modeStr[0] !== '-') return { add, remove };

  let direction: '+' | '-' = '+';
  for (const ch of modeStr) {
    if (ch === '+' || ch === '-') {
      direction = ch;
      continue;
    }
    if (direction === '+') {
      remove.delete(ch);
      add.add(ch);
    } else {
      add.delete(ch);
      remove.add(ch);
    }
  }

  // Strip parameter modes from both sets
  for (const pm of paramModes) {
    add.delete(pm);
    remove.delete(pm);
  }

  return { add, remove };
}

/** Returns true if a mode string contains parameter modes (k, l). */
export function hasParamModes(modeStr: string): boolean {
  for (const ch of modeStr) {
    if (PARAM_MODES.has(ch)) return true;
  }
  return false;
}

/**
 * Build the set of parameter modes dynamically from the server's CHANMODES ISUPPORT token.
 * Categories A (list), B (always-param), and C (param-on-set) all require parameters.
 * Falls back to the hardcoded PARAM_MODES set when CHANMODES is unavailable.
 */
export function getParamModes(api: PluginAPI): Set<string> {
  const chanmodes = api.getServerSupports()['CHANMODES'];
  if (!chanmodes) return PARAM_MODES;
  const parts = chanmodes.split(',');
  const set = new Set<string>();
  // Categories A (list), B (always-param), C (param-on-set) — indices 0, 1, 2
  for (let i = 0; i < 3 && i < parts.length; i++) {
    for (const c of parts[i]) set.add(c);
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
