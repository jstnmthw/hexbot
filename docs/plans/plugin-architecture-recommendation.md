# Plugin Architecture Recommendation

**Status:** Implemented  
**Date:** 2026-04-16  
**Based on:** [plugin-isolation.md](plugin-isolation.md), [plugin-distribution.md](plugin-distribution.md)

## Summary

Three questions were evaluated:

1. **Isolation** — How do we decouple plugin dependencies from the root `package.json`?
2. **Distribution** — How does someone outside the repo develop, share, and install a plugin?
3. **Hot-reload** — Is the runtime reload system earning its complexity cost?

After evaluating pnpm workspaces, Turborepo, tsup bundling, npm SDK publishing, and CLI install commands, the recommendation is:

- **All plugins bundle via tsup** to a single `dist/index.js`
- **Drop-in directories** for distribution
- **Keep hot-reload**, but let bundling eliminate the complexity that makes it painful

No tiers. No monorepo tooling. No npm publishing. No plugin registry. These are the right answers because of what hexbot plugins actually are.

---

## The Key Insight

hexbot plugins are **runtime extensions developed against a live host process**. They are not libraries consumed by builds. This distinction determines everything.

The npm/registry model (ESLint, Vite, Terraform) was designed for code that is:

- Developed in isolation with a types package
- Resolved at install time by a package manager
- Compiled into a build artifact
- Never run directly by the developer

hexbot plugins are none of those things. They are:

- Developed inside a running bot with a real IRC connection
- Loaded at runtime via dynamic `import()`
- Hot-reloaded without restarting the process
- Tested by interacting with the bot in a real channel

This puts hexbot in the same category as Eggdrop scripts, Metamod plugins, WordPress plugins, and Minecraft mods — all of which use "copy the directory" for distribution and have sustained large communities for decades doing so.

---

## Hot-Reload: Bundling Kills the Complexity

The hot-reload system has two parts with very different complexity profiles:

**The simple part:** unload a plugin (teardown, dispose API, unbind), then re-import it. This is the `.reload` command users see.

**The complex part:** making Node's ESM loader actually give you fresh code on re-import. Node caches modules by URL, so importing the same file twice returns the cached version. The current loader solves this with:

- **Query-string cache-busting** (`?t=Date.now()`) — works for single-file plugins
- **Multi-file temp-rewrite** (~60 lines) — for multi-file plugins, rewrites all intra-plugin imports to point at uniquely-named temp copies so Node sees each file as new. This is the fragile part: regex-based import rewriting, temp file creation/cleanup, orphan `.reload-*.ts` detection.

The multi-file temp-rewrite exists because of plugins like `chanmod` (25 `.ts` files with `./local` imports between them). Cache-busting the entry `index.ts` with `?t=` doesn't help — its `import './helpers'` still resolves to the cached `helpers.ts`.

### Why bundling eliminates this

If every plugin bundles to a single `dist/index.js`, the multi-file case **never triggers**. All local imports are resolved at build time and inlined into one file. The reload path becomes one thing:

- `?t=` query-string bust on `dist/index.js`. One line. Works perfectly.

That means the entire multi-file temp-rewrite mechanism — `collectLocalModules()`, `buildNameRemap()`, `writeRewrittenFiles()`, the orphan cleanup — can be deleted. Not because we're removing hot-reload, but because the input shape that required it no longer exists.

### Who actually uses reload

The bot author (developing core modules, dispatcher, permissions, loader itself) almost never uses `.reload` — core changes require a restart. The actual workflow is `git pull && docker rebuild`.

But a **plugin author** — someone who cloned hexbot, got it running locally, and is writing a `weather` plugin — their entire dev loop is the reload cycle:

1. Edit `plugins/weather/index.ts`
2. `pnpm build` in plugin dir
3. `.reload weather` in the REPL
4. Test in channel
5. Repeat

They never touch `src/`. They never rebuild Docker. The bot stays connected, channel state is preserved, test user permissions persist. This is a genuinely better dev loop than restarting, and it's the thing that makes hexbot nicer to develop for than Eggdrop (which can't unload at all). The build step is <100ms via esbuild — effectively instant.

---

## Architecture

### Every plugin bundles

One rule for all plugins: **every plugin has a `tsup.config.ts` and builds to `dist/index.js`.** The loader imports `dist/index.js`. No tiers, no fallback paths, no "does this plugin need a build step?" decisions.

This eliminates an entire class of questions:

- "When do I need to add `tsup.config.ts`?" — Always. The scaffold generates it.
- "My single-file plugin grew to two files, what do I do?" — Nothing new. It already bundles.
- "Does the loader handle raw `.ts` or bundled `.js`?" — Always `.js`.

The build step is <100ms per plugin via esbuild. The scaffold command generates the `tsup.config.ts` automatically. Every JS developer already understands "build before run."

Plugins with external dependencies additionally get a `package.json` declaring those deps. Plugins without external deps get a `tsup.config.ts` only — tsup bundles their source files into one output with zero config beyond the entry point.

### How the plugin-loader changes

**Changed:** the loader imports `plugins/<name>/dist/index.js` for every plugin. No resolution fallback.

**Removed:** the multi-file temp-rewrite mechanism — `collectLocalModules()`, `buildNameRemap()`, `writeRewrittenFiles()`, orphan `.reload-*.ts` cleanup, the raw `.ts` import path. ~100 lines of the most fragile code in the loader.

**Kept:** `.load` / `.unload` / `.reload`, `teardown()` lifecycle, API disposal, bind cleanup, event listener cleanup, `?t=` query-string cache-busting.

```
plugin-loader resolution:
  plugins/<name>/dist/index.js    (always)

plugin-loader commands:
  .load <name>      import + init
  .unload <name>    teardown + dispose API + unbind all
  .reload <name>    unload + reimport with ?t= cache-bust
  .plugins          list loaded plugins
```

The reload path is now always the same: one file, one `import()` with a query-string bust. No temp files, no import rewriting, no branching on file count.

### Plugin structure

**Minimal plugin (no external deps):**

```
plugins/8ball/
  index.ts                  source
  tsup.config.ts            bundles to dist/index.js
  config.json               default config (optional)
  dist/
    index.js                bundled ESM output
```

**Plugin with external deps:**

```
plugins/rss/
  index.ts                  source
  feed-fetcher.ts
  feed-store.ts
  feed-formatter.ts
  url-validator.ts
  tsup.config.ts            bundles to dist/index.js
  package.json              declares rss-parser, ipaddr.js
  config.json               default config
  dist/
    index.js                single bundled ESM file (all deps inlined)
  README.md
```

```ts
// tsup.config.ts (same for all plugins)
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  noExternal: [/.*/], // bundle all deps
  external: ['better-sqlite3'], // except native addons
});
```

```json
// package.json (only needed if the plugin has external deps)
{
  "name": "hexbot-plugin-rss",
  "private": true,
  "type": "module",
  "dependencies": {
    "rss-parser": "^3.13.0",
    "ipaddr.js": "^2.3.0"
  },
  "scripts": {
    "build": "tsup"
  }
}
```

### How third-party development works

```
1. Clone hexbot, get it running
2. pnpm run scaffold my-thing       (generates index.ts + tsup.config.ts + config.json)
3. pnpm build in plugin dir, then .load my-thing
4. Edit, pnpm build, .reload my-thing, test — repeat
5. Push to GitHub when done
```

Every plugin follows the same workflow. No decisions about tiers or build steps — the scaffold sets everything up.

The development phase is always in-tree against the real bot. The distribution phase is "copy the directory." This is honest about how the software actually works.

### How an end-user installs a third-party plugin

```bash
cd plugins/
git clone https://github.com/someone/hexbot-plugin-weather.git weather

# If plugin has deps (has dist/index.js already built):
#   Done. The release includes the bundle.

# If plugin is source-only:
#   cd weather && pnpm install && pnpm build
```

Then add config in `plugins.json` and `.load weather` from the REPL (or restart).

Updates: `cd plugins/weather && git pull` then `.reload weather` (or restart the bot).

---

## What We Explicitly Don't Do

### Don't publish `@hexbot/plugin-api` to npm

Publishing a types package to npm creates a semver maintenance obligation with zero benefit. Plugin authors need a running hexbot to develop — they already have the types in `src/types.ts`. A published package would only serve people who want to compile without the bot, which is a workflow that produces untestable code.

If this is ever revisited, the bundled output format stays the same. Publishing types is purely additive and can happen at any time without breaking anything.

### Don't add `node_modules` resolution to the loader

The loader scans `plugins/` for directories. There is no reason to also resolve from `node_modules` — it would add complexity to the loader for a workflow where `pnpm add hexbot-plugin-foo` does nothing that `git clone` doesn't already do. The user still needs to configure `plugins.json` either way.

### Don't build a plugin install command

An IRC bot that downloads and executes arbitrary code from the internet is a security liability. The bot holds NickServ credentials, has network access, and runs as a long-lived process. `git clone` exists. The user can evaluate the code before loading it.

### Don't adopt Turborepo or monorepo tooling

Turborepo's value is parallelizing and caching builds across many packages for teams with parallel workstreams. With one developer and <30 plugins where most have no build step at all, the overhead exceeds the benefit. If the plugin count grows to where build time matters, Turborepo can be layered on later — it works with the same `package.json`-per-plugin structure.

---

## Implementation Plan

### Phase 1: Bundle all plugins + simplify loader

**Goal:** Move every plugin to bundled output and delete the multi-file temp-rewrite.

1. Add `tsup.config.ts` to all 9 plugins (identical config for all)
2. Add `plugins/rss/package.json` with `rss-parser` and `ipaddr.js` (only plugin with external deps)
3. Build all plugins: each produces `dist/index.js`
4. Update plugin-loader: always import `dist/index.js`, remove raw `.ts` fallback
5. Delete from plugin-loader:
   - `collectLocalModules()` — recursive `.ts` file discovery
   - `buildNameRemap()` — temp file name mapping
   - `writeRewrittenFiles()` — import rewriting + temp file creation
   - Orphan `.reload-*.ts` cleanup
   - The `allFiles.size > 1` branch in `importWithCacheBust()`
   - The raw `.ts` import path
6. Keep: `importWithCacheBust()` with only the `?t=` query-string path, `reloadPlugin()`, all lifecycle management
7. Remove `rss-parser` and `ipaddr.js` from root `package.json`
8. Add `plugins/*/dist/` to `.gitignore`
9. Add `pnpm build:plugins` script that runs tsup in every plugin dir
10. Update Dockerfile to run `pnpm build:plugins`
11. Update `pnpm run scaffold` to generate `tsup.config.ts` automatically
12. Update tests — remove multi-file reload test cases, add bundled-plugin load/reload tests

**Expected deletion:** ~100 lines from `plugin-loader.ts` (the multi-file path), plus associated test code.  
**Net result:** `.reload` still works for all plugins. The loader is simpler. Every plugin builds the same way.

### Phase 2: Clean up type imports

**Goal:** Remove `../../src/types` imports from plugins.

1. Create `src/plugin-api.ts` that re-exports the public plugin types
2. Add a path alias or a simple `types.d.ts` in the plugin template so plugins can import types cleanly
3. Update existing plugins to use the new import path

### Phase 3: Template repo + documentation

**Goal:** Make it easy for someone else to write a plugin.

1. Create `hexbot-plugin-template` GitHub template repo:
   - `index.ts` with typed `init`/`teardown` skeleton
   - `tsup.config.ts` pre-configured
   - Copied type definitions for reference
   - Example test
   - README with the development workflow
   - GitHub Actions workflow that builds and creates a release zip
2. Document in `docs/PLUGIN_API.md`:
   - The plugin contract (exports, lifecycle, config)
   - Development workflow (clone hexbot, write plugin, test live)
   - How to install a third-party plugin

---

## Risk Assessment

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                    |
| ------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------- |
| tsup bundling breaks a dep (native addon, `__dirname` usage) | Low        | Medium | Externalize problematic deps; test each new dep plugin                                        |
| Plugin author ships broken `dist/index.js`                   | Medium     | Low    | Loader already catches init failures; bot keeps running                                       |
| Bundled deps duplicate across plugins                        | Low        | None   | At this scale, duplicate code size is negligible                                              |
| Community wants npm install workflow                         | Very low   | None   | Can be added later without changing anything already built                                    |
| Type definitions in template drift from real API             | Medium     | Low    | Template README directs authors to develop against real bot; types are reference only         |
| Reload requires build step                                   | Certain    | Low    | esbuild is <100ms; could wire `.reload` to auto-build. Every JS dev already understands this. |
