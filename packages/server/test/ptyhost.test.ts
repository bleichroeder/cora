import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHost, type Host } from '../src/ptyhost/host';
import { HostBackend, connectOrStartHost } from '../src/ptyhost/backend';
import { socketPath } from '../src/ptyhost/protocol';
import type { PtyLike, SpawnFn } from '../src/ptyhost/spawn';
import { PtyManager } from '../src/pty';

class FakePty implements PtyLike {
  dataCbs: Array<(d: string) => void> = [];
  exitCbs: Array<(e: { exitCode: number }) => void> = [];
  written: string[] = [];
  size: [number, number] = [0, 0];
  killed = false;
  onData(cb: (d: string) => void) { this.dataCbs.push(cb); }
  onExit(cb: (e: { exitCode: number }) => void) { this.exitCbs.push(cb); }
  write(d: string) { this.written.push(d); }
  resize(c: number, r: number) { this.size = [c, r]; }
  kill() { this.killed = true; this.exit(1); }
  emit(d: string) { this.dataCbs.forEach((cb) => cb(d)); }
  exit(code: number) { this.exitCbs.forEach((cb) => cb({ exitCode: code })); }
}

const TOKEN = 'test-token';
const pipe = () => (process.platform === 'win32' ? `\\\\.\\pipe\\agent-brain-test-${randomUUID()}` : join(mkdtempSync(join(tmpdir(), 'abh-')), 'pty.sock'));
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await tick(10);
  }
};

let hosts: Host[] = [];
afterEach(async () => {
  await Promise.all(hosts.map((h) => h.close()));
  hosts = [];
});

async function fixture(o: { idleMs?: number; onClose?: () => void } = {}) {
  const path = pipe();
  const ptys: FakePty[] = [];
  const spawn: SpawnFn = () => {
    const p = new FakePty();
    ptys.push(p);
    return p;
  };
  const host = await startHost({ path, token: TOKEN, spawn, idleMs: o.idleMs, onClose: o.onClose });
  hosts.push(host);
  return { path, ptys, host };
}
const meta = { sessionId: 's1', cwd: 'C:\\x', mode: 'new' as const, startedAt: 1 };
const opts = { cwd: 'C:\\x', cols: 80, rows: 24, env: {} };

describe('terminal host', () => {
  it('rejects a client with the wrong token', async () => {
    const { path } = await fixture();
    await expect(HostBackend.connect(path, 'nope')).rejects.toThrow(/bad token/);
  });

  it("a host still on the older key (from before hosts had their own) is reattached, not replaced", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'abh-'));
    hosts.push(await startHost({ path: socketPath(dataDir), token: 'old-key', spawn: () => new FakePty() }));
    const b = await connectOrStartHost({ dataDir, token: 'new-key', olderTokens: ['old-key'], hostScript: 'never-started.js', timeoutMs: 300 });
    expect(b).toBeInstanceOf(HostBackend);
    await b.close(false);
  });

  it('spawns, streams output, and routes input and resizes', async () => {
    const { path, ptys } = await fixture();
    const b = await HostBackend.connect(path, TOKEN);
    const got: string[] = [];
    b.onData((id, d) => got.push(`${id}:${d}`));
    b.spawn('t1', 'claude', ['--session-id', 's1'], opts, meta);
    await until(() => ptys.length === 1);
    ptys[0].emit('hello');
    await until(() => got.length === 1);
    expect(got).toEqual(['t1:hello']);
    b.write('t1', 'ls\r');
    b.resize('t1', 120, 40);
    await until(() => ptys[0].written.length === 1);
    expect(ptys[0].written).toEqual(['ls\r']);
    await until(() => ptys[0].size[0] === 120);
    await b.close(false);
  });

  it('terminals outlive the client; a new client gets them back with their scrollback', async () => {
    const { path, ptys } = await fixture();
    const first = await HostBackend.connect(path, TOKEN);
    first.spawn('t1', 'claude', [], opts, meta);
    await until(() => ptys.length === 1);
    ptys[0].emit('line one\r\n');
    ptys[0].emit('line two');
    await tick();
    await first.close(false); // the server stops (restart, crash)
    expect(ptys[0].killed).toBe(false);
    ptys[0].emit(' (while nobody watched)');
    await tick();

    const second = await HostBackend.connect(path, TOKEN);
    expect(second.restored).toEqual([{ id: 't1', meta, alive: true, buf: 'line one\r\nline two (while nobody watched)' }]);
    await second.close(false);
  });

  it('reports exits, including ones that happened while no server was connected', async () => {
    const { path, ptys } = await fixture();
    const a = await HostBackend.connect(path, TOKEN);
    const exits: Array<[string, number]> = [];
    a.onExit((id, code) => exits.push([id, code]));
    a.spawn('t1', 'claude', [], opts, meta);
    a.spawn('t2', 'claude', [], opts, { ...meta, sessionId: 's2' });
    await until(() => ptys.length === 2);
    ptys[0].exit(0);
    await until(() => exits.length === 1);
    expect(exits).toEqual([['t1', 0]]);
    await a.close(false);
    ptys[1].exit(3);
    await tick();
    const b = await HostBackend.connect(path, TOKEN);
    expect(b.restored.map((t) => [t.id, t.alive, t.exitCode])).toEqual([['t1', false, 0], ['t2', false, 3]]);
    await b.close(false);
  });

  it('a client that asks to end everything kills the terminals and stops the host', async () => {
    let closed = false;
    const { path, ptys } = await fixture({ onClose: () => (closed = true) });
    const b = await HostBackend.connect(path, TOKEN);
    b.spawn('t1', 'claude', [], opts, meta);
    await until(() => ptys.length === 1);
    await b.close(true);
    await until(() => closed);
    expect(ptys[0].killed).toBe(true);
  });

  it('exits on its own when idle: no terminals and no server', async () => {
    let closed = false;
    const { path } = await fixture({ idleMs: 50, onClose: () => (closed = true) });
    const b = await HostBackend.connect(path, TOKEN);
    await tick(120);
    expect(closed).toBe(false); // a connected server keeps it alive
    await b.close(false);
    await until(() => closed);
  });

  it('the host going away ends the server-side terminals', async () => {
    const { path, ptys, host } = await fixture();
    const b = await HostBackend.connect(path, TOKEN);
    const exits: Array<[string, number]> = [];
    b.onExit((id, code) => exits.push([id, code]));
    b.spawn('t1', 'claude', [], opts, meta);
    await until(() => ptys.length === 1);
    await host.close();
    await until(() => exits.length === 1);
    expect(exits[0][0]).toBe('t1');
  });
});

describe('PtyManager over the terminal host', () => {
  it('a restarted server picks up running terminals: same id, scrollback, input routing', async () => {
    const { path, ptys } = await fixture();
    const cwd = process.cwd();
    const pm1 = new PtyManager({ backend: await HostBackend.connect(path, TOKEN), claudeCmd: ['claude'], screen: null });
    const t = pm1.launch({ mode: 'new', cwd });
    await until(() => ptys.length === 1);
    ptys[0].emit('working on it');
    await tick();
    expect(pm1.persistent).toBe(true);
    await pm1.disposeAll(false); // server restart

    const exited: string[] = [];
    const pm2 = new PtyManager({ backend: await HostBackend.connect(path, TOKEN), claudeCmd: ['claude'], screen: null, onExit: (x) => exited.push(x.terminalId) });
    expect(pm2.list()).toMatchObject([{ terminalId: t.terminalId, sessionId: t.sessionId, cwd, mode: 'new', alive: true }]);
    expect(pm2.forSession(t.sessionId)?.terminalId).toBe(t.terminalId);
    const seen: string[] = [];
    pm2.attach(t.terminalId, { data: (d) => seen.push(d), exit: () => {} });
    expect(seen).toEqual(['working on it']);
    pm2.write(t.terminalId, 'y');
    await until(() => ptys[0].written.includes('y'));
    ptys[0].exit(0);
    await until(() => exited.length === 1);
    expect(pm2.liveCount()).toBe(0);
    await pm2.disposeAll(false);
  });

  it('shells outlive a restart too, still as shells; ones that ended meanwhile are dropped', async () => {
    const { path, ptys } = await fixture();
    const cwd = process.cwd();
    const pm1 = new PtyManager({ backend: await HostBackend.connect(path, TOKEN), claudeCmd: ['claude'], shellCmd: ['pwsh.exe'], screen: null });
    const a = pm1.launch({ mode: 'shell', cwd, sessionId: 's1' });
    pm1.launch({ mode: 'shell', cwd, sessionId: 's1' });
    await until(() => ptys.length === 2);
    ptys[0].emit('PS C:\\x> npm run dev');
    await tick();
    await pm1.disposeAll(false);
    ptys[1].exit(1); // ended while no server was up

    const exited: string[] = [];
    const pm2 = new PtyManager({ backend: await HostBackend.connect(path, TOKEN), claudeCmd: ['claude'], screen: null, onExit: (x) => exited.push(x.terminalId) });
    expect(pm2.list()).toMatchObject([{ terminalId: a.terminalId, sessionId: 's1', mode: 'shell', alive: true }]);
    expect(pm2.forSession('s1')).toBeUndefined();
    expect(exited).toEqual([]);
    const seen: string[] = [];
    pm2.attach(a.terminalId, { data: (d) => seen.push(d), exit: () => {} });
    expect(seen).toEqual(['PS C:\\x> npm run dev']);
    expect(pm2.closeShell(a.terminalId)).toBe(true);
    await until(() => pm2.list().length === 0);
    expect(ptys[0].killed).toBe(true);
    await pm2.disposeAll(false);
  });
});
