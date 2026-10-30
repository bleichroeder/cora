import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { sameSecret } from '../config';
import { PROTOCOL_VERSION, onLines, sendLine, type ClientMsg, type HostTerm, type TermMeta } from './protocol';
import { nodePtySpawn, type PtyLike, type SpawnFn } from './spawn';

type Term = { id: string; meta: TermMeta; pty: PtyLike | null; alive: boolean; exitCode?: number; buf: string; endedAt?: number; /** being ended (a kill was sent) */ killing?: boolean };

export type HostOptions = {
  path: string;
  token: string;
  spawn?: SpawnFn;
  /** scrollback kept per terminal and replayed to a reconnecting server */
  maxBuf?: number;
  /** exit after this long with no live terminal and no connected server */
  idleMs?: number;
  /** how long an exited terminal is still reported (so a server that was down learns it ended) */
  keepExitedMs?: number;
  /** the folder it runs from (said in its hello: Cora checks it's still whole) */
  dir?: string;
  log?: (msg: string) => void;
  onClose?: () => void;
};

export type Host = { close(): Promise<void>; terms(): HostTerm[] };

/** Start the terminal host: owns PTYs, streams them to every authenticated client, keeps scrollback for reattach. */
export async function startHost(o: HostOptions): Promise<Host> {
  const spawn = o.spawn ?? nodePtySpawn;
  const maxBuf = o.maxBuf ?? 200_000;
  const idleMs = o.idleMs ?? 5 * 60_000;
  const keepExitedMs = o.keepExitedMs ?? 10 * 60_000;
  const log = o.log ?? (() => {});
  const terms = new Map<string, Term>();
  const clients = new Set<Socket>();
  let closed = false;

  const broadcast = (msg: Parameters<typeof sendLine>[1]) => {
    for (const c of clients) sendLine(c, msg);
  };
  const snapshot = (): HostTerm[] => [...terms.values()].map((t) => ({ id: t.id, meta: t.meta, alive: t.alive, exitCode: t.exitCode, buf: t.buf.slice(-maxBuf) }));

  const exited = (t: Term, code: number) => {
    if (!t.alive) return;
    t.alive = false;
    t.exitCode = code;
    t.endedAt = Date.now();
    t.pty = null;
    broadcast({ t: 'exit', id: t.id, code });
    log(`terminal ${t.id} exited (${code})`);
    checkIdle();
  };

  const handle = (sock: Socket, m: ClientMsg) => {
    if (m.t === 'spawn') {
      if (terms.has(m.id)) return;
      const t: Term = { id: m.id, meta: m.meta, pty: null, alive: true, buf: '' };
      terms.set(m.id, t);
      try {
        const pty = spawn(m.file, m.args, { cwd: m.cwd, cols: m.cols, rows: m.rows, env: m.env as NodeJS.ProcessEnv });
        t.pty = pty;
        pty.onData((d) => {
          // appended (cheap), cut back only at twice the size: what's read is always its last maxBuf
          t.buf += d;
          if (t.buf.length > 2 * maxBuf) t.buf = t.buf.slice(-maxBuf);
          broadcast({ t: 'data', id: t.id, d });
        });
        pty.onExit(({ exitCode }) => exited(t, exitCode));
        log(`terminal ${t.id} started: ${m.file} ${m.args.join(' ')} in ${m.cwd}`);
      } catch (e) {
        const d = `\r\n[cora: could not start ${m.file}: ${(e as Error).message}]\r\n`;
        t.buf = d;
        broadcast({ t: 'data', id: t.id, d });
        exited(t, -1);
      }
      return;
    }
    if (m.t === 'write') return void terms.get(m.id)?.pty?.write(m.d);
    if (m.t === 'resize') {
      if (m.cols > 1 && m.rows > 1) terms.get(m.id)?.pty?.resize(Math.floor(m.cols), Math.floor(m.rows));
      return;
    }
    if (m.t === 'kill') {
      // once: a terminal already being ended isn't ended again (a closed panel can ask for the same shell twice)
      const t = terms.get(m.id);
      if (!t?.pty || t.killing) return;
      t.killing = true;
      log(`terminal ${t.id} kill`);
      return void t.pty.kill();
    }
    if (m.t === 'shutdown') {
      log('shutdown requested: ending all terminals');
      void close(true);
    }
    void sock;
  };

  let idleTimer: NodeJS.Timeout | undefined;
  const checkIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    const live = [...terms.values()].some((t) => t.alive);
    if (live || clients.size || closed) return;
    idleTimer = setTimeout(() => {
      log('idle: no terminals and no server; exiting');
      void close(false);
    }, idleMs);
  };

  // forget exited terminals after a while
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - keepExitedMs;
    for (const [id, t] of terms) if (!t.alive && (t.endedAt ?? 0) < cutoff) terms.delete(id);
  }, Math.min(60_000, keepExitedMs));
  sweeper.unref();

  if (process.platform !== 'win32' && existsSync(o.path)) unlinkSync(o.path);
  const server: Server = createServer((sock) => {
    let authed = false;
    sock.on('error', () => {});
    sock.on('close', () => {
      clients.delete(sock);
      checkIdle();
    });
    onLines(sock, (m: ClientMsg) => {
      if (!authed) {
        if (m?.t !== 'hello' || !sameSecret(m.token, o.token)) {
          sendLine(sock, { t: 'error', msg: 'bad token' });
          sock.end();
          return;
        }
        authed = true;
        clients.add(sock);
        checkIdle();
        sendLine(sock, { t: 'hello', v: PROTOCOL_VERSION, pid: process.pid, terms: snapshot(), ...(o.dir ? { dir: o.dir } : {}) });
        return;
      }
      handle(sock, m);
    });
  });
  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(o.path, () => {
      server.off('error', rej);
      res();
    });
  });
  log(`listening on ${o.path}`);
  checkIdle();

  const close = async (endTerminals: boolean) => {
    if (closed) return;
    closed = true;
    clearInterval(sweeper);
    if (idleTimer) clearTimeout(idleTimer);
    if (endTerminals) for (const t of terms.values()) t.pty?.kill();
    for (const c of clients) c.destroy();
    await new Promise<void>((res) => server.close(() => res()));
    o.onClose?.();
  };

  return { close: () => close(true), terms: snapshot };
}
