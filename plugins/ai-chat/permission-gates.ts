// ai-chat — permission / privilege / founder gates.
//
// All gate logic is pure or depends only on the PluginAPI + AiChatConfig.
// No module-scope state, no side effects beyond the founder post-gate's
// one `api.warn(...)` drop-log call. Split out of index.ts to keep the
// plugin entry thin and so the gate rules are readable in one place.
//
// Two layers of gating exist:
//   1. Trigger time: shouldRespond / shouldRespondReason — called by pubm
//      before we commit to running the pipeline.
//   2. Post time: isFounderPostGate / postGateFor — called by the sender
//      right before each line hits IRC, closing the race where ChanServ
//      access flips between the LLM round-trip start and end.
import type { HandlerContext, PluginAPI } from '../../src/types';
import type { AiChatConfig } from './config';
import { isIgnored, isLikelyBot } from './triggers';

export interface ShouldRespondCtx {
  nick: string;
  ident: string;
  hostname: string;
  channel: string | null;
  botNick: string;
  hasRequiredFlag: boolean;
  /** Does the user have the privilege-gating flag (e.g. +m)? */
  hasPrivilegedFlag: boolean;
  /** Bot's channel modes (e.g. 'o', 'ov') or undefined if unknown. */
  botChannelModes: string | undefined;
  /**
   * Bot's resolved ChanServ access tier for this channel (from the
   * `chanserv_access` chanset). `undefined` when no channel context is
   * available (PM etc.). Used by the founder-disable gate.
   */
  botChanservAccess: string | undefined;
  config: AiChatConfig;
  /** Dynamic ignore list (from DB) merged with config.permissions.ignoreList. */
  dynamicIgnoreList: string[];
}

/**
 * Check whether the bot's privilege level in the channel restricts AI responses.
 *
 * When `security.privilege_gating` is enabled and the bot has elevated channel
 * modes (half-op or above), either:
 * - `disable_when_privileged`: block all responses
 * - Otherwise: require the user to have the configured bot flag (default +m)
 */
function isPrivilegeRestricted(ctx: ShouldRespondCtx): boolean {
  const sec = ctx.config.security;
  if (!sec.privilegeGating || !ctx.channel) return false;

  const botModes = ctx.botChannelModes;
  if (!botModes) return false;

  // Check if bot has any elevated mode at or above threshold
  const elevated = ['q', 'a', 'o', 'h']; // founder, admin, op, halfop
  const threshIdx = elevated.indexOf(sec.privilegedModeThreshold);
  if (threshIdx === -1) return false;
  const eligibleModes = elevated.slice(0, threshIdx + 1);
  if (!eligibleModes.some((m) => botModes.includes(m))) return false;

  // Bot is privileged. Disable entirely or gate by flag.
  if (sec.disableWhenPrivileged) return true;
  return !ctx.hasPrivilegedFlag;
}

/**
 * Pure rule for the founder-disable gate. Exported for testing. A compromised
 * or prompt-injected response at founder tier can DROP the channel, transfer
 * founder to an attacker, or wipe the access list — none recoverable without
 * services-staff intervention — so we refuse to respond when the bot's
 * ChanServ tier for the channel reads `'founder'`. Only the affirmative
 * string matches; `undefined` / `'none'` / `'op'` / `'superop'` all permit.
 */
export function shouldBlockOnFounder(
  disableWhenFounder: boolean,
  channel: string | null,
  chanservAccess: string | undefined,
): boolean {
  if (!disableWhenFounder) return false;
  if (!channel) return false;
  // Normalise: defend against casing/whitespace drift if a non-chanmod path
  // ever writes chanserv_access without going through the allowedValues enum.
  return chanservAccess?.trim().toLowerCase() === 'founder';
}

function isFounderRestricted(ctx: ShouldRespondCtx): boolean {
  return shouldBlockOnFounder(
    ctx.config.security.disableWhenFounder,
    ctx.channel,
    ctx.botChanservAccess,
  );
}

/**
 * Reason a message was rejected. `'allowed'` means it passed every gate. The
 * other values name the specific gate that fired so the pubm-level debug log
 * can attribute drops without re-running each predicate.
 */
export type ShouldRespondReason =
  | 'allowed'
  | 'self'
  | 'bot_nick'
  | 'ignored'
  | 'no_flag'
  | 'privilege_restricted'
  | 'founder_restricted';

export function shouldRespondReason(ctx: ShouldRespondCtx): ShouldRespondReason {
  const nick = ctx.nick;
  if (nick.toLowerCase() === ctx.botNick.toLowerCase()) return 'self';
  if (
    isLikelyBot(nick, ctx.config.permissions.botNickPatterns, ctx.config.permissions.ignoreBots)
  ) {
    return 'bot_nick';
  }
  const hostmask = `${nick}!${ctx.ident}@${ctx.hostname}`;
  const fullIgnore = [...ctx.config.permissions.ignoreList, ...ctx.dynamicIgnoreList];
  if (isIgnored(nick, hostmask, fullIgnore)) return 'ignored';
  if (ctx.config.permissions.requiredFlag !== '-' && !ctx.hasRequiredFlag) return 'no_flag';
  if (isPrivilegeRestricted(ctx)) return 'privilege_restricted';
  if (isFounderRestricted(ctx)) return 'founder_restricted';
  return 'allowed';
}

/**
 * True when every gate (self/bot-nick/ignore/flag/privilege/founder) passes.
 * Thin wrapper over `shouldRespondReason` for call sites that don't care
 * which gate fired.
 */
export function shouldRespond(ctx: ShouldRespondCtx): boolean {
  return shouldRespondReason(ctx) === 'allowed';
}

// ---------------------------------------------------------------------------
// Helpers: build ShouldRespondCtx fields from the PluginAPI
// ---------------------------------------------------------------------------

export function getBotChannelModes(api: PluginAPI, channel: string | null): string | undefined {
  if (!channel) return undefined;
  const ch = api.getChannel(channel);
  if (!ch) return undefined;
  for (const u of ch.users.values()) {
    if (api.isBotNick(u.nick)) return u.modes;
  }
  return undefined;
}

/**
 * Read the bot's ChanServ access tier for a channel from the chanset written
 * by chanmod. Returns undefined for PMs and for channels chanmod has never
 * touched. Used by the founder-disable gate at both trigger and post time.
 */
export function getBotChanservAccess(api: PluginAPI, channel: string | null): string | undefined {
  if (!channel) return undefined;
  return api.channelSettings.getString(channel, 'chanserv_access');
}

/**
 * Post-time fail-closed gate. Re-checks the founder condition right before we
 * publish to IRC, closing the race where the ChanServ probe resolves between
 * the trigger-time `shouldRespond` decision and the LLM round-trip completing.
 * Returns true when the response must be discarded. Logs the drop.
 */
export function isFounderPostGate(
  api: PluginAPI,
  cfg: AiChatConfig,
  channel: string | null,
  reason: string,
): boolean {
  const block = shouldBlockOnFounder(
    cfg.security.disableWhenFounder,
    channel,
    getBotChanservAccess(api, channel),
  );
  if (!block) return false;
  api.warn(
    `post-gate: dropped ${reason} response — bot is ChanServ founder in ${channel} ` +
      `(disable_when_founder is on; grant op/AOP instead, or disable this gate explicitly)`,
  );
  return true;
}

/**
 * Build the post-gate predicate expected by `sender.ts`. Captures the
 * `api`/`cfg`/`channel` triple once so the call sites below can pass a
 * single thunk instead of re-threading three arguments.
 */
export function postGateFor(
  api: PluginAPI,
  cfg: AiChatConfig,
  channel: string | null,
): (reason: string) => boolean {
  return (reason) => isFounderPostGate(api, cfg, channel, reason);
}

/**
 * One-line debug summary of a pubm decision. Lets `api.debug` show why a
 * given message was skipped or routed without dumping full context. Text is
 * truncated and quoted so newlines / control bytes can't smear log lines.
 */
export function traceLine(
  ctx: HandlerContext,
  text: string,
  fields: { trigger: string; reason: ShouldRespondReason; action: string },
): string {
  const snippet = text.length > 60 ? text.slice(0, 60) + '…' : text;
  const safe = JSON.stringify(snippet);
  return (
    `pubm ch=${ctx.channel ?? '(none)'} nick=${ctx.nick} ` +
    `trigger=${fields.trigger} gate=${fields.reason} → ${fields.action} text=${safe}`
  );
}
