import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.CORA_URL ?? process.env.AGENT_BRAIN_URL ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
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
