// HexBot — Shared rendering for settings commands
//
// Both `.chanset` (channel-scope only) and `.set` / `.info` (all three
// scopes) display registered settings the same way: flag-typed entries
// in a compact +/- grid, string/int entries one per line. Sharing the
// formatters here keeps the two surfaces in lockstep — a tweak to grid
// width or the `*` overridden marker lands in one place.
import type { ChannelSettingType, ChannelSettingValue } from '../../types';
import type { SettingEntry } from '../settings-registry';

/**
 * Structural shape both `ChannelSettings.getChannelSnapshot()` (the
 * plugin-facing channel-scope view, which renames `owner` → `pluginId`)
 * and `SettingsRegistry.getSnapshot()` (any scope, internal shape)
 * satisfy. The renderers only read `key`, `type`, and the description /
 * default fields, so the minimal common shape lets the same helpers
 * format either source without coercion.
 */
export interface RenderableEntry {
  key: string;
  type: ChannelSettingType;
  description: string;
  default: ChannelSettingValue;
}

export interface SnapshotItem<E extends RenderableEntry = RenderableEntry> {
  entry: E;
  value: ChannelSettingValue;
  isDefault: boolean;
}

/**
 * Format flag (boolean) settings as a uniform-width +/- grid. An
 * overridden value is marked with `*` (e.g. `+enforce_modes*`); a
 * default-valued flag is rendered with no trailing marker. `perRow = 4`
 * keeps a typical 4-flag row well under the 80-column DCC console
 * width even when keys carry the `*` marker.
 */
export function formatFlagGrid<E extends RenderableEntry>(
  flags: SnapshotItem<E>[],
  prefix = '  ',
  perRow = 4,
): string[] {
  if (flags.length === 0) return [];
  const entries = flags.map(({ entry, value, isDefault }) => {
    const sign = value ? '+' : '-';
    const marker = isDefault ? '' : '*';
    return `${sign}${entry.key}${marker}`;
  });
  const maxLen = Math.max(...entries.map((e) => e.length));
  const lines: string[] = [];
  for (let i = 0; i < entries.length; i += perRow) {
    const row = entries.slice(i, i + perRow);
    const padded = row.map((e, j) => (j < row.length - 1 ? e.padEnd(maxLen) : e));
    lines.push(prefix + padded.join('  '));
  }
  return lines;
}

/**
 * Format string/int settings one per line: `  key: value` or
 * `  key*: value`. `*` after the key marks an overridden (non-default)
 * value. An empty string renders as `(not set)` so a stripped value is
 * visually distinct from a literal empty string the operator may have
 * written intentionally.
 */
export function formatValueLines<E extends RenderableEntry>(
  items: SnapshotItem<E>[],
  prefix = '  ',
): string[] {
  return items.map(({ entry, value, isDefault }) => {
    const display = value === '' ? '(not set)' : String(value);
    const marker = isDefault ? '' : '*';
    return `${prefix}${entry.key}${marker}: ${display}`;
  });
}

/**
 * Render a per-key detail line — `<scope> <key> (type) = <value> — <description>`.
 * Used by `.set <scope> <key>` (no value) and `.helpset <scope> <key>`
 * to surface a single setting's current state alongside its description.
 *
 * The mIRC `\x02` (bold) and `\x03<color>` codes only render in clients
 * that honour them; consoles that strip formatting (REPL, DCC with
 * stripFormatting on output) simply see the unstyled text.
 */
export function formatDetailLine<E extends RenderableEntry>(
  scopeLabel: string,
  item: SnapshotItem<E>,
): string {
  const def = item.entry;
  const display =
    def.type === 'flag' ? (item.value ? 'ON' : 'OFF') : String(item.value) || '(not set)';
  const bold = (s: string): string => `\x02${s}\x02`;
  const redBold = (s: string): string => `\x02\x034${s}\x0F`;
  return `${scopeLabel} ${redBold(def.key)} (${def.type}) = ${bold(display)}${item.isDefault ? ' (default)' : ''} — ${def.description}`;
}

/**
 * Coerce a textual value (operator input on `.set`) into the runtime
 * {@link ChannelSettingValue} expected by the def's `type`. Returns the
 * coerced value plus an optional `error` string explaining a parse
 * failure — callers reply with the error and skip the write rather than
 * storing garbage.
 *
 * Boolean parsing accepts `true|false`, `on|off`, `yes|no`, `1|0`. A
 * `+key`/`-key` prefix shorthand is unwrapped by the caller before
 * reaching this helper (it operates on the value, not the key).
 *
 * Int parsing rejects trailing-non-digit input — `parseInt('42abc', 10)`
 * silently returns `42` which would accept garbage.
 */
export function coerceValue(
  def: SettingEntry | (RenderableEntry & { allowedValues?: string[] }),
  raw: string,
): { value: ChannelSettingValue } | { error: string } {
  const trimmed = raw.trim();
  switch (def.type) {
    case 'flag': {
      const t = trimmed.toLowerCase();
      if (t === 'true' || t === 'on' || t === 'yes' || t === '1') return { value: true };
      if (t === 'false' || t === 'off' || t === 'no' || t === '0') return { value: false };
      return { error: `"${raw}" is not a boolean — use true/false, on/off, yes/no, or 1/0` };
    }
    case 'int': {
      const n = Number(trimmed);
      if (trimmed === '' || !Number.isInteger(n)) {
        return { error: `"${raw}" is not a valid integer` };
      }
      return { value: n };
    }
    case 'string': {
      if (def.allowedValues && !def.allowedValues.includes(raw)) {
        return {
          error: `Invalid value "${raw}" for ${def.key} — allowed: ${def.allowedValues.join(', ')}`,
        };
      }
      return { value: raw };
    }
  }
}

/**
 * Render the post-write hint suffix that operator commands echo back
 * after `.set` / `.unset`. The suffix is the only operator-facing
 * surface for the reload-class contract — we keep the wording in one
 * place so a future tweak doesn't drift between the three call sites
 * (set/unset/rehash).
 */
export function reloadClassHint(
  reloadClass: 'live' | 'reload' | 'restart',
  reloadFailed: boolean | undefined,
  restartReason: string | undefined,
): string {
  switch (reloadClass) {
    case 'live':
      return '(applied live)';
    case 'reload':
      return reloadFailed ? '(stored; reload failed — see logs)' : '(applied; subsystem reloaded)';
    case 'restart':
      return restartReason ? `(stored; ${restartReason})` : '(stored; takes effect after .restart)';
  }
}
