// HexBot — Per-channel settings commands
// Registers .chanset and .chaninfo with the command handler.
import type { CommandHandler } from '../../command-handler';
import { sanitize } from '../../utils/sanitize';
import type { ChannelSettings } from '../channel-settings';

/**
 * Register .chanset and .chaninfo commands on the given command handler.
 */
export function registerChannelCommands(
  handler: CommandHandler,
  channelSettings: ChannelSettings,
): void {
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

      if (parts.length < 2 || !parts[1]) {
        // List all available settings for this channel
        const snapshot = channelSettings.getChannelSnapshot(channel);
        if (snapshot.length === 0) {
          ctx.reply('No channel settings registered (no plugins with settings loaded)');
          return;
        }
        ctx.reply(`Settings for ${channel} — use .chanset ${channel} [+/-]key [value] to change:`);
        for (const { entry, value, isDefault } of snapshot) {
          let display: string;
          if (entry.type === 'flag') {
            display = value ? 'ON' : 'OFF';
          } else {
            display = String(value) || '(not set)';
          }
          const marker = isDefault ? '' : ' *';
          ctx.reply(
            `  ${entry.key.padEnd(16)} ${entry.type.padEnd(6)} ${display.padEnd(8)}${marker}  ${entry.description}`,
          );
        }
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
        return;
      }

      if (prefix === '-') {
        channelSettings.unset(channel, key);
        const defaultVal = def.type === 'flag' ? (def.default ? 'ON' : 'OFF') : String(def.default);
        ctx.reply(`${channel} ${key} reverted to default (${defaultVal})`);
        return;
      }

      // No prefix: show current value or set value
      if (parts.length === 2) {
        // Show current value
        const value = channelSettings.get(channel, key);
        const isSet = channelSettings.isSet(channel, key);
        const display = def.type === 'flag' ? (value ? 'ON' : 'OFF') : String(value);
        ctx.reply(`${channel} ${key} = ${display}${isSet ? '' : ' (default)'}`);
        return;
      }

      // Set value (string/int — flags require +/- prefix)
      if (def.type === 'flag') {
        ctx.reply(
          `Use \`.chanset ${channel} +${key}\` or \`.chanset ${channel} -${key}\` for flags`,
        );
        return;
      }

      const rawValue = sanitize(parts.slice(2).join(' '));
      if (def.type === 'int') {
        const n = parseInt(rawValue, 10);
        if (isNaN(n)) {
          ctx.reply(`"${rawValue}" is not a valid integer`);
          return;
        }
        channelSettings.set(channel, key, n);
        ctx.reply(`${channel} ${key} = ${n}`);
      } else {
        channelSettings.set(channel, key, rawValue);
        ctx.reply(`${channel} ${key} = ${rawValue}`);
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
      const byPlugin = new Map<string, typeof snapshot>();
      for (const item of snapshot) {
        const list = byPlugin.get(item.entry.pluginId) ?? [];
        list.push(item);
        byPlugin.set(item.entry.pluginId, list);
      }

      for (const [pluginId, items] of byPlugin) {
        for (const { entry, value, isDefault } of items) {
          const marker = isDefault ? '' : ' *';
          let displayValue: string;
          if (entry.type === 'flag') {
            displayValue = value ? 'ON' : 'OFF';
          } else if (value === '' && isDefault) {
            displayValue = '(default)';
          } else if (value === '') {
            displayValue = '(not set)';
          } else {
            displayValue = String(value);
          }
          ctx.reply(
            `  [${pluginId}] ${entry.key.padEnd(18)} ${entry.type.padEnd(6)} ${displayValue}${marker}  ${entry.description}`,
          );
        }
      }
    },
  );
}
