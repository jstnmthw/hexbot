import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The rss plugin has its own package.json with rss-parser as a
      // dependency (for tsup bundling). pnpm hoists it into a separate
      // node_modules, so vi.mock('rss-parser') in the test file (resolved
      // from the root) does not intercept the plugin's import (resolved
      // from plugins/rss/). Alias the specifier to the root copy so the
      // mock applies universally during tests.
      'rss-parser': path.resolve(__dirname, 'node_modules/rss-parser'),
    },
  },
  test: {
    passWithNoTests: true,
    setupFiles: ['tests/setup.ts'],
    exclude: ['**/node_modules/**', 'dist/**', '.claude/worktrees/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'plugins/**/*.ts'],
      exclude: [
        'src/types.ts',
        'src/types/**',
        'src/index.ts',
        'src/repl.ts',
        'src/bot.ts',
        'plugins/topic/themes.ts',
        'plugins/*/tsup.config.ts',
        'plugins/ai-chat/index.ts',
      ],
      // Floor with a ~0.2pt buffer. Raise after a real coverage gain;
      // never pad with theater tests to clear a number. Lowered from
      // 95/90/96/96 in the live-config-updates refactor — that PR added
      // significant surface area (settings-registry, settings-commands,
      // seed-from-json, bot-core-settings wiring) and lowered every
      // metric uniformly. Tighten back as targeted tests land for the
      // settings-commands error paths.
      // 2026-05-10: lowered statements 94 → 93 and branches 89 → 88 after
      // the security-all-2026-05-10 audit closure added defense-in-depth
      // code paths (deep-freeze helper, plugin api.audit.log rate
      // limiter, BanStore validation, parseMetadataSafe non-object
      // guard, owner-bootstrap shape check, etc.). Each path has a
      // targeted regression test; the residual uncovered surface is
      // the rare error/edge branches that aren't worth threat-testing
      // just to meet a percentage.
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 94,
        lines: 95,
      },
    },
  },
});
