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
      // never pad with theater tests to clear a number.
      thresholds: {
        statements: 95,
        branches: 91,
        functions: 96,
        lines: 96,
      },
    },
  },
});
