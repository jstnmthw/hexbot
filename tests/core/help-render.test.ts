import { describe, expect, it, vi } from 'vitest';

import { HelpRegistry } from '../../src/core/help-registry';
import {
  type RenderPermissions,
  boldTrigger,
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

describe('boldTrigger', () => {
  it('bolds the entire string when there is no whitespace', () => {
    expect(boldTrigger('!help')).toBe('\x02!help\x02');
  });

  it('bolds only the trigger word and leaves args unbolded', () => {
    expect(boldTrigger('!op [nick]')).toBe('\x02!op\x02 [nick]');
  });
});

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
  it('omits the Requires suffix for `-` flag entries', () => {
    expect(renderCommand(PUBLIC_ENTRY)).toEqual([
      '\x02!8ball\x02 <question> — Ask the magic 8-ball',
    ]);
  });

  it('appends `| Requires: <flags>` for flagged entries', () => {
    expect(renderCommand(OP_ENTRY)).toEqual(['\x02!op\x02 [nick] — Op a nick | Requires: o']);
  });

  it('renders detail lines indented under the header', () => {
    expect(renderCommand(SCOPE_KEY_ENTRY)).toEqual([
      '\x02.set\x02 core logging.level <string> — Minimum log level | Requires: n',
      '  Type: string  Default: info  Reload: live',
    ]);
  });
});

describe('renderCategory', () => {
  it('renders the bracketed category header followed by one entry per line', () => {
    const lines = renderCategory('fun', [PUBLIC_ENTRY]);
    expect(lines).toEqual(['\x02[fun]\x02', '  \x02!8ball\x02 <question> — Ask the magic 8-ball']);
  });
});

describe('renderScope', () => {
  it('renders title with summary and key count, plus one line per key', () => {
    const lines = renderScope('core', SCOPE_HEADER, [SCOPE_HEADER, SCOPE_KEY_ENTRY], '.');
    expect(lines[0]).toBe('\x02core\x02 settings (1) — Bot-wide singletons');
    expect(lines).toContain('  \x02logging.level\x02 — Minimum log level');
    expect(lines[lines.length - 1]).toBe('Type .help set core <key> for detail.');
  });

  it('omits the trailing detail hint when no keys are present', () => {
    const lines = renderScope('core', SCOPE_HEADER, [SCOPE_HEADER], '.');
    expect(lines).toEqual(['\x02core\x02 settings (0) — Bot-wide singletons']);
  });

  it('handles a missing header gracefully', () => {
    const lines = renderScope('core', null, [SCOPE_KEY_ENTRY], '.');
    expect(lines[0]).toBe('\x02core\x02 settings (1)');
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

  it('compact: bolds the header and lists one line per category', () => {
    const lines = renderIndex([PUBLIC_ENTRY, OP_ENTRY], {
      compact: true,
      header: 'HexBot',
      footer: 'end',
      prefix: '!',
    });
    expect(lines[0]).toBe('\x02HexBot\x02 — !help <category> or !help <command>');
    expect(lines.some((l) => l.includes('\x02fun\x02') && l.includes('8ball'))).toBe(true);
    expect(lines.some((l) => l.includes('\x02moderation\x02') && l.includes('op'))).toBe(true);
  });

  it('verbose: emits header, [category] sections, and footer', () => {
    const lines = renderIndex([PUBLIC_ENTRY, OP_ENTRY], {
      compact: false,
      header: 'Available',
      footer: '*** end ***',
      prefix: '.',
    });
    expect(lines[0]).toBe('\x02Available\x02');
    expect(lines).toContain('\x02[fun]\x02');
    expect(lines).toContain('\x02[moderation]\x02');
    expect(lines[lines.length - 1]).toBe('*** end ***');
  });

  it('folds set:* categories into one line per scope with summary + key count', () => {
    const lines = renderIndex([SCOPE_HEADER, SCOPE_KEY_ENTRY, PUBLIC_ENTRY], {
      compact: true,
      header: 'HexBot',
      footer: 'end',
      prefix: '!',
    });
    expect(lines.some((l) => l === '\x02[settings]\x02')).toBe(true);
    expect(lines.some((l) => l.includes('\x02core\x02') && l.includes('(1 key)'))).toBe(true);
    expect(lines.some((l) => l.includes('Bot-wide singletons'))).toBe(true);
    // Per-key entries do NOT appear as their own lines in the compact view.
    expect(lines.some((l) => l.includes('logging.level'))).toBe(false);
  });

  it('verbose: omits a footer line when footer is empty', () => {
    const lines = renderIndex([PUBLIC_ENTRY], {
      compact: false,
      header: 'h',
      footer: '',
      prefix: '.',
    });
    expect(lines[lines.length - 1]).not.toBe('');
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
    expect(lines.some((l) => l.includes('\x02fun\x02:') && l.includes('ping'))).toBe(true);
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
  it('renders a settings scope with no header (description column blank)', () => {
    // A `set:*` category entry whose header was never registered (or
    // was unregistered). Folded line should still appear with the key
    // count, just without the trailing summary.
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
    const orphanLine = lines.find((l) => l.includes('\x02orphan\x02'));
    expect(orphanLine).toBeDefined();
    expect(orphanLine).toContain('(1 key)');
    // No header → no `— summary` tail.
    expect(orphanLine).not.toContain('—');
  });

  it('renders a settings scope when the header description is empty (still no tail)', () => {
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
    const quietLine = lines.find((l) => l.includes('\x02quiet\x02'));
    expect(quietLine).toBeDefined();
    expect(quietLine).not.toContain('—');
  });
});
