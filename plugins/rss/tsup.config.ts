import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  platform: 'node',
  bundle: true,
  noExternal: [/.*/],
  external: [/^node:/, 'better-sqlite3'],
  outExtension: () => ({ js: '.js' }),
  // rss-parser's CJS transitive deps (xml2js, sax) use bare require("http")
  // etc.  esbuild wraps them in an __require() shim that checks for a global
  // `require` — which doesn't exist in Node ESM.  Injecting createRequire
  // gives the shim a working require function for Node built-ins.
  banner: {
    js: "import{createRequire as __cr}from'node:module';var require=__cr(import.meta.url);",
  },
});
