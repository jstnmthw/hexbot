// HexBot — Channel ban admin commands
// Registers .bans, .ban, .unban, .stick, .unstick with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { formatDuration, parseDuration } from '../../utils/duration';
import { paginate, parsePageFlag } from '../../utils/paginate';
import { stripFormatting } from '../../utils/strip-formatting';
import { auditActor, tryAudit } from '../audit';
import type { BanStore } from '../ban-store';
import type { BotLinkHub, SharedBanList } from '../botlink';
import { parseBanArgs } from '../command-helpers';
import type { BanOperator } from '../irc-commands';

export interface BanCommandsDeps {
  commandHandler: CommandHandler;
  banStore: BanStore;
  ircCommands: BanOperator;
  db: BotDatabase;
  hub: BotLinkHub | null;
  sharedBanList: SharedBanList | null;
  ircLower: (s: string) => string;
}

/**
 * Register channel ban admin commands (`.bans`, `.ban`, `.unban`, `.stick`,
 * `.unstick`) on the given command handler.
 *
 * Mutating commands both push the MODE to IRC via {@link BanOperator} and
 * persist the ban in {@link BanStore} so sticky-ban re-application survives
 * restarts. When `hub` is non-null the same events are broadcast over the
 * bot link so shared-ban state converges across leaves. Every mutation
 * writes a `mod_log` row via `tryAudit` — see CLAUDE.md for the audit
 * convention.
 */
export function registerBanCommands(deps: BanCommandsDeps): void {
  const { commandHandler, banStore, ircCommands, db, hub, sharedBanList, ircLower } = deps;

  // -------------------------------------------------------------------------
  // .bans [#channel] — list tracked bans
  // -------------------------------------------------------------------------

  commandHandler.registerCommand(
    'bans',
    {
      flags: '+o',
      description: 'List tracked channel bans',
      usage: '.bans [#channel] [--page N]',
      category: 'moderation',
    },
    (rawArgs, ctx) => {
      const { page, rest } = parsePageFlag(rawArgs);
      const args = rest;
      const channelArg = args.trim() || undefined;
      const localBans = channelArg ? banStore.getChannelBans(channelArg) : banStore.getAllBans();

      // Collect shared-only bans (bans we heard about over botlink but
      // never wrote to our local store). Presented with a [shared] tag so
      // operators can tell at a glance which side owns a given entry.
      const sharedEntries: Array<{
        channel: string;
        mask: string;
        by: string;
      }> = [];
      if (sharedBanList) {
        const channels = channelArg ? [channelArg] : sharedBanList.getChannels();
        // Build the local-mask key set with `${channel}:${mask}` — the
        // local channel is already case-folded by BanStore so we don't
        // re-apply ircLower here. The shared lookup below DOES need
        // ircLower since SharedBanList keys come straight off the wire.
        const localMasks = new Set(localBans.map((b) => `${b.channel}:${b.mask}`));
        for (const ch of channels) {
          for (const entry of sharedBanList.getBans(ch)) {
            const key = `${ircLower(ch)}:${entry.mask}`;
            if (!localMasks.has(key)) {
              sharedEntries.push({ channel: ch, mask: entry.mask, by: entry.setBy });
            }
          }
        }
      }

      const total = localBans.length + sharedEntries.length;
      if (total === 0) {
        ctx.reply(channelArg ? `No tracked bans for ${channelArg}.` : 'No tracked bans.');
        return;
      }

      // Build the data lines first, then prepend the header after
      // pagination so the header appears on every page.
      const dataLines: string[] = [];
      const now = Date.now();
      for (const ban of localBans) {
        const remaining = ban.expires === 0 ? 'permanent' : formatDuration(ban.expires - now);
        const stickyTag = ban.sticky ? ' [sticky]' : '';
        dataLines.push(
          `  ${stripFormatting(ban.channel).padEnd(12)} ${stripFormatting(ban.mask).padEnd(25)} by ${stripFormatting(ban.by).padEnd(10)} ${remaining}${stickyTag}`,
        );
      }
      for (const entry of sharedEntries) {
        // Shared entries arrive over botlink — sanitized at the frame
        // boundary, but strip-format again for defense-in-depth so a
        // crafted `by` never repaints the operator's terminal.
        dataLines.push(
          `  ${stripFormatting(entry.channel).padEnd(12)} ${stripFormatting(entry.mask).padEnd(25)} by ${stripFormatting(entry.by).padEnd(10)} [shared]`,
        );
      }
      const paged = paginate(dataLines, page);
      const out = [`Channel bans (${total}):`, ...paged.lines];
      if (paged.footer) out.push(paged.footer);
      ctx.reply(out.join('\n'));
    },
  );

  // -------------------------------------------------------------------------
  // .ban #channel <mask> [duration] [reason...]
  // -------------------------------------------------------------------------

  commandHandler.registerCommand(
    'ban',
    {
      flags: '+m',
      description: 'Add a channel ban',
      usage: '.ban #channel <mask> [duration] [reason...]',
      category: 'moderation',
    },
    (args, ctx) => {
      const parsed = parseBanArgs(args);
      if (!parsed) {
        ctx.reply('Usage: .ban #channel <mask> [duration] [reason...]');
        return;
      }
      const { channel, mask } = parsed;
      // 200-char ceiling matches the hostmask length cap in `.adduser` and
      // bounds the row size we persist in BanStore. RFC 2812 nick+user+host
      // tops out well below this; anything longer is almost certainly a
      // malformed mask or an attempt to bloat the store.
      if (mask.length > 200) {
        ctx.reply('Ban mask too long (max 200 characters).');
        return;
      }

      // 0 is the BanStore sentinel for "permanent" — no expiry sweep.
      // Optional duration token only — trailing words after the
      // duration are dropped. The .ban handler used to thread them as
      // `reason` into a duplicate tryAudit row (audit 2026-05-10
      // closed that); today the single mod_log row is written by
      // IRCCommands.ban and inherits the actor only.
      let durationMs = 0;
      const rest = parsed.rest;
      if (rest.length > 0) {
        const parsedDuration = parseDuration(rest[0]);
        if (parsedDuration !== null) {
          durationMs = parsedDuration;
        }
      }

      // Persist first, then push the MODE — the order matters because
      // BanStore is the source of truth for sticky-ban re-application
      // on rejoin. If the IRC send fails or the bot disconnects before
      // ircop reflects, the next reconnect still has the row to reapply.
      // Pass the resolved actor so `IRCCommands.ban` writes the single
      // attribution row — without it, two rows land for one action: one
      // attributed to `system`/`bot`, one written here. Auditing wants
      // exactly one row per action, attributed to the caller.
      banStore.storeBan(channel, mask, ctx.nick, durationMs);
      try {
        ircCommands.ban(channel, mask, auditActor(ctx));
      } catch (err) {
        // `IRCCommands.ban -> mode()` throws on parse / param-count
        // mismatches (malformed mask, capabilities mid-renegotiation).
        // Reply with the message instead of letting the throw escape into
        // the dispatcher's catch where the operator just sees a generic
        // "command failed" without context.
        const msg = err instanceof Error ? err.message : String(err);
        ctx.reply(`Ban send failed: ${msg}`);
        return;
      }

      // Propagate via botlink if hub is active — leaves apply the ban to
      // their local stores so a rejoin on another bot still bounces.
      if (hub) {
        hub.broadcast({
          type: 'CHAN_BAN_ADD',
          channel,
          mask,
          setBy: ctx.nick,
          setAt: Date.now(),
        });
      }

      const durStr = durationMs === 0 ? 'permanent' : formatDuration(durationMs);
      ctx.reply(`Banned ${mask} in ${channel} (${durStr}).`);
    },
  );

  // -------------------------------------------------------------------------
  // .unban #channel <mask>
  // -------------------------------------------------------------------------

  commandHandler.registerCommand(
    'unban',
    {
      flags: '+m',
      description: 'Remove a channel ban',
      usage: '.unban #channel <mask>',
      category: 'moderation',
    },
    (args, ctx) => {
      const parsed = parseBanArgs(args);
      if (!parsed) {
        ctx.reply('Usage: .unban #channel <mask>');
        return;
      }
      const { channel, mask } = parsed;

      banStore.removeBan(channel, mask);
      // Single audit row from IRCCommands.unban with the caller as `by`
      // — see the matching comment on `.ban` above. Avoids the
      // double-row pattern that prior callers fell into.
      try {
        ircCommands.unban(channel, mask, auditActor(ctx));
      } catch (err) {
        // mode()-parse errors surface as a friendly reply instead of a
        // bare dispatcher catch — see the matching .ban comment.
        const msg = err instanceof Error ? err.message : String(err);
        ctx.reply(`Unban send failed: ${msg}`);
        return;
      }

      if (hub) {
        hub.broadcast({ type: 'CHAN_BAN_DEL', channel, mask });
      }

      ctx.reply(`Unbanned ${mask} in ${channel}.`);
    },
  );

  // -------------------------------------------------------------------------
  // .stick #channel <mask>
  // -------------------------------------------------------------------------

  commandHandler.registerCommand(
    'stick',
    {
      flags: '+m',
      description: 'Mark a ban as sticky (auto-re-apply if removed)',
      usage: '.stick #channel <mask>',
      category: 'moderation',
    },
    (args, ctx) => {
      const parsed = parseBanArgs(args);
      if (!parsed) {
        ctx.reply('Usage: .stick #channel <mask>');
        return;
      }
      const { channel, mask } = parsed;

      if (!banStore.setSticky(channel, mask, true)) {
        ctx.reply(`No tracked ban for ${mask} in ${channel}.`);
        return;
      }
      ctx.reply(`Ban ${mask} in ${channel} is now sticky.`);
      tryAudit(db, ctx, { action: 'stick', channel, target: mask });
    },
  );

  // -------------------------------------------------------------------------
  // .unstick #channel <mask>
  // -------------------------------------------------------------------------

  commandHandler.registerCommand(
    'unstick',
    {
      flags: '+m',
      description: 'Remove sticky flag from a ban',
      usage: '.unstick #channel <mask>',
      category: 'moderation',
    },
    (args, ctx) => {
      const parsed = parseBanArgs(args);
      if (!parsed) {
        ctx.reply('Usage: .unstick #channel <mask>');
        return;
      }
      const { channel, mask } = parsed;

      if (!banStore.setSticky(channel, mask, false)) {
        ctx.reply(`No tracked ban for ${mask} in ${channel}.`);
        return;
      }
      ctx.reply(`Ban ${mask} in ${channel} is no longer sticky.`);
      tryAudit(db, ctx, { action: 'unstick', channel, target: mask });
    },
  );
}
