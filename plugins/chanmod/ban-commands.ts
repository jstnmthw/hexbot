// chanmod — !ban / !unban / !kickban / !bans
//
// Split out of commands.ts so the mode-command factory and the ban-command
// bodies (each with their own mask validation and ban-store bookkeeping) can
// be read in isolation.
import type { PluginAPI } from '../../src/types';
import { botHasOps, buildBanMask, formatExpiry, isValidNick } from './helpers';
import type { ChanmodConfig } from './state';

/**
 * Score a ban-mask pattern by how specific it is — literal (non-wildcard)
 * characters score +10 each, wildcards score -1. Mirrors
 * `src/core/hostmask-matcher.ts:patternSpecificity()` so the `--force`
 * threshold here uses the same scoring model operators already see
 * reported for weak user hostmasks. Inlined because
 * `patternSpecificity` lives on the core side of the plugin boundary
 * and is type-only for plugins.
 */
function banMaskSpecificity(pattern: string): number {
  let literal = 0;
  let wildcards = 0;
  for (const ch of pattern) {
    if (ch === '*' || ch === '?') wildcards++;
    else literal++;
  }
  return literal * 10 - wildcards;
}

/**
 * Below this score, `.ban <mask>` refuses to ban without `--force`.
 * Calibrated to flag truly overbroad ban masks (e.g. `*!*@*`→28,
 * `*!*@*.com`→67) while still accepting the common shapes operators
 * actually use (e.g. `*!*@bad.host`→98, `*!*@*.bad.host`→107). The
 * cutoff sits deliberately below `WEAK_HOSTMASK_THRESHOLD=100` in
 * `src/core/permissions.ts` — a user-record hostmask must be more
 * specific than a throwaway ban mask (a `b` list entry is revoked
 * at the end of the ban duration; a weak privileged-user mask stays
 * forever).
 */
const BAN_MASK_MIN_SPECIFICITY = 70;

/**
 * Register `!ban`, `!unban`, `!kickban`, `!bans` command binds with the core
 * help registry and the dispatcher. All require the caller to hold `+o` and
 * the bot to be opped. Ban durations are persisted via `api.banStore`; the
 * periodic expiry sweep lives in `bans.ts`.
 */
export function registerBanCommands(api: PluginAPI, config: ChanmodConfig): void {
  api.registerHelp([
    {
      command: '!ban',
      flags: 'o',
      usage: '!ban <nick|mask> [minutes]',
      description: 'Ban a nick or mask; optionally timed',
      category: 'moderation',
    },
    {
      command: '!unban',
      flags: 'o',
      usage: '!unban <nick|mask>',
      description: 'Remove a ban by nick or mask',
      category: 'moderation',
    },
    {
      command: '!kickban',
      flags: 'o',
      usage: '!kickban <nick> [reason]',
      description: 'Ban and kick in one step',
      category: 'moderation',
    },
    {
      command: '!bans',
      flags: 'o',
      usage: '!bans [channel]',
      description: 'List tracked bans and expiry times',
      category: 'moderation',
    },
  ]);

  api.bind('pub', '+o', '!ban', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const rawParts = ctx.args
      .trim()
      .split(/\s+/)
      .filter((p) => p.length > 0);
    if (rawParts.length === 0) {
      ctx.reply('Usage: !ban <nick|mask> [-t <minutes>] [--force]');
      return;
    }

    // Parse flags: `-t <minutes>` for explicit duration, `--force` to
    // override the overbroad-mask specificity guard. Keep everything
    // else in `positional` — the target (nick or mask) is the first
    // positional. Bare numeric tail triggers a helpful hint rather than
    // silently being interpreted as a duration (the old shape was
    // ambiguous when masks ended in digits).
    let force = false;
    let explicitDurationMinutes: number | null = null;
    const positional: string[] = [];
    for (let i = 0; i < rawParts.length; i++) {
      const p = rawParts[i];
      if (p === '--force') {
        force = true;
        continue;
      }
      if (p === '-t') {
        const next = rawParts[i + 1];
        if (!next || !/^\d+$/.test(next)) {
          ctx.reply('Usage: !ban <nick|mask> [-t <minutes>] [--force]');
          return;
        }
        explicitDurationMinutes = parseInt(next, 10);
        i++;
        continue;
      }
      positional.push(p);
    }

    if (positional.length === 0) {
      ctx.reply('Usage: !ban <nick|mask> [-t <minutes>] [--force]');
      return;
    }

    // Bare-numeric tail without -t: historically this meant "duration",
    // but the shape collides with bans that legitimately end in digits.
    // Warn and refuse instead of silently interpreting. Operators who
    // want a duration must pass `-t`.
    const trailing = positional[positional.length - 1];
    if (explicitDurationMinutes === null && positional.length > 1 && /^\d+$/.test(trailing)) {
      ctx.reply(
        `Numeric trailing arg detected. Use \`-t ${trailing}\` if you meant duration in minutes; otherwise quote the target into a single word.`,
      );
      return;
    }

    const durationMinutes =
      explicitDurationMinutes !== null ? explicitDurationMinutes : config.default_ban_duration;
    const durationMs = durationMinutes === 0 ? 0 : durationMinutes * 60_000;
    const target = positional.join(' ');
    const actor = api.auditActor(ctx);

    if (target.includes('!') || target.includes('@')) {
      // Validate the mask shape: `nick!ident@host` with no whitespace and
      // each segment non-empty (wildcards allowed). A garbage string like
      // `!@` would otherwise hit `mode +b` and let an attacker poison the
      // ban list with unenforceable entries.
      // Regex: optional nick (no `!@` or whitespace) + `!` + optional ident
      // (no `@` or whitespace) + `@` + non-empty host (no whitespace).
      if (!/^[^\s!@]*![^\s@]*@\S+$/.test(target)) {
        ctx.reply('Invalid ban mask. Expected nick!ident@host.');
        return;
      }

      // Specificity guard: refuse overbroad masks without --force.
      if (!force && banMaskSpecificity(target) < BAN_MASK_MIN_SPECIFICITY) {
        ctx.reply(
          `Mask "${target}" is very broad and would ban far beyond the intended target. Re-run with --force if that's really what you want.`,
        );
        return;
      }

      api.ban(channel, target, actor);
      api.banStore.storeBan(channel, target, ctx.nick, durationMs);
      const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
      api.log(
        `${api.stripFormatting(ctx.nick)} banned ${api.stripFormatting(target)} in ${channel} (${durStr})`,
      );
      return;
    }

    if (!isValidNick(target)) {
      ctx.reply('Invalid nick.');
      return;
    }
    if (api.isBotNick(target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const hostmask = api.getUserHostmask(channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Provide an explicit mask: !ban *!*@host`);
      return;
    }

    const banMask = buildBanMask(hostmask, config.default_ban_type);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    // Specificity guard also applies to resolved-from-nick masks — a
    // cloaked host could still produce a surprisingly broad ban (e.g.
    // Libera's `*!*@freenode/staff/...`). Users can --force to bypass.
    if (!force && banMaskSpecificity(banMask) < BAN_MASK_MIN_SPECIFICITY) {
      ctx.reply(
        `Resolved ban mask "${banMask}" is very broad. Re-run with --force if that's really what you want.`,
      );
      return;
    }

    api.ban(channel, banMask, actor);
    api.banStore.storeBan(channel, banMask, ctx.nick, durationMs);
    const durStr = durationMinutes === 0 ? 'permanent' : `${durationMinutes}m`;
    api.log(
      `${api.stripFormatting(ctx.nick)} banned ${api.stripFormatting(target)} (${banMask}) in ${channel} (${durStr})`,
    );
  });

  api.bind('pub', '+o', '!unban', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const arg = ctx.args.trim().split(/\s+/)[0];
    if (!arg) {
      ctx.reply('Usage: !unban <nick|mask>');
      return;
    }
    if (arg.includes('!') || arg.includes('@')) {
      // `api.mode` does not accept an actor — mod_log attribution for
      // `-b` writes goes via the ban-store removal + explicit audit log
      // below rather than through the IRC-command auto-audit path.
      api.mode(channel, '-b', arg);
      api.banStore.removeBan(channel, arg);
      api.log(
        `${api.stripFormatting(ctx.nick)} unbanned ${api.stripFormatting(arg)} in ${channel}`,
      );
      return;
    }

    const hostmask = api.getUserHostmask(channel, arg);
    if (!hostmask) {
      ctx.reply(
        `${arg} is not in the channel. Provide an explicit mask: !unban *!*@host — use !bans to list stored masks.`,
      );
      return;
    }
    // Try all three ban-mask types when unbanning by nick — the original
    // ban could have been set with any of them. Filter out nulls
    // (`buildBanMask` returns null for malformed hostmasks). Match
    // priority is "stored mask wins", with a fallthrough that issues
    // `-b` for every candidate when no record matches (operator best-effort).
    const candidates = [1, 2, 3]
      .map((t) => buildBanMask(hostmask, t))
      .filter((m): m is string => m !== null);
    const records = api.banStore.getChannelBans(channel);
    const storedMasks = new Set(records.map((r) => r.mask));
    const match = candidates.find((m) => storedMasks.has(m));
    if (match) {
      api.mode(channel, '-b', match);
      api.banStore.removeBan(channel, match);
      api.log(
        `${api.stripFormatting(ctx.nick)} unbanned ${api.stripFormatting(arg)} (${match}) in ${channel}`,
      );
    } else {
      // No stored record matched any candidate type — best-effort: try `-b`
      // for every candidate. The server silently ignores `-b` for masks that
      // aren't in the channel ban list, so over-issuing is harmless and
      // covers the case where the original ban was set out-of-band by an
      // operator who didn't go through the bot.
      for (const m of candidates) {
        api.mode(channel, '-b', m);
      }
      api.log(
        `${api.stripFormatting(ctx.nick)} unbanned ${api.stripFormatting(arg)} (no stored record) in ${channel}`,
      );
    }
  });

  api.bind('pub', '+o', '!kickban', (ctx) => {
    const { channel } = ctx;
    if (!botHasOps(api, channel)) {
      ctx.reply('I am not opped in this channel.');
      return;
    }
    const parts = ctx.args.trim().split(/\s+/);
    const target = parts[0];
    if (!target) {
      ctx.reply('Usage: !kickban <nick> [reason]');
      return;
    }
    if (api.isBotNick(target)) {
      ctx.reply('I cannot ban myself.');
      return;
    }

    const reason = parts.slice(1).join(' ') || config.default_kick_reason;

    const hostmask = api.getUserHostmask(channel, target);
    if (!hostmask) {
      ctx.reply(`Cannot resolve hostmask for ${target}. Use !ban <mask> then !kick <nick>.`);
      return;
    }

    const banMask = buildBanMask(hostmask, config.default_ban_type);
    if (!banMask) {
      ctx.reply(`Cannot build ban mask from hostmask: ${hostmask}`);
      return;
    }

    const actor = api.auditActor(ctx);
    api.ban(channel, banMask, actor);
    const kickbanDurationMs =
      config.default_ban_duration === 0 ? 0 : config.default_ban_duration * 60_000;
    api.banStore.storeBan(channel, banMask, ctx.nick, kickbanDurationMs);
    api.kick(channel, target, reason, actor);
    api.log(
      `${api.stripFormatting(ctx.nick)} kickbanned ${api.stripFormatting(target)} (${banMask}) from ${channel} (${reason})`,
    );
  });

  api.bind('pub', '+o', '!bans', (ctx) => {
    const { channel } = ctx;
    const targetChannel = ctx.args.trim() || channel;
    const bans = api.banStore.getChannelBans(targetChannel);
    if (bans.length === 0) {
      ctx.reply(`No tracked bans for ${targetChannel}.`);
      return;
    }
    for (const ban of bans) {
      ctx.reply(
        `${api.stripFormatting(ban.mask)} — set by ${api.stripFormatting(ban.by)}, ${formatExpiry(ban.expires)}`,
      );
    }
  });
}
