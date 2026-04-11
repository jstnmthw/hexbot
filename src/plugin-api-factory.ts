// HexBot — Plugin API factory
//
// Builds the scoped `PluginAPI` object each plugin sees. Owns the shape of
// the API surface and the per-plugin wrappers that enforce channel scopes,
// route actions through the message queue, and namespace the database.
//
// This file is purely a factory — it has no mutable state of its own.
// Plugin lifecycle (discovery, load, unload, reload) lives in plugin-loader.ts.
import type { BanStore } from './core/ban-store';
import type { ChannelSettings } from './core/channel-settings';
import type { ChannelState } from './core/channel-state';
import type { HelpRegistry } from './core/help-registry';
import type { IRCCommands } from './core/irc-commands';
import type { MessageQueue } from './core/message-queue';
import type { Permissions } from './core/permissions';
import type { Services } from './core/services';
import type { BotDatabase } from './database';
import type { EventDispatcher } from './dispatcher';
import type { BotEventBus } from './event-bus';
import type { Logger } from './logger';
import type {
  BindHandler,
  BindType,
  BotConfig,
  Casemapping,
  ChannelSettingDef,
  ChannelSettingValue,
  ChannelUser,
  HandlerContext,
  HelpEntry,
  PluginAPI,
  PluginBanStore,
  PluginBotConfig,
  PluginChannelSettings,
  PluginDB,
  PluginPermissions,
  PluginServices,
} from './types';
import { sanitize } from './utils/sanitize';
import { stripFormatting } from './utils/strip-formatting';
import { ircLower } from './utils/wildcard';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for plugin actions (mirrors PluginLoaderDeps). */
export interface IRCClientForPlugins {
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  action(target: string, message: string): void;
  ctcpResponse(target: string, type: string, ...params: string[]): void;
  raw?(line: string): void;
}

/**
 * Everything `createPluginApi` needs from the enclosing PluginLoader. Holding
 * this as an interface keeps the factory free of loader internals and makes
 * it trivial to unit-test the API shape in isolation.
 */
export interface PluginApiDeps {
  dispatcher: EventDispatcher;
  eventBus: BotEventBus;
  db: BotDatabase | null;
  permissions: Permissions;
  botConfig: BotConfig;
  ircClient: IRCClientForPlugins | null;
  channelState: ChannelState | null;
  ircCommands: IRCCommands | null;
  messageQueue: MessageQueue | null;
  services: Services | null;
  helpRegistry: HelpRegistry | null;
  channelSettings: ChannelSettings | null;
  banStore: BanStore | null;
  /** Root bot logger — the factory derives a per-plugin child from it. */
  rootLogger: Logger | null;
  getCasemapping: () => Casemapping;
  getServerSupports: () => Record<string, string>;
  /** Shared map of onModesReady listeners, keyed by pluginId, for cleanup on unload. */
  modesReadyListeners: Map<string, Array<(channel: string) => void>>;
}

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Build the scoped `PluginAPI` a plugin's `init(api)` receives. Returns a
 * frozen object so plugins can't mutate the API surface — sub-objects are
 * shallow-frozen by the individual sub-factories.
 *
 * @param deps           All external state the API needs to call back into.
 * @param pluginId       Stable plugin identifier (used for logging + DB namespacing).
 * @param config         Fully-resolved per-plugin config (after resolveSecrets).
 * @param channelScope   Optional whitelist of channels — when set, channel-bound
 *                       events outside the scope are silently dropped.
 */
export function createPluginApi(
  deps: PluginApiDeps,
  pluginId: string,
  config: Record<string, unknown>,
  channelScope?: string[],
): PluginAPI {
  const pluginLogger = deps.rootLogger?.child(`plugin:${pluginId}`) ?? null;
  const { getCasemapping, getServerSupports, dispatcher, botConfig } = deps;

  // Build channel scope set for filtering bind handlers.
  // When defined (even if empty), only channel events matching the set fire.
  // Non-channel events (ctx.channel === null) always pass through.
  // Note: scopeSet is built with the load-time casemapping; dispatch-time folds
  // call getCasemapping() fresh. Assumes CASEMAPPING doesn't change mid-session.
  let scopeSet: Set<string> | undefined;
  if (channelScope !== undefined) {
    scopeSet = new Set(channelScope.map((ch) => ircLower(ch, getCasemapping())));
    if (scopeSet.size > 0) {
      pluginLogger?.info(`Channel scope: ${channelScope.join(', ')}`);
    } else {
      pluginLogger?.info('Channel scope: (empty — all channel events blocked)');
    }
  }

  // Track the wrapped handler for each (handler, type, mask) triple so
  // api.unbind() can find the real bound handler in the dispatcher
  // (dispatcher matches by reference identity). Keyed on handler for GC,
  // then on "type|mask" so the same handler can be reused across binds.
  // Only populated when a channel scope is active.
  const wrappedHandlers = new WeakMap<BindHandler, Map<string, BindHandler>>();

  // Build plugin-facing bot config (password omitted; filesystem paths omitted).
  const pluginBotConfig: PluginBotConfig = {
    irc: {
      ...botConfig.irc,
      // Expose only channel names to plugins — never expose channel keys
      channels: botConfig.irc.channels.map((c) => (typeof c === 'string' ? c : c.name)),
    },
    owner: { ...botConfig.owner },
    identity: { ...botConfig.identity },
    services: {
      type: botConfig.services.type,
      nickserv: botConfig.services.nickserv,
      sasl: botConfig.services.sasl,
      // password intentionally omitted
    },
    // database and pluginDir intentionally omitted — plugins don't need filesystem paths
    logging: { ...botConfig.logging },
    chanmod: botConfig.chanmod ? { ...botConfig.chanmod } : undefined,
  };

  const api: PluginAPI = {
    pluginId,
    bind<T extends BindType>(type: T, flags: string, mask: string, handler: BindHandler<T>): void {
      // The dispatcher stores handlers as the widest BindHandler<BindType>.
      // Cast is safe because the plugin-facing api.bind guarantees the runtime
      // ctx will match the generic T the caller asked for.
      const widenedHandler = handler as BindHandler;
      if (scopeSet) {
        const boundScope = scopeSet;
        const wrapped: BindHandler = (ctx: HandlerContext) => {
          if (ctx.channel !== null && !boundScope.has(ircLower(ctx.channel, getCasemapping()))) {
            return;
          }
          return widenedHandler(ctx);
        };
        let perHandler = wrappedHandlers.get(widenedHandler);
        if (!perHandler) {
          perHandler = new Map();
          wrappedHandlers.set(widenedHandler, perHandler);
        }
        perHandler.set(`${type}|${mask}`, wrapped);
        dispatcher.bind(type, flags, mask, wrapped, pluginId);
      } else {
        dispatcher.bind(type, flags, mask, widenedHandler, pluginId);
      }
    },
    unbind<T extends BindType>(type: T, mask: string, handler: BindHandler<T>): void {
      const widenedHandler = handler as BindHandler;
      const key = `${type}|${mask}`;
      const perHandler = wrappedHandlers.get(widenedHandler);
      const actual = perHandler?.get(key) ?? widenedHandler;
      dispatcher.unbind(type, mask, actual);
      perHandler?.delete(key);
    },
    ...createPluginIrcActionsApi(deps.ircClient, deps.messageQueue, deps.ircCommands),
    ...createPluginChannelStateApi(
      deps.channelState,
      deps.eventBus,
      pluginId,
      deps.modesReadyListeners,
    ),
    permissions: createPluginPermissionsApi(deps.permissions),
    services: createPluginServicesApi(deps.services),
    db: createPluginDbApi(deps.db, pluginId),
    banStore: createPluginBanStoreApi(deps.banStore),
    botConfig: Object.freeze(pluginBotConfig),
    config: Object.freeze({ ...config }),
    getServerSupports(): Record<string, string> {
      return getServerSupports();
    },
    ircLower(text: string): string {
      return ircLower(text, getCasemapping());
    },
    buildHostmask(source: { nick: string; ident: string; hostname: string }): string {
      return `${source.nick}!${source.ident}@${source.hostname}`;
    },
    isBotNick(nick: string): boolean {
      return ircLower(nick, getCasemapping()) === ircLower(botConfig.irc.nick, getCasemapping());
    },
    getChannelKey(channel: string): string | undefined {
      const lower = ircLower(channel, getCasemapping());
      for (const entry of botConfig.irc.channels) {
        if (typeof entry === 'string') continue;
        if (ircLower(entry.name, getCasemapping()) === lower) return entry.key;
      }
      return undefined;
    },
    channelSettings: createPluginChannelSettingsApi(deps.channelSettings, pluginId),
    ...createPluginHelpApi(deps.helpRegistry, pluginId),
    stripFormatting(text: string): string {
      return stripFormatting(text);
    },
    ...createPluginLogApi(pluginLogger),
  };

  return Object.freeze(api);
}

// ---------------------------------------------------------------------------
// Sub-factories — one per concern so createPluginApi() stays readable
// ---------------------------------------------------------------------------

function createPluginBanStoreApi(banStore: BanStore | null): PluginBanStore {
  if (banStore) {
    return Object.freeze({
      storeBan: banStore.storeBan.bind(banStore),
      removeBan: banStore.removeBan.bind(banStore),
      getBan: banStore.getBan.bind(banStore),
      getChannelBans: banStore.getChannelBans.bind(banStore),
      getAllBans: banStore.getAllBans.bind(banStore),
      setSticky: banStore.setSticky.bind(banStore),
      liftExpiredBans: banStore.liftExpiredBans.bind(banStore),
      migrateFromPluginNamespace: banStore.migrateFromPluginNamespace.bind(banStore),
    });
  }
  // No DB available — return a no-op stub (return type enforced by PluginBanStore)
  return Object.freeze({
    storeBan() {},
    removeBan() {},
    getBan() {
      return null;
    },
    getChannelBans() {
      return [];
    },
    getAllBans() {
      return [];
    },
    setSticky() {
      return false;
    },
    liftExpiredBans() {
      return 0;
    },
    migrateFromPluginNamespace() {
      return 0;
    },
  });
}

function createPluginDbApi(db: BotDatabase | null, pluginId: string): PluginDB {
  if (db) {
    return Object.freeze({
      get(key: string): string | undefined {
        return db.get(pluginId, key) ?? undefined;
      },
      set(key: string, value: string): void {
        db.set(pluginId, key, value);
      },
      del(key: string): void {
        db.del(pluginId, key);
      },
      list(prefix?: string): Array<{ key: string; value: string }> {
        return db.list(pluginId, prefix);
      },
    });
  }
  return Object.freeze({
    get(): string | undefined {
      return undefined;
    },
    set(): void {},
    del(): void {},
    list(): Array<{ key: string; value: string }> {
      return [];
    },
  });
}

function createPluginPermissionsApi(permissions: Permissions): PluginPermissions {
  return Object.freeze({
    findByHostmask(hostmask: string) {
      return permissions.findByHostmask(hostmask);
    },
    checkFlags(requiredFlags: string, ctx: HandlerContext) {
      return permissions.checkFlags(requiredFlags, ctx);
    },
  });
}

function createPluginServicesApi(services: Services | null): PluginServices {
  return Object.freeze({
    async verifyUser(nick: string) {
      if (!services) return { verified: false, account: null };
      return services.verifyUser(nick);
    },
    isAvailable() {
      return services?.isAvailable() ?? false;
    },
  });
}

// IRC send actions + channel ops — routed through message queue for flood protection
// (sanitize for defense-in-depth, even though irc-framework handles framing)
function createPluginIrcActionsApi(
  ircClient: IRCClientForPlugins | null | undefined,
  messageQueue: MessageQueue | null | undefined,
  ircCommands: IRCCommands | null | undefined,
): Pick<
  PluginAPI,
  | 'say'
  | 'action'
  | 'notice'
  | 'ctcpResponse'
  | 'op'
  | 'deop'
  | 'voice'
  | 'devoice'
  | 'halfop'
  | 'dehalfop'
  | 'kick'
  | 'ban'
  | 'mode'
  | 'requestChannelModes'
  | 'topic'
  | 'invite'
  | 'join'
  | 'part'
  | 'changeNick'
> {
  function send(target: string, fn: () => void): void {
    if (messageQueue) messageQueue.enqueue(target, fn);
    else fn();
  }
  return {
    say(target: string, message: string): void {
      const safe = sanitize(message);
      send(target, () => ircClient?.say(target, safe));
    },
    action(target: string, message: string): void {
      const safe = sanitize(message);
      send(target, () => ircClient?.action(target, safe));
    },
    notice(target: string, message: string): void {
      const safe = sanitize(message);
      send(target, () => ircClient?.notice(target, safe));
    },
    ctcpResponse(target: string, type: string, message: string): void {
      const safeTarget = sanitize(target),
        safeType = sanitize(type),
        safeMsg = sanitize(message);
      send(safeTarget, () => ircClient?.ctcpResponse(safeTarget, safeType, safeMsg));
    },
    op(channel: string, nick: string): void {
      ircCommands?.op(channel, nick);
    },
    deop(channel: string, nick: string): void {
      ircCommands?.deop(channel, nick);
    },
    voice(channel: string, nick: string): void {
      ircCommands?.voice(channel, nick);
    },
    devoice(channel: string, nick: string): void {
      ircCommands?.devoice(channel, nick);
    },
    halfop(channel: string, nick: string): void {
      ircCommands?.halfop(channel, nick);
    },
    dehalfop(channel: string, nick: string): void {
      ircCommands?.dehalfop(channel, nick);
    },
    kick(channel: string, nick: string, reason?: string): void {
      ircCommands?.kick(channel, nick, reason);
    },
    ban(channel: string, mask: string): void {
      ircCommands?.ban(channel, mask);
    },
    mode(channel: string, modes: string, ...params: string[]): void {
      ircCommands?.mode(channel, modes, ...params);
    },
    requestChannelModes(channel: string): void {
      ircCommands?.requestChannelModes(channel);
    },
    topic(channel: string, text: string): void {
      ircCommands?.topic(channel, text);
    },
    invite(channel: string, nick: string): void {
      ircCommands?.invite(channel, nick);
    },
    join(channel: string, key?: string): void {
      ircCommands?.join(channel, key);
    },
    part(channel: string, message?: string): void {
      ircCommands?.part(channel, message);
    },
    changeNick(nick: string): void {
      ircClient?.raw?.(`NICK ${sanitize(nick)}`);
    },
  };
}

function createPluginChannelStateApi(
  channelState: ChannelState | null | undefined,
  eventBus: BotEventBus,
  pluginId: string,
  modesReadyListeners: Map<string, Array<(channel: string) => void>>,
): Pick<PluginAPI, 'getChannel' | 'getUsers' | 'getUserHostmask' | 'onModesReady'> {
  return {
    onModesReady(callback: (channel: string) => void): void {
      const wrappedListener = (...args: unknown[]) => callback(args[0] as string);
      eventBus.on('channel:modesReady', wrappedListener);
      const list = modesReadyListeners.get(pluginId) ?? [];
      list.push(wrappedListener);
      modesReadyListeners.set(pluginId, list);
    },
    getChannel(name: string) {
      if (!channelState) return undefined;
      const ch = channelState.getChannel(name);
      if (!ch) return undefined;
      // Convert UserInfo (internal) to ChannelUser (plugin-facing)
      const users = new Map<string, ChannelUser>();
      for (const [key, u] of ch.users) {
        users.set(key, {
          nick: u.nick,
          ident: u.ident,
          hostname: u.hostname,
          modes: u.modes.join(''),
          joinedAt: u.joinedAt.getTime(),
          accountName: u.accountName,
          away: u.away,
        });
      }
      return {
        name: ch.name,
        topic: ch.topic,
        modes: ch.modes,
        key: ch.key,
        limit: ch.limit,
        users,
      };
    },
    getUsers(channel: string): ChannelUser[] {
      if (!channelState) return [];
      const ch = channelState.getChannel(channel);
      if (!ch) return [];
      return Array.from(ch.users.values()).map((u) => ({
        nick: u.nick,
        ident: u.ident,
        hostname: u.hostname,
        modes: u.modes.join(''),
        joinedAt: u.joinedAt.getTime(),
        accountName: u.accountName,
        away: u.away,
      }));
    },
    getUserHostmask(channel: string, nick: string): string | undefined {
      return channelState?.getUserHostmask(channel, nick);
    },
  };
}

function createPluginChannelSettingsApi(
  channelSettings: ChannelSettings | null | undefined,
  pluginId: string,
): PluginChannelSettings {
  // When channelSettings is absent (e.g. minimal test harness), reads return
  // the "nothing registered" default for that return type rather than throwing.
  return Object.freeze({
    register(defs: ChannelSettingDef[]): void {
      channelSettings?.register(pluginId, defs);
    },
    get(channel: string, key: string): ChannelSettingValue {
      return channelSettings?.get(channel, key) ?? '';
    },
    getFlag(channel: string, key: string): boolean {
      return channelSettings?.getFlag(channel, key) ?? false;
    },
    getString(channel: string, key: string): string {
      return channelSettings?.getString(channel, key) ?? '';
    },
    getInt(channel: string, key: string): number {
      return channelSettings?.getInt(channel, key) ?? 0;
    },
    set(channel: string, key: string, value: ChannelSettingValue): void {
      channelSettings?.set(channel, key, value);
    },
    isSet(channel: string, key: string): boolean {
      return channelSettings?.isSet(channel, key) ?? false;
    },
    onChange(callback: (channel: string, key: string, value: ChannelSettingValue) => void): void {
      channelSettings?.onChange(pluginId, callback);
    },
  } satisfies PluginChannelSettings);
}

function createPluginHelpApi(
  helpRegistry: HelpRegistry | null | undefined,
  pluginId: string,
): Pick<PluginAPI, 'registerHelp' | 'getHelpEntries'> {
  return {
    registerHelp(entries: HelpEntry[]): void {
      helpRegistry?.register(pluginId, entries);
    },
    getHelpEntries(): HelpEntry[] {
      return helpRegistry?.getAll() ?? [];
    },
  };
}

function createPluginLogApi(
  pluginLogger: Logger | null,
): Pick<PluginAPI, 'log' | 'error' | 'warn' | 'debug'> {
  return {
    log(...args: unknown[]): void {
      pluginLogger?.info(...args);
    },
    error(...args: unknown[]): void {
      pluginLogger?.error(...args);
    },
    warn(...args: unknown[]): void {
      pluginLogger?.warn(...args);
    },
    debug(...args: unknown[]): void {
      pluginLogger?.debug(...args);
    },
  };
}
