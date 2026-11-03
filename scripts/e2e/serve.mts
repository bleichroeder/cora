// A throwaway Cora for end-to-end tests: its own home and port, real Claude Code sessions started without the user's
// settings (--setting-sources project,local, so none of their hooks reach the user's Cora on 4317), and the test
// folder's own .claude/settings.local.json pointing their hooks here instead. Never touches ~/.cora or port 4317.
//
// Usage (from the repo root, after building the client: npm run build -w packages/client):
//   npx tsx scripts/e2e/serve.mts <root> [port]
// <root> is a fresh folder (say, in your temp dir): <root>/home is its Cora home, <root>/work the folder its
// sessions work in. The port defaults to 4399. Log in to its UI with the token e2e (cookie ab_session=e2e).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../packages/server/src/config.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { computeHooksBlock } from '../../packages/server/src/settings.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const root = process.argv[2];
const port = Number(process.argv[3] ?? 4399);
if (!root) throw new Error('Usage: npx tsx scripts/e2e/serve.mts <root> [port]');
if (port === 4317) throw new Error("4317 is the user's own Cora: pick another port.");

// sessions start without the user's settings (their hooks would reach the real Cora)
if (!process.env.CORA_CLAUDE_CMD && process.env.APPDATA) {
  const exe = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  process.env.CORA_CLAUDE_CMD = JSON.stringify([exe, '--setting-sources', 'project,local']);
}

const work = join(root, 'work');
mkdirSync(join(work, '.claude'), { recursive: true });
writeFileSync(join(work, '.claude', 'settings.local.json'), JSON.stringify({ hooks: computeHooksBlock({ port, token: 'e2e-hook' }) }, null, 2));

void (async () => {
  const srv = await startServer(
    loadConfig({ dataDir: join(root, 'home'), dbPath: join(root, 'home', 'brain.db'), port, hookToken: 'e2e-hook', uiToken: 'e2e', clientDir: join(repo, 'packages', 'client', 'dist') }),
    { tail: false, ci: false, security: false },
  );
  console.log(`e2e cora up on ${port}`, !!srv);
})();
