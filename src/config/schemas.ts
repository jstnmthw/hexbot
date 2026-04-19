// HexBot — Zod schemas for config/bot.json on-disk shape
//
// These mirror the `*OnDisk` interfaces in src/types/config.ts. Every schema
// uses z.strictObject so unrecognized keys are rejected: this catches typos
// in config files (e.g. "hots" instead of "host") which otherwise silently
// load as undefined and cause obscure runtime failures later.
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
  host: z.string(),
  port: z.number(),
  tls: z.boolean(),
  nick: z.string(),
  username: z.string(),
  realname: z.string(),
  channels: z.array(ChannelListEntrySchema),
  tls_verify: z.boolean().optional(),
  tls_cert: z.string().optional(),
  tls_key: z.string().optional(),
});

const OwnerConfigSchema = z.strictObject({
  handle: z.string(),
  hostmask: z.string(),
  password_env: z.string().optional(),
});

const IdentityConfigSchema = z.strictObject({
  method: z.literal('hostmask'),
  require_acc_for: z.array(z.string()),
});

const ServicesConfigOnDiskSchema = z.strictObject({
  type: z.enum(['atheme', 'anope', 'dalnet', 'none']),
  nickserv: z.string(),
  password_env: z.string().optional(),
  sasl: z.boolean(),
  sasl_mechanism: z.enum(['PLAIN', 'EXTERNAL']).optional(),
});

const LoggingConfigSchema = z.strictObject({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  mod_actions: z.boolean(),
  mod_log_retention_days: z.number().int().min(0).optional(),
});

const QueueConfigSchema = z.strictObject({
  rate: z.number().optional(),
  burst: z.number().optional(),
});

const FloodWindowConfigSchema = z.strictObject({
  count: z.number(),
  window: z.number(),
});

const FloodConfigSchema = z.strictObject({
  pub: FloodWindowConfigSchema.optional(),
  msg: FloodWindowConfigSchema.optional(),
});

const ProxyConfigOnDiskSchema = z.strictObject({
  enabled: z.boolean(),
  host: z.string(),
  port: z.number(),
  username: z.string().optional(),
  password_env: z.string().optional(),
});

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

const DccPortTupleSchema = z
  .tuple([z.number().int().min(1024).max(65535), z.number().int().min(1024).max(65535)])
  .refine((tuple) => tuple[0] <= tuple[1], {
    message: 'port_range: first port must be <= second port',
  });

const DccConfigSchema = z.strictObject({
  enabled: z.boolean(),
  ip: IPv4DottedQuadSchema,
  port_range: DccPortTupleSchema,
  require_flags: z.string(),
  max_sessions: z.number(),
  idle_timeout_ms: z.number(),
});

const BotlinkEndpointSchema = z.strictObject({
  host: z.string(),
  port: z.number(),
});

const BotlinkConfigOnDiskSchema = z.strictObject({
  enabled: z.boolean(),
  role: z.enum(['hub', 'leaf']),
  botname: z.string(),
  hub: BotlinkEndpointSchema.optional(),
  listen: BotlinkEndpointSchema.optional(),
  password_env: z.string().optional(),
  reconnect_delay_ms: z.number().optional(),
  reconnect_max_delay_ms: z.number().optional(),
  max_leaves: z.number().optional(),
  sync_permissions: z.boolean().optional(),
  sync_channel_state: z.boolean().optional(),
  sync_bans: z.boolean().optional(),
  ping_interval_ms: z.number(),
  link_timeout_ms: z.number(),
  max_auth_failures: z.number().optional(),
  auth_window_ms: z.number().optional(),
  auth_ban_duration_ms: z.number().optional(),
  auth_ip_whitelist: z.array(z.string()).optional(),
  handshake_timeout_ms: z.number().optional(),
  max_pending_handshakes: z.number().optional(),
});

const ChanmodBotConfigOnDiskSchema = z.strictObject({
  nick_recovery_password_env: z.string().optional(),
});

const MemoConfigSchema = z.strictObject({
  memoserv_relay: z.boolean().optional(),
  memoserv_nick: z.string().optional(),
  delivery_cooldown_seconds: z.number().int().min(0).optional(),
});

export const BotConfigOnDiskSchema = z.strictObject({
  irc: IrcConfigOnDiskSchema,
  owner: OwnerConfigSchema,
  identity: IdentityConfigSchema,
  services: ServicesConfigOnDiskSchema,
  database: z.string(),
  pluginDir: z.string(),
  pluginsConfig: z.string().optional(),
  logging: LoggingConfigSchema,
  queue: QueueConfigSchema.optional(),
  flood: FloodConfigSchema.optional(),
  proxy: ProxyConfigOnDiskSchema.optional(),
  dcc: DccConfigSchema.optional(),
  botlink: BotlinkConfigOnDiskSchema.optional(),
  quit_message: z.string().optional(),
  channel_rejoin_interval_ms: z.number().optional(),
  command_prefix: z.string().min(1).optional(),
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
