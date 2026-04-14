// HexBot — Channel ban admin commands
// Registers .bans, .ban, .unban, .stick, .unstick with the command handler.
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { formatDuration, parseDuration } from '../../utils/duration';
import { tryAudit } from '../audit';
import type { BanStore } from '../ban-store';
import type { BotLinkHub, SharedBanList } from '../botlink';
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
      usage: '.bans [#channel]',
      category: 'moderation',
    },
    (args, ctx) => {
      const channelArg = args.trim() || undefined;
      const localBans = channelArg ? banStore.getChannelBans(channelArg) : banStore.getAllBans();

      // Collect shared-only bans (not in local DB)
      const sharedEntries: Array<{
        channel: string;
        mask: string;
        by: string;
      }> = [];
      if (sharedBanList) {
        const channels = channelArg ? [channelArg] : sharedBanList.getChannels();
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

      const lines = [`Channel bans (${total}):`];
      const now = Date.now();
      for (const ban of localBans) {
        const remaining = ban.expires === 0 ? 'permanent' : formatDuration(ban.expires - now);
        const stickyTag = ban.sticky ? ' [sticky]' : '';
        lines.push(
          `  ${ban.channel.padEnd(12)} ${ban.mask.padEnd(25)} by ${ban.by.padEnd(10)} ${remaining}${stickyTag}`,
        );
      }
      for (const entry of sharedEntries) {
        lines.push(
          `  ${entry.channel.padEnd(12)} ${entry.mask.padEnd(25)} by ${entry.by.padEnd(10)} [shared]`,
        );
      }
      ctx.reply(lines.join('\n'));
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
      const parts = args.trim().split(/\s+/);
      const channel = parts[0];
      const mask = parts[1];
      if (!channel || !channel.startsWith('#') || !mask) {
        ctx.reply('Usage: .ban #channel <mask> [duration] [reason...]');
        return;
      }
      if (mask.length > 200) {
        ctx.reply('Ban mask too long (max 200 characters).');
        return;
      }

      let durationMs = 0; // default: permanent
      let rest = parts.slice(2);
      if (rest.length > 0) {
        const parsed = parseDuration(rest[0]);
        if (parsed !== null) {
          durationMs = parsed;
          rest = rest.slice(1);
        }
      }
      const reason = rest.join(' ') || undefined;

      banStore.storeBan(channel, mask, ctx.nick, durationMs);
      ircCommands.ban(channel, mask);

      // Propagate via botlink if hub is active
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
      tryAudit(db, ctx, {
        action: 'ban',
        channel,
        target: mask,
        reason: reason ?? null,
        metadata: { durationMs },
      });
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
      const parts = args.trim().split(/\s+/);
      const channel = parts[0];
      const mask = parts[1];
      if (!channel || !channel.startsWith('#') || !mask) {
        ctx.reply('Usage: .unban #channel <mask>');
        return;
      }

      banStore.removeBan(channel, mask);
      ircCommands.unban(channel, mask);

      if (hub) {
        hub.broadcast({ type: 'CHAN_BAN_DEL', channel, mask });
      }

      tryAudit(db, ctx, { action: 'unban', channel, target: mask });
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
      const parts = args.trim().split(/\s+/);
      const channel = parts[0];
      const mask = parts[1];
      if (!channel || !channel.startsWith('#') || !mask) {
        ctx.reply('Usage: .stick #channel <mask>');
        return;
      }

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
      const parts = args.trim().split(/\s+/);
      const channel = parts[0];
      const mask = parts[1];
      if (!channel || !channel.startsWith('#') || !mask) {
        ctx.reply('Usage: .unstick #channel <mask>');
        return;
      }

      if (!banStore.setSticky(channel, mask, false)) {
        ctx.reply(`No tracked ban for ${mask} in ${channel}.`);
        return;
      }
      ctx.reply(`Ban ${mask} in ${channel} is no longer sticky.`);
      tryAudit(db, ctx, { action: 'unstick', channel, target: mask });
    },
  );
}
