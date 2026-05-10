// HexBot — Live config commands (.set / .unset / .info / .rehash / .restart)
//
// Operator surface for the three-scope settings registry. Mirrors
// Eggdrop's `.set` / `.unset` / `.help set` triple where the operator
// muscle-memory exists; extends it with the `.info <scope>` snapshot
// view inherited from `.chaninfo`. Per-key help (`.help set <scope>
// <key>`) flows through the unified help corpus — no dedicated
// `.helpset` command. Scopes resolved at command time:
//
//   - `core`     → coreSettings (bot-wide singletons)
//   - `<chan>`   → channelSettings.getRegistry() (#/&-prefixed names)
//   - `<plugin>` → pluginSettings.get(plugin) (anything else)
//
// Audit attribution flows through `auditActor(ctx)` so REPL / IRC / DCC /
// botlink-relay all converge on the same `coreset-set` / `pluginset-set` /
// `chanset-set` mod_log shape.
import type { CommandHandler } from '../../command-handler';
import type { BotDatabase } from '../../database';
import { auditActor, tryAudit } from '../audit';
import type { ChannelSettings } from '../channel-settings';
import { type SeedCounts, addCounts, seedFromJson } from '../seed-from-json';
import type { SettingsRegistry } from '../settings-registry';
import {
  coerceValue,
  formatDetailLine,
  formatFlagGrid,
  formatValueLines,
  reloadClassHint,
} from './settings-render';

export interface SettingsCommandsDeps {
  handler: CommandHandler;
  coreSettings: SettingsRegistry;
  channelSettings: ChannelSettings;
  pluginSettings: Map<string, SettingsRegistry>;
  /**
   * Re-read bot.json at `.rehash` time. Returns the parsed+resolved
   * config tree (or `null` when the file is missing/unreadable). Bot
   * wires this to a thunk that re-runs `parseBotConfigOnDisk` +
   * `resolveSecrets`, so config edits made post-boot are picked up.
   */
  readBotJson?: () => Record<string, unknown> | null;
  /**
   * Re-read plugins.json at `.rehash` time. Returns the parsed map of
   * `{ <pluginId>: { config: {...} } }`, or `null` when missing. The
   * `.rehash` path applies each plugin's `config` block to that
   * plugin's settings registry.
   */
  readPluginsJson?: () => Record<string, { config?: Record<string, unknown> } | undefined> | null;
  /** DB used to write `rehash` audit rows. Optional — tests omit it. */
  db?: BotDatabase | null;
  /**
   * Optional supervisor-restart hook. When provided, registers `.restart`
   * — operators run it to apply restart-class config changes and to pick
   * up plugin code edits. Bot wires this to `bot.shutdown()` followed by
   * `process.exit(0)`; the surrounding supervisor (Docker, systemd, pm2)
   * is responsible for re-launching the process. Tests omit it.
   */
  restartProcess?: () => void | Promise<void>;
}

/**
 * Resolve a scope string to its registry + the instance argument that
 * the registry's `get`/`set` calls expect. `core` and `<plugin>` use
 * `''` as the singleton instance; channel scope uses the channel name
 * folded by the registry's own `ircLower`. Returns `null` when the
 * scope is unknown — caller renders a help line.
 */
function resolveScope(
  scope: string,
  deps: SettingsCommandsDeps,
): { registry: SettingsRegistry; instance: string; label: string } | null {
  if (scope === 'core') {
    return { registry: deps.coreSettings, instance: '', label: 'core' };
  }
  if (scope.startsWith('#') || scope.startsWith('&')) {
    return {
      registry: deps.channelSettings.getRegistry(),
      instance: scope,
      label: scope,
    };
  }
  const plugin = deps.pluginSettings.get(scope);
  if (plugin) {
    return { registry: plugin, instance: '', label: scope };
  }
  return null;
}

/** All known scope labels for `.set` / `.info` discovery (no args). */
function listScopes(deps: SettingsCommandsDeps): string[] {
  const scopes: string[] = ['core'];
  for (const id of deps.pluginSettings.keys()) scopes.push(id);
  return scopes;
}

function renderScopeSnapshot(
  registry: SettingsRegistry,
  label: string,
  instance: string,
): string[] {
  const snapshot = registry.getSnapshot(instance);
  if (snapshot.length === 0) {
    return [`No settings registered under ${label}`];
  }
  const setCount = snapshot.filter((s) => !s.isDefault).length;
  const defaultCount = snapshot.filter((s) => s.isDefault).length;
  const flags = snapshot.filter((s) => s.entry.type === 'flag');
  const others = snapshot.filter((s) => s.entry.type !== 'flag');
  return [
    `Settings for ${label} (${setCount} set, ${defaultCount} default):`,
    ...formatFlagGrid(flags),
    ...formatValueLines(others),
  ];
}

/**
 * Parse `.set` arg form: peel an optional `+key`/`-key` prefix shorthand
 * for flags and return the canonical (key, value-source) pair. The
 * caller continues with normal value coercion when no prefix is found.
 */
function peelFlagPrefix(rawKey: string): { key: string; flagValue: '+' | '-' | null } {
  if (rawKey.startsWith('+')) return { key: rawKey.slice(1), flagValue: '+' };
  if (rawKey.startsWith('-')) return { key: rawKey.slice(1), flagValue: '-' };
  return { key: rawKey, flagValue: null };
}

export function registerSettingsCommands(deps: SettingsCommandsDeps): void {
  const { handler, coreSettings, channelSettings, pluginSettings } = deps;
  void coreSettings; // referenced via deps in resolveScope; explicit destructure for symmetry
  void channelSettings;
  void pluginSettings;

  // ---------------------------------------------------------------------------
  // .set <scope> [<key>] [<value>]
  // ---------------------------------------------------------------------------
  // No args                     → list scopes
  // <scope>                     → snapshot of that scope
  // <scope> <key>               → detail line for that key
  // <scope> <+/-key>            → flag toggle (boolean shorthand)
  // <scope> <key> <value>       → typed write
  handler.registerCommand(
    'set',
    {
      flags: 'n',
      description: 'Set a core / plugin / channel setting (live config)',
      usage: '.set <scope> [<key>] [<value>]',
      category: 'settings',
    },
    (args, ctx) => {
      const parts = args
        .trim()
        .split(/\s+/)
        .filter((p) => p.length > 0);
      if (parts.length === 0) {
        ctx.reply(
          `Scopes: ${listScopes(deps).join(', ')} (and any joined channel) — .set <scope> for a snapshot`,
        );
        return;
      }

      const scopeArg = parts[0];
      const resolved = resolveScope(scopeArg, deps);
      if (!resolved) {
        ctx.reply(`Unknown scope "${scopeArg}" — try one of: ${listScopes(deps).join(', ')}`);
        return;
      }
      const { registry, instance, label } = resolved;

      // <scope>                     → snapshot
      if (parts.length === 1) {
        for (const line of renderScopeSnapshot(registry, label, instance)) ctx.reply(line);
        return;
      }

      const { key: keyOnly, flagValue } = peelFlagPrefix(parts[1]);
      const def = registry.getDef(keyOnly);
      if (!def) {
        ctx.reply(
          `Unknown setting: "${keyOnly}" in scope "${label}" — use .set ${scopeArg} to list`,
        );
        return;
      }

      // <scope> +key / -key — boolean shorthand
      if (flagValue) {
        if (def.type !== 'flag') {
          ctx.reply(`"${keyOnly}" is a ${def.type}; use .set ${scopeArg} ${keyOnly} <value>`);
          return;
        }
        const out = registry.set(instance, keyOnly, flagValue === '+', auditActor(ctx));
        ctx.reply(
          `${label}.${keyOnly} = ${flagValue === '+' ? 'ON' : 'OFF'} ${reloadClassHint(out.reloadClass, out.reloadFailed, out.restartReason)}`,
        );
        return;
      }

      // <scope> <key>               → detail line
      if (parts.length === 2) {
        const value = registry.get(instance, keyOnly);
        const isDefault = !registry.isSet(instance, keyOnly);
        ctx.reply(formatDetailLine(label, { entry: def, value, isDefault }));
        return;
      }

      // <scope> <key> <value>       → typed write
      const rawValue = parts.slice(2).join(' ');
      if (def.type === 'flag') {
        // Direct value form for flags also works (`.set core foo true`).
        const coerced = coerceValue(def, rawValue);
        if ('error' in coerced) {
          ctx.reply(coerced.error);
          return;
        }
        const out = registry.set(instance, keyOnly, coerced.value, auditActor(ctx));
        ctx.reply(
          `${label}.${keyOnly} = ${coerced.value ? 'ON' : 'OFF'} ${reloadClassHint(out.reloadClass, out.reloadFailed, out.restartReason)}`,
        );
        return;
      }
      const coerced = coerceValue(def, rawValue);
      if ('error' in coerced) {
        ctx.reply(coerced.error);
        return;
      }
      const out = registry.set(instance, keyOnly, coerced.value, auditActor(ctx));
      ctx.reply(
        `${label}.${keyOnly} = ${coerced.value} ${reloadClassHint(out.reloadClass, out.reloadFailed, out.restartReason)}`,
      );
    },
  );

  // ---------------------------------------------------------------------------
  // .unset <scope> <key>
  // ---------------------------------------------------------------------------
  handler.registerCommand(
    'unset',
    {
      flags: 'n',
      description: 'Revert a setting to its registered default',
      usage: '.unset <scope> <key>',
      category: 'settings',
    },
    (args, ctx) => {
      const parts = args
        .trim()
        .split(/\s+/)
        .filter((p) => p.length > 0);
      if (parts.length < 2) {
        ctx.reply('Usage: .unset <scope> <key>');
        return;
      }
      const resolved = resolveScope(parts[0], deps);
      if (!resolved) {
        ctx.reply(`Unknown scope "${parts[0]}" — try one of: ${listScopes(deps).join(', ')}`);
        return;
      }
      const { registry, instance, label } = resolved;
      const key = parts[1].replace(/^[+-]/, ''); // tolerate +/- shorthand
      const def = registry.getDef(key);
      if (!def) {
        ctx.reply(`Unknown setting: "${key}" in scope "${label}"`);
        return;
      }
      const out = registry.unset(instance, key, auditActor(ctx));
      const display = def.type === 'flag' ? (def.default ? 'ON' : 'OFF') : String(def.default);
      ctx.reply(
        `${label}.${key} reverted to default (${display}) ${reloadClassHint(out.reloadClass, out.reloadFailed, out.restartReason)}`,
      );
    },
  );

  // ---------------------------------------------------------------------------
  // .info <scope> [--all]
  // ---------------------------------------------------------------------------
  // Read-only summary view — flags as a +/- grid, others as labeled lines,
  // grouped by owner (helpful when multiple plugins register into channel
  // scope). Permission flag is `-` so anyone with a command session can
  // inspect what's configured.
  //
  // For plugin scope, keys marked `channelOverridable: true` (chanmod's
  // bot-wide defaults that mirror channel-scope keys via `.chanset`) are
  // hidden from the main listing and counted in a footer; `--all`
  // bypasses the filter for operators who want the unfiltered view.
  // `.set <plugin>` snapshot mode never filters (muscle-memory parity
  // with the canonical operator surface).
  handler.registerCommand(
    'info',
    {
      flags: '-',
      description: 'Show settings for a scope',
      usage: '.info <scope> [--all]',
      category: 'settings',
    },
    (args, ctx) => {
      const allParts = args
        .trim()
        .split(/\s+/)
        .filter((p) => p.length > 0);
      const showAll = allParts.includes('--all');
      const parts = allParts.filter((p) => p !== '--all');
      if (parts.length < 1) {
        ctx.reply(`Usage: .info <scope> [--all]  (scopes: ${listScopes(deps).join(', ')})`);
        return;
      }
      const resolved = resolveScope(parts[0], deps);
      if (!resolved) {
        ctx.reply(`Unknown scope "${parts[0]}" — try one of: ${listScopes(deps).join(', ')}`);
        return;
      }
      const { registry, instance, label } = resolved;
      const snapshot = registry.getSnapshot(instance);
      if (snapshot.length === 0) {
        ctx.reply(`No settings registered under ${label}`);
        return;
      }

      // Hide plugin-scope keys whose value is the bot-wide default for a
      // channel-scope key of the same name — operators override them via
      // `.chanset <#chan>`. Tracked count drives the footer pointer.
      const isPluginScope = registry.getScope() === 'plugin';
      const visible =
        isPluginScope && !showAll
          ? snapshot.filter((s) => s.entry.channelOverridable !== true)
          : snapshot;
      const hiddenCount = snapshot.length - visible.length;

      const setCount = visible.filter((s) => !s.isDefault).length;
      const defaultCount = visible.filter((s) => s.isDefault).length;
      ctx.reply(`Settings for ${label} (${setCount} set, ${defaultCount} default):`);

      // Group by owner — readable when channel scope has chanmod, flood,
      // greeter, etc. all registered against the same registry.
      const byOwner = new Map<string, typeof visible>();
      for (const item of visible) {
        const list = byOwner.get(item.entry.owner) ?? [];
        list.push(item);
        byOwner.set(item.entry.owner, list);
      }
      const lines: string[] = [];
      for (const [owner, items] of byOwner) {
        const ownerPrefix = byOwner.size > 1 ? `[${owner}] ` : '  ';
        const flags = items.filter((s) => s.entry.type === 'flag');
        const others = items.filter((s) => s.entry.type !== 'flag');
        lines.push(...formatFlagGrid(flags, ownerPrefix));
        lines.push(...formatValueLines(others, ownerPrefix));
      }
      if (hiddenCount > 0) {
        lines.push(
          `  ${hiddenCount} key${hiddenCount === 1 ? '' : 's'} are per-channel — see .chanset <#chan>  (.info ${label} --all to show)`,
        );
      }
      ctx.reply(lines.join('\n'));
    },
  );

  // ---------------------------------------------------------------------------
  // .rehash [scope]
  // ---------------------------------------------------------------------------
  // No arg: re-reads bot.json + plugins.json and applies any keys that
  // differ from KV (additions/updates only — JSON deletions are NOT
  // propagated; operators use `.unset` to revert a key). With a scope
  // arg, only that scope is rehashed. Reply is per-reload-class so
  // operators see how many keys took effect immediately vs. need a
  // subsystem reload or a full restart.
  handler.registerCommand(
    'rehash',
    {
      flags: 'n',
      description: 'Re-read bot.json/plugins.json and apply changed keys',
      usage: '.rehash [scope]',
      category: 'settings',
    },
    (args, ctx) => {
      const scope = args.trim();
      const actor = auditActor(ctx);

      const rehashCore = (): SeedCounts | null => {
        if (!deps.readBotJson) return null;
        const json = deps.readBotJson();
        return seedFromJson(coreSettings, json, { actor, instance: '' });
      };
      const rehashPlugin = (id: string): SeedCounts | null => {
        const reg = pluginSettings.get(id);
        if (!reg) return null;
        if (!deps.readPluginsJson) {
          return seedFromJson(reg, null, { actor });
        }
        const all = deps.readPluginsJson();
        const cfg = all?.[id]?.config ?? null;
        return seedFromJson(reg, cfg, { actor, instance: '' });
      };

      let total: SeedCounts = {
        seeded: 0,
        updated: 0,
        unchanged: 0,
        skipped: 0,
        reloaded: 0,
        restartRequired: 0,
      };
      let scopesTouched = 0;

      if (!scope || scope === 'all') {
        const core = rehashCore();
        if (core) {
          total = addCounts(total, core);
          scopesTouched++;
        }
        for (const id of pluginSettings.keys()) {
          const c = rehashPlugin(id);
          if (c) {
            total = addCounts(total, c);
            scopesTouched++;
          }
        }
      } else if (scope === 'core') {
        const c = rehashCore();
        if (!c) {
          ctx.reply('rehash: core JSON loader not configured');
          return;
        }
        total = c;
        scopesTouched = 1;
      } else if (scope.startsWith('#') || scope.startsWith('&')) {
        // Channel scope settings have no JSON seed — they live entirely
        // under operator `.set` / `.chanset` writes.
        ctx.reply('rehash: channel-scope settings have no JSON seed (use .set/.chanset to mutate)');
        return;
      } else {
        const c = rehashPlugin(scope);
        if (c === null) {
          ctx.reply(`rehash: unknown plugin scope "${scope}"`);
          return;
        }
        total = c;
        scopesTouched = 1;
      }

      const applied = total.seeded + total.updated;
      const live = applied - total.reloaded - total.restartRequired;
      ctx.reply(
        `rehash (${scopesTouched} scope(s)): ${applied} applied (${live} live, ${total.reloaded} reloaded, ${total.restartRequired} awaiting .restart), ${total.unchanged} unchanged, ${total.skipped} skipped`,
      );
      tryAudit(deps.db ?? null, ctx, {
        action: 'rehash',
        target: scope || 'all',
        reason: `${applied} applied (${live}/${total.reloaded}/${total.restartRequired}), ${total.unchanged} unchanged, ${total.skipped} skipped`,
      });
    },
  );

  // ---------------------------------------------------------------------------
  // .restart
  // ---------------------------------------------------------------------------
  // Operators reach for `.restart` to apply restart-class config changes
  // (`irc.host`, `services.sasl_mechanism`, …) and to pick up plugin code
  // edits. The bot exits with code 0; the supervisor (Docker, systemd,
  // pm2) restarts the container. No state is lost — KV is durable; SASL,
  // channel joins, and DCC sessions are re-established by the new
  // process. We deleted `.reload` alongside the cache-busting import
  // path (audit CRITICAL 2026-04-25), and `.restart` is the canonical
  // path for "pick up code edits without leaking module-graph residue".
  if (deps.restartProcess) {
    handler.registerCommand(
      'restart',
      {
        flags: 'n',
        description: 'Shut down cleanly so the supervisor can restart the process',
        usage: '.restart',
        category: 'settings',
      },
      async (_args, ctx) => {
        tryAudit(deps.db ?? null, ctx, { action: 'restart' });
        ctx.reply('Restarting…');
        try {
          await deps.restartProcess?.();
        } catch (err) {
          ctx.reply(`Restart failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    );
  }

  // `.chanset #chan ...` and `.chaninfo #chan ...` live in
  // src/core/commands/channel-commands.ts — they use Eggdrop-style
  // toggle ergonomics for per-channel flags. Operators typing
  // `.set #chan key value` get the same behaviour through this command;
  // both routes call into the same SettingsRegistry.
}
