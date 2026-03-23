# Plan: Deployment and Distribution

## Summary

Primary distribution track: **git clone + docker compose**. Users clone the repo, edit config, and run `docker compose up -d`. The Dockerfile is included in the repo and builds locally — no pre-built image required. A future phase (deferred) will publish images to ghcr.io for users who prefer a no-clone flow.

---

## Feasibility

- **Alignment:** No design changes needed. `pnpm start` already works via `tsx`. `--config <path>` works. Hot-reload works.
- **Dependencies:** All existing — nothing new to build.
- **Blockers:** `better-sqlite3` native addon must be compiled inside the container (never copy `node_modules` from host). The container runs `pnpm install` at startup or build time to get the correct binary.
- **Complexity:** S. A Dockerfile, a compose file, and one code fix.
- **Risk:** Low. The container is just running `pnpm start` — same as local dev.

---

## Dependencies

- [x] `src/index.ts` — SIGTERM/SIGINT handled
- [x] `--config <path>` CLI flag working
- [x] `data/` directory auto-creation (currently fails if missing)

---

## Decisions

1. **Plugin directory in Docker:** Volume mount at `/app/plugins`. The image seeds the volume on first run via an entrypoint script (copies bundled compiled plugins if the directory is empty). Users can add or replace plugins by editing the mounted directory and hot-reloading. `pluginDir` in the Docker example config stays `./plugins`.

2. **First-run plugin seeding:** Entrypoint script (`entrypoint.sh`) checks if `/app/plugins` is empty and copies from `/app/bundled-plugins/` (compiled plugins baked into the image at build time). Users who want a clean slate can delete the seeded files and use their own.

3. **Process manager:** systemd only. No pm2 docs.

4. **tsconfig rootDir:** Leave `rootDir: "."` as-is. Production entry point is `node dist/src/index.js`. Don't clean this up in this plan.

5. **Image registry:** Deferred. The `docker-compose.yml` uses `build: .` so users build locally from the cloned repo. Registry publishing (ghcr.io) is a future phase.

6. **`pluginDir` in Docker config:** Stays as `./plugins` (the volume), not `./dist/plugins`. The entrypoint seeds `./plugins` from the baked-in compiled output. No separate `bot.docker.json` needed — `bot.example.json` works as-is.

---

## Phases

### Phase 1: Code fix — auto-create `data/`

**Goal:** The bot creates the `data/` directory on startup if it doesn't exist, so a fresh clone doesn't fail.

- [x] In `src/bot.ts` constructor, `mkdirSync(dirname(resolvedDbPath), { recursive: true })` before passing path to `BotDatabase`
- [x] **Verify:** Delete `data/`, run `pnpm start` — bot creates the directory and starts normally

---

### Phase 2: Package scripts

**Goal:** Add `build` and `start:prod` for non-Docker production use.

- [x] Add `"build": "tsc"` to `package.json` scripts
- [x] Add `"start:prod": "node dist/src/index.js"` to `package.json` scripts
- [x] **Verify:** `pnpm build && pnpm start:prod --config config/bot.json` starts the bot

---

### Phase 3: Dockerfile + Compose

**Goal:** `docker compose up` builds the image and starts the bot with mounted config, plugins, and data.

- [x] Create `.dockerignore`:

  ```
  node_modules
  dist
  data
  config/bot.json
  config/plugins.json
  coverage
  .claude
  .git
  *.log
  *.db
  ```

- [ ] Create `Dockerfile` (multi-stage):

  **Stage 1 — builder** (`node:20-alpine`):
  - `WORKDIR /app`
  - `COPY package.json pnpm-lock.yaml ./`
  - `RUN corepack enable && pnpm install --frozen-lockfile`
  - `COPY tsconfig.json ./`
  - `COPY src/ ./src/`
  - `RUN pnpm exec tsc`

  **Stage 2 — runtime** (`node:20-alpine`):
  - `WORKDIR /app`
  - `COPY package.json pnpm-lock.yaml ./`
  - `RUN corepack enable && pnpm install --frozen-lockfile --prod`
    _(fresh install = correct native binary for this Alpine/Node ABI — never copy node_modules from builder)_
  - `COPY --from=builder /app/dist ./dist`
  - `COPY config/bot.example.json ./config/bot.example.json`
  - `COPY config/plugins.example.json ./config/plugins.example.json`
  - `CMD ["node", "dist/src/index.js"]`

  Notes:
  - No entrypoint script needed. Plugins come from the cloned repo via the volume mount — `./plugins` is never empty.
  - Users can edit plugins in the cloned repo and hot-reload without rebuilding the image.

- [ ] **Verify:** `docker build -t hexbot:local .` succeeds. `docker run --rm hexbot:local node --version` prints Node 20.x.

---

### Phase 3: docker-compose

**Goal:** A `docker-compose.yml` in the repo root that builds locally. Users clone, configure, and `docker compose up -d`.

- [ ] Create `docker-compose.yml` at repo root:

  ```yaml
  services:
    hexbot:
      build: .
      build: .
      restart: unless-stopped
      volumes:
        - ./config:/app/config
        - ./plugins:/app/plugins
        - ./data:/app/data
  ```

- [ ] Create `docs/deploy/docker-quickstart.md`:

  ```markdown
  # Docker quickstart

  1. git clone <repo> && cd hexbot
  2. cp config/bot.example.json config/bot.json
  3. Edit config/bot.json — set server, nick, owner hostmask, NickServ password
  4. docker compose up -d
  5. docker compose logs -f # watch startup

  After a `git pull`, rebuild the image:
  docker compose up -d --build
  ```

- [ ] **Verify:** `docker compose up` starts the bot and mounts work (config readable, data dir writable).

---

### Phase 4: GitHub Actions (CI only)

**Goal:** CI runs tests on every PR and push. No Docker publishing yet (deferred to Phase 5).

- [x] Create `.github/workflows/ci.yml`:
  - Trigger: `push` to any branch, `pull_request` to `main`
  - Job `test`:
    - `actions/checkout`
    - `actions/setup-node` (Node 20)
    - `pnpm/action-setup`
    - `pnpm install --frozen-lockfile`
    - `pnpm typecheck`
    - `pnpm lint`
    - `pnpm test`

- [ ] **Verify:** CI passes on a test PR.

---

### Phase 5: README update

**Goal:** README documents the git clone → docker compose flow as the primary quickstart.

- [ ] Add "Quick start (Docker)" section to `README.md`:
  - `git clone` → edit config → `docker compose up -d`
  - Note: `docker compose up -d --build` after `git pull`
  - Link to `docs/deploy/docker-quickstart.md` for full steps
- [ ] Add "Production deployment (bare metal)" section linking to `docs/deploy/systemd.md`
- [ ] Update "Development" section to clarify `pnpm start` = tsx (dev), `pnpm start:prod` = compiled (production)

- [x] **Verify:** README renders cleanly on GitHub.

---

### Phase 6 (Deferred): Registry publishing

**Goal:** Publish pre-built images to ghcr.io so users can deploy without cloning.

When ready, this phase covers:

- `docker-compose.yml` variant using `image: ghcr.io/OWNER/hexbot:latest` (or a separate `docker-compose.registry.yml`)
- `.github/workflows/docker.yml` — build and push on version tags and `main`:
  - `docker/setup-qemu-action` (multi-arch: `linux/amd64,linux/arm64`)
  - `docker/setup-buildx-action`
  - `docker/login-action` (ghcr.io via `GITHUB_TOKEN`)
  - `docker/metadata-action` — `v*.*.*` → `:v1.2.3` + `:latest`, `main` → `:edge`
  - `docker/build-push-action` with GHA layer cache
- No-clone quickstart docs (curl compose file, pull image, run)

---

## Config changes

None. `bot.example.json` works as-is — `"pluginDir": "./plugins"` resolves correctly inside the container because it's volume-mounted to the same relative path.

---

## Database changes

None. The `data/` auto-creation in Phase 1 is a `mkdirSync` call, not a schema change.

---

## Test plan

No new automated tests — this is infrastructure (Dockerfile, YAML, docs). Manual verification steps are in each phase.

CI (Phase 4) runs the existing test suite on every PR.
