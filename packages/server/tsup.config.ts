import { defineConfig } from 'tsup';

export default defineConfig({
  // cli: the server; ptyhost: the terminal host it starts (kept separate so terminals outlive the server)
  entry: { cli: 'src/cli.ts', ptyhost: 'src/ptyhost/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  noExternal: ['@cora/shared'],
  banner: { js: '#!/usr/bin/env node' },
  // node:sqlite only exists with the node: prefix
  removeNodeProtocol: false,
});
