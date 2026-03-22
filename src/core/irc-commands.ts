// hexbot — IRC commands core module
// Convenience wrappers for common IRC operations with mod action logging.
import type { BotDatabase } from '../database.js';
import type { Logger } from '../logger.js';
import { sanitize } from '../utils/sanitize.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal IRC client interface for IRC commands. */
export interface IRCCommandsClient {
  say(target: string, message: string): void;
  notice(target: string, message: string): void;
  join(channel: string): void;
  part(channel: string, message?: string): void;
  raw(line: string): void;
  mode?(target: string, mode: string, ...params: string[]): void;
}

// ---------------------------------------------------------------------------
// IRCCommands
// ---------------------------------------------------------------------------

export class IRCCommands {
  private client: IRCCommandsClient;
  private db: BotDatabase | null;
  private logger: Logger | null;
  private modesPerLine: number;

  constructor(
    client: IRCCommandsClient,
    db: BotDatabase | null,
    modesPerLine?: number,
    logger?: Logger | null,
  ) {
    this.client = client;
    this.db = db;
    this.logger = logger?.child('irc-commands') ?? null;
    this.modesPerLine = modesPerLine ?? 4; // Safe default; updated from ISUPPORT
  }

  /** Update the max modes per line from ISUPPORT. */
  setModesPerLine(n: number): void {
    this.modesPerLine = n;
  }

  // -------------------------------------------------------------------------
  // Channel operations
  // -------------------------------------------------------------------------

  say(target: string, message: string): void {
    this.client.say(target, message);
  }

  notice(target: string, message: string): void {
    this.client.notice(target, message);
  }

  join(channel: string, key?: string): void {
    if (key) {
      this.client.raw(`JOIN ${sanitize(channel)} ${sanitize(key)}`);
    } else {
      this.client.join(channel);
    }
  }

  part(channel: string, message?: string): void {
    this.client.part(channel, message);
  }

  kick(channel: string, nick: string, reason?: string): void {
    const safe = sanitize(reason ?? '');
    this.client.raw(`KICK ${sanitize(channel)} ${sanitize(nick)} :${safe}`);
    this.logMod('kick', channel, nick, 'bot', reason ?? null);
  }

  ban(channel: string, mask: string): void {
    this.sendMode(channel, '+b', mask);
    this.logMod('ban', channel, mask, 'bot', null);
  }

  unban(channel: string, mask: string): void {
    this.sendMode(channel, '-b', mask);
    this.logMod('unban', channel, mask, 'bot', null);
  }

  op(channel: string, nick: string): void {
    this.sendMode(channel, '+o', nick);
    this.logMod('op', channel, nick, 'bot', null);
  }

  deop(channel: string, nick: string): void {
    this.sendMode(channel, '-o', nick);
    this.logMod('deop', channel, nick, 'bot', null);
  }

  voice(channel: string, nick: string): void {
    this.sendMode(channel, '+v', nick);
  }

  devoice(channel: string, nick: string): void {
    this.sendMode(channel, '-v', nick);
  }

  topic(channel: string, text: string): void {
    const safe = sanitize(text);
    this.client.raw(`TOPIC ${sanitize(channel)} :${safe}`);
  }

  quiet(channel: string, mask: string): void {
    this.sendMode(channel, '+q', mask);
  }

  /**
   * Raw mode change. Respects ISUPPORT MODES limit by batching.
   * @param channel - Target channel
   * @param modeString - Mode string, e.g. '+oov'
   * @param params - Mode parameters (nicks, masks, etc.)
   */
  mode(channel: string, modeString: string, ...params: string[]): void {
    // If the total params fit in one line, send directly
    if (params.length <= this.modesPerLine) {
      this.sendModeRaw(channel, modeString, params);
      return;
    }

    // Batch: split into groups respecting the modes-per-line limit
    const direction = modeString.charAt(0); // '+' or '-'
    const modeChars = modeString.slice(1).split('');

    for (let i = 0; i < modeChars.length; i += this.modesPerLine) {
      const batchChars = modeChars.slice(i, i + this.modesPerLine);
      const batchParams = params.slice(i, i + this.modesPerLine);
      this.sendModeRaw(channel, direction + batchChars.join(''), batchParams);
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private sendMode(channel: string, mode: string, param: string): void {
    if (this.client.mode) {
      this.client.mode(channel, mode, param);
    } else {
      this.client.raw(`MODE ${sanitize(channel)} ${mode} ${sanitize(param)}`);
    }
  }

  private sendModeRaw(channel: string, modeString: string, params: string[]): void {
    const safeChannel = sanitize(channel);
    const safeParams = params.map((p) => sanitize(p));
    const line =
      safeParams.length > 0
        ? `MODE ${safeChannel} ${modeString} ${safeParams.join(' ')}`
        : `MODE ${safeChannel} ${modeString}`;
    this.client.raw(line);
  }

  private logMod(
    action: string,
    channel: string,
    target: string,
    by: string,
    reason: string | null,
  ): void {
    if (this.db) {
      try {
        this.db.logModAction(action, channel, target, by, reason);
      } catch (err) {
        this.logger?.error('Failed to log mod action:', err);
      }
    }
  }
}
