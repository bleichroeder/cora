import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startHost, type Host } from '../src/ptyhost/host';
import { HealingHostBackend, HostBackend, connectOrStartHost, vetHost } from '../src/ptyhost/backend';
import { hostRuntime, hostRunningFrom } from '../src/ptyhost/runtime';
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

describe('the terminal host, kept', () => {
  it('goes away: its terminals end, a new host is started, and what was launched meanwhile runs there', async () => {
    const a = await fixture();
    const b = await fixture();
    const first = await HostBackend.connect(a.path, TOKEN);
    let tries = 0;
    const logs: string[] = [];
    const be = new HealingHostBackend(first, () => (tries++, HostBackend.connect(b.path, TOKEN)), (m) => logs.push(m));
    const exits: Array<[string, number]> = [];
    be.onExit((id, code) => exits.push([id, code]));
    be.spawn('t1', 'claude', [], opts, meta);
    await until(() => a.ptys.length === 1);
    await a.host.close();
    // it ends (the host ends it, or its going does)
    await until(() => exits.length === 1 && be.lost);
    expect(exits.map(([id]) => id)).toEqual(['t1']);
    // launched while it's coming back: it runs on the new host
    be.spawn('t2', 'claude', [], opts, meta);
    await until(() => b.ptys.length === 1);
    expect(tries).toBe(1);
    expect(logs.join(' ')).toMatch(/went away.*back/);
    await be.close(true);
  });

  it("no host can be started: what's launched ends at once, saying why", async () => {
    const a = await fixture();
    const be = new HealingHostBackend(await HostBackend.connect(a.path, TOKEN), () => Promise.reject(new Error('no node')), () => {});
    const said: string[] = [];
    const exits: Array<[string, number]> = [];
    be.onData((_id, d) => said.push(d));
    be.onExit((id, code) => exits.push([id, code]));
    await a.host.close();
    await until(() => be.lost);
    be.spawn('t3', 'claude', [], opts, meta);
    await until(() => exits.some(([id]) => id === 't3'), 15_000);
    expect(said.join('')).toMatch(/terminal host isn't running, so claude couldn't start/);
  }, 20_000);
});

describe("an older Cora's terminal host (an update came while it ran)", () => {
  const files = (dir: string) => {
    mkdirSync(join(dir, 'node_modules', '@lydell', 'node-pty'), { recursive: true });
    writeFileSync(join(dir, 'node.exe'), 'node');
    writeFileSync(join(dir, 'node_modules', '@lydell', 'node-pty', 'index.js'), 'pty');
  };

  it('keeps its terminals; its folder, if it lost its files, is mended from this build so new terminals start', async () => {
    const path = pipe();
    const old = mkdtempSync(join(tmpdir(), 'host-old-'));
    const ours = mkdtempSync(join(tmpdir(), 'host-new-'));
    files(ours);
    hosts.push(await startHost({ path, token: TOKEN, spawn: () => new FakePty(), dir: old }));
    const first = await HostBackend.connect(path, TOKEN);
    first.spawn('t1', 'claude', [], opts, meta);
    await tick(50);
    await first.close(false);
    const b = await HostBackend.connect(path, TOKEN);
    expect(b.hostDir).toBe(old);
    const said: string[] = [];
    expect(await vetHost(b, ours, (m) => said.push(m), async () => true)).toBe(true);
    expect(readFileSync(join(old, 'node.exe'), 'utf8')).toBe('node');
    expect(existsSync(join(old, 'node_modules', '@lydell', 'node-pty', 'index.js'))).toBe(true);
    expect(said.join('\n')).toMatch(/mended an older Cora's terminal host/);
    // this build's own host: nothing to do
    expect(await vetHost(b, old, () => {}, async () => true)).toBe(true);
    await b.close(false);
  });

  it('with no terminals, it makes way: shut down, so this build starts its own', async () => {
    const path = pipe();
    let closed = false;
    hosts.push(await startHost({ path, token: TOKEN, spawn: () => new FakePty(), dir: mkdtempSync(join(tmpdir(), 'host-old-')), onClose: () => (closed = true) }));
    const b = await HostBackend.connect(path, TOKEN);
    const ours = mkdtempSync(join(tmpdir(), 'host-new-'));
    const said: string[] = [];
    expect(await vetHost(b, ours, (m) => said.push(m), () => HostBackend.connect(path, TOKEN, 300).then((x) => (void x.close(false), true), () => false))).toBe(false);
    await until(() => closed);
    expect(said[0]).toMatch(/older Cora's, with no terminals/);
  });

  it("an update's cleanup leaves the folder a host still runs from, and removes the rest (saying when it can't)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-rt-'));
    const dist = mkdtempSync(join(tmpdir(), 'cora-dist-'));
    writeFileSync(join(dist, 'ptyhost.js'), 'host v2');
    const modules = mkdtempSync(join(tmpdir(), 'cora-mods-'));
    mkdirSync(join(modules, '@lydell', 'node-pty'), { recursive: true });
    const node = join(dist, 'node.exe');
    writeFileSync(node, 'node');
    const rt = join(dataDir, 'runtime');
    for (const d of ['host-aaaaaaaaaaaa', 'host-bbbbbbbbbbbb', 'host-cccccccccccc.gone']) mkdirSync(join(rt, d), { recursive: true });
    const r = hostRuntime({ dataDir, node, distDir: dist, modulesDir: modules, running: (dir) => dir.endsWith('host-aaaaaaaaaaaa') });
    const left = readdirSync(rt).sort();
    expect(left).toContain('host-aaaaaaaaaaaa');
    expect(left).not.toContain('host-bbbbbbbbbbbb');
    expect(left).not.toContain('host-cccccccccccc.gone');
    expect(existsSync(r.script)).toBe(true);
    // its pid kept in its folder: running while that process lives
    writeFileSync(join(rt, 'host-aaaaaaaaaaaa', 'host.pid'), String(process.pid));
    expect(hostRunningFrom(join(rt, 'host-aaaaaaaaaaaa'))).toBe(true);
    writeFileSync(join(rt, 'host-aaaaaaaaaaaa', 'host.pid'), '4294967');
    expect(hostRunningFrom(join(rt, 'host-aaaaaaaaaaaa'))).toBe(false);
  });
});
