// HexBot — Command router
// Parses command strings and dispatches to registered handlers.
// Transport-agnostic — works with REPL, IRC, or any future input source.
import type { DCCSessionEntry } from './core/dcc';
import type { HandlerContext } from './types';
import { formatTable } from './utils/table';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to command handlers. */
export interface CommandContext {
  source: 'repl' | 'irc' | 'dcc' | 'botlink';
  nick: string;
  ident?: string;
  hostname?: string;
  channel: string | null;
  /**
   * Services account name from the triggering event's IRCv3 account-tag.
   * Carried through from the bridge so `$a:` patterns resolve on the first
   * command after a nick change, before channel-state gets its next
   * account-notify update. `undefined` means "no account-tag on this
   * event"; `null` means "server confirmed the nick is not identified".
   */
  account?: string | null;
  /**
   * When the command arrived over DCC, the session that sent it. Set by
   * {@link DCCSession.onLine}; undefined for every other transport. Used
   * by DCC-only commands (e.g. `.console`) to reach per-session state.
   */
  dccSession?: DCCSessionEntry;
  reply(msg: string): void;
}

/** Permission checker interface for flag enforcement. */
export interface CommandPermissionsProvider {
  checkFlags(requiredFlags: string, ctx: HandlerContext): boolean;
}

/** Options for registering a command. */
export interface CommandOptions {
  flags: string;
  description: string;
  usage: string;
  category: string;
  /** If true, leaf bots relay this command to the hub for execution (bot-link). */
  relayToHub?: boolean;
}

/** Signature for command handler functions. */
export type CommandHandlerFn = (args: string, ctx: CommandContext) => void | Promise<void>;

/** Minimal command execution interface for consumers that only run commands. */
export interface CommandExecutor {
  execute(commandString: string, ctx: CommandContext): Promise<void>;
}

/** A registered command entry. */
export interface CommandEntry {
  name: string;
  options: CommandOptions;
  handler: CommandHandlerFn;
}

/** Default command prefix when `bot.json` doesn't set one. */
const DEFAULT_COMMAND_PREFIX = '.';

// ---------------------------------------------------------------------------
// CommandHandler
// ---------------------------------------------------------------------------

/** Pre-execute hook signature. Return true if the command was handled (e.g., relayed to hub). */
export type PreExecuteHook = (
  entry: CommandEntry,
  args: string,
  ctx: CommandContext,
) => Promise<boolean>;

export class CommandHandler {
  private commands: Map<string, CommandEntry> = new Map();
  private permissions: CommandPermissionsProvider | null;
  private preExecuteHook: PreExecuteHook | null = null;
  /**
   * Active command prefix. Configurable via `config.command_prefix` so
   * operators can side-step the `.` default on networks where it collides
   * with chit-chat in REPL/DCC input. A single-character prefix is the
   * common case but the parser accepts any non-empty string.
   */
  private readonly prefix: string;

  constructor(permissions?: CommandPermissionsProvider | null, commandPrefix?: string) {
    this.permissions = permissions ?? null;
    this.prefix =
      commandPrefix && commandPrefix.length > 0 ? commandPrefix : DEFAULT_COMMAND_PREFIX;
    // Register the built-in help command. Usage string uses the configured
    // prefix so `.help`-style docs stay accurate when an operator switches
    // to `!` or `~`.
    this.registerCommand(
      'help',
      {
        flags: '-',
        description: 'List commands or show help for a specific command',
        usage: `${this.prefix}help [command]`,
        category: 'general',
      },
      (args, ctx) => {
        this.handleHelp(args, ctx);
      },
    );
  }

  /** Return the active command prefix. Used by transports to echo usage text. */
  getPrefix(): string {
    return this.prefix;
  }

  /** Register a command. */
  registerCommand(name: string, options: CommandOptions, handler: CommandHandlerFn): void {
    this.commands.set(name.toLowerCase(), { name, options, handler });
  }

  /** Remove a previously registered command. Returns true if it existed. */
  unregisterCommand(name: string): boolean {
    return this.commands.delete(name);
  }

  /** Look up a single command by name. */
  getCommand(name: string): CommandEntry | undefined {
    return this.commands.get(name.toLowerCase());
  }

  /** Set a pre-execute hook for command relay. Returns true if the command was handled. */
  setPreExecuteHook(hook: PreExecuteHook | null): void {
    this.preExecuteHook = hook;
  }

  /** Parse and execute a command string. */
  async execute(commandString: string, ctx: CommandContext): Promise<void> {
    const trimmed = commandString.trim();
    if (!trimmed) return;

    // Must start with the configured command prefix.
    if (!trimmed.startsWith(this.prefix)) return;

    // Parse command name and arguments
    const withoutPrefix = trimmed.substring(this.prefix.length);
    const spaceIdx = withoutPrefix.indexOf(' ');
    const commandName =
      spaceIdx === -1
        ? withoutPrefix.toLowerCase()
        : withoutPrefix.substring(0, spaceIdx).toLowerCase();
    const args = spaceIdx === -1 ? '' : withoutPrefix.substring(spaceIdx + 1).trim();

    if (!commandName) return;

    // Look up the command
    const entry = this.commands.get(commandName);
    if (!entry) {
      ctx.reply(
        `Unknown command: ${this.prefix}${commandName} — type ${this.prefix}help for a list of commands`,
      );
      return;
    }

    // Check permission flags (skip for REPL and botlink — botlink checks on the hub side)
    if (
      ctx.source !== 'repl' &&
      ctx.source !== 'botlink' &&
      entry.options.flags !== '-' &&
      entry.options.flags !== ''
    ) {
      if (!this.permissions) {
        ctx.reply('Permission denied.');
        return;
      }
      const handlerCtx: HandlerContext = {
        nick: ctx.nick,
        ident: ctx.ident ?? '',
        hostname: ctx.hostname ?? '',
        channel: ctx.channel,
        text: '',
        command: commandName,
        args,
        reply: ctx.reply,
        replyPrivate: ctx.reply,
      };
      // Thread the inbound account-tag through to the flag check so `$a:`
      // patterns resolve on the first command after a nick change, before
      // channel-state has received a fresh account-notify for the new nick.
      if (ctx.account !== undefined) handlerCtx.account = ctx.account;
      if (!this.permissions.checkFlags(entry.options.flags, handlerCtx)) {
        ctx.reply('Permission denied.');
        return;
      }
    }

    // Pre-execute hook: relay to hub if configured
    if (entry.options.relayToHub && this.preExecuteHook) {
      const handled = await this.preExecuteHook(entry, args, ctx);
      if (handled) return;
    }

    // Execute the handler
    try {
      const result = entry.handler(args, ctx);
      if (result instanceof Promise) {
        await result;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.reply(`Error: ${message}`);
    }
  }

  /** Get all registered commands. */
  getCommands(): CommandEntry[] {
    return Array.from(this.commands.values());
  }

  /** Get help text for one or all commands. */
  getHelp(commandName?: string): string {
    if (commandName) {
      const entry = this.commands.get(commandName.toLowerCase());
      if (!entry) return `Unknown command: ${commandName}`;
      return `${entry.options.usage} — ${entry.options.description} [flags: ${entry.options.flags}]`;
    }

    // List all commands grouped by category
    const byCategory = new Map<string, CommandEntry[]>();
    for (const entry of this.commands.values()) {
      const cat = entry.options.category;
      let bucket = byCategory.get(cat);
      if (!bucket) {
        bucket = [];
        byCategory.set(cat, bucket);
      }
      bucket.push(entry);
    }

    const lines: string[] = ['Available commands:'];
    for (const [category, entries] of byCategory) {
      lines.push(`  [${category}]`);
      const rows = entries.map((e) => [`${this.prefix}${e.name}`, `— ${e.options.description}`]);
      lines.push(formatTable(rows, { indent: '    ' }));
    }
    lines.push(`Type ${this.prefix}help <command> for details on a specific command.`);
    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Built-in commands
  // -------------------------------------------------------------------------

  private handleHelp(args: string, ctx: CommandContext): void {
    const commandName = args.trim() || undefined;
    ctx.reply(this.getHelp(commandName));
  }
}
