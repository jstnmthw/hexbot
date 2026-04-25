// HexBot — Per-channel settings commands
// Registers .chanset and .chaninfo with the command handler.
// `.chanset` is the channel-scope-specific operator surface — its
// Eggdrop-style `+key`/`-key` toggle ergonomics make it the path of
// least friction for per-channel flags. `.set #chan key value` does
// the same thing internally (both routes call the same
// SettingsRegistry); operators pick by preference.
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import type { ChannelSettingEntry, ChannelSettingValue } from '../../types';
import { sanitize } from '../../utils/sanitize';
import { tryAudit } from '../audit';
import type { ChannelSettings } from '../channel-settings';
import { formatFlagGrid, formatValueLines } from './settings-render';

type SnapshotItem = { entry: ChannelSettingEntry; value: ChannelSettingValue; isDefault: boolean };

export interface ChannelCommandsDeps {
  handler: CommandHandler;
  channelSettings: ChannelSettings;
  db: BotDatabase | null;
}

/**
 * Register .chanset and .chaninfo commands on the given command handler.
 *
 * `db` is used to write `chanset-set` / `chanset-unset` rows to `mod_log`
 * — the admin-layer mutation flagged in the project memory must always
 * be auditable, regardless of whether the command was driven from REPL,
 * DCC, or relayed through bot-link.
 */
export function registerChannelCommands(deps: ChannelCommandsDeps): void {
  const { handler, channelSettings, db } = deps;
  // ---------------------------------------------------------------------------
  // .chanset #chan [+/-]key [value]
  // ---------------------------------------------------------------------------
  handler.registerCommand(
    'chanset',
    {
      flags: 'm',
      description: 'Set a per-channel setting',
      usage: '.chanset #chan [+/-]key [value]',
      category: 'settings',
    },
    (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const channel = parts[0];

      if (!channel || !/^[#&]/.test(channel)) {
        ctx.reply('Usage: .chanset #chan [+/-]key [value]');
        return;
      }

      // No key argument → list all registered settings for the channel.
      // Splits flag-typed entries into a compact grid and others into
      // labeled lines for legibility on a narrow DCC console.
      if (parts.length < 2 || !parts[1]) {
        const snapshot = channelSettings.getChannelSnapshot(channel);
        if (snapshot.length === 0) {
          ctx.reply('No channel settings registered (no plugins with settings loaded)');
          return;
        }
        ctx.reply(`Settings for ${channel} — .chanset ${channel} <key> for details:`);

        const flags = snapshot.filter((s) => s.entry.type === 'flag');
        const others = snapshot.filter((s) => s.entry.type !== 'flag');
        const lines = [...formatFlagGrid(flags), ...formatValueLines(others)];
        ctx.reply(lines.join('\n'));
        return;
      }

      const rawKey = parts[1];
      const hasPrefix = rawKey.startsWith('+') || rawKey.startsWith('-');
      const prefix = hasPrefix ? rawKey[0] : null;
      const key = hasPrefix ? rawKey.slice(1) : rawKey;

      if (!key) {
        ctx.reply('Usage: .chanset #chan [+/-]key [value]');
        return;
      }

      const def = channelSettings.getDef(key);
      if (!def) {
        ctx.reply(`Unknown setting: "${key}" — use .chanset ${channel} to list available settings`);
        return;
      }

      // +key / -key prefix forms
      if (prefix === '+') {
        if (def.type !== 'flag') {
          ctx.reply(`Use \`.chanset ${channel} ${key} value\` for ${def.type} settings`);
          return;
        }
        channelSettings.set(channel, key, true);
        ctx.reply(`${channel} ${key} = ON`);
        tryAudit(db, ctx, { action: 'chanset-set', channel, target: key, reason: 'true' });
        return;
      }

      if (prefix === '-') {
        channelSettings.unset(channel, key);
        const defaultVal = def.type === 'flag' ? (def.default ? 'ON' : 'OFF') : String(def.default);
        ctx.reply(`${channel} ${key} reverted to default (${defaultVal})`);
        tryAudit(db, ctx, { action: 'chanset-unset', channel, target: key });
        return;
      }

      // No prefix and exactly two args (`#chan key`): show the current
      // value plus the registered description as a detail view. The mIRC
      // color codes only render in clients that honor them; consoles
      // that strip formatting (REPL, DCC with stripFormatting on output)
      // simply see the unstyled text.
      if (parts.length === 2) {
        const value = channelSettings.get(channel, key);
        const isSet = channelSettings.isSet(channel, key);
        const display = def.type === 'flag' ? (value ? 'ON' : 'OFF') : String(value) || '(not set)';
        // mIRC formatting: \x02 bold, \x034 red, \x0F reset (same convention as src/core/dcc.ts)
        const bold = (s: string) => `\x02${s}\x02`;
        const redBold = (s: string) => `\x02\x034${s}\x0F`;
        ctx.reply(
          `${channel} ${redBold(key)} (${def.type}) = ${bold(display)}${isSet ? '' : ' (default)'} — ${def.description}`,
        );
        return;
      }

      // Set value (string/int — flags require +/- prefix and were handled above).
      if (def.type === 'flag') {
        ctx.reply(
          `Use \`.chanset ${channel} +${key}\` or \`.chanset ${channel} -${key}\` for flags`,
        );
        return;
      }

      // Sanitize the value before it touches the settings store — values
      // can be echoed back over IRC by plugins that read them, so strip
      // CRLF / NUL up-front. See docs/SECURITY.md on user-input handling.
      const rawValue = sanitize(parts.slice(2).join(' '));
      if (def.type === 'int') {
        // Strict int parsing: parseInt('42abc', 10) returns 42, which would
        // silently accept garbage. Number(rawValue) + isInteger rejects any
        // trailing non-digit characters.
        const trimmed = rawValue.trim();
        const n = Number(trimmed);
        if (trimmed === '' || !Number.isInteger(n)) {
          ctx.reply(`"${rawValue}" is not a valid integer`);
          return;
        }
        channelSettings.set(channel, key, n);
        ctx.reply(`${channel} ${key} = ${n}`);
        tryAudit(db, ctx, { action: 'chanset-set', channel, target: key, reason: String(n) });
      } else {
        if (def.allowedValues && !def.allowedValues.includes(rawValue)) {
          ctx.reply(
            `Invalid value "${rawValue}" for ${key} — allowed: ${def.allowedValues.join(', ')}`,
          );
          return;
        }
        channelSettings.set(channel, key, rawValue);
        ctx.reply(`${channel} ${key} = ${rawValue}`);
        tryAudit(db, ctx, { action: 'chanset-set', channel, target: key, reason: rawValue });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // .chaninfo #chan
  // ---------------------------------------------------------------------------
  handler.registerCommand(
    'chaninfo',
    {
      flags: '+o',
      description: 'Show all per-channel settings for a channel',
      usage: '.chaninfo #chan',
      category: 'settings',
    },
    (args, ctx) => {
      const channel = args.trim();
      if (!channel || !/^[#&]/.test(channel)) {
        ctx.reply('Usage: .chaninfo #chan');
        return;
      }

      const snapshot = channelSettings.getChannelSnapshot(channel);
      if (snapshot.length === 0) {
        ctx.reply('No settings registered (no plugins with channel settings loaded)');
        return;
      }

      const setCount = snapshot.filter((s) => !s.isDefault).length;
      const defaultCount = snapshot.filter((s) => s.isDefault).length;
      ctx.reply(`Channel settings for ${channel} (${setCount} set, ${defaultCount} default):`);

      // Group by plugin
      const byPlugin = new Map<string, SnapshotItem[]>();
      for (const item of snapshot) {
        const list = byPlugin.get(item.entry.pluginId) ?? [];
        list.push(item);
        byPlugin.set(item.entry.pluginId, list);
      }

      const lines: string[] = [];
      for (const [pluginId, items] of byPlugin) {
        const pluginPrefix = `[${pluginId}] `;
        const flags = items.filter((s) => s.entry.type === 'flag');
        const others = items.filter((s) => s.entry.type !== 'flag');
        lines.push(...formatFlagGrid(flags, pluginPrefix));
        lines.push(...formatValueLines(others, pluginPrefix));
      }
      ctx.reply(lines.join('\n'));
    },
  );
}
