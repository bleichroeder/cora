import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, readdirSync, statSync, createReadStream } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';

const target = process.env.CORA_URL ?? process.env.AGENT_BRAIN_URL ?? 'http://127.0.0.1:4317';

/**
 * The Whiteboard's fonts, served by Cora itself at /excalidraw/fonts (Excalidraw fetches them from a CDN otherwise):
 * copied into the build, served from node_modules in dev. Not Xiaolai (13 MB of CJK glyphs: those fall back to the system's).
 */
function excalidrawFonts(): Plugin {
  const pkg = dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'));
  // resolve gives dist/prod/index.js (or dist/dev): the fonts sit beside it
  const fonts = [join(pkg, 'fonts'), join(pkg, '..', 'prod', 'fonts')].find((d) => existsSync(d));
  const skip = new Set(['Xiaolai']);
  let outDir = 'dist';
  return {
    name: 'cora-excalidraw-fonts',
    configResolved(c) {
      outDir = c.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (req, res, next) => {
        if (!fonts) return next();
        const file = normalize(join(fonts, decodeURIComponent((req.url ?? '').split('?')[0])));
        if (!file.startsWith(fonts) || !existsSync(file) || !statSync(file).isFile()) return next();
        res.setHeader('content-type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      if (!fonts) return this.warn('Excalidraw fonts not found: the Whiteboard will fetch them from its CDN');
      for (const f of readdirSync(fonts)) if (!skip.has(f)) cpSync(join(fonts, f), join(outDir, 'excalidraw', 'fonts', f), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [react(), excalidrawFonts()],
  // one React in the bundle, whatever npm hoists (Excalidraw's old radix-tabs once pulled a react-dom 18 to the root:
  // the root package.json overrides it to a version that takes React 19)
  resolve: { dedupe: ['react', 'react-dom'] },
  // onnxruntime-web loads its WASM helper itself: pre-bundling would rewrite that import (and break it)
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target, changeOrigin: false },
      '/auth': { target },
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true },
      // hosted terminals (Claude and shells) stream over /pty/:id
      '/pty': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  // the dashboard, and the lock screen (lockdown: a page of its own, so nothing of the dashboard is loaded behind it)
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000, rollupOptions: { input: { main: 'index.html', lock: 'lock.html' } } },
});
