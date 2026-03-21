// n0xb0t — Command router
// Parses command strings and dispatches to registered handlers.
// Transport-agnostic — works with REPL, IRC, or any future input source.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context passed to command handlers. */
export interface CommandContext {
  source: 'repl' | 'irc';
  nick: string;
  channel: string | null;
  reply(msg: string): void;
}

/** Options for registering a command. */
export interface CommandOptions {
  flags: string;
  description: string;
  usage: string;
  category: string;
}

/** Signature for command handler functions. */
export type CommandHandlerFn = (args: string, ctx: CommandContext) => void | Promise<void>;

/** A registered command entry. */
export interface CommandEntry {
  name: string;
  options: CommandOptions;
  handler: CommandHandlerFn;
}

/** Command prefix. */
const COMMAND_PREFIX = '.';

// ---------------------------------------------------------------------------
// CommandHandler
// ---------------------------------------------------------------------------

export class CommandHandler {
  private commands: Map<string, CommandEntry> = new Map();

  constructor() {
    // Register the built-in .help command
    this.registerCommand('help', {
      flags: '-',
      description: 'List commands or show help for a specific command',
      usage: '.help [command]',
      category: 'general',
    }, (args, ctx) => {
      this.handleHelp(args, ctx);
    });
  }

  /** Register a command. */
  registerCommand(name: string, options: CommandOptions, handler: CommandHandlerFn): void {
    this.commands.set(name.toLowerCase(), { name, options, handler });
  }

  /** Parse and execute a command string. */
  async execute(commandString: string, ctx: CommandContext): Promise<void> {
    const trimmed = commandString.trim();
    if (!trimmed) return;

    // Must start with command prefix
    if (!trimmed.startsWith(COMMAND_PREFIX)) return;

    // Parse command name and arguments
    const withoutPrefix = trimmed.substring(COMMAND_PREFIX.length);
    const spaceIdx = withoutPrefix.indexOf(' ');
    const commandName = spaceIdx === -1
      ? withoutPrefix.toLowerCase()
      : withoutPrefix.substring(0, spaceIdx).toLowerCase();
    const args = spaceIdx === -1 ? '' : withoutPrefix.substring(spaceIdx + 1).trim();

    if (!commandName) return;

    // Look up the command
    const entry = this.commands.get(commandName);
    if (!entry) {
      ctx.reply(`Unknown command: .${commandName} — type .help for a list of commands`);
      return;
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
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(entry);
    }

    const lines: string[] = ['Available commands:'];
    for (const [category, entries] of byCategory) {
      lines.push(`  [${category}]`);
      for (const entry of entries) {
        lines.push(`    .${entry.name} — ${entry.options.description}`);
      }
    }
    lines.push('Type .help <command> for details on a specific command.');
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
