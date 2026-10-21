import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { compareVersions, electronStatus, nodeStatus, parseAudit, type SecurityReport } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * Is what Cora runs on still getting security fixes? Checked a little after startup and twice a day: Electron (from
 * its npm dist-tags), Node.js (nodejs.org's releases and schedule) and `npm audit` over the repo. A newer Electron
 * patch is downloaded ahead of time and noted in updates.json; the desktop app installs it when it next starts.
 */

const CHECK_EVERY_MS = 12 * 3600_000;
const FIRST_CHECK_MS = 20_000;

/** What the desktop app reads at startup: an Electron patch ready to install (or one that failed to). */
export type Updates = { electron?: { version: string; ready: boolean; failed?: string; attempts?: number; at: number } };

export function readUpdates(dataDir: string): Updates {
  try {
    return JSON.parse(readFileSync(join(dataDir, 'updates.json'), 'utf8')) as Updates;
  } catch {
    return {};
  }
}
const writeUpdates = (dataDir: string, u: Updates) => writeFileAtomic(join(dataDir, 'updates.json'), JSON.stringify(u, null, 2));

export type SecurityDeps = {
  repo: string;
  dataDir: string;
  publish(r: SecurityReport): void;
  fetchFn?: typeof fetch;
  /** `npm audit --json` in the repo (its parsed output); omitDev: only what's installed for running, not developing */
  audit?(omitDev?: boolean): Promise<unknown>;
  /** the Electron version installed in the repo (null: none) */
  electronVersion?(): string | null;
  /** download an Electron release into Electron's cache (so installing it later is quick) */
  download?(version: string): Promise<void>;
  nodeVersion?: string;
  now?(): number;
  log?(m: string): void;
};

export class SecurityWatch {
  report: SecurityReport | null = null;
  private timers: NodeJS.Timeout[] = [];
  private running: Promise<SecurityReport> | null = null;

  constructor(private d: SecurityDeps) {}

  start(): void {
    this.timers.push(setTimeout(() => void this.check(), FIRST_CHECK_MS));
    const every = setInterval(() => void this.check(), CHECK_EVERY_MS);
    every.unref?.();
    this.timers.push(every);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
  }

  /** Check everything (one check at a time). */
  check(): Promise<SecurityReport> {
    if (!this.running) this.running = this.run().finally(() => (this.running = null));
    return this.running;
  }

  private async run(): Promise<SecurityReport> {
    const now = this.d.now?.() ?? Date.now();
    if (this.report) this.d.publish({ ...this.report, checking: true });
    const [electron, node, npm] = await Promise.all([this.electron(), this.node(now), this.npm()]);
    const report: SecurityReport = { checkedAt: now, repo: this.d.repo, ...(electron ? { electron } : {}), node, npm };
    this.report = report;
    this.d.publish(report);
    return report;
  }

  private getJson = async (url: string) => {
    const r = await (this.d.fetchFn ?? fetch)(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(`${new URL(url).host}: HTTP ${r.status}`);
    return r.json();
  };

  private async electron(): Promise<SecurityReport['electron']> {
    const installed = (this.d.electronVersion ?? (() => installedElectron(this.d.repo)))();
    if (!installed) return undefined;
    try {
      const st = electronStatus(installed, (await this.getJson('https://registry.npmjs.org/-/package/electron/dist-tags')) as Record<string, string>);
      // a newer patch of this major: fetch it now, install it when Cora next starts
      const u = readUpdates(this.d.dataDir);
      if (st.latestPatch && compareVersions(st.latestPatch, installed) > 0) {
        const was = u.electron;
        if (was?.version === st.latestPatch && was.ready) return { ...st, pending: st.latestPatch };
        // it wouldn't install: said so, and tried again a day later (what held it may be gone by then)
        if (was?.failed === st.latestPatch && (this.d.now?.() ?? Date.now()) - was.at < 86_400_000) return { ...st, failed: st.latestPatch };
        try {
          await (this.d.download ?? ((v: string) => downloadElectron(this.d.repo, v)))(st.latestPatch);
          writeUpdates(this.d.dataDir, { ...u, electron: { version: st.latestPatch, ready: true, at: Date.now() } });
          this.d.log?.(`security: Electron ${st.latestPatch} downloaded; installed when Cora next starts`);
          return { ...st, pending: st.latestPatch };
        } catch (e) {
          this.d.log?.(`security: couldn't download Electron ${st.latestPatch}: ${(e as Error).message}`);
          return st;
        }
      }
      // installed (or nothing newer): nothing waiting
      if (u.electron && compareVersions(u.electron.version, installed) <= 0) writeUpdates(this.d.dataDir, { ...u, electron: undefined });
      return st;
    } catch (e) {
      return { installed, latest: installed, supportedMajors: [], supported: true, error: (e as Error).message };
    }
  }

  private async node(now: number): Promise<SecurityReport['node']> {
    const version = this.d.nodeVersion ?? process.version;
    try {
      const [releases, schedule] = await Promise.all([this.getJson('https://nodejs.org/dist/index.json'), this.getJson('https://raw.githubusercontent.com/nodejs/Release/main/schedule.json')]);
      return nodeStatus(version, releases as Array<{ version: string; security?: boolean }>, schedule as Record<string, { end?: string }>, now);
    } catch (e) {
      return { version, securityBehind: false, ended: false, error: (e as Error).message };
    }
  }

  private async npm(): Promise<SecurityReport['npm']> {
    try {
      const audit = this.d.audit ?? ((omitDev?: boolean) => npmAudit(this.d.repo, omitDev));
      const [all, prod] = await Promise.all([audit(), audit(true).catch(() => undefined)]);
      return parseAudit(all, prod);
    } catch (e) {
      return { counts: { critical: 0, high: 0, moderate: 0, low: 0, info: 0 }, findings: [], error: (e as Error).message };
    }
  }
}

export function installedElectron(repo: string): string | null {
  try {
    return String(JSON.parse(readFileSync(join(repo, 'node_modules', 'electron', 'package.json'), 'utf8')).version);
  } catch {
    return null;
  }
}

/** npm's own CLI next to this Node (so no shell is needed), else `npm` from PATH. */
function npmCommand(): { file: string; args: string[]; shell: boolean } {
  const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(cli) ? { file: process.execPath, args: [cli], shell: false } : { file: 'npm', args: [], shell: true };
}

/** `npm audit --json` in the repo (it exits non-zero when it finds something; the JSON is the answer either way). */
export function npmAudit(repo: string, omitDev = false): Promise<unknown> {
  const npm = npmCommand();
  return new Promise((resolve, reject) => {
    execFile(npm.file, [...npm.args, 'audit', '--json', ...(omitDev ? ['--omit=dev'] : [])], { cwd: repo, timeout: 120_000, maxBuffer: 32 * 1024 * 1024, shell: npm.shell, windowsHide: true }, (err, stdout) => {
      try {
        const j = JSON.parse(stdout);
        if (j?.error) return reject(new Error(String(j.error.summary ?? j.error.code ?? 'npm audit failed')));
        resolve(j);
      } catch {
        reject(new Error(err ? err.message.split('\n')[0] : 'npm audit gave no answer'));
      }
    });
  });
}

/** Fetch an Electron release into Electron's download cache, with the repo's own @electron/get. */
export function downloadElectron(repo: string, version: string): Promise<void> {
  const script = `
    const get = require(require.resolve('@electron/get', { paths: [${JSON.stringify(join(repo, 'node_modules', 'electron'))}] }));
    get.downloadArtifact({ version: ${JSON.stringify(version)}, artifactName: 'electron', platform: process.platform, arch: process.arch })
      .then(() => process.exit(0), (e) => (console.error(e && e.message), process.exit(1)));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 10 * 60_000);
    child.on('exit', (code) => (clearTimeout(timer), code === 0 ? resolve() : reject(new Error(err.trim().split('\n').pop() || `exit ${code}`))));
    child.on('error', (e) => (clearTimeout(timer), reject(e)));
  });
}
