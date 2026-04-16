// scripts/scaffold-plugin.ts — Generate a plugin skeleton.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SAFE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

const name = process.argv[2];

if (!name) {
  console.error('Usage: pnpm run scaffold <plugin-name>');
  process.exit(1);
}

if (!SAFE_NAME_RE.test(name)) {
  console.error(
    `Invalid plugin name "${name}". Use alphanumeric characters, hyphens, and underscores only.`,
  );
  process.exit(1);
}

const pluginsDir = resolve(import.meta.dirname, '..', 'plugins');
const pluginDir = join(pluginsDir, name);

if (existsSync(pluginDir)) {
  console.error(`Plugin directory already exists: ${pluginDir}`);
  process.exit(1);
}

mkdirSync(pluginDir, { recursive: true });

// index.ts
writeFileSync(
  join(pluginDir, 'index.ts'),
  `import type { PluginAPI } from '../../src/types';

export const name = '${name}';
export const version = '1.0.0';
export const description = '';

export function init(api: PluginAPI): void {
  api.log('Plugin loaded');
}

export function teardown(): void {
  // Clean up timers, connections, etc.
  // Binds are automatically removed by the loader.
}
`,
  'utf-8',
);

// tsup.config.ts
writeFileSync(
  join(pluginDir, 'tsup.config.ts'),
  `import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  external: [/^node:/, 'better-sqlite3'],
  outExtension: () => ({ js: '.js' }),
});
`,
  'utf-8',
);

// config.json
writeFileSync(join(pluginDir, 'config.json'), '{}\n', 'utf-8');

// README.md
writeFileSync(
  join(pluginDir, 'README.md'),
  `# ${name}

> TODO: describe what this plugin does.
`,
  'utf-8',
);

console.log(`Created plugin skeleton: plugins/${name}/`);
console.log(`  index.ts`);
console.log(`  tsup.config.ts`);
console.log(`  config.json`);
console.log(`  README.md`);
console.log();
console.log(`Run \`pnpm build:plugins\` to build, then \`.load ${name}\` in the REPL.`);
