// HexBot — IRC formatting strip utility
// Removes IRC control characters from a string before display in security-relevant
// contexts. See docs/SECURITY.md section 5.2 for when to apply this.

/**
 * Regex matching IRC control characters:
 * - \x03 color: optional decimal fg (1-2 digits) and bg (,1-2 digits)
 * - \x04 hex color: optional 6-digit hex fg and bg (,6-digit hex)
 * - \x02 bold, \x0F reset, \x11 monospace, \x16 reverse, \x1D italic,
 *   \x1E strikethrough, \x1F underline: no trailing parameters consumed
 */
/* eslint-disable no-control-regex -- IRC formatting codes are intentional control characters */
const IRC_FORMAT_RE =
  /\x03(\d{1,2}(,\d{1,2})?)?|\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?|[\x02\x0F\x11\x16\x1D\x1E\x1F]/g;
/* eslint-enable no-control-regex */

/**
 * Strip IRC formatting and control characters from a string.
 *
 * Use this whenever user-controlled values (nicks, messages) appear in
 * security-relevant output — permission grants, op/kick/ban announcements, logs.
 * Prevents IRC color codes from being used to visually hide or spoof messages.
 *
 * @example
 * api.say(channel, `User ${api.stripFormatting(ctx.nick)} has been granted ops`);
 */
export function stripFormatting(text: string): string {
  return text.replace(IRC_FORMAT_RE, '');
}
