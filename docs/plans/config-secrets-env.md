# Plan: Config Secrets Migration to `.env`

> **Superseded (2026-04-05):** this plan shipped with bare env var names (e.g. `NICKSERV_PASSWORD`). They have since been renamed to `HEX_`-prefixed equivalents (`HEX_NICKSERV_PASSWORD`, `HEX_BOTLINK_PASSWORD`, `HEX_CHANMOD_RECOVERY_PASSWORD`, `HEX_PROXY_PASSWORD`, `HEX_GEMINI_API_KEY`) to namespace them on shared hosts. Current canonical names live in `config/bot.env.example`. The rest of this doc is left intact as the historical decision record.

## Summary

Extract all secrets from `config/bot.json` into environment variables, resolved via a `_env` suffix convention in the JSON schema. Non-secret structure stays in JSON; secrets live in `.env` (loaded by Node's built-in `--env-file` flag). This makes `bot.json` freely shareable/re-copyable without credential loss and scales cleanly to multi-instance deployments via per-bot `.env.<network>` files.

**Hard cutover**: secrets only exist in env vars. No inline-value fallback. Live deployments migrate in lockstep with the code change.

**Branching note**: this refactor lands on `main` independently of the `feature/ai-chat-plugin` branch. The plugin-loader will gain generic `_env` resolution (Phase 5) so that when ai-chat merges, its existing `process.env.GEMINI_API_KEY` read in `plugins/ai-chat/index.ts:266` can be migrated to `api.config.api_key` as part of that merge. See "Follow-up: ai-chat branch merge" at the bottom of this doc.

## Feasibility

- **Alignment**: Codifies a pattern already half-adopted by ai-chat. Aligns with DESIGN.md's one-process-per-network model and the existing `--config` flag (see `src/index.ts:58-61`, `src/bot.ts:102-103`).
- **Dependencies**: Node 20.6+ for `--env-file` (already required — see `package.json` scripts).
- **Blockers**: None.
- **Complexity**: M — one new loader function, schema/type updates, doc rewrites, test coverage.
- **Risk areas**: Migration of live deployment (user's own bot). Startup validation must fail loudly and clearly when env vars are missing.

## Semantics

**Convention**: any JSON field with an `_env` suffix names an environment variable. The loader:

1. Walks the parsed JSON tree recursively.
2. For each `<field>_env: "VAR_NAME"` pair where the value is a string, reads `process.env.VAR_NAME`.
3. If the env var is set, emits `<field>: <env value>` in the resolved config and drops the `_env` key.
4. If the env var is unset, drops both keys (field remains `undefined`).
5. After resolution, a validation pass checks that required secrets are present given their feature flags.

**Rules:**

- `_env` fields always hold a **string naming an env var**, never the secret itself.
- Naming: bare vars, no prefix (e.g. `NICKSERV_PASSWORD`, not `HEXBOT_NICKSERV_PASSWORD`).
- Plugins never read `process.env` directly. Plugin configs may declare their own `*_env` fields; the loader resolves them before the plugin sees its config.
- Hard cutover: the runtime config shape no longer has inline secret fields (e.g. `ServicesConfig.password_env: string` replaces `password: string` in the on-disk schema). After resolution, internal code still sees `services.password` — the resolver populates it from env.

**Env vars introduced:**

| On-disk field                        | Env var                                 | Required when                                                     |
| ------------------------------------ | --------------------------------------- | ----------------------------------------------------------------- |
| `services.password_env`              | `NICKSERV_PASSWORD`                     | `services.sasl: true` AND `services.sasl_mechanism != "EXTERNAL"` |
| `botlink.password_env`               | `BOTLINK_PASSWORD`                      | `botlink.enabled: true`                                           |
| `chanmod.nick_recovery_password_env` | `CHANMOD_RECOVERY_PASSWORD`             | `chanmod` plugin loaded AND nick recovery used                    |
| `proxy.password_env`                 | `PROXY_PASSWORD`                        | `proxy.enabled: true` AND `proxy.username` set                    |
| `irc.channels[].key_env`             | per-channel (e.g. `CHANNEL_KEY_SECRET`) | Channel requires a +k key                                         |

The ai-chat plugin's `GEMINI_API_KEY` is migrated separately when its feature branch merges — see follow-up section.

## Phases

### Phase 1: `_env` resolver

**Goal:** Add the recursive resolver that walks loaded JSON and substitutes `_env` fields from `process.env`.

- [ ] Create `src/config.ts` (or add to `src/bot.ts` if it belongs there): export `resolveSecrets<T>(obj: T): T`
- [ ] Implement recursive walk: handles plain objects, arrays, primitives; pattern-matches `^(.+)_env$` keys; requires sibling value to be a string
- [ ] For each matched `_env` key: read `process.env[value]`, set `result[siblingKey] = envValue` if defined, drop the `_env` key
- [ ] Preserve original key order where practical (for deterministic debug dumps)
- [ ] Do NOT mutate the input object — return a new object
- [ ] Handle the edge case: `_env` key with non-string value (array, object, number) → leave as-is, emit a warning
- [ ] Handle the edge case: both `field` and `field_env` present in the same object → `_env` wins, emit a warning (config drift)

**Verification:** Unit tests cover: flat object, nested object, arrays of objects (for `irc.channels`), primitives, missing env var, non-string `_env` value, both forms present.

### Phase 2: Schema and type updates

**Goal:** Update the on-disk config schema in `src/types.ts` to use `_env` fields for all secrets, while keeping the resolved runtime shape (what code reads) unchanged.

- [ ] Split each config interface into two: `<Name>OnDisk` (raw JSON shape with `_env` fields) and `<Name>` (resolved, what core code uses)
- [ ] `ServicesConfig`: change `password: string` → on-disk has `password_env: string`, resolved has `password: string`
- [ ] `BotlinkConfig`: change `password: string` → `password_env: string` on-disk
- [ ] `ChanmodBotConfig`: change `nick_recovery_password?: string` → `nick_recovery_password_env?: string` on-disk
- [ ] `ProxyConfig`: change `password?: string` → `password_env?: string` on-disk
- [ ] `ChannelEntry`: change `key?: string` → `key_env?: string` on-disk
- [ ] `BotConfig` top-level: the on-disk variant composes `*OnDisk` interfaces; `resolveSecrets()` returns the runtime `BotConfig`
- [ ] Update `src/bot.ts` `loadConfig()` (around line 507) to: parse JSON → cast to on-disk type → call `resolveSecrets()` → cast to runtime type → validate
- [ ] No changes needed in consumers of `BotConfig` — they still see `services.password`, `botlink.password`, etc.

**Verification:** `pnpm typecheck` passes. Existing consumers of the resolved config compile without changes.

### Phase 3: Startup validation

**Goal:** Fail loudly at startup if a required env var is missing for an enabled feature.

- [ ] Add `validateResolvedSecrets(cfg: BotConfig): void` in `src/config.ts`
- [ ] Rule: `services.sasl === true && services.sasl_mechanism !== "EXTERNAL"` → require non-empty `services.password`; fail with `[config] NICKSERV_PASSWORD must be set (services.sasl is true). Set it in .env or disable SASL.`
- [ ] Rule: `botlink?.enabled === true` → require non-empty `botlink.password`; fail with `[config] BOTLINK_PASSWORD must be set (botlink.enabled is true).`
- [ ] Rule: `proxy?.enabled === true && proxy.username` → require `proxy.password`; fail with `[config] PROXY_PASSWORD must be set (proxy.username is configured).`
- [ ] Rule: any `irc.channels[i]` that had a `key_env` declared but resolved to empty → fail with `[config] Channel key env var for <channel> is unset.`
- [ ] Call `validateResolvedSecrets()` after `resolveSecrets()` in `loadConfig()`, before returning
- [ ] chanmod: validation happens in the plugin itself on load (plugin-scoped concern)

**Verification:** Tests for each rule — enable feature, omit env var, assert startup fails with the expected message.

### Phase 4: Example configs and `.env.example`

**Goal:** Update the templates operators copy from.

- [ ] Update `config/bot.example.json`:
  - [ ] `services.password` → `services.password_env: "NICKSERV_PASSWORD"`
  - [ ] `botlink.password` → `botlink.password_env: "BOTLINK_PASSWORD"`
  - [ ] `chanmod.nick_recovery_password` → `chanmod.nick_recovery_password_env: "CHANMOD_RECOVERY_PASSWORD"`
  - [ ] `proxy.password` field → `proxy.password_env: "PROXY_PASSWORD"` (even though proxy has no password in current example)
  - [ ] `irc.channels` keyed-channel example: `{ "name": "#secret", "key": "password" }` → `{ "name": "#secret", "key_env": "CHANNEL_KEY_SECRET" }`
  - [ ] Update the `_comment_` fields near changed sections to describe the env-var pattern
- [ ] Update `.env.example` with every known secret name, grouped and commented:

  ```bash
  # Required when services.sasl is true
  NICKSERV_PASSWORD=

  # Required when botlink.enabled is true
  BOTLINK_PASSWORD=

  # Required when chanmod plugin uses nick recovery
  CHANMOD_RECOVERY_PASSWORD=

  # Required when proxy.enabled is true and proxy.username is set
  PROXY_PASSWORD=

  # Channel keys (one per keyed channel — name matches key_env in bot.json)
  CHANNEL_KEY_SECRET=
  ```

- [ ] Verify `.gitignore` still excludes `.env` (it does via implicit patterns — confirm and add `.env` explicitly if missing)
- [ ] Do NOT add `GEMINI_API_KEY` to `.env.example` on `main` — that lives on the ai-chat branch and gets added there

**Verification:** `cp config/bot.example.json config/bot.json && cp .env.example .env`, populate `.env`, bot starts successfully.

### Phase 5: Plugin-loader support for `_env` in plugin configs

**Goal:** Make the `_env` resolver available to every plugin's config, so plugins can declare their own secret fields and the loader resolves them before the plugin's `init` runs.

- [ ] In `src/plugin-loader.ts`: after merging plugin defaults with `plugins.json` overrides, call `resolveSecrets()` on the result before calling the plugin's init handler
- [ ] Document the convention in `docs/PLUGIN_API.md` (or wherever the plugin config resolution is described): plugins may declare `<field>_env: "VAR"` in their `config.json` or in `plugins.json` overrides, and the value will be resolved from `process.env` before the plugin sees its config
- [ ] Plugin authors can validate required secrets in their plugin's init and fail the load with a clear message
- [ ] Note in the docs: plugins must never read `process.env` directly — use the resolved config

**Verification:** A test plugin with a `foo_env: "TEST_SECRET_X"` field receives `cfg.foo === "resolved-value"` when `TEST_SECRET_X` is set. No plugins on `main` currently declare `_env` fields (ai-chat is on a feature branch), so this is infrastructure-only on `main`.

### Phase 6: Multi-instance DX

**Goal:** Make the multi-instance / multi-network workflow obvious and documented.

- [ ] Add example multi-instance scripts in `package.json`:
  ```json
  "start:example": "tsx --env-file=.env.example-net src/index.ts --config=config/bot.example-net.json"
  ```
  (a real example that won't be committed accidentally — just a template comment)
- [ ] Document the multi-instance pattern in `README.md`:
  - Each bot gets its own `config/bot.<network>.json` + `.env.<network>` + `data/hexbot-<network>.db`
  - Run with `tsx --env-file=.env.<network> --config=config/bot.<network>.json src/index.ts`
  - Link bots via `botlink` for cross-network coordination
- [ ] Add a commented example systemd unit to `docs/` showing `EnvironmentFile=` + `--config=` per instance
- [ ] Add a commented `docker-compose.yml` snippet to `docs/` showing `env_file:` + `command:` per instance

**Verification:** Manually start two bots on different networks (or same network with different nicks to test botlink) using the documented pattern.

### Phase 7: Security docs

**Goal:** Update SECURITY.md to reflect the enforced pattern.

- [ ] `docs/SECURITY.md` line 138: keep the "plugins must not access `process.env`" rule; add that secrets flow through resolved `api.config` via the `_env` convention
- [ ] `docs/SECURITY.md` line 199 ("example configs must never contain real credentials"): reinforce — example configs should use `_env` references, which cannot contain a real secret by construction
- [ ] `docs/SECURITY.md` line 201: rewrite — "secrets live in `.env`, referenced via `_env` suffix in bot.json or plugin config. Plugin configs may declare their own `_env` fields; the loader resolves them."
- [ ] Add a new subsection "Env var handling" covering: never log resolved secret values, never include env names that don't belong (e.g. don't reference `AWS_SECRET_ACCESS_KEY` just because it's in the ambient env), validate at startup

**Verification:** Doc matches implemented behavior. No stale references to inline `services.password` etc.

### Phase 8: Tests

**Goal:** Full coverage of the resolver, validation, and plugin-loader integration.

- [ ] `tests/config-secrets.test.ts` (new):
  - [ ] `resolveSecrets` resolves a flat `_env` field from process.env
  - [ ] `resolveSecrets` resolves nested `_env` fields
  - [ ] `resolveSecrets` resolves `_env` fields inside arrays (for `irc.channels`)
  - [ ] `resolveSecrets` drops the `_env` key when env is unset (does not leave it in output)
  - [ ] `resolveSecrets` emits a warning when `_env` value is not a string
  - [ ] `resolveSecrets` emits a warning and prefers `_env` when both forms present
  - [ ] `resolveSecrets` does not mutate input
  - [ ] `validateResolvedSecrets` passes when SASL enabled + NICKSERV_PASSWORD set
  - [ ] `validateResolvedSecrets` fails when SASL enabled + NICKSERV_PASSWORD unset
  - [ ] `validateResolvedSecrets` passes when SASL disabled + NICKSERV_PASSWORD unset
  - [ ] `validateResolvedSecrets` covers botlink, proxy, channel key cases
- [ ] `tests/plugin-loader-secrets.test.ts` (or add to existing plugin-loader tests): plugin config `_env` fields are resolved before init (use a fixture test plugin, since no real plugins on `main` declare `_env` fields yet)
- [ ] Existing bot-boot tests: update any test fixtures that inlined `services.password` or `botlink.password` to use env vars + resolver

**Verification:** `pnpm test` passes, coverage does not regress.

### Phase 9: Migration notes for the live deployment

**Goal:** Give the operator (user) a concrete checklist for migrating their live bot in one session.

- [ ] Add `docs/MIGRATION-env-secrets.md` (or append to CHANGELOG.md) documenting:
  1. Before pulling the change: copy current secrets out of `bot.json` into a safe place
  2. Pull the code change
  3. Create `.env` in project root with the extracted secrets (template from `.env.example`)
  4. Update live `bot.json`: replace each inline secret field with its `_env` counterpart
  5. Restart the bot — startup validation will catch any missed secrets with specific error messages
  6. Rotate secrets at this point (optional but recommended, since the old values were in a JSON file)
- [ ] For multi-bot deployments: one `.env.<network>` per bot, one `bot.<network>.json` per bot
- [ ] Note the one-way nature: no rollback path without re-inlining secrets

**Verification:** User walks through the checklist against their live deployment.

## Out of scope

- Moving `tls_cert` / `tls_key` file paths to env vars — these are filesystem paths, not secrets. Stay in JSON.
- Per-instance env var prefixing (e.g. `LIBERA_NICKSERV_PASSWORD`). The `--env-file=.env.libera` pattern makes per-instance prefixes unnecessary.
- A migration tool that auto-extracts secrets from an existing `bot.json`. Manual migration is a one-time, ~5-field operation; a tool isn't worth building.
- Encrypted secrets at rest (age, sops, etc). Out of scope for this refactor — env vars from `.env` files or systemd `EnvironmentFile=` are the terminal state.
- Supporting inline secrets as a fallback during transition. User chose hard cutover.
- Runtime secret rotation (reload `.env` without restart). Not a current requirement.

## Config changes

**`config/bot.example.json` — diff sketch:**

```diff
 "services": {
   "type": "anope",
   "nickserv": "NickServ",
-  "password": "",
+  "password_env": "NICKSERV_PASSWORD",
   "sasl": true,
   "sasl_mechanism": "PLAIN"
 },
 "irc": {
-  "channels": ["#hexbot", { "name": "#secret", "key": "password" }],
+  "channels": ["#hexbot", { "name": "#secret", "key_env": "CHANNEL_KEY_SECRET" }],
 },
 "chanmod": {
-  "nick_recovery_password": ""
+  "nick_recovery_password_env": "CHANMOD_RECOVERY_PASSWORD"
 },
 "botlink": {
-  "password": "changeme-shared-secret",
+  "password_env": "BOTLINK_PASSWORD",
 },
 "proxy": {
   "enabled": false,
   "host": "127.0.0.1",
-  "port": 9050
+  "port": 9050,
+  "password_env": "PROXY_PASSWORD"
 }
```

**New file `.env.example`:**

```bash
NICKSERV_PASSWORD=
BOTLINK_PASSWORD=
CHANMOD_RECOVERY_PASSWORD=
PROXY_PASSWORD=
CHANNEL_KEY_SECRET=
```

(`GEMINI_API_KEY` is added to `.env.example` on the ai-chat branch, not here.)

## Risk and rollback

- **Risk**: Live deployment fails to start after migration due to a missed env var. **Mitigation**: Phase 3's startup validation names the exact var that's missing. Operator fixes and retries.
- **Risk**: Plugin author writes `process.env.X` in a new plugin, bypassing the resolver. **Mitigation**: SECURITY.md update + code review discipline. Longer-term consideration: a lint rule that flags `process.env` usage in `plugins/**`.
- **Rollback**: Revert the commit, restore inline secrets from the safe place in step 1 of the migration checklist.

## Follow-up: ai-chat branch merge

The ai-chat plugin currently reads `process.env.GEMINI_API_KEY` directly (`plugins/ai-chat/index.ts:266`), which violates SECURITY.md §138. It lives on `feature/ai-chat-plugin`. When that branch merges into `main` (post-refactor), the merge must include:

- [ ] Rebase `feature/ai-chat-plugin` onto post-refactor `main` (Phase 5's plugin-loader `_env` support will already be present)
- [ ] In `plugins/ai-chat/config.json`: add `"api_key_env": "GEMINI_API_KEY"` as a top-level field
- [ ] In `plugins/ai-chat/index.ts:266`: replace `process.env.GEMINI_API_KEY ?? process.env.AI_CHAT_API_KEY` with `(api.config.api_key as string | undefined) ?? ''`
- [ ] Update the plugin's config type to include `api_key?: string`
- [ ] Drop the `AI_CHAT_API_KEY` compatibility alias
- [ ] Add `GEMINI_API_KEY=` to `.env.example` (and document in `plugins/ai-chat/README.md`)
- [ ] Update `tests/plugins/ai-chat-admin.test.ts` to no longer manipulate `process.env.GEMINI_API_KEY` / `AI_CHAT_API_KEY` — use `api_key` in the test plugin config
- [ ] Update the degraded-mode warning in `plugins/ai-chat/index.ts` to reference the env var name
- [ ] Operator adds `GEMINI_API_KEY=...` to their live `.env` before the merged branch deploys

This section is intentionally outside the phased work above because it cannot be executed on `main` — the plugin code lives on the feature branch. It's a merge-time checklist.
