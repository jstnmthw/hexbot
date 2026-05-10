// HexBot — Relay orchestrator
//
// Owns the bot-link subsystem: the hub or leaf link, party-line wiring,
// virtual relay sessions, and the frame dispatch that fans incoming
// PARTY_CHAT / RELAY / PROTECT / ban-share frames out to DCC, permissions,
// and ban storage.
//
// Extracted from src/bot.ts per the 2026-04-19 quality audit. The orchestrator
// is constructed once at bot startup and survives across IRC reconnects —
// `connect()` in bot.ts never nulls these subsystems out, only `stop()` does.
// That invariant matters because `attachRelayServiceMirror()` installs
// IRC-client listeners once and `startBotLink()` installs a
// `botlink:disconnected` handler once; re-running either would leak
// duplicates.
//
// NOTE: a future SubsystemRegistry (see the same audit) could collapse
// orchestrator + DCC + memo wiring behind a single start/stop protocol.
// This module intentionally stops short of that second step.
import type { Client as IrcClient } from 'irc-framework';

import type { CommandHandler } from '../command-handler';
import type { BotDatabase } from '../database';
import type { BotEventBus } from '../event-bus';
import type { LoggerLike } from '../logger';
import type { BotConfig, Casemapping } from '../types';
import { toEventObject } from '../utils/irc-event';
import { sanitize } from '../utils/sanitize';
import { stripFormatting } from '../utils/strip-formatting';
import {
  BanListSyncer,
  BotLinkHub,
  BotLinkLeaf,
  ChannelStateSyncer,
  type LinkFrame,
  PermissionSyncer,
  type RelayHandlerDeps,
  type RelaySessionMap,
  SharedBanList,
  handleProtectFrame,
  handleRelayFrame,
} from './botlink';
import type { ChannelSettings } from './channel-settings';
import type { ChannelState } from './channel-state';
import type { DCCManager } from './dcc';
import type { IRCCommands } from './irc-commands';
import type { Permissions } from './permissions';
import type { Services } from './services';

export interface RelayOrchestratorDeps {
  config: BotConfig;
  version: string;
  logger: LoggerLike;
  eventBus: BotEventBus;
  db: BotDatabase;
  client: InstanceType<typeof IrcClient>;
  commandHandler: CommandHandler;
  permissions: Permissions;
  channelState: ChannelState;
  channelSettings: ChannelSettings;
  ircCommands: IRCCommands;
  services: Services;
  /** Live getter — DCC manager may be attached before or after the orchestrator. */
  getDccManager: () => DCCManager | null;
  /** Live getter — casemapping can change after ISUPPORT arrives. */
  getCasemapping: () => Casemapping;
}

/**
 * Start/stop wrapper around the bot-link hub/leaf plus the party-line,
 * relay session, and frame-dispatch plumbing that depends on them.
 *
 * Construction is side-effect free; all wiring happens in `start()`. Callers
 * (currently `Bot`) should construct once, call `start()` during bot startup,
 * and call `stop()` exactly once during shutdown.
 */
export class RelayOrchestrator {
  private readonly deps: RelayOrchestratorDeps;
  private readonly logger: LoggerLike;

  private _hub: BotLinkHub | null = null;
  private _leaf: BotLinkLeaf | null = null;
  private _sharedBanList: SharedBanList | null = null;

  /** Virtual relay sessions on this bot (as target). Keyed by relay handle. */
  private readonly virtualSessions: RelaySessionMap = new Map();

  /** IRC-client listeners that mirror service NOTICE/PRIVMSG into relay sessions. */
  private mirrorListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  /** Handler attached to `botlink:disconnected` — held for removal in stop(). */
  private onDisconnectedCleanup: ((botname: string, reason: string) => void) | null = null;

  /** Lazy-initialized child logger for the relay frame handler. */
  private _relayLoggerCache: LoggerLike | null = null;

  constructor(deps: RelayOrchestratorDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('bot');
  }

  /** The active bot link hub, if this bot is a hub. */
  get hub(): BotLinkHub | null {
    return this._hub;
  }

  /** The active bot link leaf, if this bot is a leaf. */
  get leaf(): BotLinkLeaf | null {
    return this._leaf;
  }

  /** The in-memory shared ban list, populated only when botlink is enabled. */
  get sharedBanList(): SharedBanList | null {
    return this._sharedBanList;
  }

  /**
   * Whether a given console handle is the target of an active virtual relay
   * session on this bot. Used by the memo subsystem to suppress direct DCC
   * delivery while a relay is in progress.
   */
  hasRelayConsole(handle: string): boolean {
    return this.virtualSessions.has(handle);
  }

  /**
   * Set up the hub/leaf (per config), install IRC-service mirror listeners,
   * and attach the `botlink:disconnected` virtual-session cleanup. When
   * botlink is not enabled this still registers the disconnect listener so
   * future-enabled links behave consistently, but does not construct a hub
   * or leaf.
   */
  async start(): Promise<void> {
    const botlinkConfig = this.deps.config.botlink;
    if (botlinkConfig?.enabled) {
      // Register the 'shared' per-channel setting for ban sync
      this.deps.channelSettings.register('core:botlink', [
        {
          key: 'shared',
          type: 'flag',
          default: false,
          description: 'Sync ban/exempt lists with linked bots',
        },
      ]);
      this._sharedBanList = new SharedBanList(this.deps.logger);
      const isShared = (ch: string) => this.deps.channelSettings.get(ch, 'shared') === true;

      if (botlinkConfig.role === 'hub') {
        const hub = new BotLinkHub(
          botlinkConfig,
          this.deps.version,
          this.deps.logger,
          this.deps.eventBus,
          this.deps.db,
        );
        this._hub = hub;
        hub.setCommandRelay(this.deps.commandHandler, this.deps.permissions, this.deps.eventBus);
        hub.onSyncRequest = (_botname, send) => {
          for (const f of ChannelStateSyncer.buildSyncFrames(this.deps.channelState)) send(f);
          for (const f of PermissionSyncer.buildSyncFrames(this.deps.permissions)) send(f);
          if (this._sharedBanList) {
            for (const f of BanListSyncer.buildSyncFrames(this._sharedBanList, isShared)) send(f);
          }
        };
        hub.onLeafConnected = (botname) => this.deps.eventBus.emit('botlink:connected', botname);
        hub.onLeafDisconnected = (botname, reason) =>
          this.deps.eventBus.emit('botlink:disconnected', botname, reason);
        hub.onLeafFrame = (_botname, frame) => {
          this.handleIncomingFrame(frame, isShared);
        };
        // BSAY: when a linked bot asks the hub to send an IRC message
        hub.onBsay = (target, message) => this.deps.client.say(target, message);
        // Party line: provide local DCC sessions for PARTY_WHOM
        hub.getLocalPartyUsers = () => {
          const dcc = this.deps.getDccManager();
          if (!dcc) return [];
          return dcc.getSessionList().map((s) => ({
            handle: s.handle,
            nick: s.nick,
            botname: botlinkConfig.botname,
            connectedAt: s.connectedAt,
            idle: 0,
          }));
        };
        // Party line: DCC outgoing → botlink frames
        this.wirePartyLine(hub);
        await hub.listen();
        this.logger.info('Bot link hub started');
      } else {
        const leaf = new BotLinkLeaf(botlinkConfig, this.deps.version, this.deps.logger);
        this._leaf = leaf;
        leaf.setCommandRelay(this.deps.commandHandler, this.deps.permissions);
        leaf.onFrame = (frame) => {
          // Leaf applies state sync (hub is authoritative, so hub doesn't need this)
          ChannelStateSyncer.applyFrame(frame, this.deps.channelState);
          PermissionSyncer.applyFrame(frame, this.deps.permissions);
          // Sync complete notification
          if (frame.type === 'SYNC_END') {
            this.deps.eventBus.emit('botlink:syncComplete', botlinkConfig.botname);
          }
          // BSAY: hub asks this leaf to send an IRC message
          if (frame.type === 'BSAY') {
            this.deps.client.say(String(frame.target ?? ''), String(frame.message ?? ''));
          }
          this.handleIncomingFrame(frame, isShared);
        };
        leaf.onConnected = (hubName) => this.deps.eventBus.emit('botlink:connected', hubName);
        leaf.onDisconnected = (reason) =>
          this.deps.eventBus.emit('botlink:disconnected', 'hub', reason);
        // Party line: DCC outgoing → botlink frames
        this.wirePartyLine(leaf);
        leaf.connect();
        this.logger.info('Bot link leaf connecting to hub');
      }
      // Forward service NOTICE/PRIVMSG replies (NickServ, ChanServ, MemoServ…)
      // into any active virtual relay sessions on this bot. Independent of DCC
      // so leaves with DCC disabled still surface async service replies back
      // to the relay origin.
      this.attachRelayServiceMirror();
    }
    // Clean up orphaned relay virtual sessions when a linked bot disconnects.
    // Hoisted to a named field so stop() can remove it — if any code path
    // ever re-creates the orchestrator in the same process, the previous
    // instance would otherwise be pinned by this listener's closure over
    // virtualSessions.
    this.onDisconnectedCleanup = (botname: string, _reason: string) => {
      for (const [handle, session] of this.virtualSessions) {
        if (session.fromBot === botname) {
          this.virtualSessions.delete(handle);
        }
      }
    };
    this.deps.eventBus.on('botlink:disconnected', this.onDisconnectedCleanup);
  }

  /**
   * Tear down every listener and link resource registered by `start()`.
   * Each step is independent so a throw in one cannot skip the rest — the
   * Bot's shutdown harness wraps this call in its own try/catch, but we
   * keep the per-step isolation here too to match bot.ts conventions.
   */
  stop(): void {
    const step = (name: string, fn: () => void): void => {
      try {
        fn();
      } catch (err) {
        this.logger.error(`Relay orchestrator stop step "${name}" threw:`, err);
      }
    };

    step('botlink-disconnect-listener', () => {
      if (this.onDisconnectedCleanup) {
        this.deps.eventBus.off('botlink:disconnected', this.onDisconnectedCleanup);
        this.onDisconnectedCleanup = null;
      }
    });

    step('botlink-hub.close', () => {
      if (this._hub) {
        this._hub.close();
        this._hub = null;
      }
    });
    step('botlink-leaf.disconnect', () => {
      if (this._leaf) {
        this._leaf.disconnect();
        this._leaf = null;
      }
    });

    step('relay-mirror-listeners', () => {
      for (const { event, fn } of this.mirrorListeners) {
        this.deps.client.removeListener(event, fn);
      }
      this.mirrorListeners = [];
    });
  }

  // -------------------------------------------------------------------------
  // Internal wiring
  // -------------------------------------------------------------------------

  private get relayLogger(): LoggerLike {
    this._relayLoggerCache ??= this.deps.logger.child('botlink:relay');
    return this._relayLoggerCache;
  }

  /** Build the RelayHandlerDeps object used by handleRelayFrame. */
  private buildRelayDeps(): RelayHandlerDeps {
    const hub = this._hub;
    const leaf = this._leaf;
    const botlink = this.deps.config.botlink;
    // Only reached when a botlink link is live, so botlink config must be set.
    if (!botlink) {
      throw new Error('[relay-orchestrator] buildRelayDeps() called without botlink configured');
    }
    return {
      permissions: this.deps.permissions,
      commandHandler: this.deps.commandHandler,
      dccManager: this.deps.getDccManager(),
      botname: botlink.botname,
      sender: {
        sendTo: (botname, frame) => {
          if (hub) return hub.send(botname, frame);
          return leaf?.send(frame) ?? false;
        },
        send: (frame) => {
          if (hub) hub.broadcast(frame);
          else leaf?.send(frame);
        },
      },
      stripFormatting,
      logger: this.relayLogger,
    };
  }

  /**
   * Install IRC-client listeners that mirror incoming private NOTICE / PRIVMSG
   * lines to every active virtual relay session. Runs whether or not DCC is
   * enabled so leaf bots without a local console still relay service replies.
   */
  private attachRelayServiceMirror(): void {
    const forward = (line: string): void => {
      for (const vs of this.virtualSessions.values()) {
        vs.sendOutput(line);
      }
    };
    const onNotice = (...args: unknown[]): void => {
      const e = toEventObject(args[0]);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      // Only mirror PMs — channel notices are part of the public channel
      // stream, not a service-reply, and would flood relay consoles.
      // Hardcoded `#&` rather than ISUPPORT CHANTYPES because relay mirrors
      // run before ISUPPORT lands on first connection; the conservative
      // default catches every real network we target.
      if (/^[#&]/.test(target)) return;
      // Suppress NickServ verification chatter so the relay user isn't
      // shown the bot's own internal ACC/STATUS round-trips.
      if (this.deps.services.isNickServVerificationReply(nick, message)) return;
      forward(`-${sanitize(nick)}- ${sanitize(message)}`);
    };
    const onPrivmsg = (...args: unknown[]): void => {
      const e = toEventObject(args[0]);
      const nick = String(e.nick ?? '');
      const target = String(e.target ?? '');
      const message = String(e.message ?? '');
      // Only PMs — public channel traffic isn't part of the relay session.
      if (/^[#&]/.test(target)) return;
      forward(`<${sanitize(nick)}> ${sanitize(message)}`);
    };
    this.deps.client.on('notice', onNotice);
    this.deps.client.on('privmsg', onPrivmsg);
    this.mirrorListeners.push({ event: 'notice', fn: onNotice });
    this.mirrorListeners.push({ event: 'privmsg', fn: onPrivmsg });
  }

  /** Handle incoming PROTECT_* frames — delegates to extracted handler with permission guards. */
  private handleProtectFrame(frame: LinkFrame): void {
    handleProtectFrame(frame, {
      channelState: this.deps.channelState,
      permissions: this.deps.permissions,
      ircCommands: this.deps.ircCommands,
      botNick: this.deps.config.irc.nick,
      casemapping: this.deps.getCasemapping(),
      sendAck: (ack) => {
        if (this._hub) this._hub.broadcast(ack);
        else this._leaf?.send(ack);
      },
    });
  }

  /** Process an incoming botlink frame — shared between hub and leaf roles. */
  private handleIncomingFrame(frame: LinkFrame, isShared: (ch: string) => boolean): void {
    const dcc = this.deps.getDccManager();
    // Party line: deliver incoming PARTY_CHAT/JOIN/PART to local DCC.
    // Strip IRC formatting from all frame fields to prevent control character injection.
    if (frame.type === 'PARTY_CHAT' && dcc) {
      const handle = stripFormatting(String(frame.handle ?? ''));
      const bot = stripFormatting(String(frame.fromBot ?? ''));
      const msg = stripFormatting(String(frame.message ?? ''));
      dcc.announce(`<${handle}@${bot}> ${msg}`);
    }
    if (frame.type === 'PARTY_JOIN' && dcc) {
      const handle = stripFormatting(String(frame.handle ?? ''));
      const bot = stripFormatting(String(frame.fromBot ?? ''));
      dcc.announce(`*** ${handle} has joined the console (on ${bot})`);
    }
    if (frame.type === 'PARTY_PART' && dcc) {
      const handle = stripFormatting(String(frame.handle ?? ''));
      const bot = stripFormatting(String(frame.fromBot ?? ''));
      dcc.announce(`*** ${handle} has left the console (on ${bot})`);
    }
    // System announcements from linked bots
    if (frame.type === 'ANNOUNCE' && dcc) {
      dcc.announce(String(frame.message ?? ''));
    }
    // Ban sharing: apply incoming ban frames
    if (frame.type.startsWith('CHAN_BAN') || frame.type.startsWith('CHAN_EXEMPT')) {
      if (this._sharedBanList) {
        BanListSyncer.applyFrame(frame, this._sharedBanList, isShared);
      }
    }
    handleRelayFrame(frame, this.buildRelayDeps(), this.virtualSessions);
    this.handleProtectFrame(frame);
  }

  /** Wire local DCC party line events to a botlink hub or leaf. */
  private wirePartyLine(link: BotLinkHub | BotLinkLeaf): void {
    const dcc = this.deps.getDccManager();
    if (!dcc) return;
    const botlink = this.deps.config.botlink;
    if (!botlink) return;
    const botname = botlink.botname;
    const sendFrame = (frame: LinkFrame) => {
      if (link instanceof BotLinkHub) {
        link.broadcast(frame);
      } else {
        link.send(frame);
      }
    };
    dcc.onPartyChat = (handle, message) => {
      sendFrame({ type: 'PARTY_CHAT', handle, fromBot: botname, message });
    };
    dcc.onPartyJoin = (handle) => {
      sendFrame({ type: 'PARTY_JOIN', handle, fromBot: botname });
    };
    dcc.onPartyPart = (handle) => {
      sendFrame({ type: 'PARTY_PART', handle, fromBot: botname });
    };
    dcc.onRelayEnd = (handle, targetBot) => {
      const endFrame: LinkFrame = { type: 'RELAY_END', handle, reason: 'User ended relay' };
      // Send only to the involved bot — no need to broadcast RELAY_END to unrelated leaves.
      if (link instanceof BotLinkHub) {
        link.send(targetBot, endFrame);
        link.unregisterRelay(handle);
      } else {
        link.send(endFrame);
      }
    };
  }
}
