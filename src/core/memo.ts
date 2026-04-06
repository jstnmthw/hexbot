// HexBot — Memo / Notes system
//
// Three layers:
// 1. MemoServ relay — forward MemoServ notices to online owners/masters
// 2. Internal notes — .note/.notes/.readnote/.delnote via DCC/REPL
// 3. Public IRC commands — !memo/!memos/!read/!delmemo in channel (m/n flags)
//
// Only users with n (owner) or m (master) flags can send/receive notes.
// Notes are stored in the _memo KV namespace with auto-incrementing IDs.
import type { CommandContext, CommandHandler } from '../command-handler';
import type { BotDatabase } from '../database';
import type { EventDispatcher } from '../dispatcher';
import type { Logger } from '../logger';
import type { Casemapping, HandlerContext, MemoConfig } from '../types';
import { ircLower } from '../utils/wildcard';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StoredNote {
  id: number;
  from: string; // sender handle (or "MemoServ")
  to: string; // recipient handle
  message: string;
  timestamp: number; // Date.now()
  read: boolean;
}

/** Minimal IRC client interface for sending NOTICE. */
export interface MemoIRCClient {
  notice(target: string, message: string): void;
}

/** Minimal DCC manager interface for console delivery. */
export interface MemoDCCManager {
  announce(message: string): void;
  getSessionList(): Array<{ handle: string; nick: string; connectedAt: number }>;
  getSession(nick: string): { writeLine(line: string): void } | undefined;
}

/** Minimal channel state interface for finding online users. */
export interface MemoChannelState {
  getAllChannels(): Array<{ name: string; users: Map<string, { hostmask: string }> }>;
}

/** Minimal permissions interface for handle/flag lookups. */
export interface MemoPermissions {
  getUser(handle: string): { handle: string; global: string } | null;
  findByHostmask(fullHostmask: string): { handle: string; global: string } | null;
  listUsers(): Array<{ handle: string; global: string }>;
}

export interface MemoDeps {
  db: BotDatabase;
  config?: MemoConfig;
  dispatcher: EventDispatcher;
  commandHandler: CommandHandler;
  permissions: MemoPermissions;
  channelState: MemoChannelState;
  client: MemoIRCClient;
  logger?: Logger | null;
  dccManager?: MemoDCCManager | null;
}

// ---------------------------------------------------------------------------
// Constants / defaults
// ---------------------------------------------------------------------------

const NAMESPACE = '_memo';
const SEQ_KEY = 'seq';
const NOTE_PREFIX = 'note:';

const DEFAULTS: Required<MemoConfig> = {
  memoserv_relay: true,
  memoserv_nick: 'MemoServ',
  max_notes_per_user: 50,
  max_note_length: 400,
  max_age_days: 90,
  delivery_cooldown_seconds: 60,
};

const OWNER_ID = 'core:memo';

/** One hour in ms — expiry sweep interval. */
const EXPIRY_INTERVAL_MS = 3_600_000;

// ---------------------------------------------------------------------------
// MemoManager
// ---------------------------------------------------------------------------

export class MemoManager {
  private db: BotDatabase;
  private config: Required<MemoConfig>;
  private dispatcher: EventDispatcher;
  private commandHandler: CommandHandler;
  private permissions: MemoPermissions;
  private channelState: MemoChannelState;
  private client: MemoIRCClient;
  private logger: Logger | null;
  private dccManager: MemoDCCManager | null;
  private casemapping: Casemapping = 'rfc1459';

  /** Per-handle cooldown for join-delivery notifications. */
  private deliveryCooldown = new Map<string, number>();
  /** Expiry sweep timer. */
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MemoDeps) {
    this.db = deps.db;
    this.config = { ...DEFAULTS, ...deps.config };
    this.dispatcher = deps.dispatcher;
    this.commandHandler = deps.commandHandler;
    this.permissions = deps.permissions;
    this.channelState = deps.channelState;
    this.client = deps.client;
    this.logger = deps.logger?.child('memo') ?? null;
    this.dccManager = deps.dccManager ?? null;
  }

  /** Update casemapping when the server announces it. */
  setCasemapping(cm: Casemapping): void {
    this.casemapping = cm;
  }

  /** Set or replace the DCC manager reference (wired after DCC init). */
  setDCCManager(dcc: MemoDCCManager): void {
    this.dccManager = dcc;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Register all binds and commands. */
  attach(): void {
    this.registerDotCommands();
    this.registerIRCCommands();
    if (this.config.memoserv_relay) {
      this.registerMemoServRelay();
    }
    this.registerJoinDelivery();

    // Start expiry sweep if max_age_days > 0
    if (this.config.max_age_days > 0) {
      this.expiryTimer = setInterval(() => this.sweepExpired(), EXPIRY_INTERVAL_MS);
    }

    this.logger?.info('Memo system attached');
  }

  /** Clean up timers and state. */
  detach(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.deliveryCooldown.clear();
    this.logger?.info('Memo system detached');
  }

  // -------------------------------------------------------------------------
  // Note CRUD (DB layer)
  // -------------------------------------------------------------------------

  private nextId(): number {
    const raw = this.db.get(NAMESPACE, SEQ_KEY);
    const next = (raw ? parseInt(raw, 10) : 0) + 1;
    this.db.set(NAMESPACE, SEQ_KEY, String(next));
    return next;
  }

  /** Store a note. Returns the note ID, or null if the mailbox is full or message too long. */
  storeNote(from: string, to: string, message: string): { id: number } | { error: string } {
    if (message.length > this.config.max_note_length) {
      return { error: `Message too long (max ${this.config.max_note_length} characters)` };
    }
    const recipientNotes = this.listNotesForHandle(to);
    if (recipientNotes.length >= this.config.max_notes_per_user) {
      return { error: `Mailbox full for ${to} (max ${this.config.max_notes_per_user} notes)` };
    }

    const id = this.nextId();
    const note: StoredNote = {
      id,
      from,
      to,
      message,
      timestamp: Date.now(),
      read: false,
    };
    this.db.set(NAMESPACE, `${NOTE_PREFIX}${id}`, note);
    return { id };
  }

  /** Get a note by ID. Returns null if not found. */
  getNote(id: number): StoredNote | null {
    const raw = this.db.get(NAMESPACE, `${NOTE_PREFIX}${id}`);
    if (!raw) return null;
    return JSON.parse(raw) as StoredNote;
  }

  /** Mark a note as read. */
  markRead(id: number): boolean {
    const note = this.getNote(id);
    if (!note) return false;
    note.read = true;
    this.db.set(NAMESPACE, `${NOTE_PREFIX}${id}`, note);
    return true;
  }

  /** Delete a note by ID. Returns true if it existed. */
  deleteNote(id: number): boolean {
    const note = this.getNote(id);
    if (!note) return false;
    this.db.del(NAMESPACE, `${NOTE_PREFIX}${id}`);
    return true;
  }

  /** List all notes for a recipient handle. */
  listNotesForHandle(handle: string): StoredNote[] {
    const rows = this.db.list(NAMESPACE, NOTE_PREFIX);
    const notes: StoredNote[] = [];
    for (const row of rows) {
      const note = JSON.parse(row.value) as StoredNote;
      if (note.to.toLowerCase() === handle.toLowerCase()) {
        notes.push(note);
      }
    }
    return notes.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Count unread notes for a handle. */
  countUnread(handle: string): number {
    return this.listNotesForHandle(handle).filter((n) => !n.read).length;
  }

  /** Delete all notes for a handle. Returns the count deleted. */
  deleteAllForHandle(handle: string): number {
    const notes = this.listNotesForHandle(handle);
    for (const note of notes) {
      this.db.del(NAMESPACE, `${NOTE_PREFIX}${note.id}`);
    }
    return notes.length;
  }

  /** Sweep notes older than max_age_days. */
  sweepExpired(): number {
    if (this.config.max_age_days <= 0) return 0;
    const cutoff = Date.now() - this.config.max_age_days * 86_400_000;
    const rows = this.db.list(NAMESPACE, NOTE_PREFIX);
    let swept = 0;
    for (const row of rows) {
      const note = JSON.parse(row.value) as StoredNote;
      if (note.timestamp < cutoff) {
        this.db.del(NAMESPACE, row.key);
        swept++;
      }
    }
    if (swept > 0) {
      this.logger?.debug(`Expired ${swept} note(s) older than ${this.config.max_age_days} days`);
    }
    return swept;
  }

  // -------------------------------------------------------------------------
  // Handle validation
  // -------------------------------------------------------------------------

  /** Check if a handle exists and has n or m flags. */
  private isAdminHandle(handle: string): boolean {
    const user = this.permissions.getUser(handle);
    if (!user) return false;
    return user.global.includes('n') || user.global.includes('m');
  }

  /** Resolve a nick to a handle using channel state + permissions. */
  private resolveNickToHandle(nick: string): string | null {
    for (const ch of this.channelState.getAllChannels()) {
      for (const user of ch.users.values()) {
        if (
          ircLower(user.hostmask.split('!')[0], this.casemapping) ===
          ircLower(nick, this.casemapping)
        ) {
          const record = this.permissions.findByHostmask(user.hostmask);
          if (record) return record.handle;
        }
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // MemoServ relay (Phase 1)
  // -------------------------------------------------------------------------

  private registerMemoServRelay(): void {
    this.dispatcher.bind(
      'notice',
      '-',
      '*',
      (ctx: HandlerContext) => {
        // Only private notices (not channel notices)
        if (ctx.channel) return;
        // Match sender nick against configured MemoServ nick
        if (
          ircLower(ctx.nick, this.casemapping) !==
          ircLower(this.config.memoserv_nick, this.casemapping)
        )
          return;

        const message = ctx.text;
        this.logger?.info(`MemoServ relay: ${message}`);

        // Store as a note from MemoServ to all admin handles
        this.storeMemoServMessage(message);

        // Forward to online admins via NOTICE
        this.relayToOnlineAdmins(`[MemoServ] ${message}`);

        // Forward to DCC console
        if (this.dccManager) {
          this.dccManager.announce(`*** [MemoServ] ${message}`);
        }
      },
      OWNER_ID,
    );
  }

  /** Store a MemoServ message as a note to each admin handle. */
  private storeMemoServMessage(message: string): void {
    const admins = this.permissions
      .listUsers()
      .filter((u) => u.global.includes('n') || u.global.includes('m'));
    for (const admin of admins) {
      this.storeNote('MemoServ', admin.handle, message);
    }
  }

  /** Send a NOTICE to all online users with n/m flags. */
  private relayToOnlineAdmins(message: string): void {
    const seen = new Set<string>();
    for (const ch of this.channelState.getAllChannels()) {
      for (const user of ch.users.values()) {
        const record = this.permissions.findByHostmask(user.hostmask);
        if (!record) continue;
        if (!(record.global.includes('n') || record.global.includes('m'))) continue;
        const key = record.handle.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        this.client.notice(user.hostmask.split('!')[0], message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // DCC/REPL dot-commands (Phase 2)
  // -------------------------------------------------------------------------

  private registerDotCommands(): void {
    // .note <handle> <message>
    this.commandHandler.registerCommand(
      'note',
      {
        flags: '+m|+n',
        description: 'Send a note to an admin',
        usage: '.note <handle> <message>',
        category: 'memo',
      },
      (args, ctx) => this.handleDotNote(args, ctx),
    );

    // .notes — list unread notes
    this.commandHandler.registerCommand(
      'notes',
      {
        flags: '+m|+n',
        description: 'List your unread notes',
        usage: '.notes',
        category: 'memo',
      },
      (args, ctx) => this.handleDotNotes(args, ctx),
    );

    // .readnote <id> — read a note and mark as read
    this.commandHandler.registerCommand(
      'readnote',
      {
        flags: '+m|+n',
        description: 'Read a note and mark it as read',
        usage: '.readnote <id>',
        category: 'memo',
      },
      (args, ctx) => this.handleDotReadNote(args, ctx),
    );

    // .delnote <id|all> — delete note(s)
    this.commandHandler.registerCommand(
      'delnote',
      {
        flags: '+m|+n',
        description: 'Delete a note or all your notes',
        usage: '.delnote <id|all>',
        category: 'memo',
      },
      (args, ctx) => this.handleDotDelNote(args, ctx),
    );

    // .notes-purge [handle] — owner-only purge
    this.commandHandler.registerCommand(
      'notes-purge',
      {
        flags: '+n',
        description: 'Purge notes for a handle (owner only)',
        usage: '.notes-purge <handle>',
        category: 'memo',
      },
      (args, ctx) => this.handleDotNotesPurge(args, ctx),
    );
  }

  /** Resolve the calling user's handle from CommandContext. */
  private resolveCallerHandle(ctx: CommandContext): string | null {
    if (ctx.source === 'dcc' || ctx.source === 'repl') {
      // DCC/REPL sessions are authenticated — nick is the handle
      return ctx.nick;
    }
    // IRC — resolve from hostmask
    if (ctx.ident && ctx.hostname) {
      const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
      const record = this.permissions.findByHostmask(hostmask);
      return record?.handle ?? null;
    }
    return null;
  }

  private handleDotNote(args: string, ctx: CommandContext): void {
    const parts = args.trim().split(/\s+/);
    if (parts.length < 2) {
      ctx.reply('Usage: .note <handle> <message>');
      return;
    }
    const targetHandle = parts[0];
    const message = args.trim().substring(targetHandle.length).trim();

    if (!this.isAdminHandle(targetHandle)) {
      ctx.reply(`No admin handle "${targetHandle}" found.`);
      return;
    }

    const callerHandle = this.resolveCallerHandle(ctx);
    if (!callerHandle) {
      ctx.reply('Cannot determine your handle.');
      return;
    }

    const result = this.storeNote(callerHandle, targetHandle, message);
    if ('error' in result) {
      ctx.reply(result.error);
    } else {
      ctx.reply(`Note #${result.id} sent to ${targetHandle}.`);
    }
  }

  private handleDotNotes(_args: string, ctx: CommandContext): void {
    const handle = this.resolveCallerHandle(ctx);
    if (!handle) {
      ctx.reply('Cannot determine your handle.');
      return;
    }

    const notes = this.listNotesForHandle(handle).filter((n) => !n.read);
    if (notes.length === 0) {
      ctx.reply('No unread notes.');
      return;
    }

    ctx.reply(`You have ${notes.length} unread note(s):`);
    for (const note of notes) {
      const date = new Date(note.timestamp).toISOString().replace('T', ' ').substring(0, 19);
      const preview =
        note.message.length > 80 ? note.message.substring(0, 77) + '...' : note.message;
      ctx.reply(`  #${note.id} from ${note.from} [${date}]: ${preview}`);
    }
  }

  private handleDotReadNote(args: string, ctx: CommandContext): void {
    const id = parseInt(args.trim(), 10);
    if (isNaN(id)) {
      ctx.reply('Usage: .readnote <id>');
      return;
    }

    const handle = this.resolveCallerHandle(ctx);
    if (!handle) {
      ctx.reply('Cannot determine your handle.');
      return;
    }

    const note = this.getNote(id);
    if (!note || note.to.toLowerCase() !== handle.toLowerCase()) {
      ctx.reply(`Note #${id} not found.`);
      return;
    }

    this.markRead(id);
    const date = new Date(note.timestamp).toISOString().replace('T', ' ').substring(0, 19);
    ctx.reply(`Note #${note.id} from ${note.from} [${date}]:`);
    ctx.reply(note.message);
  }

  private handleDotDelNote(args: string, ctx: CommandContext): void {
    const handle = this.resolveCallerHandle(ctx);
    if (!handle) {
      ctx.reply('Cannot determine your handle.');
      return;
    }

    const arg = args.trim().toLowerCase();
    if (arg === 'all') {
      const count = this.deleteAllForHandle(handle);
      ctx.reply(`Deleted ${count} note(s).`);
      return;
    }

    const id = parseInt(arg, 10);
    if (isNaN(id)) {
      ctx.reply('Usage: .delnote <id|all>');
      return;
    }

    const note = this.getNote(id);
    if (!note || note.to.toLowerCase() !== handle.toLowerCase()) {
      ctx.reply(`Note #${id} not found.`);
      return;
    }

    this.deleteNote(id);
    ctx.reply(`Note #${id} deleted.`);
  }

  private handleDotNotesPurge(args: string, ctx: CommandContext): void {
    const targetHandle = args.trim();
    if (!targetHandle) {
      ctx.reply('Usage: .notes-purge <handle>');
      return;
    }

    const user = this.permissions.getUser(targetHandle);
    if (!user) {
      ctx.reply(`Unknown handle "${targetHandle}".`);
      return;
    }

    const count = this.deleteAllForHandle(user.handle);
    ctx.reply(`Purged ${count} note(s) for ${user.handle}.`);
  }

  // -------------------------------------------------------------------------
  // Public IRC commands (Phase 3)
  // -------------------------------------------------------------------------

  private registerIRCCommands(): void {
    // !memo <handle|nick> <message>
    this.dispatcher.bind(
      'pub',
      '+m|+n',
      '!memo',
      (ctx: HandlerContext) => this.handlePubMemo(ctx),
      OWNER_ID,
    );

    // !memos — list unread notes
    this.dispatcher.bind(
      'pub',
      '+m|+n',
      '!memos',
      (ctx: HandlerContext) => this.handlePubMemos(ctx),
      OWNER_ID,
    );

    // !read <id> — read a note
    this.dispatcher.bind(
      'pub',
      '+m|+n',
      '!read',
      (ctx: HandlerContext) => this.handlePubRead(ctx),
      OWNER_ID,
    );

    // !delmemo <id|all> — delete note(s)
    this.dispatcher.bind(
      'pub',
      '+m|+n',
      '!delmemo',
      (ctx: HandlerContext) => this.handlePubDelMemo(ctx),
      OWNER_ID,
    );
  }

  /** Resolve the IRC caller's handle from HandlerContext. */
  private resolveIRCHandle(ctx: HandlerContext): string | null {
    const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
    const record = this.permissions.findByHostmask(hostmask);
    return record?.handle ?? null;
  }

  private handlePubMemo(ctx: HandlerContext): void {
    const parts = ctx.args.trim().split(/\s+/);
    if (parts.length < 2) {
      ctx.replyPrivate('Usage: !memo <handle|nick> <message>');
      return;
    }
    const target = parts[0];
    const message = ctx.args.trim().substring(target.length).trim();

    // Try as handle first, then resolve nick → handle
    let targetHandle: string | null = null;
    if (this.isAdminHandle(target)) {
      targetHandle = this.permissions.getUser(target)!.handle;
    } else {
      const resolved = this.resolveNickToHandle(target);
      if (resolved && this.isAdminHandle(resolved)) {
        targetHandle = resolved;
      }
    }

    if (!targetHandle) {
      ctx.replyPrivate(`No admin handle found for "${target}".`);
      return;
    }

    const callerHandle = this.resolveIRCHandle(ctx);
    if (!callerHandle) {
      ctx.replyPrivate('Cannot determine your handle.');
      return;
    }

    const result = this.storeNote(callerHandle, targetHandle, message);
    if ('error' in result) {
      ctx.replyPrivate(result.error);
    } else {
      ctx.replyPrivate(`Note #${result.id} sent to ${targetHandle}.`);
    }
  }

  private handlePubMemos(ctx: HandlerContext): void {
    const handle = this.resolveIRCHandle(ctx);
    if (!handle) {
      ctx.replyPrivate('Cannot determine your handle.');
      return;
    }

    const notes = this.listNotesForHandle(handle).filter((n) => !n.read);
    if (notes.length === 0) {
      ctx.replyPrivate('No unread notes.');
      return;
    }

    ctx.replyPrivate(`You have ${notes.length} unread note(s):`);
    for (const note of notes) {
      const date = new Date(note.timestamp).toISOString().replace('T', ' ').substring(0, 19);
      const preview =
        note.message.length > 80 ? note.message.substring(0, 77) + '...' : note.message;
      ctx.replyPrivate(`  #${note.id} from ${note.from} [${date}]: ${preview}`);
    }
  }

  private handlePubRead(ctx: HandlerContext): void {
    const id = parseInt(ctx.args.trim(), 10);
    if (isNaN(id)) {
      ctx.replyPrivate('Usage: !read <id>');
      return;
    }

    const handle = this.resolveIRCHandle(ctx);
    if (!handle) {
      ctx.replyPrivate('Cannot determine your handle.');
      return;
    }

    const note = this.getNote(id);
    if (!note || note.to.toLowerCase() !== handle.toLowerCase()) {
      ctx.replyPrivate(`Note #${id} not found.`);
      return;
    }

    this.markRead(id);
    const date = new Date(note.timestamp).toISOString().replace('T', ' ').substring(0, 19);
    ctx.replyPrivate(`Note #${note.id} from ${note.from} [${date}]:`);
    ctx.replyPrivate(note.message);
  }

  private handlePubDelMemo(ctx: HandlerContext): void {
    const handle = this.resolveIRCHandle(ctx);
    if (!handle) {
      ctx.replyPrivate('Cannot determine your handle.');
      return;
    }

    const arg = ctx.args.trim().toLowerCase();
    if (arg === 'all') {
      const count = this.deleteAllForHandle(handle);
      ctx.replyPrivate(`Deleted ${count} note(s).`);
      return;
    }

    const id = parseInt(arg, 10);
    if (isNaN(id)) {
      ctx.replyPrivate('Usage: !delmemo <id|all>');
      return;
    }

    const note = this.getNote(id);
    if (!note || note.to.toLowerCase() !== handle.toLowerCase()) {
      ctx.replyPrivate(`Note #${id} not found.`);
      return;
    }

    this.deleteNote(id);
    ctx.replyPrivate(`Note #${id} deleted.`);
  }

  // -------------------------------------------------------------------------
  // Join delivery (Phase 3)
  // -------------------------------------------------------------------------

  private registerJoinDelivery(): void {
    this.dispatcher.bind(
      'join',
      '-',
      '*',
      (ctx: HandlerContext) => {
        if (!ctx.channel) return;
        const hostmask = `${ctx.nick}!${ctx.ident}@${ctx.hostname}`;
        const record = this.permissions.findByHostmask(hostmask);
        if (!record) return;
        if (!(record.global.includes('n') || record.global.includes('m'))) return;

        const handleKey = record.handle.toLowerCase();
        const now = Date.now();
        const lastNotified = this.deliveryCooldown.get(handleKey) ?? 0;
        if (now - lastNotified < this.config.delivery_cooldown_seconds * 1000) return;

        const unread = this.countUnread(record.handle);
        if (unread === 0) return;

        this.deliveryCooldown.set(handleKey, now);
        this.client.notice(ctx.nick, `You have ${unread} unread note(s). Use !memos to read.`);
      },
      OWNER_ID,
    );
  }

  // -------------------------------------------------------------------------
  // DCC connect notification
  // -------------------------------------------------------------------------

  /** Call from onPartyJoin callback to notify on DCC connect. */
  notifyOnDCCConnect(handle: string, nick: string): void {
    const unread = this.countUnread(handle);
    if (unread === 0) return;
    const session = this.dccManager?.getSession(nick);
    if (session) {
      session.writeLine(`*** You have ${unread} unread note(s). Type .notes to read.`);
    }
  }
}
