// A throwaway Cora for end-to-end tests: its own home and port, real Claude Code sessions started without the user's
// settings (--setting-sources project,local, so none of their hooks reach the user's Cora on 4317), and the test
// folder's own .claude/settings.local.json pointing their hooks here instead. Never touches ~/.cora or port 4317.
//
// Usage (from the repo root, after building the client: npm run build -w packages/client):
//   npx tsx scripts/e2e/serve.mts <root> [port] [--tail]
// <root> is a fresh folder (say, in your temp dir): <root>/home is its Cora home, <root>/work the folder its
// sessions work in. The port defaults to 4399. Log in to its UI with the token e2e (cookie ab_session=e2e).
// --tail (or CORA_E2E_TAIL=1): it reads its own sessions' transcripts too (their usage, context, replies), as the real
// Cora does; never anyone else's.
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../packages/server/src/config.ts';
import { startServer } from '../../packages/server/src/server.ts';
import { computeHooksBlock } from '../../packages/server/src/settings.ts';
import { projectSlug } from '../../packages/server/src/namer.ts';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const tail = process.env.CORA_E2E_TAIL === '1' || process.argv.includes('--tail');
// absolute, as Claude Code names its folders by its sessions' full paths
const root = args[0] ? resolve(args[0]) : '';
const port = Number(args[1] ?? 4399);
if (!root) throw new Error('Usage: npx tsx scripts/e2e/serve.mts <root> [port]');
if (port === 4317) throw new Error("4317 is the user's own Cora: pick another port.");
// --tail links every transcript folder named for a folder under the root: a broad root (your home folder, a drive)
// would take in all of yours, and a cleanup could go through those links. Only a folder inside the temp folder will do.
const inTemp = (dir: string) => {
  const rel = relative(process.platform === 'win32' ? tmpdir().toLowerCase() : tmpdir(), process.platform === 'win32' ? dir.toLowerCase() : dir);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
};
if (tail && !inTemp(root)) {
  console.error(`--tail needs a root inside the temp folder (${tmpdir()}), e.g. "$TEMP/cora-e2e-$(date +%s)"; ${root} isn't one. Nothing was started.`);
  process.exit(1);
}

// sessions start without the user's settings (their hooks would reach the real Cora)
if (!process.env.CORA_CLAUDE_CMD && process.env.APPDATA) {
  const exe = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  process.env.CORA_CLAUDE_CMD = JSON.stringify([exe, '--setting-sources', 'project,local']);
}

// a test Cora never asks for your plan's usage (every Cora here reads the one login, and the endpoint limits it)
process.env.CORA_NO_USAGE = '1';

// its sessions are marked as spawned by the session running this (Claude Code's id for it), and why: whichever Cora
// their hooks reach nests them under it in the nav, and drops them once they've ended and this root is deleted
process.env.CORA_SPAWNED_BY ??= process.env.CLAUDE_CODE_SESSION_ID ?? '';
process.env.CORA_SPAWN_WHY ??= `e2e: a throwaway Cora on port ${port}`;

const work = join(root, 'work');
mkdirSync(join(work, '.claude'), { recursive: true });
writeFileSync(join(work, '.claude', 'settings.local.json'), JSON.stringify({ hooks: computeHooksBlock({ port, token: 'e2e-hook' }) }, null, 2));

// its own transcripts only: <root>/transcripts holds a junction to each folder in ~/.claude/projects named for a folder
// under this root (its work folder and its worktrees, Cora's agent in home/orchestrator, a team builder's folder),
// added as they appear. Its tailer reads that, never the rest of ~/.claude/projects.
const transcripts = join(root, 'transcripts');
mkdirSync(transcripts, { recursive: true });
/** The ~/.claude/projects folders that are this root's: named for a folder under it. */
const ownFolder = (rootDir: string, name: string): boolean => name.startsWith(`${projectSlug(rootDir)}-`);
function linkTranscripts(): void {
  const projects = join(homedir(), '.claude', 'projects');
  mkdirSync(transcripts, { recursive: true });
  // the work folder's and the agent's, made now so their first sessions are followed from the first line
  for (const dir of [work, join(root, 'home', 'orchestrator')]) mkdirSync(join(projects, projectSlug(dir)), { recursive: true });
  for (const d of readdirSync(projects)) {
    if (!ownFolder(root, d)) continue;
    const at = join(transcripts, d);
    if (!existsSync(at)) symlinkSync(join(projects, d), at, 'junction');
  }
}
if (tail) {
  linkTranscripts();
  setInterval(() => {
    try {
      linkTranscripts();
    } catch (e) {
      console.error('e2e: transcripts not linked:', (e as Error).message);
    }
  }, 2000).unref();
}

void (async () => {
  const srv = await startServer(
    // nothing of yours: its journal is its own, its Resume and search see only its own transcripts (none without
    // --tail), and it has no kubeconfigs (so it never checks your clusters)
    loadConfig({ dataDir: join(root, 'home'), dbPath: join(root, 'home', 'brain.db'), port, hookToken: 'e2e-hook', uiToken: 'e2e', clientDir: join(repo, 'packages', 'client', 'dist'), projectsDir: transcripts, journalDir: join(root, 'journal') }),
    { tail, ci: false, security: false, kubeDir: join(root, 'kube') },
  );
  console.log(`e2e cora up on ${port}${tail ? `, reading its own transcripts (${transcripts})` : ''}`, !!srv);
})();
