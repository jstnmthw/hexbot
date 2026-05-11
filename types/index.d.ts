/**
 * HexBot — Public type declarations
 *
 * This package provides TypeScript types for HexBot plugin development.
 *
 * ## Quick start
 *
 * ```typescript
 * import type { HandlerContext, PluginAPI, PluginExports } from '../../types/index.d.ts';
 *
 * export const name = 'my-plugin';
 * export const version = '1.0.0';
 * export const description = 'My HexBot plugin';
 *
 * export function init(api: PluginAPI): void {
 *   api.bind('pub', '-', '!hello', (ctx) => {
 *     ctx.reply(`Hello, ${api.stripFormatting(ctx.nick)}!`);
 *   });
 * }
 * ```
 *
 * ## Module layout
 *
 * - `events.d.ts`    — `BindType`, `HandlerContext`, `BindHandler`, `ChannelUser`, `ChannelState`
 * - `plugin-api.d.ts` — `PluginAPI`, `PluginExports`, and every sub-API surface
 * - `config.d.ts`    — `BotConfig` and the rest of the runtime config shapes
 * - `index.d.ts`     — This file — re-exports everything above
 */

// Events
export type {
  BindHandler,
  BindType,
  ChannelState,
  ChannelUser,
  HandlerContext,
} from './events.d.ts';

// Plugin API
export type {
  BanRecord,
  ChannelSettingChangeCallback,
  ChannelSettingDef,
  ChannelSettingEntry,
  ChannelSettingType,
  ChannelSettingValue,
  Flag,
  HelpEntry,
  HelpRegistryView,
  PluginAPI,
  PluginAudit,
  PluginAuditOptions,
  PluginBanStore,
  PluginBotConfig,
  PluginChannelSettings,
  PluginCoreSettingsView,
  PluginDB,
  PluginExports,
  PluginIrcConfig,
  PluginModActor,
  PluginPermissions,
  PluginServices,
  PluginSettingDef,
  PluginSettings,
  PluginSlidingWindowCounter,
  PluginUtil,
  PublicUserRecord,
  ReloadClass,
  SettingsChangeCallback,
  UserRecord,
  VerifyResult,
} from './plugin-api.d.ts';

// Configuration
export type {
  BotConfig,
  ChanmodBotConfig,
  ChannelEntry,
  DccConfig,
  FloodConfig,
  FloodWindowConfig,
  IdentityConfig,
  IrcConfig,
  LoggingConfig,
  OwnerConfig,
  PluginConfig,
  PluginsConfig,
  ProxyConfig,
  QueueConfig,
  ServicesConfig,
} from './config.d.ts';
