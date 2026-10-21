// Install an Electron patch while Cora's desktop app is closed (its files are locked while it runs), then open Cora
// again. Started by the desktop app when the server's security check has downloaded a newer patch of its Electron:
//   node scripts/update-electron.mjs --repo <repo> --version 44.7.3 --from 44.7.2 --data <~/.cora> --pid <app pid> --exe <electron.exe>
// What happened goes in <data>/update.log; a failed install is noted in updates.json so it isn't tried again.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const arg = (k) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const repo = arg('repo');
const version = arg('version');
const from = arg('from');
const data = arg('data');
const pid = Number(arg('pid'));
const exe = arg('exe') ?? join(repo, 'node_modules', 'electron', 'dist', 'electron.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => {
  try {
    appendFileSync(join(data, 'update.log'), `${new Date().toISOString()} ${m}\n`);
  } catch {
    /* nowhere to say it */
  }
};
const updatesFile = join(data, 'updates.json');
const setElectron = (e) => {
  let u = {};
  try {
    u = JSON.parse(readFileSync(updatesFile, 'utf8'));
  } catch {
    /* none yet */
  }
  writeFileSync(updatesFile, JSON.stringify({ ...u, electron: e }, null, 2));
};
const alive = (p) => {
  try {
    process.kill(p, 0);
    return true;
  } catch {
    return false;
  }
};
// the installed version: its dist/version file, not by running it (with Cora's resources/app in place, see
// brand-electron.mjs, `electron.exe --version` would open Cora)
const runs = () => {
  try {
    return existsSync(exe) ? readFileSync(join(dirname(exe), 'version'), 'utf8').trim().replace(/^v/, '') : '';
  } catch {
    return '';
  }
};
const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const npm = (args) =>
  existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 })
    : spawnSync('npm', args, { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000, shell: true });
const reopen = () => {
  try {
    spawn(exe, ['packages/desktop'], { cwd: repo, detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } catch (e) {
    log(`couldn't open Cora again: ${e.message}`);
  }
};

if (!repo || !version || !data || !pid) {
  console.error('usage: update-electron.mjs --repo <repo> --version <x.y.z> --from <x.y.z> --data <dir> --pid <pid> [--exe <electron.exe>]');
  process.exit(2);
}

// how many processes still run from Electron's folder (the app's GPU, renderer and utility helpers outlive it by a
// moment, longer when it was killed rather than quit): npm can't replace the folder while one does
const dist = dirname(exe);
const fromDist = () => {
  if (process.platform !== 'win32') return 0;
  const q = `(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '${dist.replace(/'/g, "''")}\\*' }).Count`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', q], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  return Number(String(r.stdout ?? '').trim()) || 0;
};

// while this runs, a Cora that's opened (its notification clicked, Start) leaves at once instead of holding
// Electron's folder (main.ts reads this); gone before Cora is opened again
const busyFile = join(data, 'updating.json');
writeFileSync(busyFile, JSON.stringify({ pid: process.pid, version }));
process.on('exit', () => rmSync(busyFile, { force: true }));

// wait for the app, then everything else of Electron's, to let go of its files
for (let i = 0; i < 120 && alive(pid); i++) await sleep(500);
for (let i = 0; i < 30 && fromDist() > 0; i++) await sleep(1000);
await sleep(2000);
log(`installing Electron ${version} (was ${from})`);
// a file still held (the indexer, an antivirus scan): EBUSY, which passes; try again a few times
// who holds it, for update.log (Windows' Restart Manager, scripts/who-holds.ps1)
const holders = () => {
  if (process.platform !== 'win32') return '';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(repo, 'scripts', 'who-holds.ps1'), '-Dir', dist], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  return String(r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean).join('; ') || 'nothing Windows can name';
};
let r;
for (let i = 0; i < 6; i++) {
  r = npm(['install', '-D', `electron@^${version}`, '-w', 'packages/desktop', '--no-audit', '--no-fund']);
  if (r.status === 0 || !/EBUSY|EPERM/.test(`${r.stderr}${r.stdout}`)) break;
  log(`Electron's folder is busy (held by: ${holders()}); trying again (${i + 1})`);
  await sleep(8000);
}
if (r.status !== 0) log(`npm install failed (${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ')}`);
// the binary is fetched by the install step (from the cache the server filled); fetch it again if it's missing
if (runs() !== version) spawnSync(process.execPath, [join(repo, 'node_modules', 'electron', 'install.js')], { cwd: repo, windowsHide: true, timeout: 10 * 60_000 });
const now = runs();
if (now === version) {
  log(`Electron ${version} installed`);
  setElectron(undefined);
} else {
  // tried again at the next few starts, then given up on (the Security page says so)
  let attempts = 1;
  try {
    const was = JSON.parse(readFileSync(updatesFile, 'utf8')).electron;
    if (was?.version === version) attempts = (was.attempts ?? 0) + 1;
  } catch {
    /* the first */
  }
  const giveUp = attempts >= 3;
  log(`Electron ${version} didn't install (Electron now reports "${now || 'nothing'}"); ${giveUp ? 'not trying it again' : 'trying again when Cora next starts'}`);
  // not straight away (Cora would close again as it opens): at a start ten minutes or more from now
  setElectron(giveUp ? { version, ready: false, failed: version, attempts, at: Date.now() } : { version, ready: true, attempts, after: Date.now() + 10 * 60_000, at: Date.now() });
  // a broken install: put the version that worked back
  if (!now && from) {
    npm(['install', '-D', `electron@${from}`, '-w', 'packages/desktop', '--no-audit', '--no-fund']);
    if (runs() !== from) spawnSync(process.execPath, [join(repo, 'node_modules', 'electron', 'install.js')], { cwd: repo, windowsHide: true, timeout: 10 * 60_000 });
    log(`put Electron ${from} back (now reports "${runs() || 'nothing'}")`);
  }
}
// an install replaces Electron's folder: make it Cora again (its name in Start, and no-argument launches open Cora)
try {
  const { brand } = await import('./brand-electron.mjs');
  log(await brand());
} catch (e) {
  log(`couldn't make Electron Cora again: ${e.message}`);
}
rmSync(busyFile, { force: true });
reopen();
