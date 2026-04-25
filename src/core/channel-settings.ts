// HexBot — Per-channel settings (thin wrapper over SettingsRegistry)
//
// `ChannelSettings` is the channel-scope concrete instance of
// {@link SettingsRegistry}: same typed register/get/set/unset/onChange
// surface, channel-key folding via `ircLower`, and `chanset-set` /
// `chanset-unset` audit actions. Plugins consume this through
// `api.channelSettings.*` — the wrapper exists so the plugin-facing
// API doesn't have to thread the registry's scope/namespace/instance
// arguments through every call.
import type { BotDatabase } from '../database';
import type { LoggerLike } from '../logger';
import type {
  ChannelSettingChangeCallback,
  ChannelSettingDef,
  ChannelSettingEntry,
  ChannelSettingValue,
} from '../types';
import type { ModActor } from './audit';
import { type ChannelLower, SettingsRegistry } from './settings-registry';

export type { ChannelSettingChangeCallback };
export type { ChannelLower };

const DEFAULT_LOWER: ChannelLower = (s) => s.toLowerCase();

export class ChannelSettings {
  private readonly registry: SettingsRegistry;

  constructor(db: BotDatabase, logger?: LoggerLike, ircLower?: ChannelLower) {
    this.registry = new SettingsRegistry({
      scope: 'channel',
      namespace: 'chanset',
      db,
      logger,
      auditActions: { set: 'chanset-set', unset: 'chanset-unset' },
      ircLower: ircLower ?? DEFAULT_LOWER,
    });
  }

  register(pluginId: string, defs: ChannelSettingDef[]): void {
    this.registry.register(pluginId, defs);
  }

  unregister(pluginId: string): void {
    this.registry.unregister(pluginId);
  }

  get(channel: string, key: string): ChannelSettingValue {
    return this.registry.get(channel, key);
  }

  getFlag(channel: string, key: string): boolean {
    return this.registry.getFlag(channel, key);
  }

  getString(channel: string, key: string): string {
    return this.registry.getString(channel, key);
  }

  getInt(channel: string, key: string): number {
    return this.registry.getInt(channel, key);
  }

  set(channel: string, key: string, value: ChannelSettingValue, actor?: ModActor): void {
    this.registry.set(channel, key, value, actor);
  }

  unset(channel: string, key: string): void {
    this.registry.unset(channel, key);
  }

  onChange(pluginId: string, callback: ChannelSettingChangeCallback): void {
    this.registry.onChange(pluginId, callback);
  }

  offChange(pluginId: string): void {
    this.registry.offChange(pluginId);
  }

  isSet(channel: string, key: string): boolean {
    return this.registry.isSet(channel, key);
  }

  getDef(key: string): ChannelSettingEntry | undefined {
    const entry = this.registry.getDef(key);
    return entry ? this.registry.toChannelSettingEntry(entry) : undefined;
  }

  getAllDefs(): ChannelSettingEntry[] {
    return this.registry.getAllDefs().map((e) => this.registry.toChannelSettingEntry(e));
  }

  getChannelSnapshot(
    channel: string,
  ): Array<{ entry: ChannelSettingEntry; value: ChannelSettingValue; isDefault: boolean }> {
    return this.registry.getSnapshot(channel).map((row) => ({
      entry: this.registry.toChannelSettingEntry(row.entry),
      value: row.value,
      isDefault: row.isDefault,
    }));
  }

  /** Underlying registry — exposed so `.chanset` / future helpers can
   *  share rendering code with core / plugin scope without re-deriving. */
  getRegistry(): SettingsRegistry {
    return this.registry;
  }
}
