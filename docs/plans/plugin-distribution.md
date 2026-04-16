# Third-Party Plugin Development & Distribution

**Status:** Proposal  
**Date:** 2026-04-16  
**Companion to:** [plugin-isolation.md](plugin-isolation.md)

## Question

How does someone outside the hexbot repo develop, test, and distribute a plugin? How does an end-user install one?

## Context

The [plugin isolation report](plugin-isolation.md) evaluated how to decouple plugin dependencies from the root `package.json`. This document evaluates the same options — plus new ones — through the lens of someone who doesn't have commit access to hexbot.

**Today's third-party story is: there isn't one.**

- Plugins live in `plugins/<name>/` inside the hexbot repo
- Types are imported via `../../src/types` — a path that only works in-tree
- The plugin-loader scans one directory; there is no way to reference a plugin from `node_modules` or an arbitrary path
- No published types package, no test harness, no plugin template repo
- Community sharing happens via "copy this directory into your `plugins/` folder"

**What a third-party plugin author needs:**

1. **A running hexbot instance.** Unlike ESLint rules or Vite plugins, IRC bot plugins can't be meaningfully developed in isolation. Bind handlers fire from IRC events, the DB is real, message queue throttling affects behavior, channel state matters. A types package lets you _compile_, but it doesn't let you _develop_. The realistic workflow is: clone hexbot, get it running, write your plugin in `plugins/`, test it live with `.reload`. This is a strength, not a limitation — the developer always works against the real system with zero mock/production divergence.
2. **Types** — `PluginAPI`, `HandlerContext`, bind signatures, config shapes. Available in the hexbot repo for in-tree development; optionally copied into a template for reference.
3. **A distribution mechanism** — how someone else gets the finished plugin into their bot.
4. **A compatibility contract** — how the author knows which hexbot versions their plugin works with.

**Prior art — how other ecosystems solve this:**

| System                 | Types                  | Testing                     | Distribution                                | Discovery                                               |
| ---------------------- | ---------------------- | --------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| **ESLint**             | `@types/eslint` on npm | `RuleTester` harness        | npm (`eslint-plugin-*`)                     | Config file by name, resolved from `node_modules`       |
| **Vite**               | `vite` exports types   | Run Vite with plugin loaded | npm                                         | `vite.config.ts` by name or import                      |
| **Obsidian**           | `obsidian` on npm      | Mock vault helpers          | Community plugin registry + GitHub releases | In-app browser, or manual clone to `.obsidian/plugins/` |
| **VS Code**            | `@types/vscode` on npm | `@vscode/test-electron`     | VS Code Marketplace                         | Extension ID in marketplace                             |
| **Eggdrop**            | N/A (Tcl is untyped)   | None                        | Copy `.tcl` file                            | `source scripts/foo.tcl` in config                      |
| **Metamod**            | C++ headers in SDK     | Compile against HL SDK      | Copy `.so`/`.dll` to `addons/`              | `plugins.ini`                                           |
| **WordPress**          | N/A (PHP, untyped)     | `WP_UnitTestCase`           | WordPress.org or zip download               | Drop into `wp-content/plugins/`                         |
| **Minecraft (Fabric)** | Fabric API jar         | Run game with mod loaded    | Modrinth / CurseForge / jar download        | Drop jar into `mods/`                                   |
| **Terraform**          | `terraform-plugin-sdk` | `resource.Test()` harness   | Terraform Registry + GitHub releases        | `required_providers` block by name                      |

**Key observation:** The npm/registry model (ESLint, Vite, Terraform) is designed for **libraries consumed by builds** — dependencies resolved at install time, compiled into a bundle, never touched by the developer. The drop-in model (Eggdrop, Metamod, WordPress, Minecraft) is designed for **runtime extensions loaded into a long-running process** — developed against the real host, distributed as self-contained artifacts. hexbot plugins are the latter category.

---

## Options

### Option 1: In-Tree Only (enhanced status quo)

Plugins are always part of the hexbot repo. Third-party contributions come via PRs or copy-paste. No SDK, no npm package, no external resolution.

**Enhancements over today:**

- Extract a `@hexbot/plugin-api` types package internally (not published to npm) so in-tree plugins use clean imports
- Add a `pnpm run scaffold <name>` command that generates the plugin skeleton
- Document the plugin contract clearly in `docs/PLUGIN_API.md`

**Developer experience:**

```
1. Fork hexbot
2. pnpm run scaffold my-plugin
3. Edit plugins/my-plugin/index.ts
4. pnpm test
5. pnpm dev  (run bot with plugin loaded)
6. Open PR — or tell users "clone this into your plugins/ dir"
```

**Pros:**

- Zero infrastructure to maintain — no npm packages, no registry, no versioning headaches
- Plugin authors always develop against the real bot — no mock/production divergence
- Copy-paste distribution is honest about what it is and surprisingly resilient

**Cons:**

- "Clone my repo, copy this folder" is a bad first impression for a community
- Plugin authors must understand the full hexbot repo to contribute
- No way to version a plugin independently from hexbot
- Updating a third-party plugin means re-copying files

**Effort:** S  
**Who it serves:** You and close contributors. Not a broader community.

---

### Option 2: Published SDK + node_modules Resolution

Publish `@hexbot/plugin-api` to npm with types and a test harness. Update the plugin-loader to resolve plugins from `node_modules` in addition to `plugins/`. This is the ESLint/Vite model.

**How it works:**

The SDK package:

```
@hexbot/plugin-api/
  index.ts          — re-exports PluginAPI, HandlerContext, etc.
  test-harness.ts   — createMockAPI() for unit testing
  package.json      — published to npm, semver'd
```

A third-party plugin:

```
hexbot-plugin-weather/
  package.json:
    { "name": "hexbot-plugin-weather",
      "peerDependencies": { "@hexbot/plugin-api": "^1.0.0" },
      "dependencies": { "openweather-sdk": "^3.0.0" } }
  index.ts:
    import type { PluginAPI } from '@hexbot/plugin-api';
    export const name = 'weather';
    export function init(api: PluginAPI) { ... }
```

End-user installation:

```bash
# In hexbot directory
pnpm add hexbot-plugin-weather
```

Plugin-loader change — `plugins.json` gains a `packages` array:

```json
{
  "weather": {
    "package": "hexbot-plugin-weather",
    "config": { "api_key_env": "OPENWEATHER_KEY" }
  }
}
```

The loader resolves `hexbot-plugin-weather` via `import.meta.resolve()` or `createRequire().resolve()` from `node_modules`, then dynamically imports it.

**Developer experience:**

```
1. mkdir hexbot-plugin-weather && cd $_
2. pnpm init
3. pnpm add -D @hexbot/plugin-api
4. Write index.ts with typed PluginAPI
5. pnpm add -D vitest
6. Write tests using createMockAPI()
7. To integration-test: pnpm link into a hexbot instance, add to plugins.json
8. pnpm publish
9. Users: pnpm add hexbot-plugin-weather
```

**Pros:**

- Standard ecosystem pattern — anyone who's written an ESLint or Vite plugin knows this flow
- Plugin authors develop completely independently with full type support
- `peerDependencies` gives a clear compatibility contract (`@hexbot/plugin-api: ^1.0.0`)
- `pnpm add` / `pnpm remove` for install/uninstall — familiar, reliable
- Plugins can have their own repos, CI, changelogs, semver, contributors
- npm search / discoverability for free

**Cons:**

- **You must publish and maintain `@hexbot/plugin-api` on npm.** This is the big one. Every breaking change to `PluginAPI` is a semver major. You're now a library author with downstream consumers, not just a bot author.
- `node_modules` resolution interacts with hot-reload: when the loader `import()`s from `node_modules`, cache-busting with `?t=` still works, but the module graph is deeper (the plugin's own deps are in nested `node_modules`)
- Plugin deps pollute the bot's `node_modules` unless the plugin is bundled (combines with Option C from isolation report)
- Need to decide: does the plugin ship source `.ts` or compiled `.js`? If source, the bot needs `tsx` to load it. If compiled, the author needs a build step.
- The test harness (`createMockAPI()`) must faithfully simulate the real API — maintaining that is ongoing work

**Effort:** L — publish npm package, add `node_modules` resolution to loader, build test harness, write plugin authoring docs, maintain semver  
**Who it serves:** A real community. Appropriate if you want hexbot to be a platform, not just a bot.

---

### Option 3: Drop-In Bundles (Eggdrop model, modernized)

Plugins are distributed as self-contained directories with a pre-built `dist/index.js`. No npm resolution, no workspace — just drop the folder into `plugins/`. The plugin-loader works exactly as it does today.

**How it works:**

The author develops however they want (standalone repo, any build tool). The deliverable is a directory:

```
hexbot-plugin-weather/
  dist/
    index.js        — single bundled ESM file, all deps inlined
  config.json       — default config
  README.md
```

Distribution is via GitHub releases, a zip, or `git clone`:

```bash
cd plugins/
git clone https://github.com/someone/hexbot-plugin-weather.git weather
# Done. Plugin is now at plugins/weather/dist/index.js
```

For types during development, the author either:

- Installs `@hexbot/plugin-api` from npm (if published)
- Or copies the type definitions from hexbot's repo (they're small — ~200 lines)
- Or develops without types and relies on the documented contract

**Developer experience:**

```
1. Clone hexbot-plugin-template (a GitHub template repo you maintain)
2. pnpm install  (gets types + tsup)
3. Write index.ts
4. pnpm build    (tsup bundles to dist/index.js)
5. Copy dist/ into a hexbot's plugins/weather/ to test
6. Push to GitHub
7. Users: git clone into plugins/, or download the release zip
```

**Pros:**

- Lowest friction for end-users — `git clone` and done, or download a zip
- No npm account required for plugin authors
- No `node_modules` resolution changes to the loader — plugins load exactly as they do today
- Self-contained bundles mean zero dependency conflicts between plugins
- Works even if `@hexbot/plugin-api` is never published — a template repo with copied types is enough
- Hot-reload is the simplest case: one file, query-string cache-bust

**Cons:**

- No automated update path — user must manually `git pull` or re-download
- No version resolution — user can install a plugin that's incompatible with their hexbot version and get a runtime error (mitigated: plugin-loader already validates the export contract and catches init failures gracefully)
- Plugin author's build setup is their problem — mitigated by providing a template repo with tsup pre-configured

**Effort:** S — create a template repo, document the contract, optionally publish types  
**Who it serves:** The actual IRC community. This is how Eggdrop, Metamod, WordPress, and Minecraft mods have always worked — and those ecosystems have thrived for decades with this model.

---

### Option 4: CLI Install Command (Obsidian model)

Add a `.install` bot command (or REPL command) that fetches plugins from a known source — npm, a GitHub org, or a simple registry JSON file.

```
.install weather              — resolves to @hexbot/plugin-weather on npm (or hexbot-plugin-weather)
.install github:someone/foo   — clones from GitHub
.install https://example.com/plugin.tar.gz
.uninstall weather
.update weather
```

Under the hood, `.install` either:

- Runs `pnpm add` and symlinks from `node_modules` into `plugins/` (npm source)
- Or `git clone`s into `plugins/` (git source)
- Or downloads + extracts a tarball (URL source)

Then loads the plugin via the existing loader.

**Pros:**

- Best end-user experience — install from the bot itself
- Supports multiple sources (npm, git, URL)
- `.update` gives an upgrade path
- Could maintain a curated plugin list (a JSON file in the hexbot repo or a simple GitHub Pages site)

**Cons:**

- **Significant security surface.** The bot is now downloading and executing arbitrary code from the internet. For an IRC bot that typically runs with network access and may have NickServ credentials, this is a serious trust boundary.
- Must handle: download failures, version conflicts, partial installs, rollback on init failure
- The `.install` command itself needs elevated permissions (only bot owners, never from IRC)
- Maintaining a registry (even a simple JSON file) is ongoing work
- Conflates package management with bot operation — pnpm already does this job

**Effort:** L — implement install/uninstall/update commands, handle multiple sources, security review, REPL-only access control  
**Who it serves:** Users who want a batteries-included experience. But the security implications may outweigh the convenience for an IRC bot.

---

## Comparison

| Criterion                         | 1: In-Tree       | 2: npm SDK             | 3: Drop-In                       | 4: CLI Install           |
| --------------------------------- | ---------------- | ---------------------- | -------------------------------- | ------------------------ |
| Author setup friction             | Low (fork repo)  | Low (npm init)         | Low (clone hexbot)               | Low (npm init)           |
| End-user install friction         | Medium (copy)    | Low (pnpm add)         | Low (clone/download)             | Lowest (.install)        |
| Types available                   | In-tree          | npm package            | In-tree (dev against real bot)   | npm package              |
| Integration testing               | Full bot         | Mock API (incomplete)  | Full bot (always)                | Mock API (incomplete)    |
| Update path                       | git pull         | pnpm update            | git pull / re-download           | .update                  |
| Compatibility contract            | None (same repo) | peerDependencies       | Loader validates on load         | peerDependencies         |
| Security risk                     | None             | Low (npm audit)        | Low (manual trust, you chose it) | High (auto-fetch + exec) |
| Maintenance burden on you         | None             | High (SDK semver)      | Low (template repo)              | High (install infra)     |
| Matches how plugins are developed | Yes              | No (isolated from bot) | Yes                              | No (isolated from bot)   |

---

## Recommendation

**Option 3 (Drop-In Bundles) is the endgame, not a stepping stone.**

**Core argument:** IRC bot plugins are runtime extensions developed against a live host process. The development workflow is inherently in-tree — you need a running bot with an IRC connection, a real database, and live channel state. This means the distribution model only needs to answer one question: _"how does someone else get your finished plugin into their bot?"_ The answer is the same one that has worked for Eggdrop, Metamod, WordPress, and Minecraft for decades: copy the directory.

**Why not graduate to npm (Option 2):**

1. **The npm SDK model assumes isolated development.** It publishes a types package so authors can `npm init` a standalone project and develop without the host. But IRC bot plugins _can't_ be meaningfully developed without the host. A types package lets you compile — it doesn't let you test bind handlers, message queue behavior, channel state, or services integration. If the author needs hexbot running anyway, they already have the types.

2. **Publishing `@hexbot/plugin-api` creates a maintenance liability with no upside.** You become a library author with downstream semver obligations. Every `PluginAPI` change is a potential breaking change you have to think about, even if the only consumers are people who are going to clone hexbot to develop anyway.

3. **`node_modules` resolution adds complexity to the loader for a workflow nobody will use.** Why would a plugin author publish to npm and have users `pnpm add` it, when the user needs to configure `plugins.json` either way? The `pnpm add` step adds nothing over `git clone` — it's ceremony for ceremony's sake.

**Why Option 3 is sufficient at any scale:**

- **Development:** Clone hexbot, write plugin in `plugins/`, test with `.reload`. Types are right there in `src/types.ts`.
- **Distribution:** Push to GitHub. Users `git clone` into `plugins/` or download a release zip.
- **Updates:** `git pull` in the plugin directory, `.reload` in the REPL.
- **Compatibility:** The plugin-loader already validates the export contract (`name`, `init`, optional `teardown`) and catches init failures gracefully. An incompatible plugin fails loudly and safely — the bot keeps running.
- **Dependency isolation:** Bundled `dist/index.js` via tsup. Deps are baked in. No conflicts. No `node_modules`.

**Option 4 is a trap.** It turns an IRC bot into a package manager. The security surface (downloading and executing arbitrary code on a process that holds NickServ credentials) is unjustifiable. `git clone` already exists.

**Concrete next steps:**

1. Create a `hexbot-plugin-template` GitHub template repo containing:
   - `index.ts` with typed `init`/`teardown` skeleton
   - `tsup.config.ts` pre-configured for ESM + bundle-all
   - Copied type definitions from hexbot (small — `PluginAPI`, `HandlerContext`, config shapes)
   - `vitest.config.ts` + example test
   - `README.md` explaining the workflow: clone hexbot to develop, build with tsup, distribute the directory
   - `.github/workflows/build.yml` that produces a release zip

2. Document in `docs/PLUGIN_API.md`:
   - The plugin contract (exports, lifecycle, config)
   - The development workflow (clone hexbot, write plugin, test live)
   - How to install a third-party plugin (clone into `plugins/`)

---

## How This Intersects With Plugin Isolation

This document is the distribution-side companion to [plugin-isolation.md](plugin-isolation.md). The recommendations are compatible:

| Concern             | Isolation Report (internal)                                          | This Report (external)                                |
| ------------------- | -------------------------------------------------------------------- | ----------------------------------------------------- |
| Shipped plugins     | Option C: tsup bundles for plugins with deps, raw `.ts` for zero-dep | Same — shipped plugins are in-tree                    |
| Third-party plugins | Not addressed                                                        | Drop-in bundles (Option 3)                            |
| Types               | Extract internally for clean imports                                 | Available in-tree; copied into template for reference |
| Loader changes      | Prefer `dist/index.js` when present                                  | Same — drop-in bundles use `dist/index.js`            |
| Hot-reload          | Single-file import, query-string bust                                | Same — bundles are single files                       |

Both recommendations converge on the same runtime model: **the plugin-loader imports a single bundled `dist/index.js` file per plugin.** Whether that plugin was built in-tree (isolation report) or by a third party (this report), the loader doesn't care. That's the right abstraction boundary.
