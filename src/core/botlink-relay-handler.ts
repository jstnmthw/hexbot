// HexBot — Bot link relay frame handler
// Extracted from bot.ts for testability. Handles incoming RELAY_* frames
// that create and manage virtual relay sessions between linked bots.
import type { CommandContext } from '../command-handler';
import type { Logger } from '../logger';
import type { stripFormatting as StripFormattingFn } from '../utils/strip-formatting';
import type { LinkFrame } from './botlink-protocol';
import type { DCCSessionEntry } from './dcc';

/** Minimal command executor — just the .execute() method. */
export interface RelayCommandExecutor {
  execute(commandString: string, ctx: CommandContext): Promise<void>;
}

/** Minimal permissions lookup for relay — getUser by handle. */
export interface RelayPermissionsProvider {
  getUser(handle: string): { hostmasks: string[] } | null;
}

/** Minimal DCC view for relay — session listing, lookup, and announcement. */
export interface RelayDCCView {
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  getSession(
    nick: string,
  ): Pick<DCCSessionEntry, 'writeLine' | 'isRelaying' | 'exitRelay' | 'confirmRelay'> | undefined;
  announce(message: string): void;
}

/** Callback to send a frame to a specific bot or to broadcast. */
export interface RelaySender {
  /** Send a frame to a specific bot (hub.send). Returns false if bot not found. */
  sendTo(botname: string, frame: LinkFrame): boolean;
  /** Send a frame via the default path (leaf.send or hub.broadcast). */
  send(frame: LinkFrame): void;
}

export interface RelayHandlerDeps {
  permissions: RelayPermissionsProvider;
  commandHandler: RelayCommandExecutor;
  dccManager: RelayDCCView | null;
  botname: string;
  sender: RelaySender;
  stripFormatting: typeof StripFormattingFn;
  logger?: Logger | null;
}

/** Per-handle virtual session state tracked on the target bot. */
export interface RelayVirtualSession {
  fromBot: string;
  sendOutput: (line: string) => void;
}

/** Map of handle -> virtual session, keyed by relay handle. */
export type RelaySessionMap = Map<string, RelayVirtualSession>;

/**
 * Handle an incoming RELAY_* frame.
 * Manages virtual relay sessions, command execution, and party line chat
 * for relayed DCC users across the bot link.
 *
 * Mutates `sessions` in place (adds/removes virtual sessions).
 */
export function handleRelayFrame(
  frame: LinkFrame,
  deps: RelayHandlerDeps,
  sessions: RelaySessionMap,
): void {
  const handle = String(frame.handle ?? '');
  const log = deps.logger;

  if (frame.type === 'RELAY_REQUEST') {
    // This bot is the target — create a virtual relay session.
    // Works even without a local DCC manager: the target executes commands via
    // the command handler and streams output back as RELAY_OUTPUT frames.
    const fromBot = String(frame.fromBot ?? '');
    const user = deps.permissions.getUser(handle);
    if (!user) {
      log?.warn(`RELAY_REQUEST from "${fromBot}" for unknown handle "${handle}" — rejecting`);
      deps.sender.sendTo(fromBot, {
        type: 'RELAY_END',
        handle,
        reason: 'User not found',
      });
      return;
    }
    log?.info(`RELAY_REQUEST accepted: "${fromBot}" → "${deps.botname}" for handle "${handle}"`);
    deps.sender.sendTo(fromBot, { type: 'RELAY_ACCEPT', handle, toBot: deps.botname });

    sessions.set(handle, {
      fromBot,
      sendOutput: (line: string) => {
        deps.sender.sendTo(fromBot, { type: 'RELAY_OUTPUT', handle, line });
      },
    });
    return;
  }

  if (frame.type === 'RELAY_ACCEPT' && deps.dccManager) {
    // This bot is the origin — the target bot accepted the relay request.
    const toBot = String(frame.toBot ?? '');
    log?.info(`RELAY_ACCEPT received: relay to "${toBot}" for handle "${handle}"`);
    for (const s of deps.dccManager.getSessionList()) {
      if (s.handle === handle) {
        deps.dccManager.getSession(s.nick)?.confirmRelay?.();
      }
    }
    return;
  }

  if (frame.type === 'RELAY_INPUT') {
    const vs = sessions.get(handle);
    if (!vs) {
      log?.debug(`RELAY_INPUT dropped: no virtual session for handle "${handle}"`);
      return;
    }
    const line = String(frame.line ?? '');
    if (line.startsWith('.')) {
      log?.debug(`RELAY_INPUT "${handle}": ${line}`);
      const user = deps.permissions.getUser(handle);
      deps.commandHandler
        .execute(line, {
          source: 'botlink',
          nick: user?.hostmasks[0]?.split('!')[0] || handle,
          ident: 'relay',
          hostname: 'relay',
          channel: null,
          reply: (msg: string) => {
            for (const part of msg.split('\n')) vs.sendOutput(part);
          },
        })
        .catch((err) => {
          log?.warn(`RELAY_INPUT command error for handle "${handle}": ${String(err)}`);
        });
    } else {
      // Party line chat from relayed user — strip formatting to prevent injection
      const safeHandle = deps.stripFormatting(handle);
      const safeLine = deps.stripFormatting(line);
      if (deps.dccManager) {
        deps.dccManager.announce(`<${safeHandle}@relay> ${safeLine}`);
      }
      vs.sendOutput(`<${safeHandle}> ${safeLine}`);
    }
    return;
  }

  if (frame.type === 'RELAY_OUTPUT' && deps.dccManager) {
    // This bot is the origin — display output to the DCC session
    for (const session of deps.dccManager.getSessionList()) {
      if (session.handle === handle) {
        const dccSession = deps.dccManager.getSession(session.nick);
        dccSession?.writeLine(String(frame.line ?? ''));
      }
    }
    return;
  }

  if (frame.type === 'RELAY_END') {
    const reason = String(frame.reason ?? 'remote bot');
    // Clean up virtual session if we're the target
    if (sessions.delete(handle)) {
      log?.info(`RELAY_END for handle "${handle}" (target side): ${reason}`);
    }
    // Exit relay mode if we're the origin
    if (deps.dccManager) {
      for (const s of deps.dccManager.getSessionList()) {
        if (s.handle === handle) {
          const session = deps.dccManager.getSession(s.nick);
          if (session?.isRelaying) {
            log?.info(`RELAY_END for handle "${handle}" (origin side): ${reason}`);
            session.exitRelay();
            session.writeLine(`*** Relay ended: ${reason}`);
          }
        }
      }
    }
  }
}
