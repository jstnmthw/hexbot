// HexBot — Dispatch & handler-context types
//
// Defines the bind system taxonomy (bind types, flags, casemapping) and the
// per-type HandlerContext variants that the dispatcher narrows at plugin call
// sites. Pure type definitions — no runtime code.

// ---------------------------------------------------------------------------
// IRC network types
// ---------------------------------------------------------------------------

/** IRC CASEMAPPING values from ISUPPORT 005. */
export type Casemapping = 'rfc1459' | 'strict-rfc1459' | 'ascii';

// ---------------------------------------------------------------------------
// Bind system types
// ---------------------------------------------------------------------------

/** Bind types supported by the dispatcher. */
export type BindType =
  | 'pub' // Channel message — exact command match, non-stackable
  | 'pubm' // Channel message — wildcard on full text, stackable
  | 'msg' // Private message — exact command match, non-stackable
  | 'msgm' // Private message — wildcard on full text, stackable
  | 'join' // User joins channel, stackable
  | 'part' // User parts channel, stackable
  | 'kick' // User kicked, stackable
  | 'nick' // Nick change, stackable
  | 'mode' // Mode change, stackable
  | 'raw' // Raw server line, stackable
  | 'time' // Timer (interval), stackable
  | 'ctcp' // CTCP request, stackable
  | 'notice' // Notice message, stackable
  | 'topic' // Topic change, stackable
  | 'quit' // User quit (not channel-scoped), stackable
  | 'invite' // Bot invited to a channel, stackable
  | 'join_error'; // Bot failed to join a channel (banned, invite-only, bad key, etc.), stackable

/** Permission flags: n=owner, m=master, o=op, v=voice, d=deop (suppress auto-op/halfop), -=anyone. */
export type Flag = 'n' | 'm' | 'o' | 'v' | 'd' | '-';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/**
 * Context object passed to every bind handler. The plugin-facing `api.bind` is
 * generic on `BindType`, so each handler receives a context narrowed to its
 * bind type — see {@link BindContextFor}. For example, a `'pub'` handler gets
 * {@link ChannelHandlerContext} (channel is `string`), and a `'join'` handler
 * gets {@link JoinContext} (channel is `string`, command is the literal
 * `'JOIN'`, args is the literal `''`).
 *
 * `HandlerContext` below is the *union* of every per-type shape, used by the
 * dispatcher and permission internals where the bind type isn't known at
 * compile time.
 *
 * Field semantics by bind type (cross-reference the type names in the last
 * column — each one is exported for use outside `api.bind` callbacks):
 *
 * | type        | nick            | channel       | text                         | command             | args                    | interface                        |
 * |-------------|-----------------|---------------|------------------------------|---------------------|-------------------------|----------------------------------|
 * | pub         | sender          | #channel      | full message (raw)           | command word        | text after command      | {@link ChannelHandlerContext}    |
 * | pubm        | sender          | #channel      | full message (raw)           | command word / `''` for `/me` | args / action text | {@link ChannelHandlerContext}    |
 * | msg         | sender          | null (PM)     | full message (raw)           | command word        | text after command      | {@link NullChannelHandlerContext}|
 * | msgm        | sender          | null (PM)     | full message (raw)           | command word / `''` for `/me` | args / action text | {@link NullChannelHandlerContext}|
 * | join        | joiner          | #channel      | `"#chan nick!ident@host"`    | `'JOIN'`            | `''`                    | {@link JoinContext}              |
 * | part        | parter          | #channel      | `"#chan nick!ident@host"`    | `'PART'`            | part reason             | {@link PartContext}              |
 * | kick        | **kicked** nick | #channel      | `"#chan kicked!ident@host"`  | `'KICK'`            | `"reason (by kicker)"`  | {@link KickContext}              |
 * | nick        | old nick        | null          | new nick                     | `'NICK'`            | new nick                | {@link NickContext}              |
 * | mode        | mode setter     | #channel      | `"#chan +o nick"`            | mode string (`+o`)  | mode param              | {@link ModeContext}              |
 * | ctcp        | sender          | null          | CTCP payload (no type prefix)| CTCP type (upper)   | CTCP payload            | {@link CtcpContext}              |
 * | notice      | sender          | #chan / null  | notice text                  | `'NOTICE'`          | notice text             | {@link NullableChannelHandlerContext}|
 * | topic       | setter          | #channel      | new topic                    | `'topic'`           | `''`                    | {@link TopicContext}             |
 * | quit        | quitter         | null          | quit reason                  | `'quit'`            | `''`                    | {@link QuitContext}              |
 * | invite      | inviter         | #channel      | `"#chan nick!ident@host"`    | `'INVITE'`          | `''`                    | {@link InviteContext}            |
 * | time        | `''`            | null          | `''`                         | `''`                | `''`                    | {@link TimeContext}              |
 * | raw         | `''`            | null          | raw server line              | raw command         | raw params              | {@link RawContext}               |
 * | join_error  | bot nick        | #channel      | failure reason               | error name          | `''`                    | {@link JoinErrorContext}         |
 */
export interface BaseHandlerContext {
  /** Nick of the user who triggered this event. For `kick`: the kicked user (not the kicker). */
  nick: string;
  /** Ident of the user who triggered this event. */
  ident: string;
  /** Hostname of the user who triggered this event. */
  hostname: string;
  /**
   * Services account name for the triggering user, when IRCv3 `account-tag`
   * was present on the inbound message.
   * - `string`    — authoritative: server confirmed this account sent the message
   * - `null`      — authoritative: server confirmed the sender is not identified
   * - `undefined` — tag not available (no account-tag cap, non-PRIVMSG event,
   *                 or server didn't include the tag on this message)
   * Plugin authors should treat a defined value as safer than a WHOIS / ACC
   * round-trip and an undefined value as "unknown, fall back to other signals".
   */
  account?: string | null;
  /**
   * Raw message text (for `pub`/`msg`/`pubm`/`msgm`: includes IRC formatting codes).
   * For non-message events, a synthetic string — see table above.
   */
  text: string;
  /**
   * For `pub`/`msg`: the first whitespace-delimited word with formatting stripped (e.g. `'!op'`).
   * For `pubm`/`msgm` triggered by `/me` actions: `''`.
   * For non-message events: an event-specific keyword — see table above.
   */
  command: string;
  /**
   * For `pub`/`msg`: everything after the command word, trimmed.
   * For `pubm`/`msgm` triggered by `/me` actions: the action text.
   * For other events: event-specific value — see table above.
   */
  args: string;
  /**
   * Send a reply to the channel (or nick if from a PM).
   * Long messages are automatically split. Output is rate-limited.
   */
  reply(msg: string): void;
  /**
   * Send a private NOTICE reply to the originating nick.
   * Long messages are automatically split. Output is rate-limited.
   */
  replyPrivate(msg: string): void;
}

/** Channel is guaranteed to be set. Bind types: `pub`, `pubm`, `join`, `part`, `kick`, `mode`, `topic`, `invite`, `join_error`. */
export interface ChannelHandlerContext extends BaseHandlerContext {
  channel: string;
}

/** Channel is guaranteed to be null. Bind types: `msg`, `msgm`, `nick`, `ctcp`, `quit`, `time`, `raw`. */
export interface NullChannelHandlerContext extends BaseHandlerContext {
  channel: null;
}

/**
 * Channel may be either. Bind type: `notice` — channel notices carry a channel,
 * PM notices do not. Handlers must narrow before using `channel`.
 */
export interface NullableChannelHandlerContext extends BaseHandlerContext {
  channel: string | null;
}

/** Context for `'join'` binds. */
export interface JoinContext extends ChannelHandlerContext {
  command: 'JOIN';
  args: '';
}

/** Context for `'part'` binds. `args` is the part reason (may be empty). */
export interface PartContext extends ChannelHandlerContext {
  command: 'PART';
}

/**
 * Context for `'kick'` binds. `nick` is the *kicked* user (not the kicker);
 * `args` is `"reason (by kicker)"` or `"by kicker"`.
 */
export interface KickContext extends ChannelHandlerContext {
  command: 'KICK';
}

/** Context for `'nick'` binds. `nick` is the old nick; `args` and `text` are the new nick. */
export interface NickContext extends NullChannelHandlerContext {
  command: 'NICK';
}

/** Context for `'mode'` binds. `command` is the mode string (e.g. `'+o'`); `args` is the mode parameter. */
// Mode strings are not literal-narrowable, so this is structurally identical to ChannelHandlerContext.
export type ModeContext = ChannelHandlerContext;

/** Context for `'topic'` binds. `text` is the new topic. */
export interface TopicContext extends ChannelHandlerContext {
  command: 'topic';
  args: '';
}

/** Context for `'invite'` binds. */
export interface InviteContext extends ChannelHandlerContext {
  command: 'INVITE';
  args: '';
}

/** Context for `'quit'` binds. `text` is the quit reason. */
export interface QuitContext extends NullChannelHandlerContext {
  command: 'quit';
  args: '';
}

/** Context for `'time'` (timer) binds. All user fields are empty — timers fire on a schedule, not on user input. */
export interface TimeContext extends NullChannelHandlerContext {
  nick: '';
  ident: '';
  hostname: '';
  text: '';
  command: '';
  args: '';
}

/** Context for `'join_error'` binds. `command` is the irc-framework error name (or `'need_registered_nick'`); `text` is the failure reason. */
export interface JoinErrorContext extends ChannelHandlerContext {
  args: '';
}

/** Context for `'ctcp'` binds. `command` is the uppercased CTCP type (e.g. `'PING'`); `text`/`args` are the payload. */
// CTCP types are user-controlled and unbounded, so this is structurally identical to NullChannelHandlerContext.
export type CtcpContext = NullChannelHandlerContext;

/** Context for `'raw'` binds. Free-form fields carrying the raw server line. */
// Raw binds are rarely used and fields are already loose, so this is structurally identical to NullChannelHandlerContext.
export type RawContext = NullChannelHandlerContext;

/**
 * Mapped type: pick the right handler context for a given bind type.
 * Used by {@link BindHandler} to narrow `ctx` at plugin call sites.
 */
export type BindContextFor<T extends BindType> = T extends 'pub'
  ? ChannelHandlerContext
  : T extends 'pubm'
    ? ChannelHandlerContext
    : T extends 'msg'
      ? NullChannelHandlerContext
      : T extends 'msgm'
        ? NullChannelHandlerContext
        : T extends 'join'
          ? JoinContext
          : T extends 'part'
            ? PartContext
            : T extends 'kick'
              ? KickContext
              : T extends 'nick'
                ? NickContext
                : T extends 'mode'
                  ? ModeContext
                  : T extends 'raw'
                    ? RawContext
                    : T extends 'time'
                      ? TimeContext
                      : T extends 'ctcp'
                        ? CtcpContext
                        : T extends 'notice'
                          ? NullableChannelHandlerContext
                          : T extends 'topic'
                            ? TopicContext
                            : T extends 'quit'
                              ? QuitContext
                              : T extends 'invite'
                                ? InviteContext
                                : T extends 'join_error'
                                  ? JoinErrorContext
                                  : never;

/**
 * The widest handler context — a union over every bind type. Used by dispatcher
 * and permission internals where the bind type isn't statically known. Plugin
 * authors rarely see this directly; `api.bind<'pub'>(...)` narrows automatically.
 */
export type HandlerContext = BindContextFor<BindType>;

/**
 * Signature for bind handler functions. Generic on `BindType` so `ctx` narrows
 * to the specific per-type shape at the call site. Defaults to the widest
 * `HandlerContext` union for code that takes handlers without knowing the type.
 */
export type BindHandler<T extends BindType = BindType> = (
  ctx: BindContextFor<T>,
) => void | Promise<void>;
