// HexBot — Zod schemas for config/bot.json on-disk shape
//
// These mirror the `*OnDisk` interfaces in src/types/config.ts. Every schema
// uses z.strictObject so unrecognized keys are rejected: this catches typos
// in config files (e.g. "hots" instead of "host") which otherwise silently
// load as undefined and cause obscure runtime failures later.
//
// Every leaf field carries a `@reload:<class>` token in its `.describe(...)`
// annotation. The settings registry reads the token via
// `parseReloadClassFromZod` and uses it to drive the live-config command
// surface (`live` applies on the spot, `reload` reattaches a subsystem,
// `restart` warns the operator). Reload classes follow the matrix in
// docs/plans/live-config-updates.md §4.
//
// If you add/rename a field in types/config.ts, update the matching schema
// here. The _SchemaMatchesInterface assertion below will flag drift at
// `tsc --noEmit` time if the two diverge.
import { z } from 'zod';

import type { BotConfigOnDisk } from '../types';

const ChannelEntryOnDiskSchema = z.strictObject({
  name: z.string(),
  key: z.string().optional(),
  key_env: z.string().optional(),
});

const ChannelListEntrySchema = z.union([z.string(), ChannelEntryOnDiskSchema], {
  error: 'channel entry must be a string (e.g. "#chan") or { name, key?, key_env? }',
});

const IrcConfigOnDiskSchema = z.strictObject({
  host: z.string().describe('@reload:restart IRC server hostname'),
  port: z.number().describe('@reload:restart IRC TCP port'),
  tls: z.boolean().describe('@reload:restart Use TLS'),
  nick: z.string().describe('@reload:reload Primary nick'),
  username: z.string().describe('@reload:restart USER ident'),
  realname: z.string().describe('@reload:restart GECOS / realname'),
  channels: z.array(ChannelListEntrySchema).describe('@reload:live Configured channels'),
  tls_verify: z.boolean().optional().describe('@reload:restart Verify TLS certificate'),
  tls_cert: z.string().optional().describe('@reload:restart TLS client certificate path'),
  tls_key: z.string().optional().describe('@reload:restart TLS client key path'),
  alt_nick: z.string().optional().describe('@reload:restart Fallback nick on collision'),
  ghost_on_recover: z.boolean().optional().describe('@reload:restart Auto-GHOST nick on collision'),
});

// Owner handle and hostmask now come from HEX_OWNER_HANDLE /
// HEX_OWNER_HOSTMASK (see src/bootstrap.ts). Only the password reference
// remains in bot.json, via the `_env` convention.
const OwnerConfigSchema = z.strictObject({
  password_env: z.string().optional().describe('@reload:restart Owner DCC password env var'),
});

const IdentityConfigSchema = z.strictObject({
  method: z.literal('hostmask').describe('@reload:restart Identity verification method'),
  require_acc_for: z
    .array(z.string())
    .describe('@reload:live Flags requiring NickServ ACC verification'),
});

const ServicesConfigOnDiskSchema = z.strictObject({
  type: z.enum(['atheme', 'anope', 'dalnet', 'none']).describe('@reload:reload Services flavor'),
  nickserv: z.string().describe('@reload:reload NickServ target'),
  password_env: z.string().optional().describe('@reload:restart NickServ password env var'),
  sasl: z.boolean().describe('@reload:restart Negotiate SASL at registration'),
  sasl_mechanism: z
    .enum(['PLAIN', 'EXTERNAL'])
    .optional()
    .describe('@reload:restart SASL mechanism'),
  identify_before_join: z
    .boolean()
    .optional()
    .describe('@reload:live Wait for bot:identified before JOIN'),
  identify_before_join_timeout_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('@reload:live Identify-before-join timeout (ms)'),
});

const LoggingConfigSchema = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']).describe('@reload:live Minimum log level'),
  mod_actions: z.boolean().describe('@reload:live Persist privileged actions to mod_log'),
  mod_log_retention_days: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('@reload:live mod_log retention window (days; 0 = unlimited)'),
});

const QueueConfigSchema = z.strictObject({
  // Cap rate at 1000 msgs/sec — above that, `Math.floor(1000 / rate)`
  // collapses to 0 and the drain timer fires as fast as the event loop
  // allows. The runtime queue clamps `costMs >= 1` defensively, but
  // pinning the schema bound lets a typo (`rate: 10000`) fail loudly.
  rate: z
    .number()
    .positive()
    .max(1000)
    .optional()
    .describe('@reload:live Outbound message rate (msgs/sec, max 1000)'),
  burst: z
    .number()
    .positive()
    .max(100)
    .optional()
    .describe('@reload:live Outbound message burst size (max 100)'),
});

const FloodWindowConfigSchema = z.strictObject({
  count: z.number(),
  window: z.number(),
});

const FloodConfigSchema = z.strictObject({
  pub: FloodWindowConfigSchema.optional().describe('@reload:live Pub/pubm flood window'),
  msg: FloodWindowConfigSchema.optional().describe('@reload:live Msg/msgm flood window'),
});

const ProxyConfigOnDiskSchema = z.strictObject({
  enabled: z.boolean().describe('@reload:restart SOCKS5 proxy enabled'),
  host: z.string().describe('@reload:restart SOCKS5 proxy host'),
  port: z.number().describe('@reload:restart SOCKS5 proxy port'),
  username: z.string().optional().describe('@reload:restart SOCKS5 username'),
  password_env: z.string().optional().describe('@reload:restart SOCKS5 password env var'),
});

// Validate the dotted-quad shape with a regex first, then refine to enforce
// per-octet 0..255. The regex alone admits "999.999.999.999" because `\d{1,3}`
// doesn't bound the integer value — the refine step closes that.
const IPv4DottedQuadSchema = z
  .string()
  .regex(/^(?:\d{1,3}\.){3}\d{1,3}$/)
  .refine(
    (ip) => {
      const parts = ip.split('.').map((p) => Number(p));
      return parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255);
    },
    { message: 'ip must be a valid IPv4 dotted-quad (DCC advertises IPv4 literals only)' },
  );

// DCC port range — both endpoints are above the well-known/IANA-registered
// region (>=1024) and within the 16-bit cap. The refine ensures the tuple
// is ordered so the listener allocator can iterate `[min..max]` directly.
const DccPortTupleSchema = z
  .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
  .refine((tuple) => tuple[0] <= tuple[1], {
    message: 'port_range: first port must be <= second port',
  });

const DccConfigSchema = z.strictObject({
  enabled: z.boolean().describe('@reload:reload DCC CHAT enabled'),
  ip: IPv4DottedQuadSchema.describe('@reload:reload DCC public IPv4'),
  port_range: DccPortTupleSchema.describe('@reload:reload DCC passive listener port range'),
  require_flags: z
    .string()
    .optional()
    .describe('@reload:live Flags required to open a DCC session'),
  max_sessions: z.number().optional().describe('@reload:live Max concurrent DCC sessions'),
  idle_timeout_ms: z.number().optional().describe('@reload:live DCC idle disconnect (ms)'),
});

const BotlinkEndpointSchema = z.strictObject({
  host: z.string(),
  port: z.number(),
});

const BotlinkConfigOnDiskSchema = z.strictObject({
  enabled: z.boolean().describe('@reload:restart Bot-link enabled'),
  role: z.enum(['hub', 'leaf']).describe('@reload:restart Bot-link role'),
  botname: z.string().describe('@reload:restart Bot identity within the botnet'),
  hub: BotlinkEndpointSchema.optional().describe('@reload:reload Bot-link hub endpoint (leaf)'),
  listen: BotlinkEndpointSchema.optional().describe(
    '@reload:reload Bot-link listen endpoint (hub)',
  ),
  password_env: z.string().optional().describe('@reload:reload Bot-link password env var'),
  // Per-botnet HMAC salt — hex string, ≥ 32 chars (16 bytes decoded).
  // Optional at schema level so the schema still loads when `botlink` is
  // disabled with only `enabled: false` present; required at runtime when
  // `botlink.enabled === true` (enforced in validateResolvedSecrets).
  link_salt: z
    .string()
    .min(32, 'link_salt must be at least 32 hex chars (16 bytes)')
    .regex(/^[0-9a-fA-F]+$/, 'link_salt must be hex characters only')
    .optional()
    .describe('@reload:restart Bot-link HELLO HMAC salt'),
  reconnect_delay_ms: z.number().optional().describe('@reload:live Initial reconnect delay (ms)'),
  reconnect_max_delay_ms: z.number().optional().describe('@reload:live Max reconnect delay (ms)'),
  max_leaves: z.number().optional().describe('@reload:live Hub-side concurrent leaf cap'),
  sync_permissions: z
    .boolean()
    .optional()
    .describe('@reload:live Replicate _permissions across botnet'),
  sync_channel_state: z
    .boolean()
    .optional()
    .describe('@reload:live Replicate channel state on link-up'),
  sync_bans: z.boolean().optional().describe('@reload:live Replicate ban list mutations'),
  ping_interval_ms: z.number().optional().describe('@reload:live Hub→leaf ping interval (ms)'),
  link_timeout_ms: z.number().optional().describe('@reload:live Leaf disconnect threshold (ms)'),
  max_auth_failures: z.number().optional().describe('@reload:live Auth failures before IP ban'),
  auth_window_ms: z.number().optional().describe('@reload:live Auth-failure window (ms)'),
  auth_ban_duration_ms: z.number().optional().describe('@reload:live Auth-ban base duration (ms)'),
  auth_ip_whitelist: z
    .array(z.string())
    .optional()
    .describe(
      '@reload:live Auth rate-limit IPv4-CIDR whitelist. ' +
        'Each entry MUST be IPv4 CIDR (`10.0.0.0/24`) or a bare IPv4 (`10.0.0.5`, expanded to /32 at runtime). ' +
        'IPv6 entries and free-form host strings are not supported and are dropped at config load with a [security] warning.',
    ),
  handshake_timeout_ms: z.number().optional().describe('@reload:live HELLO handshake timeout (ms)'),
  max_pending_handshakes: z
    .number()
    .optional()
    .describe('@reload:live Concurrent unauth handshakes per IP'),
  cmd_inbound_rate: z.number().optional().describe('@reload:live Hub→leaf CMD frames/sec ceiling'),
});

const ChanmodBotConfigOnDiskSchema = z.strictObject({
  nick_recovery_password_env: z
    .string()
    .optional()
    .describe('@reload:restart NickServ GHOST password env var'),
});

const MemoConfigSchema = z.strictObject({
  memoserv_relay: z.boolean().optional().describe('@reload:live MemoServ notice relay'),
  memoserv_nick: z.string().optional().describe('@reload:live MemoServ service nick'),
  delivery_cooldown_seconds: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('@reload:live Per-user join-delivery cooldown (sec)'),
});

// `database` and `pluginDir` now come from HEX_DB_PATH / HEX_PLUGIN_DIR
// (see src/bootstrap.ts). They are intentionally absent from the on-disk
// schema; the strict-object guard rejects bot.json files that still
// carry them, and `parseBotConfigOnDisk` rewrites the resulting Zod
// error to point operators at the env var to set.
export const BotConfigOnDiskSchema = z.strictObject({
  irc: IrcConfigOnDiskSchema,
  owner: OwnerConfigSchema,
  identity: IdentityConfigSchema,
  services: ServicesConfigOnDiskSchema,
  pluginsConfig: z.string().optional().describe('@reload:restart plugins.json path'),
  logging: LoggingConfigSchema,
  queue: QueueConfigSchema.optional(),
  flood: FloodConfigSchema.optional(),
  proxy: ProxyConfigOnDiskSchema.optional(),
  dcc: DccConfigSchema.optional(),
  botlink: BotlinkConfigOnDiskSchema.optional(),
  quit_message: z.string().optional().describe('@reload:live Server-visible QUIT message'),
  channel_rejoin_interval_ms: z
    .number()
    .optional()
    .describe('@reload:live Periodic presence-check interval (ms)'),
  channel_retry_schedule_ms: z
    .array(z.number().nonnegative())
    .optional()
    .describe('@reload:live Channel rejoin backoff schedule (ms)'),
  command_prefix: z
    .string()
    .min(1)
    .optional()
    .describe('@reload:live Built-in admin command prefix'),
  chanmod: ChanmodBotConfigOnDiskSchema.optional(),
  memo: MemoConfigSchema.optional(),
});

// Compile-time guard: if BotConfigOnDisk (types/config.ts) drifts from the
// schema above, the `true` assignment fails with one of the branch messages.
type _SchemaMatchesInterface = [BotConfigOnDisk] extends [z.infer<typeof BotConfigOnDiskSchema>]
  ? [z.infer<typeof BotConfigOnDiskSchema>] extends [BotConfigOnDisk]
    ? true
    : 'Zod schema has fields the BotConfigOnDisk interface does not declare'
  : 'BotConfigOnDisk interface has fields the Zod schema does not cover';
const _verifySchemaMatches: _SchemaMatchesInterface = true;
void _verifySchemaMatches;
