/**
 * hexbot — Public type declarations
 *
 * This package provides TypeScript types for hexbot plugin development.
 *
 * ## Quick start
 *
 * ```typescript
 * import type { HandlerContext, PluginAPI, PluginExports } from '../../types/index.d.ts';
 *
 * export const name = 'my-plugin';
 * export const version = '1.0.0';
 * export const description = 'My hexbot plugin';
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
 * - `plugin-api.d.ts` — `PluginAPI`, `PluginExports`, `PluginDB`, `PluginPermissions`,
 *                        `PluginServices`, `PluginChannelSettings`, `HelpEntry`, `VerifyResult`
 * - `config.d.ts`    — `BotConfig`, `IrcConfig`, `ServicesConfig`, and all other config shapes
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
  ChannelSettingDef,
  ChannelSettingType,
  ChannelSettingValue,
  Flag,
  HelpEntry,
  PluginAPI,
  PluginChannelSettings,
  PluginDB,
  PluginExports,
  PluginPermissions,
  PluginServices,
  UserRecord,
  VerifyResult,
} from './plugin-api.d.ts';

// Configuration
export type {
  BotConfig,
  DccConfig,
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
