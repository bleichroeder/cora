import { spawn as spawnChild } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { openSync } from 'node:fs';
import { join } from 'node:path';
import { PROTOCOL_VERSION, legacySocketPath, onLines, sendLine, socketPath, type HostMsg, type HostTerm, type TermMeta } from './protocol';
import { nodePtySpawn, type PtyLike, type SpawnFn } from './spawn';
import { rollLog } from '../fsx';

type SpawnOpts = { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv };

/** Where hosted terminals actually run: in this process, or in the terminal host that outlives the server. */
export interface PtyBackend {
  /** true when terminals survive this server stopping */
  readonly persistent: boolean;
  /** terminals that were already running when this server started (from a host that outlived the last server) */
  readonly restored: HostTerm[];
  spawn(id: string, file: string, args: string[], o: SpawnOpts, meta: TermMeta): void;
  write(id: string, d: string): void;
  resize(id: string, cols: number, rows: number): void;
  kill(id: string): void;
  onData(cb: (id: string, d: string) => void): void;
  onExit(cb: (id: string, code: number) => void): void;
  /** the server is stopping: end the terminals, or leave them running in the host */
  close(endTerminals: boolean): Promise<void>;
}

class Emitter {
  dataCbs: Array<(id: string, d: string) => void> = [];
  exitCbs: Array<(id: string, code: number) => void> = [];
  onData(cb: (id: string, d: string) => void) {
    this.dataCbs.push(cb);
  }
  onExit(cb: (id: string, code: number) => void) {
    this.exitCbs.push(cb);
  }
  data(id: string, d: string) {
    for (const cb of this.dataCbs) cb(id, d);
  }
  exit(id: string, code: number) {
    for (const cb of this.exitCbs) cb(id, code);
  }
}

/** Terminals as children of this process (tests, `--sim`, and the fallback when the host can't start). */
export class LocalBackend extends Emitter implements PtyBackend {
  readonly persistent = false;
  readonly restored: HostTerm[] = [];
  private ptys = new Map<string, PtyLike>();
  constructor(private spawnFn: SpawnFn = nodePtySpawn) {
    super();
  }
  spawn(id: string, file: string, args: string[], o: SpawnOpts): void {
    const pty = this.spawnFn(file, args, o);
    this.ptys.set(id, pty);
    pty.onData((d) => this.data(id, d));
    pty.onExit(({ exitCode }) => {
      this.ptys.delete(id);
      this.exit(id, exitCode);
    });
  }
  write(id: string, d: string) {
    this.ptys.get(id)?.write(d);
  }
  resize(id: string, cols: number, rows: number) {
    try {
      this.ptys.get(id)?.resize(cols, rows);
    } catch {
      // it exited and its exit event hasn't arrived yet (a resize then throws, and took the whole server down)
    }
  }
  kill(id: string) {
    this.ptys.get(id)?.kill();
  }
  async close(): Promise<void> {
    for (const p of this.ptys.values()) p.kill();
  }
}

/** Terminals in the terminal host, reached over its socket. */
export class HostBackend extends Emitter implements PtyBackend {
  readonly persistent = true;
  private live = new Set<string>();
  private closing = false;
  private constructor(private sock: Socket, readonly restored: HostTerm[], readonly hostPid: number) {
    super();
    for (const t of restored) if (t.alive) this.live.add(t.id);
    // The host going away takes its terminals with it.
    sock.on('close', () => {
      if (this.closing) return;
      for (const id of this.live) this.exit(id, -1);
      this.live.clear();
    });
  }

  private handle(m: HostMsg) {
    if (m.t === 'data') this.data(m.id, m.d);
    else if (m.t === 'exit') {
      this.live.delete(m.id);
      this.exit(m.id, m.code);
    }
  }

  /** Connect and authenticate; resolves with the host's current terminals. */
  static connect(path: string, token: string, timeoutMs = 2000): Promise<HostBackend> {
    return new Promise((resolve, reject) => {
      const sock = connect(path);
      const timer = setTimeout(() => fail(new Error('terminal host did not answer')), timeoutMs);
      const fail = (e: Error) => {
        clearTimeout(timer);
        sock.destroy();
        reject(e);
      };
      sock.once('error', fail);
      sock.once('connect', () => sendLine(sock, { t: 'hello', token, v: PROTOCOL_VERSION }));
      // one reader for the socket's life: the first line is the handshake, the rest go to the backend
      let backend: HostBackend | null = null;
      onLines(sock, (m: HostMsg) => {
        if (backend) return backend.handle(m);
        clearTimeout(timer);
        sock.off('error', fail);
        if (m.t !== 'hello') return fail(new Error(m.t === 'error' ? `terminal host: ${m.msg}` : 'unexpected handshake'));
        sock.on('error', () => {});
        backend = new HostBackend(sock, m.terms, m.pid);
        resolve(backend);
      });
    });
  }

  spawn(id: string, file: string, args: string[], o: SpawnOpts, meta: TermMeta): void {
    this.live.add(id);
    sendLine(this.sock, { t: 'spawn', id, file, args, cwd: o.cwd, cols: o.cols, rows: o.rows, env: o.env as Record<string, string | undefined>, meta });
  }
  write(id: string, d: string) {
    sendLine(this.sock, { t: 'write', id, d });
  }
  resize(id: string, cols: number, rows: number) {
    sendLine(this.sock, { t: 'resize', id, cols, rows });
  }
  kill(id: string) {
    sendLine(this.sock, { t: 'kill', id });
  }
  async close(endTerminals: boolean): Promise<void> {
    this.closing = true;
    if (endTerminals) sendLine(this.sock, { t: 'shutdown' });
    await new Promise<void>((res) => this.sock.end(res));
  }
}

/**
 * Connect to the running terminal host, or start one (detached, so it outlives this server) and connect.
 * `hostScript` is the built ptyhost.js next to cli.js.
 */
export async function connectOrStartHost(o: { dataDir: string; legacyDataDirs?: string[]; /** its key, then older ones a host still running may have (the hook token, before hosts had their own) */ token: string; olderTokens?: string[]; hostScript: string; /** the Node it runs on (default: this one) */ hostNode?: string; log?: (m: string) => void; timeoutMs?: number }): Promise<HostBackend> {
  const path = socketPath(o.dataDir);
  // a host started before the rename listens at the old address, with the same token (the data was copied over)
  for (const p of [path, ...(o.legacyDataDirs ?? []).map(legacySocketPath)]) {
    for (const t of [o.token, ...(o.olderTokens ?? [])]) {
      try {
        return await HostBackend.connect(p, t);
      } catch {
        /* not there, or not its key */
      }
    }
  }
  spawnHost(o.hostNode ?? process.execPath, o.hostScript, o.dataDir, join(o.dataDir, 'ptyhost.log'));
  o.log?.('started terminal host');
  const deadline = Date.now() + (o.timeoutMs ?? 8000);
  let last: unknown;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 150));
    try {
      return await HostBackend.connect(path, o.token);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(`terminal host did not start: ${(last as Error)?.message ?? 'timeout'}`);
}

/**
 * Start the terminal host so that it belongs to no one. On Windows a detached child still counts as the server's
 * descendant (and so the desktop app's), and "end process tree" on the app (Task Manager, taskkill /T) would take
 * every hosted session with it. Starting it through a shell that exits at once leaves it parentless. Elsewhere a
 * detached child already survives its parent.
 */
export function spawnHost(node: string, script: string, dataDir: string, logFile: string): void {
  rollLog(logFile);
  if (process.platform === 'win32') {
    // PowerShell's Start-Process: hidden (a console app started from a detached shell would get a visible console
    // window of its own), output to the log, and PowerShell exits at once, leaving the host parentless.
    const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const command = [
      'Start-Process',
      `-FilePath ${ps(node)}`,
      `-ArgumentList @(${[script, '--data', dataDir].map((a) => ps(`"${a}"`)).join(',')})`,
      '-WindowStyle Hidden',
      // in Cora's data folder: the host outlives Cora, and a folder it runs in can't be renamed (Electron's own,
      // when Cora was opened from Start, kept Electron's security patches from installing)
      `-WorkingDirectory ${ps(dataDir)}`,
      `-RedirectStandardOutput ${ps(logFile)}`,
      `-RedirectStandardError ${ps(logFile.replace(/\.log$/, '') + '.err.log')}`,
    ].join(' ');
    const shell = spawnChild('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], { cwd: dataDir, stdio: 'ignore', windowsHide: true, env: process.env });
    shell.unref();
    return;
  }
  const out = openSync(logFile, 'a');
  const child = spawnChild(node, [script, '--data', dataDir], { cwd: dataDir, detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
}
