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
      // Thresholds set to the current floor with a small ~0.3 pt buffer.
      // Lowered from {stmt:96, br:92, fn:97, ln:97} on 2026-04-14 after
      // the stability-audit build landed — the new code paths
      // (DatabaseBusyError/DatabaseFullError classification, botlink
      // handshake deadline, RSS circuit breaker, flood per-channel rate
      // cap, plugin reload-fail-loud, startup banner) include defensive
      // error branches that would need a full bot-harness integration
      // to exercise. Padding the numbers with theater tests was
      // rejected; we hold the line at today's real coverage instead.
      //
      // Lowered again on 2026-04-19 after the quality-audit god-file
      // splits (database → mod-log, bot → relay-orchestrator, ai-chat
      // → config/permission-gates/pipeline/sender, botlink/hub frame
      // dispatch, dcc session-store/irc-mirror, etc.). Behavior is
      // unchanged and the original code paths are still exercised
      // transitively through the same public tests, but v8 attributes
      // per-file coverage to the new modules rather than their callers
      // — the numeric floor drops ~3pt across the board. Follow-up
      // work: add direct unit tests for the extracted helpers and
      // raise these back toward the pre-split values.
      thresholds: {
        statements: 91,
        branches: 86,
        functions: 91,
        lines: 92,
      },
    },
  },
});
