import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { IdeStatus } from '@cora/shared';
import { writeFileAtomic } from './fsx';
import { prepareIde } from './ideTheme';

/**
 * The IDE panel's VS Code: your installed VS Code serving its own web interface (`code serve-web`), on this machine
 * only (127.0.0.1, with a secret token), shown in a Board panel at the session's folder. One server for every panel;
 * started when a panel asks (after you accept Microsoft's server licence, once), stopped with Cora.
 */
export const IDE_LICENSE_URL = 'https://code.visualstudio.com/license/server';

/** Where the VS Code CLI is (`code-tunnel` runs serve-web itself, no shell between). */
export function findCodeCli(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  const win = process.platform === 'win32';
  const dirs = win
    ? [env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'bin'), env.ProgramFiles && join(env.ProgramFiles, 'Microsoft VS Code', 'bin'), env['ProgramFiles(x86)'] && join(env['ProgramFiles(x86)'], 'Microsoft VS Code', 'bin')]
    : ['/usr/local/bin', '/usr/bin', '/snap/bin', '/Applications/Visual Studio Code.app/Contents/Resources/app/bin'];
  // anywhere on PATH too
  for (const p of (env.PATH ?? env.Path ?? '').split(win ? ';' : ':')) if (p && /code/i.test(p)) dirs.push(p);
  for (const d of dirs) {
    if (!d) continue;
    const exe = join(d, win ? 'code-tunnel.exe' : 'code-tunnel');
    if (exists(exe)) return exe;
    if (!win && exists(join(d, 'code'))) return join(d, 'code');
  }
  return null;
}

/** A free port on this machine. */
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (typeof a === 'object' && a ? resolve(a.port) : reject(new Error('no port'))));
    });
  });

/** The port it had before, if it's free; else a new one. */
async function keptPort(was?: number): Promise<number> {
  if (was && was > 1024 && was < 65536) {
    const free = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen(was, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (free) return was;
  }
  return freePort();
}

/** The VS Code server's own command line (it adds extensions): the newest one serve-web fetched. */
function serverTool(cliDir: string): string | null {
  const root = join(cliDir, 'serve-web');
  let order: string[] = [];
  try {
    order = JSON.parse(readFileSync(join(root, 'lru.json'), 'utf8')) as string[];
  } catch {
    try {
      order = readdirSync(root).filter((n) => /^[0-9a-f]{40}$/.test(n));
    } catch {
      return null;
    }
  }
  for (const commit of order) {
    const t = join(root, commit, 'bin', process.platform === 'win32' ? 'code-server.cmd' : 'code-server');
    if (existsSync(t)) return t;
  }
  return null;
}

type Saved = { accepted?: boolean; /** the port it had (kept: a web VS Code keeps your layout and open files per address) */ port?: number };

export class Ide {
  private proc: ChildProcess | null = null;
  private port = 0;
  private token = '';
  private st: IdeStatus['state'] = 'off';
  private message = '';
  private lastOut = '';
  private claude: IdeStatus['claude'];
  private readonly file: string;

  constructor(private o: { dataDir: string; onChange?: () => void; cli?: string | null; log?: (m: string) => void; fetch?: typeof fetch; /** where its Cora extension reaches Cora, and its token */ bridge?: { url: string; token: string } }) {
    this.file = join(o.dataDir, 'ide.json');
    // the server going away some other way than its shutdown (that stops it too): VS Code goes with it
    process.once('exit', () => {
      const pid = this.proc?.pid;
      if (!pid) return;
      try {
        if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        else process.kill(pid);
      } catch {
        /* already gone */
      }
    });
  }

  private saved(): Saved {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Saved;
    } catch {
      return {};
    }
  }

  private cli(): string | null {
    return this.o.cli !== undefined ? this.o.cli : findCodeCli();
  }

  status(): IdeStatus {
    const cli = this.cli();
    const state = !cli ? 'missing' : this.st === 'off' && !this.saved().accepted ? 'needs-ok' : this.st;
    return {
      state,
      license: IDE_LICENSE_URL,
      ...(state === 'ready' ? { url: `http://127.0.0.1:${this.port}/ide/?tkn=${this.token}` } : {}),
      ...(this.message ? { message: this.message } : {}),
      ...(this.claude ? { claude: this.claude } : {}),
    };
  }

  private set(state: IdeStatus['state'], message = ''): void {
    this.st = state;
    this.message = message;
    this.o.onChange?.();
  }

  /** Start it (once accepted: `accept` is the user accepting the licence now). Resolves when it answers, or failed. */
  async start(accept = false, /** your Cora colour (its theme's accent) */ accent = '#f472b6'): Promise<IdeStatus> {
    const cli = this.cli();
    if (!cli) return this.status();
    if (accept) writeFileAtomic(this.file, JSON.stringify({ ...this.saved(), accepted: true }));
    if (!this.saved().accepted) return this.status();
    if (this.proc && (this.st === 'starting' || this.st === 'ready')) return this.status();
    const home = join(this.o.dataDir, 'vscode');
    mkdirSync(home, { recursive: true });
    this.port = await keptPort(this.saved().port);
    writeFileAtomic(this.file, JSON.stringify({ ...this.saved(), port: this.port }));
    this.token = randomBytes(18).toString('hex');
    // one left from before (Cora closed without stopping it): it goes first
    this.killStale(join(home, 'pid'));
    // the token in a file of its own, as it is (VS Code reads it), only for you; never on the command line, where any
    // process can read it
    // its own extensions and settings (never your desktop VS Code's): Cora's theme in your colour, calmer defaults
    const serverData = join(home, 'server');
    prepareIde(serverData, accent, this.o.bridge);
    const tokenFile = join(home, 'token');
    writeFileAtomic(tokenFile, this.token, { mode: 0o600 });
    this.set('starting', 'Starting VS Code…');
    const args = ['serve-web', '--host', '127.0.0.1', '--port', String(this.port), '--server-base-path', '/ide', '--connection-token-file', tokenFile, '--accept-server-license-terms', '--disable-telemetry', '--cli-data-dir', join(home, 'cli'), '--server-data-dir', serverData];
    const p = spawn(cli, args, { cwd: dirname(cli), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    if (p.pid) writeFileAtomic(join(home, 'pid'), String(p.pid));
    const seen = (b: Buffer) => {
      const t = b.toString();
      this.lastOut = (this.lastOut + t).slice(-2000);
      // the first time it fetches the server that matches your VS Code
      if (/download/i.test(t) && this.st === 'starting') this.set('starting', 'Downloading the VS Code server (once)…');
    };
    p.stdout?.on('data', seen);
    p.stderr?.on('data', seen);
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.set(this.st === 'off' ? 'off' : 'error', this.st === 'off' ? '' : `VS Code stopped (${code ?? 'killed'}): ${this.lastOut.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
    });
    p.on('error', (e) => this.proc === p && this.set('error', e.message));
    // ready when it answers (the first run downloads the server first: give it a few minutes)
    const f = this.o.fetch ?? fetch;
    const until = Date.now() + 5 * 60_000;
    while (Date.now() < until && this.proc === p) {
      // its page, with the token: it answers with a redirect that sets its cookie (not followed here: without the
      // cookie the next hop is a 403); without the token, its front says 403 before the server behind it is up
      const ok = await f(`http://127.0.0.1:${this.port}/ide/?tkn=${this.token}`, { redirect: 'manual', signal: AbortSignal.timeout(4000) })
        .then((r) => r.status === 200 || (r.status >= 300 && r.status < 400))
        .catch(() => false);
      if (ok) {
        this.set('ready');
        void this.addClaude(home, serverData);
        return this.status();
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (this.proc === p && this.st === 'starting') {
      this.stop();
      this.set('error', 'VS Code took too long to start.');
    }
    return this.status();
  }

  /**
   * Claude Code's extension in it, once (from the marketplace, by the VS Code server's own tool): sessions in the
   * panel's folder connect to it (/ide, or --ide when Cora starts them) and show their edits as diffs there, see your
   * selection and VS Code's problems.
   */
  private async addClaude(home: string, serverData: string): Promise<void> {
    const extDir = join(serverData, 'extensions');
    const has = () => {
      try {
        return readdirSync(extDir).some((n) => n.toLowerCase().startsWith('anthropic.claude-code-'));
      } catch {
        return false;
      }
    };
    if (has()) return void ((this.claude = 'ready'), this.o.onChange?.());
    const tool = serverTool(join(home, 'cli'));
    if (!tool) return void ((this.claude = 'failed'), this.o.onChange?.());
    this.claude = 'installing';
    this.o.onChange?.();
    const win = process.platform === 'win32';
    const ok = await new Promise<boolean>((resolve) => {
      // (a .cmd runs through cmd; its arguments are ours, no user text)
      const p = spawn(win ? 'cmd.exe' : tool, [...(win ? ['/d', '/s', '/c', tool] : []), '--server-data-dir', serverData, '--install-extension', 'anthropic.claude-code'], { windowsHide: true, stdio: 'ignore' });
      p.on('exit', (code) => resolve(code === 0));
      p.on('error', () => resolve(false));
      setTimeout(() => resolve(false), 3 * 60_000);
    });
    this.claude = ok && has() ? 'ready' : 'failed';
    this.o.log?.(`Claude Code's extension: ${this.claude}`);
    this.o.onChange?.();
  }

  /** A VS Code this Cora started before and never stopped (it closed without its shutdown): stopped now. */
  private killStale(pidFile: string): void {
    try {
      const pid = Number(readFileSync(pidFile, 'utf8').trim());
      if (!pid || pid === this.proc?.pid) return;
      process.kill(pid, 0);
      // only if that id is still VS Code's CLI (Windows hands ids out again)
      if (process.platform === 'win32') {
        const row = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        if (!/^"code-tunnel\.exe"/i.test(row.trim())) return;
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {});
      } else process.kill(pid);
    } catch {
      /* none, or already gone */
    }
  }

  /** Stop it (with Cora, or from the panel). Its own children go with it. */
  stop(): void {
    const p = this.proc;
    this.proc = null;
    this.st = 'off';
    this.message = '';
    if (p?.pid) {
      if (process.platform === 'win32') execFile('taskkill', ['/PID', String(p.pid), '/T', '/F'], () => {});
      else p.kill();
    }
    this.o.onChange?.();
  }
}
