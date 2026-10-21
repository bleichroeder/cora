// Build Cora's Windows installer:
//   node scripts/package.mjs [--no-build] [--publish] [--version x.y.z]
// It builds the packages, stages an app with the repo's layout (release/app: the desktop app, the server and the
// client, with the server's runtime dependencies), fetches a standalone Node for the terminal host (checked against
// nodejs.org's checksums, cached in release/cache), and runs electron-builder (its tools live in packaging/, away from
// the workspace). The installer lands in release/dist. With --publish (and GH_TOKEN) it's published to the private
// releases repo; with CORA_UPDATE_TOKEN set, installed copies can read that repo for updates.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REL = join(ROOT, 'release');
const APP = join(REL, 'app');
const CACHE = join(REL, 'cache');
const RES = join(REL, 'resources');
/** The terminal host's Node: the version Electron's own Node is (any Node with N-API would do) */
const NODE_VERSION = '24.22.0';
const has = (f) => process.argv.includes(`--${f}`);
const read = (f) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const run = (file, args, o = {}) => execFileSync(file, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...o });

if (!has('no-build')) run('npm', ['run', 'build']);

// --- the app, in the repo's layout (so the paths between its parts are the ones the code already uses)
const desktop = read('packages/desktop/package.json');
// --version 0.1.1: build that version without changing package.json (a test release)
const vi = process.argv.indexOf('--version');
if (vi > 0) desktop.version = process.argv[vi + 1];
const server = read('packages/server/package.json');
const electron = read('node_modules/electron/package.json').version;
const updater = '^6.8.9';
rmSync(APP, { recursive: true, force: true });
mkdirSync(APP, { recursive: true });
for (const [from, to] of [
  ['packages/desktop/dist', 'packages/desktop/dist'],
  ['packages/desktop/splash.html', 'packages/desktop/splash.html'],
  ['packages/server/dist', 'packages/server/dist'],
  ['packages/client/dist', 'packages/client/dist'],
]) {
  if (!existsSync(join(ROOT, from))) throw new Error(`missing ${from}: build first`);
  cpSync(join(ROOT, from), join(APP, to), { recursive: true });
}
// the server is ES modules
writeFileSync(join(APP, 'packages', 'server', 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2));
const deps = Object.fromEntries(Object.entries(server.dependencies).filter(([k]) => !k.startsWith('@cora/')));
writeFileSync(
  join(APP, 'package.json'),
  JSON.stringify({ name: 'cora', productName: 'Cora', version: desktop.version, description: 'Cora: a desktop dashboard for Claude Code', author: 'David Herzfeld', private: true, main: 'packages/desktop/dist/main.cjs', dependencies: { ...deps, 'electron-updater': updater } }, null, 2),
);
// its runtime dependencies (production only; @lydell/node-pty's prebuilt binary comes with its platform package)
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--workspaces=false'], { cwd: APP });
// installed copies read the private releases repo with a read-only token (none: no updates)
// (from CORA_UPDATE_TOKEN, or packaging/update-token: kept on this machine, never in git)
const tokenFile = join(ROOT, 'packaging', 'update-token');
const updateToken = process.env.CORA_UPDATE_TOKEN || (existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '');
if (updateToken) writeFileSync(join(APP, 'update.json'), JSON.stringify({ token: updateToken }));
else console.warn('\nNo update token (CORA_UPDATE_TOKEN or packaging/update-token): this build will never update itself.\n');

// --- the terminal host's Node (outside the install folder at run time: see packages/server/src/ptyhost/runtime.ts)
mkdirSync(CACHE, { recursive: true });
const nodeExe = join(CACHE, `node-v${NODE_VERSION}-win-x64.exe`);
if (!existsSync(nodeExe)) {
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const want = sums.split('\n').find((l) => l.trim().endsWith(' win-x64/node.exe'))?.split(/\s+/)[0];
  if (!want) throw new Error(`no checksum for win-x64/node.exe in ${base}/SHASUMS256.txt`);
  const r = await fetch(`${base}/win-x64/node.exe`);
  if (!r.ok) throw new Error(`downloading node.exe: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = createHash('sha256').update(buf).digest('hex');
  if (got !== want) throw new Error(`node.exe checksum mismatch: ${got} != ${want}`);
  writeFileSync(nodeExe, buf);
}
rmSync(RES, { recursive: true, force: true });
mkdirSync(join(RES, 'node'), { recursive: true });
cpSync(nodeExe, join(RES, 'node', 'node.exe'));

// --- the installer
const builder = join(ROOT, 'packaging', 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
if (!existsSync(builder)) run('npm', ['install', '--no-audit', '--no-fund'], { cwd: join(ROOT, 'packaging') });
run(builder, ['--win', '--config', 'packaging/electron-builder.yml', `-c.electronVersion=${electron}`, '--publish', 'never']);
// --- published: a release in the private releases repo with what the updater reads (latest.yml) and downloads
// (with gh, not electron-builder's publisher: two of its uploaders race to create the same release)
if (has('publish')) {
  const dist = join(REL, 'dist');
  const exe = `Cora-Setup-${desktop.version}.exe`;
  run('gh', ['release', 'create', `v${desktop.version}`, '--repo', 'bleichroeder/cora-releases', '--title', `Cora ${desktop.version}`, '--notes', `Cora ${desktop.version}`, join(dist, exe), join(dist, `${exe}.blockmap`), join(dist, 'latest.yml')], { shell: false });
}
console.log(`\nCora ${desktop.version}: ${join(REL, 'dist')}`);
