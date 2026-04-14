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
      // Thresholds set to the current floor with a small 0.25 pt buffer.
      // The 2026-04-14 memleak-audit pass added substantial new subsystem
      // code (plugin API dispose, eventbus owner registry, flood enforcement
      // drain, RSS abort signal, chanmod clearSharedState, bot.shutdown()
      // step wrappers) whose remaining uncovered paths are either defensive
      // error branches or require a full bot-harness integration to
      // exercise. Padding the numbers with theater tests was rejected; we
      // hold the line at today's real coverage instead.
      thresholds: {
        statements: 96,
        branches: 92,
        functions: 97,
        lines: 97,
      },
    },
  },
});
