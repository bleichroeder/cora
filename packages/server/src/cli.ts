import './quiet';
import { hostRuntime } from './ptyhost/runtime';
import { exec } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { legacyDataDirs, loadConfig, retireLoggedKey, type Config } from './config';
import { startServer } from './server';
import { isScreenError, rebuildScreens } from './screen';
import { connectOrStartHost, type PtyBackend } from './ptyhost/backend';
import { computeHooksBlock, diffText, hooksAimed, isOurs, legacyHooks, mergeHooks, readSettings, removeHooks, settingsPath, shortHooks, writeSettings } from './settings';
import { stage } from './stages';

/**
 * Setup in a simulation: a believable PC, half set up, with nothing read from this one (its Claude Code, its
 * account, its settings), so the simulator can be shown.
 */
const SIM_SETUP = {
  claude: () => ({ found: true, path: 'C:\\Users\\you\\.local\\bin\\claude.exe', signedIn: true, email: 'you@example.com' }),
  hooks: () => true,
  which: async (cmd: string) => (['git', 'npx'].includes(cmd) ? `C:\\Program Files\\${cmd}\\${cmd}.exe` : null),
  glabAuthed: async () => false,
  kubeconfigs: () => 0,
  voiceKey: () => false,
  slack: () => true,
  gmail: () => false,
  jira: () => ({ on: true, site: 'acme.atlassian.net' }),
  agent: () => true,
  mcp: () => ['atlassian', 'GitLab'],
  onePassword: async () => ({ app: false, cli: false, connected: false }),
};
import { seedInbox, startSim } from './sim';

const argv = process.argv.slice(2);
const cmd = argv[0] ?? 'help';
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function openBrowser(url: string) {
  const c = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(c);
}

async function confirm(question: string): Promise<boolean> {
  if (flag('yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

function baseConfig(extra: Partial<Config> = {}): Config {
  return loadConfig({
    ...(opt('port') ? { port: Number(opt('port')) } : {}),
    ...(opt('dev-origin') ? { devOrigin: opt('dev-origin') } : {}),
    ...extra,
  });
}

async function start() {
  const sim = flag('sim');
  const config = baseConfig(sim ? { dbPath: ':memory:' } : {});
  // Hosted terminals run in the terminal host so they outlive this server (restarts, crashes, updates).
  // A simulation runs them in-process unless `--host` (to try restarts against a scratch CORA_HOME).
  let ptyBackend: PtyBackend | undefined;
  if ((!sim || flag('host')) && !flag('no-host')) {
    stage('host', 'start');
    try {
      const dist = dirname(fileURLToPath(import.meta.url));
      // installed Cora: the host runs on the bundled Node, from a copy in ~/.cora/runtime (never the install folder)
      const installed = process.env.CORA_HOST_NODE ? hostRuntime({ dataDir: config.dataDir, node: process.env.CORA_HOST_NODE, distDir: dist, modulesDir: join(dist, '..', '..', '..', 'node_modules') }) : null;
      ptyBackend = await connectOrStartHost({ dataDir: config.dataDir, legacyDataDirs: legacyDataDirs(config.dataDir), token: config.hostToken, olderTokens: [config.hookToken], hostScript: installed?.script ?? join(dist, 'ptyhost.js'), ...(installed ? { hostNode: installed.node } : {}), log: (m) => console.log(`  ${m}`) });
      const kept = ptyBackend.restored.filter((t) => t.alive).length;
      if (kept) console.log(`  reattached ${kept} running terminal(s)`);
      stage('host', 'done', { kept });
    } catch (e) {
      console.error(`  terminal host unavailable (${(e as Error).message}); hosted terminals will end when the server stops`);
      stage('host', 'done');
      stage('note', 'warn', { key: 'nohost' });
    }
  } else stage('host', 'skip');
  // the sign-in key an older Cora left in server.log is retired (the desktop app reads the new one when it loads)
  if (!sim) {
    const fresh = retireLoggedKey(config.dataDir, config.uiToken);
    if (fresh) config.uiToken = fresh;
  }
  const running = await startServer(config, { tail: sim ? flag('tail') : !flag('no-tail'), ptyBackend, onShutdown: (o) => void shutdown(o.endTerminals), ci: !flag('no-ci'), security: !sim && !flag('no-security-check'), ...(sim ? { setupChecks: SIM_SETUP } : {}) });
  const url = `http://127.0.0.1:${config.port}/auth?key=${config.uiToken}`;
  console.log(`\n  Cora ${sim ? '(simulation) ' : ''}listening on http://127.0.0.1:${config.port}`);
  // the link is the key to the dashboard: printed for you at a terminal, never into a log file (audit S11)
  const toLog = !process.stdout.isTTY || !!process.env.CORA_STAGE_FILE;
  console.log(`  open: ${toLog ? `http://127.0.0.1:${config.port}/auth?key=<the key in ${join(config.dataDir, 'ui-token')}>` : url}\n`);
  let json: Record<string, any> = {};
  try {
    json = readSettings().json;
  } catch (e) {
    console.log(`  ${(e as Error).message}\n`);
  }
  const aimed = hooksAimed(json, { port: config.port, token: config.hookToken });
  if (aimed.state === 'none' && !sim) {
    console.log('  hooks not installed: live tool/permission events need `cora install`, or the setup screen (transcripts still work).\n');
  }
  // another Cora's (a test install) are left alone: only said, so you know events don't reach this one (audit B4)
  if (aimed.state === 'elsewhere' && !sim) {
    console.log(`  Cora's hooks point at ${aimed.port ? `another Cora (port ${aimed.port})` : 'an old key'}: this one gets no live events until they're installed again (\`cora install\`, or Setup).\n`);
  }
  // hooks written before the rename carry the old header: rewrite them once (a backup is kept; both headers work meanwhile)
  const old = legacyHooks(json, { port: config.port, token: config.hookToken });
  // hooks from an older Cora that wait less than prompts sent to your phone need: rewritten too
  if ((old.found && !old.envToken || shortHooks(json, { port: config.port, token: config.hookToken })) && !sim) {
    try {
      const backup = writeSettings(mergeHooks(json, computeHooksBlock({ port: config.port, token: config.hookToken })));
      console.log(`  updated Cora's hooks in your Claude Code settings${backup ? ` (backup: ${backup})` : ''}`);
    } catch (e) {
      console.error(`  couldn't update the hooks to the new name (${(e as Error).message}); the old ones keep working`);
    }
  }
  const stopSim = sim ? startSim(running.pipeline, running.pending, { repo: opt('sim-repo'), name: running.sim.name, cora: running.sim.cora, live: running.live }) : undefined;
  if (sim) seedInbox(running.inbox);
  if (!flag('no-open')) openBrowser(url);
  const shutdown = async (endTerminals = false) => {
    stopSim?.();
    await running.close({ endTerminals });
    process.exit(0);
  };
  // A crash in a terminal mirror must not take the server, and every hosted terminal, down with it.
  process.on('uncaughtException', (e) => {
    if (isScreenError(e)) {
      console.error(`[cora] terminal mirror error (${e.message}); rebuilt ${rebuildScreens()} mirror(s)`);
      return;
    }
    console.error(e);
    process.exit(1);
  });
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function install(remove: boolean) {
  const config = baseConfig();
  const file = settingsPath();
  const { raw, json } = readSettings(file);
  const next = remove ? removeHooks(json) : mergeHooks(json, computeHooksBlock({ port: config.port, token: config.hookToken, envToken: flag('env-token') }));
  const after = JSON.stringify(next, null, 2);
  const before = raw.trim() ? JSON.stringify(json, null, 2) : '';
  if (after === before) {
    console.log(remove ? "Cora's hooks are not installed; nothing to do." : "Cora's hooks are already installed and up to date.");
    return;
  }
  console.log(`\n${file}\n`);
  console.log(diffText(before, after).replace(/\b[0-9a-f]{64}\b/g, (t) => `${t.slice(0, 6)}…`));
  console.log();
  if (!(await confirm(remove ? "Remove Cora's hooks from your Claude Code settings?" : 'Write these hooks to your Claude Code settings?'))) {
    console.log('Aborted. Nothing written.');
    return;
  }
  const backup = writeSettings(next, file);
  console.log(`${remove ? 'Removed' : 'Installed'}.${backup ? ` Backup: ${backup}` : ''}`);
  if (!remove && flag('env-token')) {
    console.log(`Set CORA_TOKEN in your user environment (Windows: setx CORA_TOKEN ${config.hookToken.slice(0, 6)}… — value in ${config.dataDir}\\token).`);
  }
  if (!remove) console.log('New Claude Code sessions will report to Cora. Start it with `cora start`.');
}

async function replay() {
  const file = argv[1];
  if (!file) throw new Error('usage: cora replay <session.jsonl> [--speed 4]');
  const speed = Number(opt('speed') ?? 4);
  const config = baseConfig({ dbPath: ':memory:' });
  const running = await startServer(config, { tail: false });
  const url = `http://127.0.0.1:${config.port}/auth?key=${config.uiToken}`;
  console.log(`replaying ${basename(file)} at ${speed}x → ${url}`);
  if (!flag('no-open')) openBrowser(url);
  const objs = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const sessionId = `replay-${basename(file, '.jsonl').slice(0, 8)}`;
  const t0 = Date.now();
  const first = objs.find((o: any) => o.timestamp)?.timestamp;
  const base = first ? Date.parse(first) : t0;
  await new Promise((r) => setTimeout(r, 2500)); // give the browser time to connect
  for (const o of objs as any[]) {
    if (o.timestamp) {
      const due = (Date.parse(o.timestamp) - base) / speed;
      const wait = Math.min(due - (Date.now() - t0), 4000);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      o.timestamp = new Date().toISOString();
    }
    o.sessionId = sessionId;
    running.pipeline.ingestTranscript(file, [o], { sessionId, agentId: o.agentId ?? 'main', projectSlug: 'replay' });
  }
  console.log('replay finished; server keeps running (Ctrl+C to exit)');
}

const HELP = `cora: a live view of your Claude Code sessions

  cora start [--port 4317] [--no-open] [--no-tail] [--no-ci] [--sim [--tail] [--host] [--sim-repo <git checkout>]]
  cora install [--yes] [--env-token]   add http hooks to ~/.claude/settings.json (shows diff, backs up)
  cora uninstall [--yes]               remove only Cora's hooks
  cora replay <session.jsonl> [--speed 4]
`;

const run = { start, install: () => install(false), uninstall: () => install(true), replay } as Record<string, () => Promise<void>>;
(run[cmd] ?? (async () => console.log(HELP)))().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
