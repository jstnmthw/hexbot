import { describe, expect, it, vi } from 'vitest';

import { HelpRegistry } from '../../src/core/help-registry';
import {
  type RenderPermissions,
  filterByPermission,
  isScopeHeaderEntry,
  lookup,
  renderCategory,
  renderCommand,
  renderIndex,
  renderScope,
} from '../../src/core/help-render';
import type { HandlerContext, HelpEntry } from '../../src/types';

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    nick: 'user1',
    ident: 'user',
    hostname: 'host.com',
    channel: '#test',
    text: '',
    command: '!help',
    args: '',
    reply: vi.fn(),
    replyPrivate: vi.fn(),
    ...overrides,
  };
}

const PUBLIC_ENTRY: HelpEntry = {
  command: '!8ball',
  flags: '-',
  usage: '!8ball <question>',
  description: 'Ask the magic 8-ball',
  category: 'fun',
};

const OP_ENTRY: HelpEntry = {
  command: '!op',
  flags: 'o',
  usage: '!op [nick]',
  description: 'Op a nick',
  category: 'moderation',
};

const SCOPE_HEADER: HelpEntry = {
  command: '.set core',
  flags: 'n',
  usage: '.set core <key> [value]',
  description: 'Bot-wide singletons',
  category: 'set:core',
};

const SCOPE_KEY_ENTRY: HelpEntry = {
  command: '.set core logging.level',
  flags: 'n',
  usage: '.set core logging.level <string>',
  description: 'Minimum log level',
  detail: ['Type: string  Default: info  Reload: live'],
  category: 'set:core',
};

describe('isScopeHeaderEntry', () => {
  it('returns true for the bare scope command (.set core)', () => {
    expect(isScopeHeaderEntry(SCOPE_HEADER, 'core')).toBe(true);
  });

  it('returns false for per-key entries (.set core foo)', () => {
    expect(isScopeHeaderEntry(SCOPE_KEY_ENTRY, 'core')).toBe(false);
  });
});

describe('filterByPermission', () => {
  it('returns the input unchanged when perms is null (REPL trusted path)', () => {
    const entries = [PUBLIC_ENTRY, OP_ENTRY];
    expect(filterByPermission(entries, makeCtx(), null)).toEqual(entries);
  });

  it('keeps `-` flag entries even when perms denies', () => {
    const perms: RenderPermissions = { checkFlags: vi.fn().mockReturnValue(false) };
    const result = filterByPermission([PUBLIC_ENTRY, OP_ENTRY], makeCtx(), perms);
    expect(result).toEqual([PUBLIC_ENTRY]);
  });

  it('keeps flagged entries when perms approves', () => {
    const perms: RenderPermissions = { checkFlags: vi.fn().mockReturnValue(true) };
    const result = filterByPermission([PUBLIC_ENTRY, OP_ENTRY], makeCtx(), perms);
    expect(result).toEqual([PUBLIC_ENTRY, OP_ENTRY]);
  });
});

describe('lookup', () => {
  function setup(): HelpRegistry {
    const registry = new HelpRegistry();
    registry.register('chanmod', [OP_ENTRY]);
    registry.register('8ball', [PUBLIC_ENTRY]);
    registry.register('bot', [SCOPE_HEADER, SCOPE_KEY_ENTRY]);
    return registry;
  }

  it('returns command when the query matches an entry exactly', () => {
    const reg = setup();
    const result = lookup(reg, '!8ball', makeCtx(), null, '!');
    expect(result.kind).toBe('command');
    if (result.kind === 'command') expect(result.entry.command).toBe('!8ball');
  });

  it('strips the leading prefix and case-folds the query', () => {
    const reg = setup();
    const result = lookup(reg, '8BALL', makeCtx(), null, '!');
    expect(result.kind).toBe('command');
  });

  it('returns category when the query matches a category label', () => {
    const reg = setup();
    const result = lookup(reg, 'fun', makeCtx(), null, '!');
    expect(result.kind).toBe('category');
    if (result.kind === 'category') {
      expect(result.category).toBe('fun');
      expect(result.entries.map((e) => e.command)).toContain('!8ball');
    }
  });

  it('pivots a scope-header command into a scope view (lists the scope keys)', () => {
    const reg = setup();
    const result = lookup(reg, '.set core', makeCtx(), null, '.');
    expect(result.kind).toBe('scope');
    if (result.kind === 'scope') {
      expect(result.scope).toBe('core');
      expect(result.header?.command).toBe('.set core');
      expect(result.entries.length).toBeGreaterThan(0);
    }
  });

  it('treats a `set:*` category lookup as a scope view', () => {
    const reg = setup();
    const result = lookup(reg, 'set:core', makeCtx(), null, '.');
    expect(result.kind).toBe('scope');
    if (result.kind === 'scope') {
      expect(result.scope).toBe('core');
    }
  });

  it('returns denied when the matched command flags out the caller', () => {
    const reg = setup();
    const perms: RenderPermissions = { checkFlags: vi.fn().mockReturnValue(false) };
    const result = lookup(reg, '!op', makeCtx(), perms, '!');
    expect(result.kind).toBe('denied');
  });

  it('returns none for unknown queries', () => {
    const reg = setup();
    const result = lookup(reg, 'nosuch', makeCtx(), null, '!');
    expect(result.kind).toBe('none');
  });

  it('resolves a deep sub-help command (.set core logging.level)', () => {
    const reg = setup();
    const result = lookup(reg, '.set core logging.level', makeCtx(), null, '.');
    expect(result.kind).toBe('command');
    if (result.kind === 'command') {
      expect(result.entry.command).toBe('.set core logging.level');
    }
  });

  it('expands a dotted-prefix group (.set core logging) into a scope view', () => {
    const reg = setup();
    const result = lookup(reg, '.set core logging', makeCtx(), null, '.');
    expect(result.kind).toBe('scope');
    if (result.kind === 'scope') {
      expect(result.scope).toBe('core');
      expect(result.group).toBe('logging');
    }
  });

  it('returns none for a settings group with no matching keys', () => {
    const reg = setup();
    expect(lookup(reg, '.set core nonesuch', makeCtx(), null, '.').kind).toBe('none');
  });

  // `<topic> <command>` drill-down — the ChanServ `HELP SET EMAIL` shape.
  describe('topic drill-down', () => {
    it('resolves `<topic> <command>` to the command detail', () => {
      const reg = setup();
      const result = lookup(reg, 'fun 8ball', makeCtx(), null, '!');
      expect(result.kind).toBe('command');
      if (result.kind === 'command') expect(result.entry.command).toBe('!8ball');
    });

    it('rejects a command drilled through the wrong topic', () => {
      const reg = setup();
      expect(lookup(reg, 'moderation 8ball', makeCtx(), null, '!').kind).toBe('none');
    });

    it('returns denied when the drilled command flags out the caller', () => {
      const reg = setup();
      const perms: RenderPermissions = { checkFlags: vi.fn().mockReturnValue(false) };
      expect(lookup(reg, 'moderation op', makeCtx(), perms, '!').kind).toBe('denied');
    });

    it('keeps prefix isolation for the drilled command', () => {
      // `.help moderation op` with only `!op` registered — the bang-side
      // command must not surface on the dot-command surface.
      const reg = setup();
      expect(lookup(reg, 'moderation op', makeCtx(), null, '.').kind).toBe('none');
    });
  });

  it('returns none for an empty / whitespace-only query', () => {
    const reg = setup();
    expect(lookup(reg, '   ', makeCtx(), null, '!').kind).toBe('none');
    expect(lookup(reg, '', makeCtx(), null, '!').kind).toBe('none');
  });

  it('falls back to denied when the scope-pivot visible filter empties out', () => {
    // Header itself flagged 'n' and caller has no flags: scope-pivot's
    // visible filter empties, so the lookup falls through to the
    // command branch which then denies.
    const reg = new HelpRegistry();
    reg.register('bot', [{ ...SCOPE_HEADER, flags: 'n' }]);
    const perms: RenderPermissions = { checkFlags: vi.fn().mockReturnValue(false) };
    expect(lookup(reg, '.set core', makeCtx(), perms, '.').kind).toBe('denied');
  });

  // Prefix isolation — `.help` (REPL/admin) and `!help` (channel) surface
  // different corpora even when categories overlap.
  describe('prefix isolation', () => {
    function setupCrossPrefix(): HelpRegistry {
      // Same-named ban command on both surfaces (mirrors the real
      // core `.ban` + chanmod `!ban` coexistence).
      const dotBan: HelpEntry = {
        command: '.ban',
        flags: '+o',
        usage: '.ban [#channel] <mask> [duration]',
        description: 'Admin ban',
        category: 'moderation',
      };
      const bangBan: HelpEntry = {
        command: '!ban',
        flags: 'o',
        usage: '!ban <nick|mask>',
        description: 'Channel ban',
        category: 'moderation',
      };
      const reg = new HelpRegistry();
      reg.register('core', [dotBan]);
      reg.register('chanmod', [bangBan]);
      return reg;
    }

    it('bare query under prefix . resolves to the dot-variant', () => {
      const reg = setupCrossPrefix();
      const result = lookup(reg, 'ban', makeCtx(), null, '.');
      expect(result.kind).toBe('command');
      if (result.kind === 'command') expect(result.entry.command).toBe('.ban');
    });

    it('bare query under prefix ! resolves to the bang-variant', () => {
      const reg = setupCrossPrefix();
      const result = lookup(reg, 'ban', makeCtx(), null, '!');
      expect(result.kind).toBe('command');
      if (result.kind === 'command') expect(result.entry.command).toBe('!ban');
    });

    it('explicit-prefix query rejects the wrong prefix surface', () => {
      const reg = setupCrossPrefix();
      // `.help !ban` from REPL — no result (channel command not invocable from REPL).
      const fromRepl = lookup(reg, '!ban', makeCtx(), null, '.');
      expect(fromRepl.kind).toBe('none');
      // `!help .ban` from channel — same.
      const fromChan = lookup(reg, '.ban', makeCtx(), null, '!');
      expect(fromChan.kind).toBe('none');
    });

    it('category listing filters to entries matching the active prefix', () => {
      const reg = setupCrossPrefix();
      const dotResult = lookup(reg, 'moderation', makeCtx(), null, '.');
      expect(dotResult.kind).toBe('category');
      if (dotResult.kind === 'category') {
        expect(dotResult.entries.map((e) => e.command)).toEqual(['.ban']);
      }
      const bangResult = lookup(reg, 'moderation', makeCtx(), null, '!');
      expect(bangResult.kind).toBe('category');
      if (bangResult.kind === 'category') {
        expect(bangResult.entries.map((e) => e.command)).toEqual(['!ban']);
      }
    });

    it('settings scope is invisible under the bang prefix', () => {
      const reg = new HelpRegistry();
      reg.register('bot', [SCOPE_HEADER, SCOPE_KEY_ENTRY]);
      // `.set core` surfaces under `.` (admin); under `!` it disappears.
      expect(lookup(reg, '.set core', makeCtx(), null, '.').kind).toBe('scope');
      expect(lookup(reg, '.set core', makeCtx(), null, '!').kind).toBe('none');
      expect(lookup(reg, 'set:core', makeCtx(), null, '!').kind).toBe('none');
    });
  });
});

describe('renderCommand', () => {
  it('omits the Requires line for `-` flag entries', () => {
    expect(renderCommand(PUBLIC_ENTRY)).toEqual([
      'Syntax: !8ball <question>',
      ' ',
      'Ask the magic 8-ball',
    ]);
  });

  it('appends a `Requires: <flags>` line for flagged entries', () => {
    expect(renderCommand(OP_ENTRY)).toEqual([
      'Syntax: !op [nick]',
      ' ',
      'Op a nick',
      'Requires: o',
    ]);
  });

  it('renders detail lines indented between the description and Requires', () => {
    expect(renderCommand(SCOPE_KEY_ENTRY)).toEqual([
      'Syntax: .set core logging.level <string>',
      ' ',
      'Minimum log level',
      '  Type: string  Default: info  Reload: live',
      'Requires: n',
    ]);
  });

  it('wraps a long description at the prose width', () => {
    const entry: HelpEntry = {
      ...PUBLIC_ENTRY,
      description:
        'Ask the magic 8-ball a question and receive a mystical answer drawn from the classic set of twenty responses',
    };
    const lines = renderCommand(entry);
    expect(lines[0]).toBe('Syntax: !8ball <question>');
    expect(lines[1]).toBe(' ');
    const descLines = lines.slice(2);
    expect(descLines.length).toBeGreaterThan(1);
    for (const line of descLines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });
});

describe('renderCategory', () => {
  it('renders the uppercased label, aligned rows, and a wrapped drill-down hint', () => {
    const lines = renderCategory('fun', [PUBLIC_ENTRY], '!');
    expect(lines).toEqual([
      'FUN',
      ' ',
      '    8ball  Ask the magic 8-ball',
      ' ',
      'Type !help fun <command> for more information on a',
      'particular command.',
    ]);
  });

  it('appends the curated topic blurb to the label when one exists', () => {
    const lines = renderCategory('moderation', [OP_ENTRY], '!');
    expect(lines[0]).toBe('MODERATION — Channel bans and enforcement');
  });

  it('aligns command names into a shared column', () => {
    const lines = renderCategory('moderation', [OP_ENTRY, PUBLIC_ENTRY], '!');
    // Widest name is `8ball` (5) → `op` (2) padded to align descriptions.
    expect(lines).toContain('    op     Op a nick');
    expect(lines).toContain('    8ball  Ask the magic 8-ball');
  });
});

describe('renderScope', () => {
  it('folds keys by dotted prefix with a count grid and an expand hint', () => {
    const lines = renderScope('core', SCOPE_HEADER, [SCOPE_HEADER, SCOPE_KEY_ENTRY], '.');
    expect(lines[0]).toBe('core settings — 1 key — Bot-wide singletons');
    expect(lines).toContain('    logging.* 1');
    // Per-key names do NOT appear in the folded view.
    expect(lines.some((l) => l.includes('logging.level'))).toBe(false);
    expect(lines[lines.length - 1]).toBe(
      'Type .help set core <group> to expand, or <key> for detail.',
    );
  });

  it('lists non-dotted keys directly rather than folding them', () => {
    const flatKey: HelpEntry = {
      command: '.set core motd',
      flags: 'n',
      usage: '.set core motd <string>',
      description: 'Message of the day',
      category: 'set:core',
    };
    const lines = renderScope('core', SCOPE_HEADER, [SCOPE_HEADER, flatKey], '.');
    expect(lines).toContain('    motd  Message of the day');
    expect(lines[lines.length - 1]).toBe('Type .help set core <key> for detail.');
  });

  it('expands a single dotted-prefix group when `group` is given', () => {
    const second: HelpEntry = {
      command: '.set core logging.file',
      flags: 'n',
      usage: '.set core logging.file <string>',
      description: 'Log file path',
      category: 'set:core',
    };
    const lines = renderScope(
      'core',
      SCOPE_HEADER,
      [SCOPE_HEADER, SCOPE_KEY_ENTRY, second],
      '.',
      'logging',
    );
    expect(lines[0]).toBe('core / logging — 2 keys');
    expect(lines).toContain('    logging.level  Minimum log level');
    expect(lines).toContain('    logging.file   Log file path');
    expect(lines[lines.length - 1]).toBe("Type .help set core <key> for one key's detail.");
  });

  it('omits the trailing hint when no keys are present', () => {
    const lines = renderScope('core', SCOPE_HEADER, [SCOPE_HEADER], '.');
    expect(lines).toEqual(['core settings — 0 keys — Bot-wide singletons']);
  });

  it('handles a missing header gracefully', () => {
    const lines = renderScope('core', null, [SCOPE_KEY_ENTRY], '.');
    expect(lines[0]).toBe('core settings — 1 key');
  });
});

describe('renderIndex', () => {
  it('returns a single-line "No commands available" when input is empty', () => {
    const lines = renderIndex([], {
      compact: true,
      header: 'h',
      footer: 'f',
      prefix: '!',
    });
    expect(lines).toEqual(['No commands available.']);
  });

  it('compact: bolds the header and packs names under uppercased sections', () => {
    const lines = renderIndex([PUBLIC_ENTRY, OP_ENTRY], {
      compact: true,
      header: 'HexBot',
      footer: 'end',
      prefix: '!',
    });
    expect(lines[0]).toBe('HexBot — !help <category> or !help <command>');
    expect(lines.some((l) => l.includes('FUN') && l.includes('8ball'))).toBe(true);
    expect(lines.some((l) => l.includes('MODERATION') && l.includes('op'))).toBe(true);
    // Compact view lists names only — no descriptions.
    expect(lines.some((l) => l.includes('Op a nick'))).toBe(false);
  });

  it('verbose: emits wrapped header, aligned topic rows, and footer', () => {
    const lines = renderIndex([PUBLIC_ENTRY, OP_ENTRY], {
      compact: false,
      header: 'Available',
      footer: '*** end ***',
      prefix: '!',
    });
    expect(lines[0]).toBe('Available');
    expect(lines[1]).toBe(' ');
    // Topics only — plugin topics fall back to their command names as the
    // blurb; per-command descriptions never appear at index level.
    expect(lines).toContain('    FUN         8ball');
    expect(lines).toContain('    MODERATION  Channel bans and enforcement');
    expect(lines.some((l) => l.includes('Ask the magic 8-ball'))).toBe(false);
    expect(lines[lines.length - 2]).toBe(' ');
    expect(lines[lines.length - 1]).toBe('*** end ***');
  });

  it('verbose: wraps a long header paragraph to 60 columns', () => {
    const intro =
      'HexBot allows you to manage and control various aspects of the bot ' +
      'and its channels. Available command topics are listed below.';
    const lines = renderIndex([PUBLIC_ENTRY], {
      compact: false,
      header: intro,
      footer: '',
      prefix: '!',
    });
    const blank = lines.indexOf(' ');
    const introLines = lines.slice(0, blank);
    expect(introLines.length).toBeGreaterThan(1);
    for (const line of introLines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
    expect(introLines.join(' ')).toBe(intro);
  });

  it('folds set:* categories into a single Configuration pointer line (verbose)', () => {
    const lines = renderIndex([SCOPE_HEADER, SCOPE_KEY_ENTRY, PUBLIC_ENTRY], {
      compact: false,
      header: 'HexBot',
      footer: '',
      prefix: '.',
    });
    expect(lines.some((l) => l === 'Configuration: core — .help set <scope>')).toBe(true);
    // Neither scope key counts, summaries, nor per-key names appear in the index.
    expect(lines.some((l) => l.includes('Bot-wide singletons'))).toBe(false);
    expect(lines.some((l) => l.includes('logging.level'))).toBe(false);
    expect(lines.some((l) => l.includes('key'))).toBe(false);
  });

  it('folds set:* scopes into a single SETTINGS pointer line (compact)', () => {
    const lines = renderIndex([SCOPE_HEADER, SCOPE_KEY_ENTRY, PUBLIC_ENTRY], {
      compact: true,
      header: 'HexBot',
      footer: 'end',
      prefix: '!',
    });
    expect(lines.some((l) => l === ' CONFIG  core — !help set <scope>')).toBe(true);
    expect(lines.some((l) => l.includes('logging.level'))).toBe(false);
  });

  it('verbose: omits the footer and its separator when footer is empty', () => {
    const lines = renderIndex([PUBLIC_ENTRY], {
      compact: false,
      header: 'h',
      footer: '',
      prefix: '.',
    });
    expect(lines[lines.length - 1]).not.toBe('');
    expect(lines[lines.length - 1]).not.toBe(' ');
  });

  it('compact: strips a multi-character prefix from command names', () => {
    const entry: HelpEntry = {
      command: '::ping',
      flags: '-',
      usage: '::ping',
      description: 'Ping',
      category: 'fun',
    };
    const lines = renderIndex([entry], {
      compact: true,
      header: 'h',
      footer: '',
      prefix: '::',
    });
    // Compact line lists `ping` (no prefix), not `::ping`.
    expect(lines.some((l) => l.includes('FUN') && l.includes('ping'))).toBe(true);
    expect(lines.some((l) => l.includes('::ping'))).toBe(false);
  });

  it('compact: passes through commands that do not match the prefix', () => {
    // Defensive path — the registry might carry an entry with a stale
    // prefix (e.g. plugin source predates a `command_prefix` swap).
    // The command name should still appear in the listing.
    const entry: HelpEntry = {
      command: '!stale',
      flags: '-',
      usage: '!stale',
      description: 'Stale',
      category: 'misc',
    };
    const lines = renderIndex([entry], {
      compact: true,
      header: 'h',
      footer: '',
      prefix: '.',
    });
    expect(lines.some((l) => l.includes('!stale'))).toBe(true);
  });
});

describe('renderScope', () => {
  it('falls back to the full command when an entry does not match the scope', () => {
    // Defensive path inside `extractKeyName` — segments < 3 surfaces
    // the raw command instead of garbling the key.
    const stray: HelpEntry = {
      command: '.weird',
      flags: 'n',
      usage: '.weird',
      description: 'Stray entry under set:core somehow',
      category: 'set:core',
    };
    const lines = renderScope('core', null, [stray], '.');
    expect(lines.some((l) => l.includes('.weird'))).toBe(true);
  });

  it('falls back when segments[1] does not match the scope name', () => {
    // Defensive path: 3+ segments but the middle one is from a different
    // scope. extractKeyName should bail out rather than slice off random
    // tokens.
    const stray: HelpEntry = {
      command: '.set otherscope foo',
      flags: 'n',
      usage: '.set otherscope foo',
      description: 'Misfiled entry',
      category: 'set:core',
    };
    const lines = renderScope('core', null, [stray], '.');
    expect(lines.some((l) => l.includes('.set otherscope foo'))).toBe(true);
  });
});

describe('renderIndex — settings scope edge cases', () => {
  it('lists a scope name in the pointer line even with no registered header', () => {
    // A `set:*` category entry whose header was never registered (or
    // was unregistered). The scope name still folds into the pointer line
    // — the index no longer surfaces per-scope key counts or summaries.
    const orphanKey: HelpEntry = {
      command: '.set orphan foo',
      flags: 'n',
      usage: '.set orphan foo <string>',
      description: 'Orphan key',
      category: 'set:orphan',
    };
    const lines = renderIndex([orphanKey], {
      compact: true,
      header: 'h',
      footer: '',
      prefix: '.',
    });
    expect(lines).toContain(' CONFIG  orphan — .help set <scope>');
    expect(lines.some((l) => l.includes('key'))).toBe(false);
  });

  it('dedupes a scope with both header and keys into a single pointer entry', () => {
    const emptyHeader: HelpEntry = {
      command: '.set quiet',
      flags: 'n',
      usage: '.set quiet <key>',
      description: '',
      category: 'set:quiet',
    };
    const key: HelpEntry = {
      command: '.set quiet x',
      flags: 'n',
      usage: '.set quiet x',
      description: 'Quiet key',
      category: 'set:quiet',
    };
    const lines = renderIndex([emptyHeader, key], {
      compact: true,
      header: 'h',
      footer: '',
      prefix: '.',
    });
    // Scope appears once, not once per entry.
    expect(lines).toContain(' CONFIG  quiet — .help set <scope>');
  });
});
