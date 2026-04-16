// scripts/build-plugins.ts — Discover and build all plugins with tsup configs.
import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pluginsDir = resolve(import.meta.dirname, '..', 'plugins');

const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(pluginsDir, d.name, 'tsup.config.ts')))
  .map((d) => d.name)
  .sort();

if (pluginDirs.length === 0) {
  console.log('[build-plugins] No plugins with tsup.config.ts found.');
  process.exit(0);
}

console.log(`[build-plugins] Building ${pluginDirs.length} plugins: ${pluginDirs.join(', ')}`);

// Install local dependencies for plugins that have their own package.json
for (const name of pluginDirs) {
  const pkgJson = join(pluginsDir, name, 'package.json');
  if (existsSync(pkgJson)) {
    console.log(`  ${name}: installing local dependencies ...`);
    try {
      execSync('pnpm install --ignore-workspace', { cwd: join(pluginsDir, name), stdio: 'pipe' });
    } catch (err) {
      const message = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
      console.error(`  FAILED to install deps for ${name}\n${message}`);
      process.exit(1);
    }
  }
}

let failed = 0;
for (const name of pluginDirs) {
  const configPath = join(pluginsDir, name, 'tsup.config.ts');
  const outDir = join(pluginsDir, name, 'dist');
  console.log(`  ${name} ...`);
  try {
    execSync(`pnpm exec tsup --config ${configPath} --outDir ${outDir}`, {
      cwd: join(pluginsDir, name),
      stdio: 'pipe',
    });
  } catch (err) {
    failed++;
    const message = err instanceof Error && 'stderr' in err ? String(err.stderr) : String(err);
    console.error(`  FAILED: ${name}\n${message}`);
  }
}

if (failed > 0) {
  console.error(`\n[build-plugins] ${failed} plugin(s) failed to build.`);
  process.exit(1);
}

console.log(`[build-plugins] All ${pluginDirs.length} plugins built successfully.`);
