import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default [
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // Plugin isolation (docs/SECURITY.md §4.1): plugins reach core only
    // through the scoped PluginAPI. A *value* import from `src/` bundles a
    // copy of core into the plugin's dist that goes stale on a core change
    // and runs outside the frozen API. Type-only imports are fine — they are
    // erased at build time and carry no runtime coupling.
    files: ['plugins/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/src/*', '**/src/**'],
              allowTypeImports: true,
              message:
                'Plugins must access core via the scoped PluginAPI (api.*), not a runtime import from src/. Type-only imports (import type) are allowed. See docs/SECURITY.md §4.1.',
            },
          ],
        },
      ],
    },
  },
  {
    ignores: [
      'dist/',
      '**/dist/',
      'node_modules/',
      'coverage/',
      'eslint.config.js',
      '**/.reload-*.ts',
    ],
  },
];
