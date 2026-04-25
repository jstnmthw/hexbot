import { type Mock, beforeEach, describe, expect, it, vi } from 'vitest';

import { type CommandContext, CommandHandler } from '../../../src/command-handler';
import { auditActor } from '../../../src/core/audit';
import {
  IDLE_TIMEOUT_MS,
  PAGE_SIZE,
  _resetPagersForTest,
  clearPagerForSession,
  parseDurationSeconds,
  parseModlogFilter,
  registerModlogCommands,
  relativeTime,
} from '../../../src/core/commands/modlog-commands';
import { Permissions } from '../../../src/core/permissions';
import { BotDatabase } from '../../../src/database';
import { BotEventBus } from '../../../src/event-bus';

type CtxWithReply = CommandContext & { reply: Mock<(msg: string) => void>; replies: string[] };

function makeCtx(overrides: Partial<CommandContext> = {}): CtxWithReply {
  const replies: string[] = [];
  const reply = vi.fn<(msg: string) => void>((m) => {
    replies.push(m);
  });
  const ctx: CommandContext = {
    source: 'repl',
    nick: 'admin',
    channel: null,
    reply,
    ...overrides,
  };
  return Object.assign(ctx as CtxWithReply, { reply, replies });
}

/**
 * Wire the four collaborators `.modlog` needs (db, event bus, permissions,
 * command handler) into a single fixture. The event bus must be attached to
 * the db before the modlog command registers its `.audit-tail` listener,
 * otherwise live mod_log writes won't reach the tail subscriber.
 */
function setup() {
  const db = new BotDatabase(':memory:');
  db.open();
  const eventBus = new BotEventBus();
  db.setEventBus(eventBus);
  const perms = new Permissions(db);
  const handler = new CommandHandler(perms);
  registerModlogCommands({ handler, db, permissions: perms, eventBus });
  return { handler, db, perms, eventBus };
}

/**
 * Insert `count` mod_log rows with sensible kick-style defaults. Each row
 * gets a unique `target` (`user0`, `user1`, ...) so pagination tests can
 * assert on per-row identity. Pass `base` overrides to vary the `action`,
 * `channel`, etc. — but note `target`/`reason` are overwritten last by the
 * spread so callers can't pin them.
 */
function seed(
  db: BotDatabase,
  count: number,
  base: Partial<Parameters<typeof db.logModAction>[0]> = {},
): void {
  for (let i = 0; i < count; i++) {
    db.logModAction({
      action: base.action ?? 'kick',
      source: base.source ?? 'irc',
      by: base.by ?? 'admin',
      channel: base.channel ?? '#test',
      target: `user${i}`,
      reason: `r${i}`,
      ...base,
    });
  }
}

describe('auditActor (re-exported)', () => {
  it('produces a ModActor from a CommandContext', () => {
    const ctx: CommandContext = {
      source: 'dcc',
      nick: 'alice',
      channel: null,
      reply: () => {},
    };
    expect(auditActor(ctx)).toEqual({ by: 'alice', source: 'dcc' });
  });
});

describe('tryLogModAction', () => {
  it('is a no-op when db is null', async () => {
    const { tryLogModAction } = await import('../../../src/core/audit');
    expect(() =>
      tryLogModAction(null, { action: 'kick', source: 'irc', by: 'a', target: 'b' }),
    ).not.toThrow();
  });
});

describe('clearPagerForSession', () => {
  it('drops a session entry when called', () => {
    // Smoke test — mostly here to exercise the exported helper since DCC
    // session-close hooks aren't wired through the dispatcher mock.
    expect(() => clearPagerForSession('dcc:nobody')).not.toThrow();
  });
});

describe('parseModlogFilter', () => {
  it('parses an empty string into an empty filter', () => {
    expect(parseModlogFilter('')).toEqual({ filter: {}, error: null });
  });

  it('parses each scalar field', () => {
    const r = parseModlogFilter(
      'action kick channel #foo by alice source irc plugin flood target spammer',
    );
    expect(r.error).toBeNull();
    expect(r.filter).toMatchObject({
      action: 'kick',
      channel: '#foo',
      by: 'alice',
      source: 'irc',
      plugin: 'flood',
      target: 'spammer',
    });
  });

  it('rejects grep with no value', () => {
    expect(parseModlogFilter('grep').error).toMatch(/grep needs a value/);
  });

  it('parses outcome and rejects an invalid value', () => {
    expect(parseModlogFilter('outcome failure').filter.outcome).toBe('failure');
    expect(parseModlogFilter('outcome maybe').error).toMatch(/invalid outcome/);
  });

  it('lowercases the channel field', () => {
    expect(parseModlogFilter('channel #FOO').filter.channel).toBe('#foo');
  });

  it('rejects unknown filter tokens', () => {
    expect(parseModlogFilter('frob bar').error).toMatch(/unknown filter "frob"/);
  });

  it('rejects an unknown source value', () => {
    expect(parseModlogFilter('source martian').error).toMatch(/invalid source/);
  });

  it('rejects a field with no value', () => {
    expect(parseModlogFilter('action').error).toMatch(/needs a value/);
  });

  it('parses since as a relative window', () => {
    const r = parseModlogFilter('since 1h');
    expect(r.error).toBeNull();
    expect(r.filter.sinceTimestamp).toBeDefined();
    const expected = Math.floor(Date.now() / 1000) - 3600;
    expect(Math.abs((r.filter.sinceTimestamp ?? 0) - expected)).toBeLessThan(2);
  });

  it('rejects a malformed duration', () => {
    expect(parseModlogFilter('since wat').error).toMatch(/invalid duration/);
  });

  it('grep consumes the remainder of the line', () => {
    const r = parseModlogFilter('action kick grep too many words here');
    expect(r.filter.grep).toBe('too many words here');
    expect(r.filter.action).toBe('kick');
  });
});

describe('parseDurationSeconds', () => {
  it('handles s/m/h/d', () => {
    expect(parseDurationSeconds('30s')).toBe(30);
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2h')).toBe(7200);
    expect(parseDurationSeconds('7d')).toBe(7 * 86400);
  });

  it('returns null on bad input', () => {
    expect(parseDurationSeconds('1y')).toBeNull();
    expect(parseDurationSeconds('m')).toBeNull();
    expect(parseDurationSeconds('0h')).toBeNull();
  });
});

describe('relativeTime', () => {
  it('renders s/m/h/d windows', () => {
    const now = 1_000_000;
    expect(relativeTime(now - 5, now)).toBe('5s ago');
    expect(relativeTime(now - 90, now)).toBe('1m ago');
    expect(relativeTime(now - 3700, now)).toBe('1h ago');
    expect(relativeTime(now - 86_500, now)).toBe('1d ago');
  });
});

describe('.modlog command', () => {
  let handler: CommandHandler;
  let db: BotDatabase;
  let perms: Permissions;

  beforeEach(() => {
    _resetPagersForTest();
    ({ handler, db, perms } = setup());
  });

  // -------------------------------------------------------------------------
  // Permission matrix
  // -------------------------------------------------------------------------

  describe('permissions', () => {
    it('REPL caller is implicitly allowed', async () => {
      seed(db, 3);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      expect(ctx.replies.some((r) => r.includes('kick'))).toBe(true);
    });

    it('rejects IRC source with the redirect notice', async () => {
      perms.addUser('admin', '*!a@h', 'n', 'REPL');
      const ctx = makeCtx({
        source: 'irc',
        nick: 'admin',
        ident: 'a',
        hostname: 'h',
        channel: '#test',
      });
      await handler.execute('.modlog', ctx);
      expect(ctx.replies[0]).toContain('DCC-only');
    });

    it('rejects DCC caller below master flag', async () => {
      perms.addUser('user', '*!u@h', 'o', 'REPL');
      const ctx = makeCtx({ source: 'dcc', nick: 'user', ident: 'u', hostname: 'h' });
      await handler.execute('.modlog', ctx);
      expect(ctx.replies[0]).toContain('+m or higher');
    });

    it('rejects DCC caller with no matching user record', async () => {
      const ctx = makeCtx({
        source: 'dcc',
        nick: 'stranger',
        ident: 's',
        hostname: 'unknown.host',
      });
      await handler.execute('.modlog', ctx);
      expect(ctx.replies[0]).toContain('permission denied');
    });

    it('rejects DCC caller with missing ident and hostname', async () => {
      const ctx = makeCtx({ source: 'dcc', nick: 'ghost' });
      await handler.execute('.modlog', ctx);
      expect(ctx.replies[0]).toContain('permission denied');
    });

    it('master with channel `n` flag includes that channel in scope', async () => {
      perms.addUser('master', '*!m@h', 'm', 'REPL');
      perms.setChannelFlags('master', '#owned', 'n', 'REPL');
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'a',
        channel: '#owned',
        target: 'spy',
      });
      const ctx = makeCtx({ source: 'dcc', nick: 'master', ident: 'm', hostname: 'h' });
      await handler.execute('.modlog', ctx);
      expect(ctx.replies.join('\n')).toContain('spy');
    });

    it('master user only sees rows from channels they op', async () => {
      // Master with `o` only on #ops; not allowed to see #secret rows.
      perms.addUser('master', '*!m@h', 'm', 'REPL');
      perms.setChannelFlags('master', '#ops', 'o', 'REPL');

      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'someone',
        channel: '#ops',
        target: 'spammer',
      });
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'someone',
        channel: '#secret',
        target: 'spy',
      });

      const ctx = makeCtx({ source: 'dcc', nick: 'master', ident: 'm', hostname: 'h' });
      await handler.execute('.modlog', ctx);
      const out = ctx.replies.join('\n');
      expect(out).toContain('spammer');
      expect(out).not.toContain('spy');
    });

    it('master user explicitly filtering a forbidden channel sees nothing', async () => {
      perms.addUser('master', '*!m@h', 'm', 'REPL');
      perms.setChannelFlags('master', '#ops', 'o', 'REPL');
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'a',
        channel: '#secret',
        target: 'spy',
      });

      const ctx = makeCtx({ source: 'dcc', nick: 'master', ident: 'm', hostname: 'h' });
      await handler.execute('.modlog channel #secret', ctx);
      expect(ctx.replies.join('\n')).toContain('no matching rows');
    });

    it('owner sees rows from any channel', async () => {
      perms.addUser('owner', '*!o@h', 'n', 'REPL');
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'a',
        channel: '#secret',
        target: 'spy',
      });
      const ctx = makeCtx({ source: 'dcc', nick: 'owner', ident: 'o', hostname: 'h' });
      await handler.execute('.modlog', ctx);
      expect(ctx.replies.join('\n')).toContain('spy');
    });
  });

  // -------------------------------------------------------------------------
  // Pagination
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('renders a page of 10 with a footer', async () => {
      seed(db, 25);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      const lines = ctx.replies;
      // header + 10 rows + footer = 12 lines
      expect(lines.length).toBe(PAGE_SIZE + 2);
      expect(lines[lines.length - 1]).toContain('1-10 of 25');
    });

    it('next walks forward', async () => {
      seed(db, 25);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog next', ctx);
      const footer = ctx.replies[ctx.replies.length - 1];
      expect(footer).toContain('11-20 of 25');
    });

    it('prev walks back', async () => {
      seed(db, 25);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      await handler.execute('.modlog next', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog prev', ctx);
      const footer = ctx.replies[ctx.replies.length - 1];
      expect(footer).toContain('1-10 of 25');
    });

    it('end walks to the last page', async () => {
      seed(db, 25);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog end', ctx);
      const footer = ctx.replies[ctx.replies.length - 1];
      expect(footer).toContain('21-25 of 25');
    });

    it('next on the last page reports end of results', async () => {
      seed(db, 5);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog next', ctx);
      expect(ctx.replies[0]).toContain('end of results');
    });

    it('footer total is cached from the first query (does not re-count on nav)', async () => {
      // Stability audit 2026-04-14: `.modlog next/prev` no longer
      // re-runs `SELECT COUNT(*)` against the filter on every nav —
      // the total is snapshotted at first-query time and stays
      // stable until the user runs `.modlog top`. On a 10M-row
      // table, repeated counts were the dominant nav cost.
      seed(db, 12);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      // New rows land mid-browse — the footer total stays at 12.
      seed(db, 3, { action: 'op' });
      ctx.replies.length = 0;
      await handler.execute('.modlog next', ctx);
      const footer = ctx.replies[ctx.replies.length - 1];
      expect(footer).toContain('of 12');
      expect(footer).not.toContain('+3 new');
    });

    it('top re-snapshots so the total reflects newly-landed rows', async () => {
      seed(db, 12);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      seed(db, 3, { action: 'op' });
      ctx.replies.length = 0;
      await handler.execute('.modlog top', ctx);
      const footer = ctx.replies[ctx.replies.length - 1];
      expect(footer).toContain('of 15');
    });

    it('next without a prior query is rejected', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog next', ctx);
      expect(ctx.replies[0]).toContain('no active query');
    });

    it('prev without a prior query is rejected', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog prev', ctx);
      expect(ctx.replies[0]).toContain('no active query');
    });

    it('top without a prior query is rejected', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog top', ctx);
      expect(ctx.replies[0]).toContain('no active query');
    });

    it('end without a prior query is rejected', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog end', ctx);
      expect(ctx.replies[0]).toContain('no active query');
    });

    it('prev on the first page reports already-at-first', async () => {
      seed(db, 5);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog prev', ctx);
      expect(ctx.replies[0]).toContain('already at the first page');
    });

    it('next on an empty result set reports no more rows', async () => {
      // Run a filter that matches nothing → empty rows array → second next
      // hits the "rows.length === 0" guard before the cursor branch.
      const ctx = makeCtx();
      await handler.execute('.modlog action nope', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog next', ctx);
      expect(ctx.replies[0]).toContain('no more rows');
    });

    it('end on a single-page result set just renders that page', async () => {
      seed(db, 3);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog end', ctx);
      expect(ctx.replies[ctx.replies.length - 1]).toContain('1-3 of 3');
    });

    it('clear forgets the pager state', async () => {
      seed(db, 3);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      await handler.execute('.modlog clear', ctx);
      ctx.replies.length = 0;
      await handler.execute('.modlog next', ctx);
      expect(ctx.replies[0]).toContain('no active query');
    });

    it('idle pagers expire after the timeout', async () => {
      seed(db, 3);
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      // Force the pager's lastUsed into the past via a time mock.
      const realNow = Date.now;
      Date.now = () => realNow() + IDLE_TIMEOUT_MS + 1000;
      try {
        ctx.replies.length = 0;
        await handler.execute('.modlog next', ctx);
        expect(ctx.replies[0]).toContain('no active query');
      } finally {
        Date.now = realNow;
      }
    });
  });

  // -------------------------------------------------------------------------
  // Rendering edge cases
  // -------------------------------------------------------------------------

  describe('rendering', () => {
    it('truncates over-wide column values with an ellipsis', async () => {
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'admin',
        channel: '#test',
        target: 'a-very-long-target-name-that-overflows-the-column',
      });
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      // Truncated to 17 chars + ellipsis (column width is 18).
      const row = ctx.replies.find((r) => r.includes('a-very-long-targ'));
      expect(row).toBeDefined();
      expect(row).toContain('…');
    });

    it('renders rows with null channel/target/by columns as `—`', async () => {
      db.logModAction({
        action: 'auth-fail',
        source: 'dcc',
        target: null,
        outcome: 'failure',
      });
      const ctx = makeCtx();
      await handler.execute('.modlog', ctx);
      const row = ctx.replies.find((r) => r.includes('auth-fail'));
      expect(row).toBeDefined();
      expect(row).toContain('—');
    });
  });

  // -------------------------------------------------------------------------
  // Filter grammar end-to-end
  // -------------------------------------------------------------------------

  describe('filter integration', () => {
    it('action filter narrows the results', async () => {
      seed(db, 5, { action: 'kick' });
      seed(db, 5, { action: 'op' });
      const ctx = makeCtx();
      await handler.execute('.modlog action kick', ctx);
      const footer = ctx.replies[ctx.replies.length - 1];
      expect(footer).toContain('of 5');
    });

    it('since 1h windows recent rows only', async () => {
      // Insert one row with a backdated timestamp via raw SQL to simulate age.
      const internalDb = db.rawHandleForTests();
      internalDb
        .prepare(
          `INSERT INTO mod_log (timestamp, action, source, by_user, channel, target, outcome)
           VALUES (?, 'old', 'irc', 'a', '#test', 'historic', 'success')`,
        )
        .run(Math.floor(Date.now() / 1000) - 7200); // 2h ago
      seed(db, 3, { action: 'fresh' });

      const ctx = makeCtx();
      await handler.execute('.modlog since 1h', ctx);
      const out = ctx.replies.join('\n');
      expect(out).toContain('fresh');
      expect(out).not.toContain('historic');
    });

    it('rejects an unknown filter token cleanly', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog wat lol', ctx);
      expect(ctx.replies[0]).toContain('unknown filter');
    });
  });

  // -------------------------------------------------------------------------
  // .modlog show
  // -------------------------------------------------------------------------

  describe('show <id>', () => {
    it('renders full row detail including parsed metadata JSON', async () => {
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'flood',
        by: 'flood',
        channel: '#busy',
        reason: '+R',
        metadata: { mode: 'R', flooderCount: 5 },
      });
      const ctx = makeCtx();
      await handler.execute('.modlog show 1', ctx);
      const out = ctx.replies.join('\n');
      expect(out).toContain('Row #1');
      expect(out).toContain('flood-lockdown');
      expect(out).toContain('plugin=flood');
      expect(out).toContain('"flooderCount":5');
    });

    it('rejects a non-existent id', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog show 9999', ctx);
      expect(ctx.replies[0]).toContain('no row with id 9999');
    });

    it('rejects show without a numeric arg', async () => {
      const ctx = makeCtx();
      await handler.execute('.modlog show', ctx);
      expect(ctx.replies[0]).toContain('usage');
    });

    it('master cannot show a row from a forbidden channel', async () => {
      perms.addUser('master', '*!m@h', 'm', 'REPL');
      perms.setChannelFlags('master', '#ops', 'o', 'REPL');
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'a',
        channel: '#secret',
        target: 'spy',
      });
      const ctx = makeCtx({ source: 'dcc', nick: 'master', ident: 'm', hostname: 'h' });
      await handler.execute('.modlog show 1', ctx);
      expect(ctx.replies[0]).toContain('permission denied');
    });

    it('master cannot show a row that has no channel at all', async () => {
      perms.addUser('master', '*!m@h', 'm', 'REPL');
      perms.setChannelFlags('master', '#ops', 'o', 'REPL');
      // auth-fail has no channel — master's per-channel scope can't allow it.
      db.logModAction({
        action: 'auth-fail',
        source: 'dcc',
        target: 'someone',
        outcome: 'failure',
      });
      const ctx = makeCtx({ source: 'dcc', nick: 'master', ident: 'm', hostname: 'h' });
      await handler.execute('.modlog show 1', ctx);
      expect(ctx.replies[0]).toContain('permission denied');
    });

    it('renders a non-plugin row without the plugin annotation', async () => {
      db.logModAction({
        action: 'kick',
        source: 'irc',
        by: 'admin',
        channel: '#test',
        target: 'baddie',
      });
      const ctx = makeCtx();
      await handler.execute('.modlog show 1', ctx);
      const out = ctx.replies.join('\n');
      expect(out).toContain('source:  irc');
      expect(out).not.toContain('plugin=');
    });

    it('renders a row with all null optional columns as `—`', async () => {
      db.logModAction({ action: 'auth-fail', source: 'system', outcome: 'failure' });
      const ctx = makeCtx();
      await handler.execute('.modlog show 1', ctx);
      const out = ctx.replies.join('\n');
      expect(out).toContain('by:      —');
      expect(out).toContain('channel: —');
      expect(out).toContain('target:  —');
      expect(out).toContain('reason:  —');
    });
  });

  // -------------------------------------------------------------------------
  // .audit-tail
  // -------------------------------------------------------------------------

  describe('.audit-tail', () => {
    it('rejects non-REPL callers', async () => {
      perms.addUser('owner', '*!o@h', 'n', 'REPL');
      const ctx = makeCtx({ source: 'dcc', nick: 'owner', ident: 'o', hostname: 'h' });
      await handler.execute('.audit-tail', ctx);
      expect(ctx.replies[0]).toContain('REPL-only');
    });

    it('streams matching rows to the REPL', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail action kick', ctx);
      ctx.replies.length = 0;

      db.logModAction({ action: 'kick', source: 'irc', by: 'a', channel: '#t', target: 'x' });
      db.logModAction({ action: 'op', source: 'irc', by: 'a', channel: '#t', target: 'y' });

      const out = ctx.replies.join('\n');
      expect(out).toContain('kick');
      expect(out).not.toContain('op');
    });

    it('off detaches the listener', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail', ctx);
      await handler.execute('.audit-tail off', ctx);
      ctx.replies.length = 0;

      db.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'x' });
      // No streamed rows after off.
      expect(ctx.replies).toHaveLength(0);
    });

    it('off without an active tail reports clearly', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail off', ctx);
      expect(ctx.replies[0]).toContain('not currently tailing');
    });

    it('replacing a tail keeps only one listener active', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail action kick', ctx);
      await handler.execute('.audit-tail action op', ctx);
      ctx.replies.length = 0;
      db.logModAction({ action: 'op', source: 'irc', by: 'a', target: 'x' });
      const matches = ctx.replies.filter((r) => r.includes('op')).length;
      expect(matches).toBe(1);
    });

    it('rejects a malformed filter on activation', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail wat lol', ctx);
      expect(ctx.replies[0]).toContain('unknown filter');
    });

    it('matcher honors target / source / plugin / by / outcome / since / grep filters', async () => {
      // Single test exercises every makeMatcher branch by walking a
      // multi-filter tail across rows that vary on each axis.
      const ctx = makeCtx();
      await handler.execute(
        '.audit-tail target alice source plugin plugin flood by flood outcome failure since 1h grep needle',
        ctx,
      );
      ctx.replies.length = 0;

      // Match: every filter satisfied.
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'flood',
        by: 'flood',
        target: 'alice',
        outcome: 'failure',
        reason: 'needle in haystack',
      });
      // Misses for each axis.
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'flood',
        by: 'flood',
        target: 'bob', // wrong target
        outcome: 'failure',
        reason: 'needle',
      });
      db.logModAction({
        action: 'kick',
        source: 'irc', // wrong source
        by: 'flood',
        target: 'alice',
        outcome: 'failure',
        reason: 'needle',
      });
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'other', // wrong plugin
        by: 'flood',
        target: 'alice',
        outcome: 'failure',
        reason: 'needle',
      });
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'flood',
        by: 'someoneelse', // wrong by
        target: 'alice',
        outcome: 'failure',
        reason: 'needle',
      });
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'flood',
        by: 'flood',
        target: 'alice',
        outcome: 'success', // wrong outcome
        reason: 'needle',
      });
      db.logModAction({
        action: 'flood-lockdown',
        source: 'plugin',
        plugin: 'flood',
        by: 'flood',
        target: 'alice',
        outcome: 'failure',
        reason: 'haystack', // no needle
      });

      // Only the first row should have streamed.
      const matches = ctx.replies.filter((r) => r.includes('alice'));
      expect(matches).toHaveLength(1);
    });

    it('matcher honors channel filter case-insensitively', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail channel #FOO', ctx);
      ctx.replies.length = 0;
      db.logModAction({ action: 'kick', source: 'irc', by: 'a', channel: '#foo', target: 'x' });
      db.logModAction({ action: 'kick', source: 'irc', by: 'a', channel: '#bar', target: 'y' });
      const out = ctx.replies.join('\n');
      expect(out).toContain('x');
      expect(out).not.toContain(' y ');
    });

    it('matcher with channel filter handles rows with null channel', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail channel #foo', ctx);
      ctx.replies.length = 0;
      db.logModAction({
        action: 'auth-fail',
        source: 'dcc',
        target: 'x',
        outcome: 'failure',
      });
      // null channel can never match an explicit channel filter.
      expect(ctx.replies).toHaveLength(0);
    });

    it('matcher grep blob handles null reason and missing metadata', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail grep needle', ctx);
      ctx.replies.length = 0;
      // Row with null reason AND no metadata — blob is just spaces, no match.
      db.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'x' });
      expect(ctx.replies).toHaveLength(0);
    });

    it('matcher with no filters streams every row', async () => {
      const ctx = makeCtx();
      await handler.execute('.audit-tail', ctx);
      ctx.replies.length = 0;
      db.logModAction({ action: 'kick', source: 'irc', by: 'a', target: 'x' });
      db.logModAction({ action: 'op', source: 'irc', by: 'a', target: 'y' });
      // Two rows in, two rows out — covers the "no filter" code path
      // (every makeMatcher branch falls through to `return true`).
      expect(ctx.replies.length).toBeGreaterThanOrEqual(2);
    });
  });

  // -------------------------------------------------------------------------
  // Factory edge case
  // -------------------------------------------------------------------------

  describe('registerModlogCommands', () => {
    it('is a no-op when db is null', () => {
      const handler2 = new CommandHandler();
      const before = handler2.getCommands().length;
      registerModlogCommands({
        handler: handler2,
        db: null,
        permissions: new Permissions(),
        eventBus: new BotEventBus(),
      });
      const after = handler2.getCommands().length;
      expect(after).toBe(before);
    });
  });

  // -------------------------------------------------------------------------
  // Session keying
  // -------------------------------------------------------------------------

  describe('session isolation', () => {
    it('two DCC sessions get separate pager state', async () => {
      perms.addUser('owner1', '*!o@h1', 'n', 'REPL');
      perms.addUser('owner2', '*!o@h2', 'n', 'REPL');
      seed(db, 25);

      const dccSession1 = { handle: 'owner1', nick: 'owner1' } as never;
      const dccSession2 = { handle: 'owner2', nick: 'owner2' } as never;
      const ctx1 = makeCtx({
        source: 'dcc',
        nick: 'owner1',
        ident: 'o',
        hostname: 'h1',
        dccSession: dccSession1,
      });
      const ctx2 = makeCtx({
        source: 'dcc',
        nick: 'owner2',
        ident: 'o',
        hostname: 'h2',
        dccSession: dccSession2,
      });

      await handler.execute('.modlog', ctx1);
      await handler.execute('.modlog next', ctx1);
      // ctx2 has no state — next must say "no active query"
      await handler.execute('.modlog next', ctx2);
      expect(ctx2.replies[0]).toContain('no active query');
    });
  });
});
