# Plan: Plugin Bundling Refactor

## Summary

Refactor all hexbot plugins to bundle via tsup into a single `dist/index.js` per plugin. This decouples plugin dependencies from the root `package.json`, simplifies the plugin-loader by deleting ~100 lines of multi-file temp-rewrite code, and establishes a uniform build/reload model for all plugins — shipped and third-party.

See [plugin-architecture-recommendation.md](plugin-architecture-recommendation.md) for the full rationale.

## Feasibility

- **Alignment:** DESIGN.md already states the loader "imports compiled `.js` output." Bundling to `dist/index.js` is a refinement, not a design change.
- **Dependencies:** All required core modules exist. tsup + esbuild are the only new dev dependencies.
- **Blockers:** None. This can be done incrementally.
- **Complexity:** M — the loader changes are a net deletion, the tsup configs are identical across plugins, and the test updates are mechanical.
- **Risk areas:** (1) tsup bundling `../../src/utils/*` runtime imports into plugins — verified feasible, esbuild resolves relative paths correctly. (2) Node built-in imports (`node:fs`, `node:crypto`, etc.) must be externalized — esbuild does this by default with `platform: 'node'` but we'll be explicit.

## Dependencies

- [ ] tsup must be added as a root devDependency
- [ ] No other prerequisites — all plugins and core modules exist

---

## Phases

### Phase 1: Add tsup and create plugin build configs

**Goal:** Every plugin gets a `tsup.config.ts` and produces a `dist/index.js`. Nothing changes in the loader yet — this phase is additive only.

- [x] Add `tsup` as a root devDependency: `pnpm add -D tsup`
- [x] Create identical `tsup.config.ts` in all 9 plugin dirs (`8ball`, `chanmod`, `ctcp`, `flood`, `greeter`, `help`, `rss`, `seen`, `topic`):

  ```ts
  import { defineConfig } from 'tsup';

  export default defineConfig({
    entry: ['index.ts'],
    format: ['esm'],
    platform: 'node',
    bundle: true,
    noExternal: [/.*/],
    external: [/^node:/, 'better-sqlite3'],
    outExtension: () => ({ js: '.js' }),
  });
  ```

- [x] Create `scripts/build-plugins.ts` — discovers all plugin dirs with `tsup.config.ts` and runs `tsup --config <path>` for each. Runs from project root so relative imports (`../../src/utils/*`) resolve correctly.
- [x] Add `"build:plugins": "tsx scripts/build-plugins.ts"` to root `package.json` scripts
- [x] Run `pnpm build:plugins` and verify all 9 plugins produce `plugins/<name>/dist/index.js`
- [x] Verify bundled output for special cases:
  - `chanmod`: confirm `../../src/utils/wildcard` (runtime import of `wildcardMatch`) is inlined into bundle
  - `flood`: confirm `../../src/utils/sliding-window` (runtime import of `SlidingWindowCounter`) is inlined into bundle
  - `rss`: confirm `rss-parser` and `ipaddr.js` are inlined into bundle
  - `ctcp`: confirm `node:fs` and `node:path` remain as external imports in bundle
  - All plugins: confirm `import type` statements from `../../src/types` are stripped (not present in output)
- [x] Add `plugins/*/dist/` to `.gitignore`
- [x] Add `plugins/*/dist` to `tsconfig.json` exclude array to prevent tsc from checking bundled output

**Verification:** `pnpm build:plugins` succeeds. Each plugin has a `dist/index.js`. `pnpm typecheck` still passes. No git-tracked files in `plugins/*/dist/`.

---

### Phase 2: Update plugin-loader to import bundled output

**Goal:** The loader imports `dist/index.js` instead of `index.ts`. The multi-file temp-rewrite mechanism is deleted.

#### 2a: Change plugin resolution paths

- [x] In `src/plugin-loader.ts` `loadAll()`: change `existsSync(join(..., 'index.ts'))` to `existsSync(join(..., 'dist', 'index.js'))`
- [x] In `src/plugin-loader.ts` `loadAll()`: change `join(this.pluginDir, name, 'index.ts')` to `join(this.pluginDir, name, 'dist', 'index.js')`
- [x] In `src/plugin-loader.ts` `inferPluginName()`: update to handle `dist/index.js` path pattern — the plugin name is now 2 levels up from the file (`plugins/<name>/dist/index.js`)
- [x] In `src/plugin-loader.ts` `mergeConfig()`: `pluginDir` derivation from `pluginFilePath` changes — `resolve(pluginFilePath, '..', '..')` instead of `resolve(pluginFilePath, '..')` since the file is now in `dist/`
- [x] In `src/core/commands/plugin-commands.ts`: change `${pluginDir}/${name}/index.ts` to `${pluginDir}/${name}/dist/index.js`

#### 2b: Delete multi-file temp-rewrite mechanism

- [x] Delete `collectLocalModules()` method
- [x] Delete `buildNameRemap()` method
- [x] Delete `writeRewrittenFiles()` method
- [x] Simplify `importWithCacheBust()` to single-file cache-bust only
- [x] Remove unused imports: `writeFileSync`, `unlinkSync`, `basename`, `dirname`
- [x] Delete `cleanupOrphanedTempFiles()` method — no more `.reload-*.ts` temp files
- [x] Remove the `cleanupOrphanedTempFiles()` call site in `loadAll()`
- [x] Remove `.reload-*.ts` from `.gitignore` and `tsconfig.json` exclude

#### 2c: Update error messages and logging

- [x] Updated comment references from `index.ts` to `dist/index.js`
- [x] Path-traversal guard unchanged — works with any path, no extension assumptions

**Verification:** `pnpm test` passes. Bot starts, loads all plugins from `dist/index.js`. `.load`, `.unload`, `.reload` all work from REPL. `.reload` on a plugin after rebuilding it picks up changes.

---

### Phase 3: Update tests

**Goal:** All tests pass against the new loader behavior.

#### 3a: Update test helpers

- [ ] In `tests/plugin-loader.test.ts`, update `writePlugin()` helper (line 39-45):
  ```ts
  function writePlugin(dir: string, name: string, code: string): string {
    const distDir = join(dir, name, 'dist');
    mkdirSync(distDir, { recursive: true });
    const filePath = join(distDir, 'index.js');
    writeFileSync(filePath, code, 'utf-8');
    return filePath;
  }
  ```
  Note: test plugin code is now `.js` (ESM), not `.ts`. Test stubs are simple enough that this just means removing type annotations from test plugin source strings.
- [x] Update `writePluginConfig()` helper — config.json stays at plugin root (`plugins/<name>/config.json`), not in `dist/` (unchanged — already correct)

#### 3b: Update individual test cases

- [x] Update all `join(tempDir, 'name', 'index.ts')` path references to `join(tempDir, 'name', 'dist', 'index.js')` throughout the test file
- [x] Update `inferPluginName` tests for new path pattern
- [x] Remove `collectLocalModules` tests (method deleted; tests were exercising the removed multi-file scan)
- [x] Existing tests cover loading from `dist/index.js` (all tests use the updated `writePlugin` helper)
- [x] Existing reload test covers cache-busting (uses globalThis counter across cache-busted imports)
- [x] Update `tests/core/commands/plugin-commands.test.ts` — `.load` expects `dist/index.js`

#### 3c: Run full suite

- [x] `pnpm test` — all 5836 tests pass (196 test files)
- [x] `pnpm typecheck` — passes

**Verification:** `pnpm test` and `pnpm typecheck` both pass. No regressions.

---

### Phase 4: Decouple rss plugin dependencies

**Goal:** Move `rss-parser` and `ipaddr.js` from root `package.json` to a plugin-local `package.json`. The rss bundle is fully self-contained.

- [x] Create `plugins/rss/package.json` with rss-parser and ipaddr.js as dependencies
- [x] Run `cd plugins/rss && pnpm install --ignore-workspace` to create a local `node_modules`
- [x] Add `plugins/*/node_modules` to `.gitignore`
- [x] Update `scripts/build-plugins.ts` to run `pnpm install --ignore-workspace` in plugin dirs with a `package.json` before building
- [x] Rebuilt rss plugin: `dist/index.js` resolves deps from local `node_modules` (355KB bundle)
- [x] Remove `rss-parser` and `ipaddr.js` from root `dependencies`; kept as root `devDependencies` for test resolution (tests import source files directly, not bundles)
- [x] `pnpm build:plugins` builds all plugins including rss from local deps

**Verification:** Root `dependencies` has no plugin-specific packages. `pnpm build:plugins` builds all 9 plugins. rss bundle is self-contained (355KB with rss-parser and ipaddr.js inlined).

---

### Phase 5: Update Dockerfile and CI

**Goal:** Docker builds produce bundled plugins. CI validates the build.

- [x] Update `Dockerfile`: add `RUN pnpm build:plugins` after `COPY plugins/ ./plugins/` and before `RUN pnpm exec tsc --noEmit`
- [x] Dockerfile now copies `scripts/` directory (needed for `build-plugins.ts`)
- [x] Update `pnpm check` script to include `pnpm build:plugins` before typecheck
- [ ] Verify `docker build` succeeds (requires Docker daemon)
- [ ] Verify `docker run` starts the bot and loads all plugins (requires Docker + config)

**Verification:** Dockerfile and `pnpm check` updated. Docker verification deferred to manual testing.

---

### Phase 6: Update documentation

**Goal:** DESIGN.md and PLUGIN_API.md reflect the new architecture.

- [x] Update `DESIGN.md` section 2.5 (Plugin loader): updated discovery/loading description
- [x] Update `DESIGN.md` section 2.2: updated plugin description to mention tsup bundling
- [x] Update `DESIGN.md` hot-reload workflow: edit → `pnpm build:plugins` → `.reload`
- [x] Update `DESIGN.md` minimum viable plugin example to include `tsup.config.ts`
- [x] Update `docs/PLUGIN_API.md`: reflect bundled plugin structure, build instructions
- [x] `CLAUDE.md` — references are general enough, no changes needed
- [x] Update `docs/plans/plugin-architecture-recommendation.md` status to "Implemented"

**Verification:** Documentation accurately describes the current system. No references to the old multi-file reload mechanism remain.

---

### Phase 7: Create scaffold command

**Goal:** `pnpm run scaffold <name>` generates a ready-to-build plugin skeleton.

- [x] Create `scripts/scaffold-plugin.ts` that generates: `index.ts`, `tsup.config.ts`, `config.json`, `README.md`
- [x] Add `"scaffold": "tsx scripts/scaffold-plugin.ts"` to root `package.json` scripts
- [x] Validate plugin name against `SAFE_NAME_RE`
- [x] Refuse to overwrite if plugin dir already exists
- [x] After generating, print: "Run `pnpm build:plugins` to build, then `.load <name>` in the REPL"

**Verification:** `pnpm run scaffold test-scaffold` creates the directory with all files. `pnpm build:plugins` builds it (10 plugins). All error cases tested.

---

### Phase 8: Clean up type imports

**Goal:** Replace `../../src/types` imports with a cleaner path. This is a quality-of-life improvement — esbuild already strips these type imports from bundles, so functionality is unaffected.

- [x] Evaluated options — chose **Option C (leave as-is)** per recommendation: imports work, esbuild strips them, no additional tooling needed
- [ ] ~~Create `src/plugin-api.ts` that re-exports the public plugin types:~~
  ```ts
  export type {
    PluginAPI,
    HandlerContext,
    ChannelHandlerContext,
    HelpEntry,
    PublicUserRecord,
  } from './types';
  ```
- [ ] Evaluate options for clean import paths in plugins:
  - **Option A:** TypeScript path alias in tsconfig.json (`"@hexbot/types": ["./src/types.ts"]`) — works for tsc, but tsup/esbuild needs a plugin to resolve aliases
  - **Option B:** Keep relative imports but shorter — `../../src/plugin-api` instead of `../../src/types` (minimal improvement)
  - **Option C:** Leave as-is — the imports work, esbuild strips them, the path is ugly but harmless
- [ ] If proceeding with a path alias or change: update all `import type` statements across all 9 plugins
- [ ] Verify `pnpm build:plugins` and `pnpm typecheck` both still pass

**Verification:** All plugins compile and bundle. Type imports resolve correctly in IDE.

---

## Config Changes

**Root `package.json`:**

```json
{
  "scripts": {
    "build:plugins": "tsx scripts/build-plugins.ts",
    "scaffold": "tsx scripts/scaffold-plugin.ts",
    "check": "pnpm build:plugins && tsc --noEmit && eslint . && vitest run"
  },
  "devDependencies": {
    "tsup": "^8.0.0"
  }
}
```

After Phase 4, `rss-parser` and `ipaddr.js` move out of root `dependencies`.

**New file: `plugins/rss/package.json`:**

```json
{
  "name": "hexbot-plugin-rss",
  "private": true,
  "type": "module",
  "dependencies": {
    "rss-parser": "^3.13.0",
    "ipaddr.js": "^2.3.0"
  }
}
```

**`.gitignore` additions:**

```
plugins/*/dist/
plugins/*/node_modules/
```

**`.gitignore` removals:**

```
.reload-*.ts    (no longer generated)
```

**`tsconfig.json` addition to `exclude`:**

```json
"exclude": ["node_modules", "dist", "**/.reload-*.ts", "plugins/*/dist"]
```

## Database Changes

None.

## Test Plan

| Test area                        | What to verify                                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Plugin load from `dist/index.js` | Loader finds and imports bundled output                                                                                        |
| Plugin reload with cache-bust    | `.reload` picks up rebuilt bundle via `?t=`                                                                                    |
| Plugin unload lifecycle          | `teardown()`, API disposal, bind cleanup unchanged                                                                             |
| Plugin config merging            | `config.json` at plugin root still merges with `plugins.json` overrides (path derivation changed since file is now in `dist/`) |
| Plugin name inference            | `inferPluginName()` extracts name from `plugins/<name>/dist/index.js` path                                                     |
| Path traversal guard             | Rejects paths outside `pluginDir` (unchanged logic, updated path)                                                              |
| `.load` command                  | Constructs correct `dist/index.js` path                                                                                        |
| `.reload` command                | Calls `reload()` which unloads + reimports                                                                                     |
| Build script                     | `pnpm build:plugins` builds all 9 plugins without errors                                                                       |
| rss standalone deps              | `plugins/rss/package.json` deps install and bundle correctly                                                                   |

## Open Questions

1. **Should `scripts/build-plugins.ts` run tsup in parallel?** Parallel builds are faster but produce interleaved output. At 9 plugins with <100ms each, sequential is fine. Parallel becomes worthwhile at 20+.

2. **Should `.reload` auto-build?** The recommendation mentions this as a possibility — `.reload weather` detects `tsup.config.ts` exists and runs `tsup` before reimporting. This is convenient but adds shell execution to a hot path. Recommend deferring — explicit `pnpm build` then `.reload` is clearer and the build step is well-understood by JS developers.

3. **Phase 8 path alias approach:** Option A (tsconfig path alias) is cleanest for developers but requires an esbuild/tsup plugin to resolve. Option C (leave as-is) costs nothing and the imports are stripped anyway. Recommend Option C unless the `../../src/types` path becomes a documented plugin authoring interface.
