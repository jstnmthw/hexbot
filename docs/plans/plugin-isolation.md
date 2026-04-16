# Plugin Dependency Isolation

**Status:** Proposal  
**Date:** 2026-04-16  
**Author:** Claude (reason skill)

## Question

How should hexbot decouple plugin dependencies from the root `package.json` so that plugins are isolated units that declare and manage their own dependencies?

## Context

**Current state:**

- 9 shipped plugins; only `rss` has external deps (`rss-parser`, `ipaddr.js`)
- All deps live in root `package.json` — adding/removing a plugin mutates the root dep tree
- Plugins are loaded via dynamic ESM `import()` with query-string cache-busting (single-file) and temp-file rewriting (multi-file)
- Robust lifecycle isolation already exists: API disposal, namespace-scoped DB, bind tagging, event listener cleanup
- Runtime is `tsx` (no pre-compile for dev); build is `tsc` to `dist/`
- pnpm 10.32, Node >= 24, ESM throughout, strict TypeScript

**Constraints:**

- Hot-reload is a core feature — plugins must be loadable/unloadable/reloadable without restart
- Plugins are in-process (same event loop), not separate processes
- Plugin authors currently import `../../src/types` for the `PluginAPI` type — this coupling needs addressing regardless of option
- The multi-file cache-busting mechanism (~60 lines of temp-file rewrite in `plugin-loader.ts`) is the most fragile part of the loader

**Scale:**

- ~10 plugins now, likely 20-30 at maturity
- 2 external deps across all plugins today, maybe 5-10 at maturity
- Single developer, not a team with parallel workstreams

---

## Options

### Option A: pnpm Workspaces (monorepo, no bundling)

Each plugin gets its own `package.json` and declares its own dependencies. The root `pnpm-workspace.yaml` lists `plugins/*` as workspace packages. A shared `@hexbot/types` package exports `PluginAPI` and friends.

```yaml
# pnpm-workspace.yaml
packages:
  - 'plugins/*'
  - 'packages/*' # shared types package
```

```json
// plugins/rss/package.json
{
  "name": "@hexbot/plugin-rss",
  "dependencies": {
    "rss-parser": "^3.13.0",
    "ipaddr.js": "^2.3.0"
  },
  "devDependencies": {
    "@hexbot/types": "workspace:*"
  }
}
```

pnpm installs per-plugin deps via its content-addressable store (deduped on disk). pnpm catalogs can centralize version pinning for shared deps.

**Pros:**

- Standard monorepo pattern — well-documented, widely understood
- `pnpm install` handles everything; no custom build tooling per plugin
- pnpm catalogs keep shared dep versions in sync from one place
- Plugin authors just add deps to their own `package.json`

**Cons:**

- ESM + symlinks = real-path resolution headaches (Node follows symlinks, so two plugins importing the same dep can get different module instances)
- Each plugin needs its own `tsconfig.json` for clean compilation
- Hot-reload mechanism unchanged — still need the cache-busting dance, and now module resolution goes through workspace symlinks which can confuse the temp-file rewrite
- `N x package.json` + `N x tsconfig.json` boilerplate for simple plugins like `8ball` (1 file, 0 deps)

**Effort:** M — restructure dirs, add per-plugin `package.json`/`tsconfig.json`, extract types package, update plugin-loader resolution  
**Compatibility:** Requires updating plugin-loader to resolve from workspace-linked `node_modules` rather than root

---

### Option B: pnpm Workspaces + Turborepo

Same as Option A, but add Turborepo on top for task orchestration, caching, and `turbo watch`.

```json
// turbo.json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["^build"] },
    "dev": { "persistent": true }
  }
}
```

Turborepo understands the dependency graph between packages: when you change `@hexbot/types`, it knows to rebuild all plugins that depend on it. `turbo watch` re-runs builds on file change. Remote caching can speed up CI.

**Pros:**

- All of Option A's pros, plus intelligent task scheduling
- Cached builds — if a plugin hasn't changed, skip its build entirely
- `turbo watch` provides dependency-aware rebuild on file changes
- JIT strategy available — plugins export raw `.ts`, consumer transpiles (no per-plugin build step)

**Cons:**

- All of Option A's cons, plus added tooling complexity
- Turborepo is a build orchestrator for teams — it solves a coordination problem that doesn't exist with 1 developer and 10 plugins
- `turbo watch` has known rough edges with dependent rebuilds
- JIT strategy conflicts with hot-reload: if plugins export raw `.ts` and the host transpiles, you're back to the single-compilation problem
- The caching wins are marginal at this scale — `tsc` for 10 small plugins is already fast

**Effort:** L — everything in Option A plus `turbo.json` config, CI integration, understanding the task graph model  
**Compatibility:** Same resolution issues as A, plus Turborepo opinions about project structure

---

### Option C: tsup-Bundled Plugins (per-plugin build to single file)

Each plugin with external deps gets a `package.json` (for deps) and a `tsup.config.ts`. tsup uses esbuild to bundle each plugin into a single self-contained `.js` file with all dependencies inlined. The host bot imports one file per plugin.

```ts
// plugins/rss/tsup.config.ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  noExternal: [/.*/], // bundle everything in
  external: ['better-sqlite3'], // except native addons
});

// Output: plugins/rss/dist/index.js  (single file, rss-parser baked in)
```

The plugin-loader's `import()` targets `plugins/<name>/dist/index.js` when it exists. Cache-busting stays the same (query-string on a single file — no multi-file temp rewrite needed).

**Tiered approach:** Zero-dep plugins (8ball, greeter, seen, ctcp, help) continue loading raw `.ts` via `tsx` as today. Only plugins with external deps get the build step.

**Pros:**

- Maximum isolation — each plugin is a single self-contained ESM module
- Cleanest hot-reload: single-file `import()` with query-string bust, no symlink games, no multi-file temp rewrite needed for bundled plugins
- Plugin deps are _gone_ at runtime — they're baked into the bundle. No resolution, no `node_modules`
- The `../../src/types` import problem disappears — types are dev-only and stripped by esbuild
- Simple plugins don't pay any boilerplate tax

**Cons:**

- Adds a build step per plugin before reload (esbuild is fast: <100ms per plugin, but it's a step)
- Native addons (e.g., `better-sqlite3` if a plugin ever imports it directly) must be externalized
- Duplicates bundled code if two plugins depend on the same library (at this scale, negligible)
- `__dirname` / `import.meta.url` inside bundled deps may need esbuild shims

**Effort:** M — add tsup config per plugin with deps, update plugin-loader to prefer `dist/index.js`, make simple plugins opt-out of bundling  
**Compatibility:** Simplifies the plugin-loader (removes multi-file rewrite path for bundled plugins)

---

### Option D: pnpm Workspaces + tsup (hybrid)

Workspace structure for development ergonomics (per-plugin deps, types package, pnpm catalogs) but each plugin builds to a single bundled file via tsup. The plugin-loader always imports the bundled output.

```yaml
# pnpm-workspace.yaml
packages:
  - 'plugins/*'
  - 'packages/*'

catalog:
  better-sqlite3: ^12.8.0
  vitest: ^4.1.4
```

```json
// plugins/rss/package.json
{
  "dependencies": { "rss-parser": "catalog:" },
  "scripts": { "build": "tsup" }
}
```

Development uses workspace resolution (IDE autocomplete, type checking across packages). Runtime uses bundled output (clean single-file imports).

**Pros:**

- Best of both worlds — workspace for dev, bundles for runtime
- pnpm catalogs centralize version pinning
- IDE experience is great — each plugin is a proper package with typed deps
- Hot-reload is clean — single bundled file per plugin
- Can extract `@hexbot/plugin-api` as a proper typed package for third-party plugin authors

**Cons:**

- Most complex setup — workspace + per-plugin tsup + catalogs
- Two mental models: workspace resolution at dev time, bundled output at runtime
- Simple zero-dep plugins pay a boilerplate tax: `package.json` + `tsup.config.ts` for a 40-line file
- Need to keep tsup externals in sync with what the host provides

**Effort:** L — full monorepo restructure plus per-plugin build configs  
**Compatibility:** Clean separation but significant migration from current flat structure

---

## Comparison

| Criterion              | A: pnpm WS          | B: + Turborepo      | C: tsup Bundle      | D: WS + tsup    |
| ---------------------- | ------------------- | ------------------- | ------------------- | --------------- |
| Dep isolation          | Strong              | Strong              | Maximum             | Maximum         |
| Hot-reload impact      | Unchanged (complex) | Unchanged (complex) | Simplified          | Simplified      |
| Boilerplate per plugin | High                | Higher              | Low (tiered)        | High            |
| Build complexity       | Low                 | Medium              | Low                 | Medium          |
| Effort                 | M                   | L                   | M                   | L               |
| Scales to 30 plugins   | Yes                 | Yes                 | Yes                 | Yes             |
| Upgrade path           | Add tsup later      | Already maximal     | Add workspace later | Already maximal |

---

## Recommendation

**Option C: tsup-Bundled Plugins**, with a tiered approach. **Confidence: High.**

**Why:**

1. **The real problem is narrow.** 2 external deps across 9 plugins. Options A, B, and D restructure the entire project to solve a problem that currently affects 1 plugin.

2. **Hot-reload is king.** The multi-file temp-rewrite is the most fragile part of `plugin-loader.ts`. Bundled plugins reduce every plugin to a single-file import, which eliminates the multi-file path entirely. This is a simplification, not added complexity.

3. **Scale matches the approach.** Turborepo's value is parallelizing builds across many packages for teams. With 1 developer and <30 plugins, `pnpm run --filter ./plugins/* build` is fast enough. Turborepo can be added later if the build becomes slow — the workspace structure is the same.

4. **Tiered loading preserves simplicity for simple plugins:**
   - **Zero-dep plugins** (8ball, greeter, seen, ctcp, help): Load raw `.ts` via `tsx` as today. No build step, no config.
   - **Plugins with external deps** (rss, and future ones): Get `package.json` + `tsup.config.ts`, build to `dist/index.js`, plugin-loader imports the bundle.

5. **Migration path is clean.** Start with just the `rss` plugin. That's a single PR that proves the pattern. Then migrate other plugins to bundled output if/when they gain deps.

6. **Upgrades to D are easy.** If you later want workspace structure for IDE ergonomics or a shared types package, you can add `pnpm-workspace.yaml` entries around the existing per-plugin `package.json` files. The runtime output is identical.

---

## What Eggdrop Does

Eggdrop has no dependency management. Tcl scripts use `package require <name>` to request system-level Tcl packages — if they're not installed, the script fails at load time. There's no per-script manifest, no isolation, and no version pinning. All scripts share one Tcl interpreter and global namespace; name collisions are common.

Eggdrop's `.rehash` re-sources config and scripts but **cannot unload** previously sourced code. Scripts that need cleanup must bind to `evnt PRERESTART` manually.

**Lessons for hexbot:**

- Eggdrop's `package require` pattern (soft-check for optional deps, fail gracefully) is worth borrowing: plugins with optional deps should catch import failures and degrade rather than crash
- Eggdrop's inability to unload validates hexbot's API-disposal + bind-tagging system — don't regress on this
- The shared-namespace collisions validate hexbot's scoped plugin APIs — maintain the property that plugins can't accidentally share state regardless of isolation option chosen

---

## Implementation Sketch (Option C)

### Phase 1 — Prove the pattern with `rss`

1. Add `plugins/rss/package.json` with `rss-parser` and `ipaddr.js` as deps
2. Add `plugins/rss/tsup.config.ts` (ESM, bundle all, externalize `better-sqlite3`)
3. Run `cd plugins/rss && pnpm install && pnpm build`
4. Update plugin-loader: if `dist/index.js` exists, import it instead of `index.ts`
5. Remove `rss-parser` and `ipaddr.js` from root `package.json`
6. Verify hot-reload still works (now simpler — single file, query-string bust only)

### Phase 2 — Extract plugin types

1. Create `packages/plugin-api/` with `PluginAPI`, `HandlerContext`, etc. exported
2. Plugins import `@hexbot/plugin-api` instead of `../../src/types`
3. This is a dev-only import — esbuild strips it from bundles

### Phase 3 — Add `pnpm build:plugins` script

1. Script discovers plugins with `tsup.config.ts` and runs their builds
2. Add to `pnpm check` pipeline
3. Add `.reload` REPL command option that builds + loads in one step
