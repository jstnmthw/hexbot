// HexBot — NickServ ACC/STATUS response parsers
//
// Pure parsers for the two reply shapes NickServ backends emit when asked to
// verify a nick's identity: Atheme's ACC reply and Anope's STATUS reply.
// Lifted out of services.ts so they're unit-testable without standing up a
// full Services instance. The shapes are stable across all current IRC
// networks we target, so adding a new backend is usually a matter of adding
// a new parser alongside these two.

/** Parsed form of either a NickServ ACC or STATUS reply. */
export interface ServicesVerificationReply {
  /** The nick the reply is about — from the reply body, not the NickServ envelope. */
  nick: string;
  /**
   * Verification level: 0/1 = not identified, 2 = known but not identified,
   * 3 = identified / fully authenticated. Callers treat `>= 3` as verified.
   */
  level: number;
}

/** Parse an Atheme `<nick> ACC <level>` reply. Returns null on mismatch. */
export function tryParseAccResponse(message: string): ServicesVerificationReply | null {
  const m = message.match(/^(\S+)\s+ACC\s+(\d+)/i);
  if (!m) return null;
  return { nick: m[1], level: parseInt(m[2], 10) };
}

/** Parse an Anope `STATUS <nick> <level>` reply. Returns null on mismatch. */
export function tryParseStatusResponse(message: string): ServicesVerificationReply | null {
  const m = message.match(/^STATUS\s+(\S+)\s+(\d+)/i);
  if (!m) return null;
  return { nick: m[1], level: parseInt(m[2], 10) };
}
