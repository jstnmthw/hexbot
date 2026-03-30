# Plan: Response Formatting Cleanup

## Summary

Two changes: (1) introduce a shared table-formatting utility so all multi-column
outputs align correctly regardless of content width, and (2) remove the
`hexbot> ` prompt from DCC CHAT sessions — the bot should respond without a
shell-style prompt. The REPL keeps its prompt because it's a local terminal
with no other context.

## Feasibility

- **Alignment**: Fully aligned with DESIGN.md — this is internal output
  formatting, no architectural impact.
- **Dependencies**: None — all affected files already exist.
- **Blockers**: None.
- **Complexity**: S (hours)
- **Risk areas**: Tests that assert exact output strings will need updating.

## Phases

### Phase 1: Table formatter utility

**Goal:** A single function that accepts rows of string columns and returns
lines with columns padded to their max width, so everything aligns.

- [ ] Create `src/utils/table.ts` with:
  ```ts
  /**
   * Format rows into aligned columns.
   * @param rows  Array of string arrays (each inner array = one row of cells)
   * @param opts  { indent?: string, gap?: string }
   *              indent = leading whitespace (default "  ")
   *              gap    = between columns (default "  ")
   * @returns Joined multi-line string
   */
  export function formatTable(rows: string[][], opts?: { indent?: string; gap?: string }): string;
  ```
- [ ] Write tests in `tests/utils/table.test.ts` covering:
  - Basic alignment with varying cell widths
  - Empty rows, single-column, single-row
  - Custom indent and gap
- [ ] Verify: `pnpm test -- tests/utils/table.test.ts`

### Phase 2: Adopt table formatter in existing commands

**Goal:** Replace hardcoded `padEnd()` calls and ad-hoc formatting with the
shared utility.

Files to update:

- [ ] `src/core/commands/channel-commands.ts` — `.chanset` list (line 50-52)
      and `.chaninfo` (line 174-176). Build rows array from snapshot, pass to
      `formatTable()`.
- [ ] `src/core/commands/dispatcher-commands.ts` — `.binds` (line 32-33).
      Columns: type, flags, mask, pluginId, hits.
- [ ] `src/core/commands/permission-commands.ts` — `.users` (line 123-126).
      Columns: handle, flags, hostmasks.
- [ ] `src/command-handler.ts` — `.help` list (line 170-176). Align command
      names and descriptions within each category.
- [ ] Verify: `pnpm test` (full suite — multiple test files will need output
      assertion updates)

### Phase 3: Remove DCC CHAT prompt

**Goal:** DCC sessions no longer print `hexbot> ` — the bot just sends
responses. REPL is unchanged.

- [ ] `src/core/dcc.ts` — Delete `const PROMPT = 'hexbot> ';` (line 125)
- [ ] `src/core/dcc.ts` — Remove `this.write(PROMPT)` after banner (line 221)
- [ ] `src/core/dcc.ts` — Remove `this.write(PROMPT)` in the readline
      `line` handler callback (line 227: `if (!this.closed) this.write(PROMPT);`)
- [ ] Update `tests/core/dcc.test.ts` — remove any assertions that expect
      `hexbot> ` in DCC session output
- [ ] Verify REPL still has `hexbot> ` prompt (`src/repl.ts` line 43 —
      no change needed, just confirm)
- [ ] Verify: `pnpm test -- tests/core/dcc.test.ts`

## Config changes

None.

## Database changes

None.

## Test plan

- **Unit tests** for `formatTable()`: alignment correctness, edge cases
- **Existing command tests**: update expected output strings to match new
  aligned format (no more hardcoded `padEnd` widths — widths are now dynamic)
- **DCC tests**: verify no `hexbot> ` appears in session output
- **REPL tests**: verify `hexbot> ` prompt is still present
- Full suite must pass: `pnpm test`

## Open questions

1. **Should the help plugin (`plugins/help/index.ts`) also use the table
   formatter?** It sends lines over IRC (NOTICE/PRIVMSG) where monospace isn't
   guaranteed. The compact index format (`category: cmd1  cmd2  cmd3`) probably
   shouldn't change, but the verbose view could align command names. User input
   needed.
2. **Column gap size** — `"  "` (two spaces) is the proposed default gap
   between columns. Any preference?
