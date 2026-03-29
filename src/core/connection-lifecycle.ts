// HexBot — Connection lifecycle
// Handles the IRC connection events: registered, close, reconnecting, socket error.
// Extracted from Bot to keep bot.ts a thin orchestrator.
import type { BotEventBus } from '../event-bus';
import type { Logger } from '../logger';
import type { BotConfig, Casemapping } from '../types';
import type { BindHandler, BindType } from '../types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface needed for connection lifecycle. */
export interface LifecycleIRCClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  join(channel: string, key?: string): void;
  network: { supports(feature: string): string | boolean };
}

export interface ConnectionLifecycleDeps {
  client: LifecycleIRCClient;
  config: BotConfig;
  configuredChannels: Array<{ name: string; key?: string }>;
  eventBus: BotEventBus;
  /** Callback to propagate the server's casemapping to the Bot and all modules. */
  applyCasemapping: (cm: Casemapping) => void;
  messageQueue: { clear(): void };
  dispatcher: {
    bind(type: BindType, flags: string, mask: string, handler: BindHandler, owner?: string): void;
  };
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Register all IRC connection lifecycle event listeners on the client.
 * The returned promise resolves when the bot successfully registers,
 * and rejects on a socket error before registration.
 */
export function registerConnectionEvents(
  deps: ConnectionLifecycleDeps,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  const { client, config, logger } = deps;
  const cfg = config.irc;
  let registered = false;

  client.on('registered', () => {
    registered = true;
    logger.info(`Connected to ${cfg.host}:${cfg.port} as ${cfg.nick}`);

    if (cfg.tls) {
      logTlsCipher(client, logger);
    }

    deps.eventBus.emit('bot:connected');
    applyCasemapping(deps);
    registerJoinErrorListeners(client, logger);
    bindCoreInviteHandler(deps);
    joinConfiguredChannels(deps);

    resolve();
  });

  client.on('close', () => {
    logger.info('Connection closed');
    deps.eventBus.emit('bot:disconnected', 'connection closed');
  });

  client.on('reconnecting', () => {
    deps.messageQueue.clear();
    logger.info('Reconnecting...');
  });

  client.on('socket error', (err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    logger.error('Socket error:', error.message);
    deps.eventBus.emit('bot:error', error);
    if (!registered) {
      reject(error);
    }
  });
}

// ---------------------------------------------------------------------------
// Startup helpers (called from the 'registered' handler)
// ---------------------------------------------------------------------------

/** Read CASEMAPPING from ISUPPORT and propagate it to all modules. */
function applyCasemapping(deps: ConnectionLifecycleDeps): void {
  const raw = deps.client.network.supports('CASEMAPPING');
  const cm: Casemapping =
    raw === 'ascii' || raw === 'strict-rfc1459' || raw === 'rfc1459' ? raw : 'rfc1459'; // safe fallback for unknown values
  deps.logger.info(`CASEMAPPING: ${cm}`);
  deps.applyCasemapping(cm);
}

/** Log TLS cipher info from the underlying socket. */
function logTlsCipher(client: LifecycleIRCClient, logger: Logger): void {
  // Access the TLS socket through irc-framework's internal connection/transport chain.
  // Using optional chaining throughout since this is private API.
  type InternalClient = { connection?: { transport?: { socket?: unknown } } };
  const tlsSocket = (client as unknown as InternalClient).connection?.transport?.socket;
  if (tlsSocket && typeof (tlsSocket as Record<string, unknown>).getCipher === 'function') {
    const cipher = (tlsSocket as { getCipher(): { name: string; version: string } }).getCipher();
    logger.info(`TLS connected — ${cipher.name} (${cipher.version})`);
  } else {
    logger.info('TLS connected');
  }
}

/** Register listeners for IRC join-error numerics (irc error + unknown command). */
function registerJoinErrorListeners(client: LifecycleIRCClient, logger: Logger): void {
  const JOIN_ERROR_NAMES: Record<string, string> = {
    channel_is_full: 'channel is full (+l)',
    invite_only_channel: 'invite only (+i)',
    banned_from_channel: 'banned from channel (+b)',
    bad_channel_key: 'bad channel key (+k)',
  };
  client.on('irc error', (event: unknown) => {
    const e = event as Record<string, unknown>;
    const reason = JOIN_ERROR_NAMES[String(e.error ?? '')];
    if (reason) {
      logger.warn(`Cannot join ${String(e.channel ?? '')}: ${reason}`);
    }
  });
  // 477 (need to register nick) is unknown to irc-framework — catch it via raw numeric.
  client.on('unknown command', (event: unknown) => {
    const e = event as Record<string, unknown>;
    if (String(e.command ?? '') === '477') {
      const params = Array.isArray(e.params) ? (e.params as unknown[]) : [];
      logger.warn(`Cannot join ${String(params[1] ?? '')}: need to register nick (+r)`);
    }
  });
}

/**
 * Bind the core INVITE handler — auto-re-joins configured channels on invite.
 * No permission check: this is a bot-level feature, not user-triggered.
 * Plugins may add their own 'invite' binds with flag checking.
 */
function bindCoreInviteHandler(deps: ConnectionLifecycleDeps): void {
  const { client, configuredChannels, dispatcher, logger } = deps;
  dispatcher.bind(
    'invite',
    '-',
    '*',
    (ctx) => {
      const channel = ctx.channel;
      if (!channel) return;
      const ch = configuredChannels.find((c) => c.name.toLowerCase() === channel.toLowerCase());
      if (!ch) return;
      client.join(ch.name, ch.key);
      logger.info(`INVITE from ${ctx.nick}: re-joining configured channel ${ch.name}`);
    },
    'core',
  );
}

/** Send JOIN for every channel in the configured list. */
function joinConfiguredChannels(deps: ConnectionLifecycleDeps): void {
  for (const ch of deps.configuredChannels) {
    deps.client.join(ch.name, ch.key);
    deps.logger.info(`Joining ${ch.name}`);
  }
}
