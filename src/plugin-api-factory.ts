// HexBot — Plugin API factory
//
// Builds the scoped `PluginAPI` object each plugin sees. Owns the shape of
// the API surface and the per-plugin wrappers that enforce channel scopes,
// route actions through the message queue, and namespace the database.
//
// This file is purely a factory — it has no mutable state of its own.
// Plugin lifecycle (discovery, load, unload, reload) lives in plugin-loader.ts.
import { type ModActor, tryLogModAction } from './core/audit';
import type { BanStore } from './core/ban-store';
import type { ChannelSettings } from './core/channel-settings';
import type { ChannelState } from './core/channel-state';
import type { HelpRegistry } from './core/help-registry';
import type { IRCCommands } from './core/irc-commands';
import type { MessageQueue } from './core/message-queue';
import type { Permissions } from './core/permissions';
import type { Services } from './core/services';
import type { BotDatabase } from './database';
import type { BindRegistrar } from './dispatcher';
import type { BotEventBus } from './event-bus';
import type { LoggerLike } from './logger';
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
  PluginAudit,
  PluginAuditOptions,
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
  dispatcher: BindRegistrar;
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
  rootLogger: LoggerLike | null;
  getCasemapping: () => Casemapping;
  getServerSupports: () => Record<string, string>;
  /** Shared map of onModesReady listeners, keyed by pluginId, for cleanup on unload. */
  modesReadyListeners: Map<string, Array<(channel: string) => void>>;
  /** Shared map of onPermissionsChanged listeners, keyed by pluginId, for cleanup on unload. */
  permissionsChangedListeners: Map<string, Array<(handle: string) => void>>;
}

/** Internal fan-out list for the permissions-change listener wiring. */
const PERMISSIONS_CHANGE_EVENTS = [
  'user:added',
  'user:flagsChanged',
  'user:hostmaskAdded',
] as const;

// ---------------------------------------------------------------------------
// Main factory
// ---------------------------------------------------------------------------

/**
 * Handle returned by {@link createPluginApi}. Callers get the usual frozen
 * `api` to hand to the plugin's `init()`, plus a `dispose()` hook that
 * post-teardown converts every method on the api into a no-op. This is the
 * architectural defense against closures that outlive plugin unload: even
 * if a stale `setInterval` or retained ESM module still holds `api`, once
 * disposed it cannot fan out to the dispatcher, database, or IRC client.
 * See audit finding W-PS1 (2026-04-14).
 */
export interface PluginApiHandle {
  readonly api: PluginAPI;
  /** Turn every method on the returned `api` into a no-op. Idempotent. */
  dispose(): void;
}

/** Keys on the top-level api whose value is a sub-API namespace whose
 *  methods must also be no-op'd after dispose. Data-only keys like
 *  `botConfig` and `config` are deliberately excluded — reading them
 *  after dispose is harmless since they don't reference the bot graph. */
const SUB_API_KEYS = new Set([
  'permissions',
  'services',
  'db',
  'banStore',
  'channelSettings',
  'audit',
]);

/**
 * Build the scoped `PluginAPI` a plugin's `init(api)` receives. Returns a
 * handle containing the frozen api and a `dispose()` hook so plugin-loader
 * can neutralise the api post-teardown. See {@link PluginApiHandle}.
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
): PluginApiHandle {
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
  // (dispatcher matches by reference identity). Populated only when a
  // channel scope is active. A plain array beats a WeakMap-of-Maps here:
  // the list is bounded by this plugin's bind count, entries live exactly
  // as long as the plugin API instance does, and unbind() is the only
  // lookup path — O(n) scan is negligible in practice and the data shape
  // is far easier to reason about than the nested-map version.
  interface WrappedEntry {
    handler: BindHandler;
    type: BindType;
    mask: string;
    wrapped: BindHandler;
  }
  const wrappedHandlers: WrappedEntry[] = [];

  // Build plugin-facing bot config (password omitted; filesystem paths omitted).
  //
  // `chanmod` carries `nick_recovery_password` — the NickServ GHOST password
  // — so we must NEVER hand a shallow copy of the whole object to every
  // plugin. Only the chanmod plugin itself needs the live password; every
  // other plugin gets the config with the password field stripped.
  const buildPluginChanmodView = (): PluginBotConfig['chanmod'] => {
    if (!botConfig.chanmod) return undefined;
    if (pluginId === 'chanmod') return { ...botConfig.chanmod };
    const { nick_recovery_password: _ignored, ...rest } = botConfig.chanmod;
    return { ...rest };
  };

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
    chanmod: buildPluginChanmodView(),
  };

  // Mutable cell shared by every guarded method returned from the factory.
  // `dispose()` flips this; every wrapped method early-returns `undefined`
  // once set, so a closure still holding a reference to this api can no
  // longer fan out to the bot's core graph. See W-PS1.
  const disposedCell = { disposed: false };

  const rawApi: PluginAPI = {
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
        wrappedHandlers.push({ handler: widenedHandler, type, mask, wrapped });
        dispatcher.bind(type, flags, mask, wrapped, pluginId);
      } else {
        dispatcher.bind(type, flags, mask, widenedHandler, pluginId);
      }
    },
    unbind<T extends BindType>(type: T, mask: string, handler: BindHandler<T>): void {
      const widenedHandler = handler as BindHandler;
      const idx = wrappedHandlers.findIndex(
        (e) => e.handler === widenedHandler && e.type === type && e.mask === mask,
      );
      const actual = idx === -1 ? widenedHandler : wrappedHandlers[idx].wrapped;
      dispatcher.unbind(type, mask, actual);
      if (idx !== -1) wrappedHandlers.splice(idx, 1);
    },
    ...createPluginIrcActionsApi(deps.ircClient, deps.messageQueue, deps.ircCommands, pluginId),
    ...createPluginChannelStateApi(
      deps.channelState,
      deps.eventBus,
      pluginId,
      deps.modesReadyListeners,
      deps.permissionsChangedListeners,
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
    audit: createPluginAuditApi(deps.db, pluginId, pluginLogger),
    ...createPluginLogApi(pluginLogger),
  };

  // Wrap every method (top-level + sub-API namespaces in SUB_API_KEYS) with
  // a guard that short-circuits to `undefined` after `dispose()` is called.
  // Data-only keys like `botConfig` and `config` are preserved unchanged —
  // reading them after dispose is harmless.
  const guardedApi = Object.freeze(
    wrapApiMethods(rawApi as unknown as Record<string, unknown>, disposedCell, SUB_API_KEYS),
  ) as unknown as PluginAPI;

  return {
    api: guardedApi,
    dispose: () => {
      disposedCell.disposed = true;
    },
  };
}

/**
 * Clone `obj` into a fresh frozen object whose function-valued entries are
 * replaced with guards that early-return `undefined` once `cell.disposed`
 * is true. Keys in `recurseInto` are themselves walked one more level —
 * used for the sub-API namespaces (`api.db`, `api.permissions`, etc.) so
 * their methods are guarded too. Anything else (primitive, data object)
 * is copied through unchanged.
 */
function wrapApiMethods(
  obj: Record<string, unknown>,
  cell: { disposed: boolean },
  recurseInto: Set<string> | null,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown;
      result[key] = function guarded(this: unknown, ...args: unknown[]): unknown {
        if (cell.disposed) return undefined;
        return fn.apply(this, args);
      };
    } else if (recurseInto && recurseInto.has(key) && typeof value === 'object' && value !== null) {
      result[key] = Object.freeze(wrapApiMethods(value as Record<string, unknown>, cell, null));
    } else {
      result[key] = value;
    }
  }
  return result;
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

/** Exported for unit tests — verifies `password_hash` is stripped from the plugin view. */
export function createPluginPermissionsApi(permissions: Permissions): PluginPermissions {
  return Object.freeze({
    findByHostmask(hostmask: string, account?: string | null) {
      const record = permissions.findByHostmask(hostmask, account);
      if (!record) return null;
      // Strip password_hash before returning — plugins must never see secret material.
      // Shallow clone is enough because password_hash is a string.
      const { password_hash: _hash, ...publicRecord } = record;
      return publicRecord;
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
    isNickServVerificationReply(nick: string, message: string) {
      return services?.isNickServVerificationReply(nick, message) ?? false;
    },
  });
}

// IRC send actions + channel ops — routed through message queue for flood protection
// (sanitize for defense-in-depth, even though irc-framework handles framing)
function createPluginIrcActionsApi(
  ircClient: IRCClientForPlugins | null | undefined,
  messageQueue: MessageQueue | null | undefined,
  ircCommands: IRCCommands | null | undefined,
  pluginId: string,
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
  // The actor every plugin-driven mutation lands under in mod_log. Frozen
  // per-plugin so a misbehaving plugin can't mutate it cross-plugin.
  const actor: ModActor = Object.freeze({
    by: pluginId,
    source: 'plugin',
    plugin: pluginId,
  });
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
      // NB: irc-framework's ctcpResponse() sends a NOTICE (not a PRIVMSG) —
      // see `node_modules/irc-framework/src/client.js`. RFC 2812 §3.3.2
      // requires CTCP replies to be NOTICEs so a bot-to-bot exchange
      // cannot trigger automatic replies on the other side and spiral
      // into a CTCP loop. Do NOT reroute this through `say()` or `raw()`.
      const safeTarget = sanitize(target),
        safeType = sanitize(type),
        safeMsg = sanitize(message);
      send(safeTarget, () => ircClient?.ctcpResponse(safeTarget, safeType, safeMsg));
    },
    op(channel: string, nick: string): void {
      ircCommands?.op(channel, nick, actor);
    },
    deop(channel: string, nick: string): void {
      ircCommands?.deop(channel, nick, actor);
    },
    voice(channel: string, nick: string): void {
      ircCommands?.voice(channel, nick, actor);
    },
    devoice(channel: string, nick: string): void {
      ircCommands?.devoice(channel, nick, actor);
    },
    halfop(channel: string, nick: string): void {
      ircCommands?.halfop(channel, nick, actor);
    },
    dehalfop(channel: string, nick: string): void {
      ircCommands?.dehalfop(channel, nick, actor);
    },
    kick(channel: string, nick: string, reason?: string): void {
      ircCommands?.kick(channel, nick, reason, actor);
    },
    ban(channel: string, mask: string): void {
      ircCommands?.ban(channel, mask, actor);
    },
    mode(channel: string, modes: string, ...params: string[]): void {
      ircCommands?.mode(channel, modes, ...params);
    },
    requestChannelModes(channel: string): void {
      ircCommands?.requestChannelModes(channel);
    },
    topic(channel: string, text: string): void {
      ircCommands?.topic(channel, text, actor);
    },
    invite(channel: string, nick: string): void {
      ircCommands?.invite(channel, nick, actor);
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

/**
 * Build the plugin-facing audit writer. The factory captures `pluginId` in
 * the closure so the plugin cannot override `by`, `source`, or `plugin` —
 * even if it tries to pass them in `options`, the explicit args here take
 * precedence over any stowaway fields. Routes through `tryLogModAction`
 * so a failed audit write never crashes the calling plugin handler.
 */
function createPluginAuditApi(
  db: BotDatabase | null,
  pluginId: string,
  logger: LoggerLike | null,
): PluginAudit {
  if (!db) {
    return Object.freeze({ log() {} });
  }
  return Object.freeze({
    log(action: string, options: PluginAuditOptions = {}): void {
      tryLogModAction(
        db,
        {
          action,
          source: 'plugin',
          plugin: pluginId,
          by: pluginId,
          channel: options.channel ?? null,
          target: options.target ?? null,
          outcome: options.outcome ?? 'success',
          reason: options.reason ?? null,
          metadata: options.metadata ?? null,
        },
        logger,
      );
    },
  });
}

function createPluginChannelStateApi(
  channelState: ChannelState | null | undefined,
  eventBus: BotEventBus,
  pluginId: string,
  modesReadyListeners: Map<string, Array<(channel: string) => void>>,
  permissionsChangedListeners: Map<string, Array<(handle: string) => void>>,
): Pick<
  PluginAPI,
  | 'getChannel'
  | 'getUsers'
  | 'getUserHostmask'
  | 'onModesReady'
  | 'offModesReady'
  | 'onPermissionsChanged'
  | 'offPermissionsChanged'
> {
  // Per-plugin callback→wrapper maps used by off*() to look up the actual
  // listener that was installed on the event bus. Keyed by the plugin's
  // original callback reference so a plugin can `offX(sameFn)` cleanly.
  // See audit finding W-PS2 (2026-04-14).
  const modesReadyByCallback = new Map<(channel: string) => void, (channel: string) => void>();
  const permissionsByCallback = new Map<
    (handle: string) => void,
    (handle: string, ...rest: unknown[]) => void
  >();

  return {
    onModesReady(callback: (channel: string) => void): void {
      if (modesReadyByCallback.has(callback)) return; // idempotent
      const wrappedListener = (channel: string): void => {
        callback(channel);
      };
      eventBus.on('channel:modesReady', wrappedListener);
      modesReadyByCallback.set(callback, wrappedListener);
      const list = modesReadyListeners.get(pluginId) ?? [];
      list.push(wrappedListener);
      modesReadyListeners.set(pluginId, list);
    },
    offModesReady(callback: (channel: string) => void): void {
      const wrapped = modesReadyByCallback.get(callback);
      if (!wrapped) return;
      eventBus.off('channel:modesReady', wrapped);
      modesReadyByCallback.delete(callback);
      const list = modesReadyListeners.get(pluginId);
      if (list) {
        const idx = list.indexOf(wrapped);
        if (idx !== -1) list.splice(idx, 1);
      }
    },
    onPermissionsChanged(callback: (handle: string) => void): void {
      if (permissionsByCallback.has(callback)) return; // idempotent
      // One wrapper fans three events into the plugin callback. The three
      // events carry different tail params (global flags, hostmask, ...);
      // we only surface `handle` (arg 0) and discard the rest.
      const wrappedListener = (handle: string, ..._rest: unknown[]): void => {
        callback(handle);
      };
      for (const ev of PERMISSIONS_CHANGE_EVENTS) {
        eventBus.on(ev, wrappedListener);
      }
      permissionsByCallback.set(callback, wrappedListener);
      const list = permissionsChangedListeners.get(pluginId) ?? [];
      list.push(wrappedListener);
      permissionsChangedListeners.set(pluginId, list);
    },
    offPermissionsChanged(callback: (handle: string) => void): void {
      const wrapped = permissionsByCallback.get(callback);
      if (!wrapped) return;
      for (const ev of PERMISSIONS_CHANGE_EVENTS) {
        eventBus.off(ev, wrapped);
      }
      permissionsByCallback.delete(callback);
      const list = permissionsChangedListeners.get(pluginId);
      if (list) {
        const idx = list.indexOf(wrapped);
        if (idx !== -1) list.splice(idx, 1);
      }
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
  pluginLogger: LoggerLike | null,
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
