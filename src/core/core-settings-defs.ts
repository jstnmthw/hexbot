// HexBot — core-scope SettingsRegistry definitions, each bundled with its
// live-apply handler.
//
// Mirrors the matrix in docs/plans/live-config-updates.md §4: live keys
// apply on the spot, reload keys reattach a subsystem, restart keys warn
// the operator that a process restart is needed.
//
// Defs are registered directly (rather than via Zod schema reflection) so
// each onChange handler can close over the bot's wired subsystems.
// Reload classes still match the Zod `.describe` tokens in
// `src/config/schemas.ts` so introspection sees the same contract.
//
// Skipped here (handled out-of-band): array-typed settings
// (`irc.channels`, `channel_retry_schedule_ms`, `identity.require_acc_for`,
// `botlink.auth_ip_whitelist`) and tuple-typed `dcc.port_range`. These read
// from `bot.config` directly until typed-array support lands.
import type { Bot } from '../bot';
import type { LogLevel } from '../logger';
import type { SettingDef } from './settings-registry';

/**
 * Pairing of a setting def with its optional live-apply handler. The
 * registry registers each `def`; the central onChange fan-out (installed
 * by `Bot.registerCoreSettings`) consults `onChange` for live keys.
 * Restart-class entries typically omit `onChange` because the def's
 * `restart` reload class is what surfaces the warning to the operator.
 */
export interface CoreSettingEntry {
  def: SettingDef;
  onChange?: (value: unknown) => void;
}

/**
 * Build the full list of core-scope setting entries for this bot. Each
 * entry's `onChange` closes over the bot instance so it can reach into
 * the wired subsystems (logger, db, memo, dispatcher, messageQueue, ...).
 */
export function buildCoreSettingEntries(bot: Bot): CoreSettingEntry[] {
  // Shared handler for queue.rate / queue.burst — both keys rebuild the
  // same rate/burst pair.
  const applyQueueChange = (): void => {
    const rate = bot.coreSettings.getInt('', 'queue.rate') || bot.config.queue?.rate || 2;
    const burst = bot.coreSettings.getInt('', 'queue.burst') || bot.config.queue?.burst || 4;
    bot.messageQueue.setRate(rate, burst);
  };

  // Shared handler for flood.* — all four keys rebuild the dispatcher's
  // flood config struct.
  const applyFloodChange = (): void => {
    const pubCount = bot.coreSettings.getInt('', 'flood.pub.count');
    const pubWindow = bot.coreSettings.getInt('', 'flood.pub.window');
    const msgCount = bot.coreSettings.getInt('', 'flood.msg.count');
    const msgWindow = bot.coreSettings.getInt('', 'flood.msg.window');
    const next: {
      pub?: { count: number; window: number };
      msg?: { count: number; window: number };
    } = {};
    if (pubCount > 0 && pubWindow > 0) next.pub = { count: pubCount, window: pubWindow };
    if (msgCount > 0 && msgWindow > 0) next.msg = { count: msgCount, window: msgWindow };
    bot.dispatcher.setFloodConfig(next);
  };

  // Shared handler for memo.* — three keys rebuild the memo config struct.
  const applyMemoChange = (): void => {
    bot.memo.setConfig({
      memoserv_relay: bot.coreSettings.getFlag('', 'memo.memoserv_relay'),
      memoserv_nick: bot.coreSettings.getString('', 'memo.memoserv_nick') || 'MemoServ',
      delivery_cooldown_seconds: bot.coreSettings.getInt('', 'memo.delivery_cooldown_seconds'),
    });
  };

  return [
    // -------- Live keys --------
    {
      def: {
        key: 'logging.level',
        type: 'string',
        default: 'info',
        description: 'Minimum log level',
        allowedValues: ['debug', 'info', 'warn', 'error'],
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'string') bot.logger.setLevel(value as LogLevel);
      },
    },
    {
      def: {
        key: 'logging.mod_actions',
        type: 'flag',
        default: true,
        description: 'Persist privileged actions to mod_log',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'boolean') bot.db.setModLogEnabled(value);
      },
    },
    {
      def: {
        key: 'logging.mod_log_retention_days',
        type: 'int',
        default: 0,
        description: 'mod_log retention window in days (0 = unlimited)',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'number') bot.db.setModLogRetentionDays(value);
      },
    },
    {
      def: {
        key: 'queue.rate',
        type: 'int',
        default: 2,
        description: 'Outbound message rate (msgs/sec)',
        reloadClass: 'live',
      },
      onChange: applyQueueChange,
    },
    {
      def: {
        key: 'queue.burst',
        type: 'int',
        default: 4,
        description: 'Outbound message burst size',
        reloadClass: 'live',
      },
      onChange: applyQueueChange,
    },
    {
      def: {
        key: 'flood.pub.count',
        type: 'int',
        default: 0,
        description: 'Pub/pubm flood window count (0 = disabled)',
        reloadClass: 'live',
      },
      onChange: applyFloodChange,
    },
    {
      def: {
        key: 'flood.pub.window',
        type: 'int',
        default: 0,
        description: 'Pub/pubm flood window seconds',
        reloadClass: 'live',
      },
      onChange: applyFloodChange,
    },
    {
      def: {
        key: 'flood.msg.count',
        type: 'int',
        default: 0,
        description: 'Msg/msgm flood window count (0 = disabled)',
        reloadClass: 'live',
      },
      onChange: applyFloodChange,
    },
    {
      def: {
        key: 'flood.msg.window',
        type: 'int',
        default: 0,
        description: 'Msg/msgm flood window seconds',
        reloadClass: 'live',
      },
      onChange: applyFloodChange,
    },
    {
      def: {
        key: 'memo.memoserv_relay',
        type: 'flag',
        default: true,
        description: 'Relay MemoServ notices to console',
        reloadClass: 'live',
      },
      onChange: applyMemoChange,
    },
    {
      def: {
        key: 'memo.memoserv_nick',
        type: 'string',
        default: 'MemoServ',
        description: 'MemoServ service nick',
        reloadClass: 'live',
      },
      onChange: applyMemoChange,
    },
    {
      def: {
        key: 'memo.delivery_cooldown_seconds',
        type: 'int',
        default: 60,
        description: 'Per-user join-delivery cooldown (sec)',
        reloadClass: 'live',
      },
      onChange: applyMemoChange,
    },
    {
      def: {
        key: 'quit_message',
        type: 'string',
        default: '',
        description: 'Server-visible QUIT message',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'string') bot.config.quit_message = value;
      },
    },
    {
      def: {
        key: 'channel_rejoin_interval_ms',
        type: 'int',
        default: 30000,
        description: 'Periodic presence-check interval (ms)',
        reloadClass: 'live',
      },
      // The lifecycle handle isn't built until connect(); on next reconnect
      // it picks up bot.config.channel_rejoin_interval_ms. Update the
      // in-memory config too so a mid-session reconnect sees the new value.
      onChange: (value) => {
        if (typeof value === 'number') bot.config.channel_rejoin_interval_ms = value;
      },
    },
    {
      def: {
        key: 'services.identify_before_join',
        type: 'flag',
        default: false,
        description: 'Wait for bot:identified before JOIN',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'boolean') bot.config.services.identify_before_join = value;
      },
    },
    {
      def: {
        key: 'services.identify_before_join_timeout_ms',
        type: 'int',
        default: 10000,
        description: 'Identify-before-join timeout (ms)',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'number') {
          bot.config.services.identify_before_join_timeout_ms = value;
        }
      },
    },
    {
      def: {
        key: 'services.services_host_pattern',
        type: 'string',
        default: '',
        description: 'NickServ services-host wildcard match',
        reloadClass: 'live',
      },
      // Services reads this on every NickServ NOTICE; mutating the
      // config record is enough — no rebuild needed.
      onChange: (value) => {
        if (typeof value === 'string') bot.config.services.services_host_pattern = value;
      },
    },
    {
      def: {
        key: 'dcc.require_flags',
        type: 'string',
        default: 'm',
        description: 'Flags required to open a DCC session',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'string' && bot.config.dcc) bot.config.dcc.require_flags = value;
      },
    },
    {
      def: {
        key: 'dcc.max_sessions',
        type: 'int',
        default: 5,
        description: 'Max concurrent DCC sessions',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'number' && bot.config.dcc) bot.config.dcc.max_sessions = value;
      },
    },
    {
      def: {
        key: 'dcc.idle_timeout_ms',
        type: 'int',
        default: 300000,
        description: 'DCC idle disconnect (ms)',
        reloadClass: 'live',
      },
      onChange: (value) => {
        if (typeof value === 'number' && bot.config.dcc) bot.config.dcc.idle_timeout_ms = value;
      },
    },
    // -------- Reload-class keys: onReload reattaches the relevant subsystem --------
    {
      def: {
        key: 'irc.nick',
        type: 'string',
        default: '',
        description: 'Primary nick (live: triggers NICK)',
        reloadClass: 'reload',
        onReload: (value) => {
          if (typeof value === 'string' && value.length > 0) {
            bot.client.changeNick(value);
          }
        },
      },
    },
    // -------- Restart-class keys: read at boot only --------
    {
      def: {
        key: 'irc.host',
        type: 'string',
        default: '',
        description: 'IRC server host (effective on next connect)',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'irc.port',
        type: 'int',
        default: 0,
        description: 'IRC server port (effective on next connect)',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'irc.tls',
        type: 'flag',
        default: true,
        description: 'TLS for the IRC connection (effective on next connect)',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'irc.username',
        type: 'string',
        default: '',
        description: 'USER ident (sent at registration)',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'irc.realname',
        type: 'string',
        default: '',
        description: 'GECOS / realname (sent at registration)',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'identity.method',
        type: 'string',
        default: 'hostmask',
        description: 'Identity verification method',
        allowedValues: ['hostmask'],
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'services.type',
        type: 'string',
        default: 'none',
        description: 'Services flavor',
        allowedValues: ['atheme', 'anope', 'dalnet', 'none'],
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'services.nickserv',
        type: 'string',
        default: 'NickServ',
        description: 'NickServ target',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'services.sasl',
        type: 'flag',
        default: false,
        description: 'SASL at registration',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'services.sasl_mechanism',
        type: 'string',
        default: 'PLAIN',
        description: 'SASL mechanism',
        allowedValues: ['PLAIN', 'EXTERNAL'],
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'pluginsConfig',
        type: 'string',
        default: '',
        description: 'plugins.json path (read at loadAll)',
        reloadClass: 'restart',
      },
    },
    {
      def: {
        key: 'command_prefix',
        type: 'string',
        default: '.',
        description: 'Built-in admin command prefix',
        reloadClass: 'restart',
      },
    },
  ];
}
