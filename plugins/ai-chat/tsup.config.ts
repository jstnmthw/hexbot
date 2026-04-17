import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  external: [/^node:/, 'better-sqlite3'],
  outExtension: () => ({ js: '.js' }),
});
