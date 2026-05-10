// HexBot — IRC commands core module
// Convenience wrappers for common IRC operations with mod action logging.
import type { BotDatabase } from '../database';
import type { LoggerLike } from '../logger';
import { sanitize } from '../utils/sanitize';
import { type ModActor, tryLogModAction } from './audit';
import { type ServerCapabilities, defaultServerCapabilities } from './isupport';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for IRC commands. */
export interface IRCCommandsClient {
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  join(channel: string): void;
  part(channel: string, message?: string): void;
  raw(line: string): void;
  mode?(target: string, mode: string, ...params: string[]): void;
}

/**
 * Structural type for the outbound message queue. Kept local so this module
 * doesn't acquire a hard dep on `MessageQueue`; matches the surface used by
 * `enqueue`. When unset, mutating verbs send synchronously and bypass the
 * 2 msg/s steady-state pacer — the bot is one chanmod recovery storm away
 * from an Excess Flood K-line.
 */
export interface MessageQueueLike {
  enqueue(target: string, fn: () => void): void;
}

/**
 * Narrow role interface for consumers that only need to set/lift channel
 * bans (e.g. `.ban`/`.unban` command registrars). `IRCCommands` satisfies
 * this structurally — use this type in consumers so tests can pass plain
 * objects without casting.
 */
export interface BanOperator {
  ban(channel: string, mask: string, actor?: ModActor): void;
  unban(channel: string, mask: string, actor?: ModActor): void;
}

/**
 * Default actor used when a caller doesn't pass one. Core command handlers
 * pass an explicit `auditActor(ctx)`; unattributed background writes (auto-
 * reconciliation, join-time fixups) fall back to this.
 */
const DEFAULT_ACTOR: ModActor = { by: 'bot', source: 'system' };

/**
 * Byte caps on kick reason / topic text. An IRC line caps at 512 bytes
 * including prefix + verb + target + CRLF; a long reason pushes the KICK
 * past that and servers drop it silently — leaving the mod_log row
 * claiming a kick the server never applied. Capping at 250 leaves comfort
 * for prefix framing and multibyte encoding.
 */
const MAX_KICK_REASON_BYTES = 250;
const MAX_TOPIC_BYTES = 350;

/**
 * Clamp a string to `maxBytes` UTF-8 bytes, truncating by code point so a
 * multibyte character never splits across the boundary. Returns the input
 * unchanged if it already fits.
 */
function clampBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  let used = 0;
  for (const cp of s) {
    const cpBytes = Buffer.byteLength(cp, 'utf8');
    if (used + cpBytes > maxBytes) break;
    out += cp;
    used += cpBytes;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode-string parsing
// ---------------------------------------------------------------------------

interface ModeSegment {
  dir: '+' | '-';
  chars: string[];
}

/**
 * Split a mode string into per-direction segments.
 * `"+o-v"` → `[{dir:'+',chars:['o']},{dir:'-',chars:['v']}]`
 * Throws if the string does not start with a direction indicator.
 */
function parseModeString(s: string): ModeSegment[] {
  const segments: ModeSegment[] = [];
  let dir: '+' | '-' | null = null;
  let chars: string[] = [];

  for (const ch of s) {
    if (ch === '+' || ch === '-') {
      if (dir !== null && chars.length > 0) {
        segments.push({ dir, chars });
      }
      dir = ch;
      chars = [];
      continue;
    }
    if (dir === null) {
      throw new Error(`IRCCommands.mode(): mode string "${s}" is missing a leading + or -`);
    }
    chars.push(ch);
  }

  if (dir !== null && chars.length > 0) {
    segments.push({ dir, chars });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// IRCCommands
// ---------------------------------------------------------------------------

export class IRCCommands {
  private client: IRCCommandsClient;
  private db: BotDatabase | null;
  private logger: LoggerLike | null;
  private modesPerLine: number;
  private capabilities: ServerCapabilities = defaultServerCapabilities();
  private defaultActor: ModActor = DEFAULT_ACTOR;
  private messageQueue: MessageQueueLike | null = null;

  constructor(
    client: IRCCommandsClient,
    db: BotDatabase | null,
    modesPerLine?: number,
    logger?: LoggerLike | null,
  ) {
    this.client = client;
    this.db = db;
    this.logger = logger?.child('irc-commands') ?? null;
    // Conservative default before ISUPPORT lands. RFC 2812 mandates a floor
    // of 3; 4 matches Solanum/Libera; the real number arrives via
    // `setCapabilities()` once 005 is parsed and may go up to 20+.
    this.modesPerLine = modesPerLine ?? 4;
  }

  /**
   * Wire the outbound message queue so mutating verbs (KICK, MODE, TOPIC,
   * INVITE, JOIN-with-key) pace through it. Bot wires this after both
   * objects exist; tests can leave it null for synchronous semantics.
   */
  setMessageQueue(queue: MessageQueueLike | null): void {
    this.messageQueue = queue;
  }

  /**
   * Route a wire-level send through `messageQueue` if one is wired, else
   * call `fn()` synchronously. The mod_log row is written by the caller
   * at intent time (before this), so a queued line that never reaches the
   * server still has the operator's audit trail.
   */
  private dispatchSend(target: string, fn: () => void): void {
    if (this.messageQueue) {
      this.messageQueue.enqueue(target, fn);
    } else {
      fn();
    }
  }

  /** Update the max modes per line from ISUPPORT. */
  setModesPerLine(n: number): void {
    this.modesPerLine = n;
  }

  /**
   * Apply a parsed ISUPPORT snapshot. Pulls `modesPerLine` from the network
   * and stores the full capability object for `mode()`'s param allocation.
   */
  setCapabilities(caps: ServerCapabilities): void {
    this.capabilities = caps;
    this.modesPerLine = caps.modesPerLine;
  }

  /**
   * Batch-set the default actor recorded against mutations that don't pass
   * one explicitly. Core command handlers always pass an explicit actor
   * via `auditActor(ctx)`; this setter exists for plugin / background sites
   * that want to tag a whole block of work with a consistent attribution.
   */
  setDefaultActor(actor: ModActor): void {
    this.defaultActor = actor;
  }

  // -------------------------------------------------------------------------
  // Channel operations
  // -------------------------------------------------------------------------

  say(target: string, message: string): void {
    this.client.say(target, message);
  }

  notice(target: string, message: string): void {
    this.client.notice(target, message);
  }

  /**
   * Send a JOIN. When a channel key is provided we drop to `raw()` because
   * irc-framework's typed `join()` does not accept a key parameter. Both
   * `channel` and `key` are sanitized to strip CRLF — see SECURITY.md §2.1
   * (raw() output sanitization is mandatory).
   */
  join(channel: string, key?: string): void {
    if (key) {
      const safeChan = sanitize(channel);
      const safeKey = sanitize(key);
      this.dispatchSend(channel, () => this.client.raw(`JOIN ${safeChan} ${safeKey}`));
    } else {
      this.dispatchSend(channel, () => this.client.join(channel));
    }
  }

  part(channel: string, message?: string): void {
    this.dispatchSend(channel, () => this.client.part(channel, message));
  }

  kick(channel: string, nick: string, reason?: string, actor?: ModActor): void {
    const safe = clampBytes(sanitize(reason ?? ''), MAX_KICK_REASON_BYTES);
    const safeChan = sanitize(channel);
    const safeNick = sanitize(nick);
    this.dispatchSend(channel, () => this.client.raw(`KICK ${safeChan} ${safeNick} :${safe}`));
    this.logMod('kick', channel, nick, actor, reason ?? null);
  }

  ban(channel: string, mask: string, actor?: ModActor): void {
    this.sendMode(channel, '+b', mask);
    this.logMod('ban', channel, mask, actor, null);
  }

  unban(channel: string, mask: string, actor?: ModActor): void {
    this.sendMode(channel, '-b', mask);
    this.logMod('unban', channel, mask, actor, null);
  }

  op(channel: string, nick: string, actor?: ModActor): void {
    this.sendMode(channel, '+o', nick);
    this.logMod('op', channel, nick, actor, null);
  }

  deop(channel: string, nick: string, actor?: ModActor): void {
    this.sendMode(channel, '-o', nick);
    this.logMod('deop', channel, nick, actor, null);
  }

  voice(channel: string, nick: string, actor?: ModActor): void {
    this.sendMode(channel, '+v', nick);
    this.logMod('voice', channel, nick, actor, null);
  }

  devoice(channel: string, nick: string, actor?: ModActor): void {
    this.sendMode(channel, '-v', nick);
    this.logMod('devoice', channel, nick, actor, null);
  }

  halfop(channel: string, nick: string, actor?: ModActor): void {
    this.sendMode(channel, '+h', nick);
    this.logMod('halfop', channel, nick, actor, null);
  }

  dehalfop(channel: string, nick: string, actor?: ModActor): void {
    this.sendMode(channel, '-h', nick);
    this.logMod('dehalfop', channel, nick, actor, null);
  }

  invite(channel: string, nick: string, actor?: ModActor): void {
    // RFC 2812 §3.2.7 INVITE: arg order is `<nick> <channel>`, the inverse of
    // the natural English reading. Easy to invert by accident — the sanitize()
    // calls also serve as a checkpoint for that order.
    const safeChan = sanitize(channel);
    const safeNick = sanitize(nick);
    this.dispatchSend(channel, () => this.client.raw(`INVITE ${safeNick} ${safeChan}`));
    this.logMod('invite', channel, nick, actor, null);
  }

  topic(channel: string, text: string, actor?: ModActor): void {
    const safe = clampBytes(sanitize(text), MAX_TOPIC_BYTES);
    const safeChan = sanitize(channel);
    this.dispatchSend(channel, () => this.client.raw(`TOPIC ${safeChan} :${safe}`));
    // Persist the new topic as `reason` so audit queries can grep topic
    // changes by substring. Text is user-controlled but safely stored
    // (parameterized insert). Cap at 4 KB so a pathological caller can't
    // bloat the row beyond mod_log's existing 8 KiB metadata cap; the
    // wire-level value already went out under MAX_TOPIC_BYTES.
    const TOPIC_REASON_MAX = 4096;
    const persistedReason =
      text.length > TOPIC_REASON_MAX ? `${text.slice(0, TOPIC_REASON_MAX - 1)}…` : text;
    this.logMod('topic', channel, null, actor, persistedReason);
  }

  quiet(channel: string, mask: string, actor?: ModActor): void {
    this.sendMode(channel, '+q', mask);
    this.logMod('quiet', channel, mask, actor, null);
  }

  /** Request the current channel modes from the server (triggers RPL_CHANNELMODEIS). */
  requestChannelModes(channel: string): void {
    this.client.raw(`MODE ${sanitize(channel)}`);
  }

  /**
   * Raw mode change. Respects ISUPPORT MODES limit by batching.
   *
   * Mode strings with mixed directions (e.g. `"+o-v"`) are segmented so each
   * batch contains a single direction — the server would otherwise re-apply
   * the leading sign to every subsequent char, producing the wrong modes.
   *
   * Per-char param allocation is driven by the ISUPPORT `CHANMODES` snapshot
   * exposed by `ServerCapabilities.expectsParam()`. Prefix modes (`o`, `v`,
   * ...) and type A/B modes (`b`, `k`, ...) always consume a param; type C
   * modes (`l`) consume a param only on `+`; type D modes (`m`, `n`, `t`,
   * ...) never consume one. This lets callers mix `"+mo alice"` in a single
   * call — the old code could only handle uniform-param runs.
   *
   * Param count is checked up-front: a mismatch throws rather than silently
   * truncating the excess or dropping modes off the end of the line.
   *
   * @param channel - Target channel
   * @param modeString - Mode string, e.g. `'+ov'`, `'+mo'`, `'+o-v'`, `'+i'`
   * @param params - Mode parameters for the param-taking chars only
   */
  mode(channel: string, modeString: string, ...params: string[]): void {
    const segments = parseModeString(modeString);
    const caps = this.capabilities;

    // Single pass: pair each mode char with its param (or null when the
    // mode takes none), accumulating by segment so direction is preserved.
    interface PairedSegment {
      dir: '+' | '-';
      entries: Array<{ char: string; param: string | null }>;
    }
    const paired: PairedSegment[] = [];
    let paramsNeeded = 0;
    let paramIdx = 0;
    for (const seg of segments) {
      const entries: Array<{ char: string; param: string | null }> = [];
      for (const ch of seg.chars) {
        if (caps.expectsParam(ch, seg.dir)) {
          paramsNeeded++;
          entries.push({ char: ch, param: params[paramIdx++] ?? null });
        } else {
          entries.push({ char: ch, param: null });
        }
      }
      paired.push({ dir: seg.dir, entries });
    }
    if (paramsNeeded !== params.length) {
      throw new Error(
        `IRCCommands.mode(): mode string "${modeString}" needs ${paramsNeeded} param(s) ` +
          `but ${params.length} were supplied — must match 1:1`,
      );
    }

    // Emit one MODE line per batch, respecting `modesPerLine` as the cap on
    // total chars per line (conservative — real servers only count
    // param-taking modes against MODES=, but the stricter rule is always
    // legal and keeps the batcher simpler).
    for (const seg of paired) {
      let batchChars: string[] = [];
      let batchParams: string[] = [];
      const flush = (): void => {
        if (batchChars.length === 0) return;
        this.sendModeRaw(channel, seg.dir + batchChars.join(''), batchParams);
        batchChars = [];
        batchParams = [];
      };
      for (const entry of seg.entries) {
        batchChars.push(entry.char);
        if (entry.param !== null) batchParams.push(entry.param);
        if (batchChars.length >= this.modesPerLine) flush();
      }
      flush();
    }

    // Log the mode mutation as a single row — `reason` carries the full mode
    // string and `metadata.params` the param list so audit queries can still
    // answer "who set +m on #foo".
    this.logMod('mode', channel, null, undefined, modeString, { params });
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private sendMode(channel: string, mode: string, param: string): void {
    const safeChan = sanitize(channel);
    const safeMode = sanitize(mode);
    const safeParam = sanitize(param);
    if (this.client.mode) {
      this.dispatchSend(channel, () => this.client.mode!(safeChan, safeMode, safeParam));
    } else {
      this.dispatchSend(channel, () =>
        this.client.raw(`MODE ${safeChan} ${safeMode} ${safeParam}`),
      );
    }
  }

  private sendModeRaw(channel: string, modeString: string, params: string[]): void {
    const safeChannel = sanitize(channel);
    const safeModes = sanitize(modeString);
    // Reject params carrying whitespace / comma / leading colon before the
    // MODE line is assembled. A param with a space would split into two on
    // the wire ("MODE #c +o alice bob" from one call) and silently turn one
    // op into two; a leading `:` is the IRC trailing-arg sentinel and would
    // swallow every subsequent param into the reason/hostmask tail.
    const safeParams: string[] = [];
    for (const raw of params) {
      const p = sanitize(raw);
      if (p === '' || /[\s,]/.test(p) || p.startsWith(':')) {
        throw new Error(
          `IRCCommands.mode(): refusing unsafe MODE param ${JSON.stringify(raw)} — ` +
            `params may not contain whitespace, commas, or a leading ':'`,
        );
      }
      safeParams.push(p);
    }
    const line =
      safeParams.length > 0
        ? `MODE ${safeChannel} ${safeModes} ${safeParams.join(' ')}`
        : `MODE ${safeChannel} ${safeModes}`;
    this.dispatchSend(channel, () => this.client.raw(line));
  }

  private logMod(
    action: string,
    channel: string,
    target: string | null,
    actor: ModActor | undefined,
    reason: string | null,
    metadata?: Record<string, unknown>,
  ): void {
    const a = actor ?? this.defaultActor;
    tryLogModAction(
      this.db,
      {
        action,
        source: a.source,
        by: a.by,
        plugin: a.plugin,
        channel,
        target,
        reason,
        metadata: metadata ?? null,
      },
      this.logger,
    );
  }
}
