// HexBot — Command router
// Parses command strings and dispatches to registered handlers.
// Transport-agnostic — works with REPL, IRC, or any future input source.
import type { DCCSessionEntry } from './core/dcc';
import { HelpRegistry } from './core/help-registry';
import {
  type RenderPermissions,
  lookup,
  renderCategory,
  renderCommand,
  renderIndex,
  renderScope,
} from './core/help-render';
import type { HandlerContext, HelpEntry } from './types';

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
  /**
   * Resolved `UserRecord.handle` when the triggering nick matched a
   * permission record (populated by {@link CommandHandler.execute} via the
   * flag check). Audit-actor code prefers this over `ctx.nick` so `.mod_log`
   * rows identify the user by their stable handle rather than whatever
   * nick they happened to be using.
   *
   * Unset for REPL (`ctx.nick` is the owner/operator label) and botlink
   * (the hub already resolved the handle before relay).
   */
  handle?: string;
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
  /**
   * Shared help corpus. Every {@link registerCommand} call mirrors its
   * options into the registry under the reserved `'core'` pluginId so
   * a single `!help` / `.help` view spans plugin commands and core
   * dot-commands. Bot wires the shared instance in production; tests
   * that don't pass one get a private auto-instantiated registry — same
   * code path either way.
   */
  private readonly helpRegistry: HelpRegistry;

  constructor(
    permissions?: CommandPermissionsProvider | null,
    commandPrefix?: string,
    helpRegistry?: HelpRegistry,
  ) {
    this.permissions = permissions ?? null;
    this.prefix =
      commandPrefix && commandPrefix.length > 0 ? commandPrefix : DEFAULT_COMMAND_PREFIX;
    this.helpRegistry = helpRegistry ?? new HelpRegistry();
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
    const entry: HelpEntry = {
      command: `${this.prefix}${name}`,
      flags: options.flags,
      usage: options.usage,
      description: options.description,
      category: options.category,
    };
    this.helpRegistry.register('core', [entry]);
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

  /**
   * Parse and execute a command string. No-ops silently when the input is
   * empty or missing the configured prefix — this lets transports pipe every
   * inbound line through unconditionally without pre-filtering. Handler
   * exceptions are caught and reported back via `ctx.reply` so one bad
   * command can't take down the caller.
   */
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

    // Order matters: permission check FIRST, relay hook SECOND, local handler
    // THIRD. Reordering would either let the hub side double-check a command
    // we already denied locally (wasted relay frame, confusing audit trail)
    // or let an unprivileged user trigger a hub round-trip purely to be denied.
    if (!this.checkCommandPermissions(entry, commandName, args, ctx)) return;

    if (await this.runPreExecuteHook(entry, args, ctx)) return;

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

  /**
   * Gate a command on its flag string. Returns `true` if execution should
   * proceed, `false` if the caller already replied with a denial. REPL and
   * botlink transports bypass the check entirely: REPL is trusted locally
   * and botlink commands are re-checked on the hub side.
   */
  private checkCommandPermissions(
    entry: CommandEntry,
    commandName: string,
    args: string,
    ctx: CommandContext,
  ): boolean {
    // REPL: trusted local console — only reachable by someone who can already
    // read config/bot.json off disk, so flag enforcement is moot.
    // Botlink: the authenticator is `src/core/botlink/hub-cmd-relay.ts`:
    // `hub-frame-dispatch` checks `permissions.checkFlagsByHandle(fromHandle, …)`
    // plus a live DCC-session proof before emitting a `source:'botlink'`
    // frame. Re-checking here would double-deny against the relay actor's
    // hostmask, which never matches. Do not relax that hub-side gate without
    // tightening this one — see docs/SECURITY.md §11 for the trust-boundary
    // rationale.
    if (ctx.source === 'repl' || ctx.source === 'botlink') return true;
    if (entry.options.flags === '-' || entry.options.flags === '') return true;

    if (!this.permissions) {
      ctx.reply('Permission denied.');
      return false;
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
    // Resolve the user record so the audit actor can attribute the action
    // to the stable handle instead of whatever nick happened to trigger it.
    // Best-effort: not every permissions implementation exposes
    // findByHostmask — fall back to ctx.nick when it's missing or no record
    // matches. Typed through a narrow interface so plugin-test doubles keep
    // working without implementing the full Permissions API.
    const resolver = this.permissions as CommandPermissionsProvider & {
      findByHostmask?: (mask: string, account?: string | null) => { handle: string } | null;
    };
    if (typeof resolver.findByHostmask === 'function' && ctx.ident && ctx.hostname) {
      const record = resolver.findByHostmask(
        `${ctx.nick}!${ctx.ident}@${ctx.hostname}`,
        ctx.account ?? null,
      );
      if (record) ctx.handle = record.handle;
    }
    if (!this.permissions.checkFlags(entry.options.flags, handlerCtx)) {
      ctx.reply('Permission denied.');
      return false;
    }
    return true;
  }

  /**
   * Relay the command to the hub when the leaf has a hook installed and the
   * command is flagged `relayToHub`. Returns `true` when the hook absorbed the
   * command and execution should short-circuit locally.
   */
  private async runPreExecuteHook(
    entry: CommandEntry,
    args: string,
    ctx: CommandContext,
  ): Promise<boolean> {
    if (!entry.options.relayToHub || !this.preExecuteHook) return false;
    return this.preExecuteHook(entry, args, ctx);
  }

  /** Get all registered commands. */
  getCommands(): CommandEntry[] {
    return Array.from(this.commands.values());
  }

  // -------------------------------------------------------------------------
  // Built-in commands
  // -------------------------------------------------------------------------

  private handleHelp(args: string, ctx: CommandContext): void {
    // Bridge the CommandContext into the HandlerContext shape the renderer's
    // permissions check expects. REPL and botlink are trusted transports —
    // pass `null` perms so every entry is visible (matches the bypass at
    // checkCommandPermissions).
    const handlerCtx: HandlerContext = {
      nick: ctx.nick,
      ident: ctx.ident ?? '',
      hostname: ctx.hostname ?? '',
      channel: ctx.channel,
      text: '',
      command: 'help',
      args,
      reply: ctx.reply,
      replyPrivate: ctx.reply,
    };
    if (ctx.account !== undefined) handlerCtx.account = ctx.account;
    const renderPerms: RenderPermissions | null =
      ctx.source === 'repl' || ctx.source === 'botlink' ? null : this.permissions;

    const arg = args.trim();
    if (arg) {
      const result = lookup(this.helpRegistry, arg, handlerCtx, renderPerms);
      switch (result.kind) {
        case 'command':
          ctx.reply(renderCommand(result.entry).join('\n'));
          return;
        case 'category':
          ctx.reply(renderCategory(result.category, result.entries).join('\n'));
          return;
        case 'scope':
          ctx.reply(
            renderScope(result.scope, result.header, result.entries, this.prefix).join('\n'),
          );
          return;
        case 'denied':
        case 'none':
          ctx.reply(`No help for "${arg}" — type ${this.prefix}help for a list of commands`);
          return;
      }
      return;
    }

    // Bare-index render. Verbose mode (compact: false) so the trusted
    // operator console gets the categorised listing operators expect.
    const visibleEntries =
      renderPerms === null
        ? this.helpRegistry.getAll()
        : this.helpRegistry
            .getAll()
            .filter((e) => e.flags === '-' || renderPerms.checkFlags(e.flags, handlerCtx));
    const lines = renderIndex(visibleEntries, {
      compact: false,
      header: 'Available commands',
      footer: `Type ${this.prefix}help <command> for details on a specific command.`,
      prefix: this.prefix,
    });
    ctx.reply(lines.join('\n'));
  }
}
