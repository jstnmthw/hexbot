/**
 * hexbot — Event types
 *
 * Defines the bind system's event types, handler signatures, and the
 * HandlerContext object passed to every handler.
 */

// ---------------------------------------------------------------------------
// Bind types
// ---------------------------------------------------------------------------

/**
 * All bind types supported by the dispatcher.
 *
 * **Non-stackable** (`pub`, `msg`): only one handler can be registered per mask.
 * A new bind on the same mask replaces the previous one. Use for commands.
 *
 * **Stackable** (all others): multiple handlers can be registered on the same
 * mask. All matching handlers fire in registration order.
 *
 * @example
 * // Non-stackable: register a command handler
 * api.bind('pub', '-', '!hello', ctx => ctx.reply('Hello!'));
 *
 * // Stackable: react to all channel messages
 * api.bind('pubm', '-', '*', ctx => console.log(ctx.text));
 */
export type BindType =
  | 'pub' // Channel message — exact command match, non-stackable
  | 'pubm' // Channel message — wildcard on full text, stackable
  | 'msg' // Private message — exact command match, non-stackable
  | 'msgm' // Private message — wildcard on full text, stackable
  | 'join' // User joins channel, stackable
  | 'part' // User parts channel, stackable
  | 'kick' // User kicked from channel, stackable
  | 'nick' // User changes nick, stackable
  | 'mode' // Channel mode change (one dispatch per mode change), stackable
  | 'raw' // Raw IRC line from server, stackable
  | 'time' // Repeating timer — mask is interval in seconds (min 10), stackable
  | 'ctcp' // CTCP request received (rate-limited), stackable
  | 'notice' // NOTICE received, stackable
  | 'topic' // Topic change (suppressed during startup burst), stackable
  | 'quit'; // User quit the network (not channel-scoped), stackable

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/**
 * Context object passed to every bind handler. All fields are derived from
 * the IRC event that triggered the bind.
 *
 * ### Field semantics by bind type
 *
 * | type    | nick               | channel      | text                             | command              | args                       |
 * |---------|--------------------|--------------|----------------------------------|----------------------|----------------------------|
 * | `pub`   | sender             | `#channel`   | full message (raw)               | command word         | text after command          |
 * | `pubm`  | sender             | `#channel`   | full message (raw)               | command word / `''` for `/me` | args / action text   |
 * | `msg`   | sender             | `null`       | full message (raw)               | command word         | text after command          |
 * | `msgm`  | sender             | `null`       | full message (raw)               | command word / `''` for `/me` | args / action text   |
 * | `join`  | joiner             | `#channel`   | `"#chan nick!ident@host"`         | `'JOIN'`             | `''`                        |
 * | `part`  | parter             | `#channel`   | `"#chan nick!ident@host"`         | `'PART'`             | part reason                 |
 * | `kick`  | **kicked** nick    | `#channel`   | `"#chan kicked!ident@host"`       | `'KICK'`             | `"reason (by kicker)"`      |
 * | `nick`  | old nick           | `null`       | new nick                         | `'NICK'`             | new nick                    |
 * | `mode`  | mode setter        | `#channel`   | `"#chan +o nick"`                 | mode string (`+o`)   | mode param (`nick`)         |
 * | `ctcp`  | sender             | `null`       | CTCP payload (no type prefix)    | CTCP type (UPPER)    | CTCP payload                |
 * | `notice`| sender             | `#chan`/`null` | notice text                    | `'NOTICE'`           | notice text                 |
 * | `topic` | setter             | `#channel`   | new topic text                   | `'topic'`            | `''`                        |
 * | `quit`  | quitter            | `null`       | quit reason                      | `'quit'`             | `''`                        |
 * | `time`  | `''`               | `null`       | `''`                             | `''`                 | `''`                        |
 *
 * ### Notes
 * - `kick`: `ctx.nick` is the **kicked** user, not the kicker. The kicker's
 *   name appears at the end of `ctx.args` as `"reason (by kicker)"`.
 * - `mode`: the dispatcher fires one event per individual mode change.
 *   `ctx.command` is the full mode string (e.g. `'+o'`), `ctx.args` is
 *   the target param (e.g. a nick for `+o/+v`).
 * - `pub`/`pubm` command: IRC formatting codes are stripped before parsing.
 *   `ctx.text` retains the raw message including formatting.
 * - `time`: all fields are empty strings / null. Use for periodic tasks.
 * - `raw`: use only for IRC numerics not otherwise handled. All other fields
 *   are populated from the raw line on a best-effort basis.
 */
export interface HandlerContext {
  /** Nick of the event source. For `kick`: the kicked user, not the kicker. */
  nick: string;
  /** Ident of the event source. */
  ident: string;
  /** Hostname of the event source. */
  hostname: string;
  /**
   * Channel the event occurred in. `null` for private messages, CTCP, nick
   * changes, quit events, and timer ticks.
   */
  channel: string | null;
  /**
   * Raw message or event text. For `pub`/`msg`/`pubm`/`msgm`: the full
   * message body including IRC formatting codes. For non-message events:
   * a synthetic value — see table above.
   */
  text: string;
  /**
   * Parsed command. For `pub`/`msg`: the first whitespace-delimited word
   * with IRC formatting stripped (e.g. `'!op'`). For `pubm`/`msgm` fired
   * by a `/me` action: `''`. For non-message events: an event-specific
   * keyword — see table above.
   */
  command: string;
  /**
   * Arguments following the command. For `pub`/`msg`: everything after the
   * command word, trimmed. For `pubm`/`msgm` fired by `/me`: the action
   * text. For non-message events: event-specific — see table above.
   */
  args: string;
  /**
   * Send a reply to the channel (for channel events) or to the originating
   * nick (for PMs). Long messages are split automatically. Output is
   * rate-limited through the message queue.
   */
  reply(msg: string): void;
  /**
   * Send a private NOTICE to the originating nick. Long messages are split
   * automatically. Output is rate-limited through the message queue.
   */
  replyPrivate(msg: string): void;
}

/** Signature for all bind handler functions. */
export type BindHandler = (ctx: HandlerContext) => void | Promise<void>;

// ---------------------------------------------------------------------------
// Channel state (plugin-facing)
// ---------------------------------------------------------------------------

/**
 * A user present in a channel, as seen by plugins.
 * The internal representation is richer; this is the projected plugin view.
 */
export interface ChannelUser {
  nick: string;
  ident: string;
  hostname: string;
  /**
   * Channel privilege modes as a concatenated string.
   * `'o'` = op, `'v'` = voice, `'ov'` = op + voice, `''` = no special modes.
   */
  modes: string;
  /** Unix timestamp (ms) when this user joined the channel. */
  joinedAt: number;
  /**
   * Services account name from IRCv3 `account-notify` / `extended-join`.
   *
   * - `string`    — identified as this account name
   * - `null`      — confirmed NOT identified (server sent account-notify with no account)
   * - `undefined` — no account information available (server doesn't support the caps,
   *                 or the user joined before capability data was received)
   *
   * Use `api.services.verifyUser(nick)` as a fallback when this is `undefined`.
   */
  accountName?: string | null;
}

/** State for a single channel, as seen by plugins. */
export interface ChannelState {
  /** Lowercased channel name. */
  name: string;
  /** Current topic text, or `''` if unset. */
  topic: string;
  /** Active channel modes as a string (e.g. `'+mnt'`). */
  modes: string;
  /** Users currently in the channel, keyed by lowercased nick (using server CASEMAPPING). */
  users: Map<string, ChannelUser>;
}
