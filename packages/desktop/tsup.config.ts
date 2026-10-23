import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
/** The design language's fonts, beside the splash (it loads before the dashboard and can't reach the client's bundle). */
function copyFonts() {
  mkdirSync('dist/fonts', { recursive: true });
  for (const [pkg, file] of [
    ['@fontsource-variable/figtree', 'figtree-latin-wght-normal.woff2'],
    ['@fontsource-variable/jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2'],
  ]) copyFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), 'files', file), join('dist/fonts', file));
}

export default defineConfig([
  {
    // webChrome: what every page in Cora's browser runs first (chromeIdentity.ts)
    entry: { main: 'src/main.ts', preload: 'src/preload.ts', webChrome: 'src/webChrome.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: false,
    // electron-updater ships in the installed app (release/app's dependencies), never in a dev checkout
    external: ['electron', 'electron-updater'],
    outExtension: () => ({ js: '.cjs' }),
  },
  // the startup splash: a self-contained browser bundle (three.js included), loaded from disk before the server is up
  {
    entry: { splash: 'src/splash/splash.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    outDir: 'dist',
    clean: false,
    noExternal: [/.*/],
    minify: true,
    outExtension: () => ({ js: '.js' }),
    onSuccess: async () => copyFonts(),
  },
]);
