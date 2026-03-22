# Plan: Deployment and Distribution

## Summary

Two parallel distribution tracks: **Option A** (Docker image via ghcr.io, primary for users who just want to run a bot) and **Option B** (git clone + pnpm, already mostly working, with small gaps for a clean production experience). Option A is built on top of Option B — the Docker image compiles the TypeScript source and serves as the hermetically packaged artifact for release.

---

## Feasibility

- **Alignment:** No design changes required. SIGTERM/SIGINT are already handled in `src/index.ts`. `--config <path>` already works. `tsconfig.json` already has `outDir: "dist"`.
- **Dependencies:** All existing — nothing new to build first.
- **Blockers:** One gotcha: `tsconfig.json` has `rootDir: "."`, which means the compiled entry point is `dist/src/index.js`, not `dist/index.js`. This is slightly ugly but functional. A tsconfig cleanup is a separate concern — don't fix it here.
- **Complexity:** S–M total. Each phase is small and independent.
- **Risk:** `better-sqlite3` native addon. The Dockerfile **must** run `pnpm install` inside the container — never copy `node_modules` from host. The multi-stage build handles this correctly by doing a fresh `pnpm install --prod` in the runtime stage.

---

## Dependencies

- [x] `src/index.ts` — SIGTERM/SIGINT handled
- [x] `--config <path>` CLI flag working
- [x] `tsconfig.json` with `outDir: "dist"`
- [ ] `data/` directory auto-creation (currently fails silently if missing)

---

## Decisions

1. **Plugin directory in Docker:** Volume mount at `/app/plugins`. The image seeds the volume on first run via an entrypoint script (copies bundled compiled plugins if the directory is empty). Users can add or replace plugins by editing the mounted directory and hot-reloading. `pluginDir` in the Docker example config stays `./plugins`.

2. **First-run plugin seeding:** Entrypoint script (`entrypoint.sh`) checks if `/app/plugins` is empty and copies from `/app/bundled-plugins/` (compiled plugins baked into the image at build time). Users who want a clean slate can delete the seeded files and use their own.

3. **Process manager:** systemd only. No pm2 docs.

4. **tsconfig rootDir:** Leave `rootDir: "."` as-is. Production entry point is `node dist/src/index.js`. Don't clean this up in this plan.

5. **Image registry:** `ghcr.io` (GitHub Container Registry). GitHub username is `OWNER` — fill in during build phase.

6. **`pluginDir` in Docker config:** Stays as `./plugins` (the volume), not `./dist/plugins`. The entrypoint seeds `./plugins` from the baked-in compiled output. No separate `bot.docker.json` needed — `bot.example.json` works as-is.

---

## Phases

### Phase 1: Option B gaps

**Goal:** `pnpm start` works cleanly in a production VPS context without tsx. Auto-create `data/` on startup. Provide a systemd unit for "always on" deployments.

- [ ] Add `"build": "tsc"` script to `package.json`
- [ ] Add `"start:prod": "node dist/src/index.js"` script to `package.json`
- [ ] In `src/bot.ts` constructor, `mkdirSync(dirname(resolvedDbPath), { recursive: true })` before passing path to `BotDatabase` — ensures `data/` exists even if the user forgot to create it
- [ ] Create `docs/deploy/systemd.md` with:
  - A complete `n0xb0t.service` unit file (ExecStart = `/usr/bin/node dist/src/index.js`, WorkingDirectory = `/opt/n0xb0t`, Restart=on-failure, RestartSec=5, User=n0xb0t)
  - Brief instructions: `useradd -r n0xb0t`, install to `/opt/n0xb0t`, `pnpm build`, `systemctl enable --now n0xb0t`
- [ ] **Verify:** `pnpm build && node dist/src/index.js --config config/bot.json` starts the bot and connects to IRC

---

### Phase 2: Dockerfile

**Goal:** A multi-stage Dockerfile that produces a minimal image with compiled JS, production deps only, and the native `better-sqlite3` binary fetched for the runtime environment.

- [ ] Create `.dockerignore`:

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

- [ ] Create `entrypoint.sh`:

  ```sh
  #!/bin/sh
  # Seed plugins volume on first run if empty
  if [ -z "$(ls -A /app/plugins 2>/dev/null)" ]; then
    echo "[n0xb0t] Seeding plugins from image..."
    cp -r /app/bundled-plugins/. /app/plugins/
  fi
  exec node dist/src/index.js "$@"
  ```

- [ ] Create `Dockerfile` (multi-stage):

  **Stage 1 — builder** (`node:20-alpine`):
  - `WORKDIR /app`
  - `COPY package.json pnpm-lock.yaml ./`
  - `RUN corepack enable && pnpm install --frozen-lockfile`
  - `COPY tsconfig.json ./`
  - `COPY src/ ./src/`
  - `COPY plugins/ ./plugins/`
  - `RUN pnpm exec tsc`

  **Stage 2 — runtime** (`node:20-alpine`):
  - `WORKDIR /app`
  - `COPY package.json pnpm-lock.yaml ./`
  - `RUN corepack enable && pnpm install --frozen-lockfile --prod`
    _(fresh install = correct native binary for this Alpine/Node ABI — never copy node_modules from builder)_
  - `COPY --from=builder /app/dist ./dist`
  - `COPY --from=builder /app/dist/plugins ./bundled-plugins` _(seed source, not a volume)_
  - `COPY config/bot.example.json ./config/bot.example.json`
  - `COPY config/plugins.example.json ./config/plugins.example.json`
  - `COPY entrypoint.sh ./entrypoint.sh`
  - `RUN chmod +x entrypoint.sh`
  - `VOLUME ["/app/config", "/app/plugins", "/app/data"]`
  - `ENTRYPOINT ["./entrypoint.sh"]`

  Notes:
  - `pluginDir` in bot.json stays `./plugins` — the volume. Entrypoint seeds it from `./bundled-plugins` if empty.
  - Users can add custom plugins to the mounted `./plugins` dir and hot-reload without rebuilding the image.

- [ ] **Verify:** `docker build -t n0xb0t:local .` succeeds. `docker run --rm n0xb0t:local node --version` prints Node 20.x.

---

### Phase 3: docker-compose

**Goal:** A single `docker-compose.yml` that a new user can download and run immediately.

- [ ] Create `docker-compose.yml` at repo root:

  ```yaml
  services:
    n0xb0t:
      image: ghcr.io/OWNER/n0xb0t:latest
      restart: unless-stopped
      volumes:
        - ./config:/app/config
        - ./plugins:/app/plugins
        - ./data:/app/data
  ```

  Replace `OWNER` with the actual GitHub username before committing.

- [ ] Create `docs/deploy/docker-quickstart.md`:

  ```markdown
  # Docker quickstart

  1. mkdir my-n0xb0t && cd my-n0xb0t
  2. curl -O <raw docker-compose.yml URL>
  3. mkdir config data
  4. curl -o config/bot.json <raw config/bot.docker.json URL>
  5. Edit config/bot.json — set server, nick, owner hostmask, NickServ password
  6. docker compose up -d
  7. docker compose logs -f # watch startup
  ```

- [ ] **Verify:** With a local image tag, `docker compose up` starts the bot and mounts work (config readable, data dir writable).

---

### Phase 4: GitHub Actions

**Goal:** CI runs on every PR. Docker image is built and pushed on version tags and main branch.

- [ ] Create `.github/workflows/ci.yml`:
  - Trigger: `push` to any branch, `pull_request` to `main`
  - Job `test`:
    - `actions/checkout`
    - `actions/setup-node` (Node 20)
    - `pnpm/action-setup`
    - `pnpm install --frozen-lockfile`
    - `pnpm typecheck`
    - `pnpm lint`
    - `pnpm test`

- [ ] Create `.github/workflows/docker.yml`:
  - Trigger: `push` to `main`, `push` tags matching `v*.*.*`
  - Permissions: `packages: write`, `contents: read`
  - Job `build-push`:
    - `actions/checkout`
    - `docker/setup-qemu-action` (for multi-arch)
    - `docker/setup-buildx-action`
    - `docker/login-action` (ghcr.io, using `GITHUB_TOKEN`)
    - `docker/metadata-action` — generates tags:
      - `v*.*.*` tag → `:v1.2.3` and `:latest`
      - `main` push → `:edge`
    - `docker/build-push-action`:
      - `platforms: linux/amd64,linux/arm64`
      - `push: true`
      - tags from metadata step
      - `cache-from: type=gha`, `cache-to: type=gha,mode=max`

- [ ] **Verify:** Push a test tag (`v0.0.1-test`), confirm image appears in GitHub Packages with correct tags.

---

### Phase 5: README update

**Goal:** README has a Docker quickstart at the top, alongside the existing git-clone quickstart.

- [ ] Add "Deploy with Docker" section to `README.md` (above the existing Quick start):
  - One-liner: pull image, mount config, run
  - Link to `docs/deploy/docker-quickstart.md` for full steps
- [ ] Add "Production deployment" section linking to `docs/deploy/systemd.md`
- [ ] Update "Development" section to clarify `pnpm start` = tsx (dev), `pnpm start:prod` = compiled (production)

- [ ] **Verify:** README renders cleanly on GitHub. All links resolve.

---

## Config changes

No new config files needed. `bot.example.json` works as-is for Docker — `"pluginDir": "./plugins"` resolves to the mounted volume, which the entrypoint seeds with compiled plugins on first run.

---

## Database changes

None. The `data/` auto-creation fix in Phase 1 is a `mkdirSync` call, not a schema change.

---

## Test plan

No new automated tests needed — this is all infrastructure (Dockerfile, YAML, docs). Manual verification steps are in each phase above.

If a future PR introduces a `build:` test step, add a CI job that runs `pnpm build` and asserts exit code 0.
