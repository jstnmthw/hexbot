// HexBot — IRC formatting strip utility
// Removes IRC control characters from a string before display in security-relevant
// contexts. See docs/SECURITY.md section 5.2 for when to apply this.

/**
 * Regex matching IRC control characters:
 * \x02 bold, \x03 color (with optional color code), \x04 hex color,
 * \x0F reset, \x11 monospace, \x16 reverse, \x1D italic,
 * \x1E strikethrough, \x1F underline.
 */
// eslint-disable-next-line no-control-regex
const IRC_FORMAT_RE = /[\x02\x03\x04\x0F\x11\x16\x1D\x1E\x1F](\d{1,2}(,\d{1,2})?)?/g;

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
