import { execFileSync, spawn as spawnChild } from 'node:child_process';
import { connect, type Socket } from 'node:net';
import { copyFileSync, cpSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
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
  /** the terminal host went away (the PC shutting down, or it crashed), taking its terminals with it */
  readonly lost?: boolean;
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
  lost = false;
  /** told when the host goes away (not when this server closes it) */
  onLost?: () => void;
  private constructor(private sock: Socket, readonly restored: HostTerm[], readonly hostPid: number, /** the folder it runs from (hosts from before said nothing) */ readonly hostDir?: string) {
    super();
    for (const t of restored) if (t.alive) this.live.add(t.id);
    // The host going away takes its terminals with it.
    sock.on('close', () => {
      if (this.closing) return;
      this.lost = true;
      for (const id of this.live) this.exit(id, -1);
      this.live.clear();
      this.onLost?.();
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
        backend = new HostBackend(sock, m.terms, m.pid, m.dir);
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
 * The terminal host, kept: when it goes away (it crashed, or was ended), its terminals end as before, and Cora
 * connects to a new one (starting it), so what's started next runs. Anything started while it's away waits for it;
 * if no host can be started, it ends at once, saying why (in its terminal and the server's log) instead of nothing.
 */
export class HealingHostBackend extends Emitter implements PtyBackend {
  readonly persistent = true;
  readonly restored: HostTerm[];
  private cur: HostBackend | null;
  private queue: Array<() => void> = [];
  private healing: Promise<void> | null = null;
  private closing = false;
  /** the host it started with is gone (sticky: the frozen terminals stay frozen) */
  lost = false;
  constructor(
    first: HostBackend,
    private reconnect: () => Promise<HostBackend>,
    private log: (m: string) => void = () => {},
  ) {
    super();
    this.restored = first.restored;
    this.cur = this.adopt(first);
  }
  get hostPid(): number | undefined {
    return this.cur?.hostPid;
  }

  private adopt(b: HostBackend): HostBackend {
    b.onData((id, d) => this.data(id, d));
    b.onExit((id, code) => this.exit(id, code));
    b.onLost = () => {
      if (this.cur !== b) return;
      this.lost = true;
      this.cur = null;
      this.log('terminal host went away: starting a new one');
      void this.heal();
    };
    return b;
  }

  /** A new host (a few tries); what waited for it then goes. */
  private heal(): Promise<void> {
    this.healing ??= (async () => {
      let err: unknown;
      for (let i = 0; i < 4 && !this.closing; i++) {
        try {
          this.cur = this.adopt(await this.reconnect());
          this.log('terminal host back');
          const q = this.queue;
          this.queue = [];
          for (const f of q) f();
          return;
        } catch (e) {
          err = e;
          await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
        }
      }
      // none: what waited ends, saying why
      const why = (err as Error)?.message ?? 'it did not start';
      this.log(`terminal host could not be started again: ${why}`);
      const q = this.queue;
      this.queue = [];
      for (const f of q) f();
    })().finally(() => (this.healing = null));
    return this.healing;
  }

  spawn(id: string, file: string, args: string[], o: SpawnOpts, meta: TermMeta): void {
    const go = () => {
      if (this.cur) return this.cur.spawn(id, file, args, o, meta);
      // no host: it ends at once, and says why
      this.data(id, `\r\n[cora: the terminal host isn't running, so ${file} couldn't start. Restarting Cora starts it again.]\r\n`);
      this.exit(id, -1);
    };
    if (this.cur) return go();
    this.queue.push(go);
    void this.heal();
  }
  write(id: string, d: string) {
    this.cur?.write(id, d);
  }
  resize(id: string, cols: number, rows: number) {
    this.cur?.resize(id, cols, rows);
  }
  kill(id: string) {
    this.cur?.kill(id);
  }
  async close(endTerminals: boolean): Promise<void> {
    this.closing = true;
    await this.cur?.close(endTerminals);
  }
}

/**
 * Connect to the running terminal host, or start one (detached, so it outlives this server) and connect.
 * `hostScript` is the built ptyhost.js next to cli.js.
 */
export async function connectOrStartHost(o: { /** where a host runs from, by its pid (hosts from before didn't say; tests fake it) */ whereIs?: (pid: number) => string | null; dataDir: string; legacyDataDirs?: string[]; /** its key, then older ones a host still running may have (the hook token, before hosts had their own) */ token: string; olderTokens?: string[]; hostScript: string; /** the Node it runs on (default: this one) */ hostNode?: string; log?: (m: string) => void; timeoutMs?: number }): Promise<HostBackend> {
  const path = socketPath(o.dataDir);
  // a host started before the rename listens at the old address, with the same token (the data was copied over)
  for (const p of [path, ...(o.legacyDataDirs ?? []).map(legacySocketPath)]) {
    for (const t of [o.token, ...(o.olderTokens ?? [])]) {
      let b: HostBackend;
      try {
        b = await HostBackend.connect(p, t);
      } catch {
        continue; /* not there, or not its key */
      }
      // an older build's host (Cora was updated while it ran): whole, or mended, it keeps its terminals; with none, it
      // makes way for this build's
      const stillThere = () => HostBackend.connect(p, t, 300).then((x) => (void x.close(false), true), () => false);
      if (!o.hostNode || (await vetHost(b, dirname(o.hostNode), o.log ?? (() => {}), stillThere, o.whereIs))) return b;
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
 * A host Cora found running: is it this build's? If not (an update came while it ran) and it has no live terminal, it's
 * shut down so this build's starts (false). If it has some, it stays for them; if its folder lost its files (an older
 * Cora removed it while it ran: no new terminal could start), they're put back from this build's (Node and the terminal
 * library: what it loads when it starts or ends a terminal).
 */
export async function vetHost(b: HostBackend, ours: string, log: (m: string) => void, stillThere: () => Promise<boolean>, whereIs: (pid: number) => string | null = hostFolderOf): Promise<boolean> {
  const dir = b.hostDir ?? whereIs(b.hostPid);
  if (!dir || resolvePath(dir).toLowerCase() === resolvePath(ours).toLowerCase()) return true;
  if (!b.restored.some((t) => t.alive)) {
    log("the terminal host is an older Cora's, with no terminals: starting this one's");
    await b.close(true).catch(() => {});
    // its pipe goes with it
    for (let i = 0; i < 20 && (await stillThere()); i++) await new Promise((r) => setTimeout(r, 150));
    return false;
  }
  const missing = ['node.exe', join('node_modules', '@lydell')].filter((f) => !existsSync(join(dir, f)));
  if (missing.length) {
    try {
      mkdirSync(dir, { recursive: true });
      if (missing.includes('node.exe')) cpSync(join(ours, 'node.exe'), join(dir, 'node.exe'));
      cpSync(join(ours, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
      log(`mended an older Cora's terminal host (its folder had lost ${missing.join(' and ')}): its terminals carry on, new ones start`);
    } catch (e) {
      log(`couldn't mend an older Cora's terminal host's folder (${dir}): ${(e as Error).message}`);
    }
  }
  return true;
}

/** The folder a process runs from (Windows; elsewhere, null). */
function hostFolderOf(pid: number): string | null {
  if (process.platform !== 'win32' || !pid) return null;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").ExecutablePath`], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
    return out ? dirname(out) : null;
  } catch {
    return null;
  }
}

/**
 * Start the terminal host so that it belongs to no one. On Windows a detached child still counts as the server's
 * descendant (and so the desktop app's), and "end process tree" on the app (Task Manager, taskkill /T) would take
 * every hosted session with it. Starting it through a shell that exits at once leaves it parentless. Elsewhere a
 * detached child already survives its parent.
 */
export function spawnHost(node: string, script: string, dataDir: string, logFile: string): void {
  rollLog(logFile);
  // the host before this one: its logs kept (Start-Process starts a new log over the old), so a host that went away
  // can be looked into
  for (const f of [logFile, logFile.replace(/\.log$/, '') + '.err.log'])
    try {
      if (existsSync(f) && statSync(f).size) copyFileSync(f, f.replace(/\.log$/, '.prev.log'));
    } catch {
      /* not kept */
    }
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
