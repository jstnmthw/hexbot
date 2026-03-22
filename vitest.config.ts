import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    passWithNoTests: true,
    setupFiles: ['tests/setup.ts'],
    exclude: ['**/node_modules/**', '.claude/worktrees/**'],
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
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
