import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
const cfg = () =>
  loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-app-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') });
afterEach(async () => srv?.close());

const fixtures = join(__dirname, 'fixtures', 'hooks');
const replayHooks = async (s: Running) => {
  for (const f of readdirSync(fixtures).sort()) {
    const body = JSON.parse(readFileSync(join(fixtures, f), 'utf8')).body;
    const r = await s.app.inject({ method: 'POST', url: `/hook/${body.hook_event_name}`, headers: { 'x-cora-token': 'hooktok' }, payload: body });
    expect(r.statusCode).toBe(204);
  }
};

describe('server app', () => {
  it('rejects hooks without the token', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const r = await srv.app.inject({ method: 'POST', url: '/hook/PreToolUse', payload: {} });
    expect(r.statusCode).toBe(401);
  });

  it('ingests a real captured hook sequence into sessions, agents and events', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    await replayHooks(srv);
    const [s] = srv.store.listSessions();
    expect(s).toMatchObject({ cwd: 'C:\\work\\capdemo', project: 'capdemo', state: 'ended' });
    const agents = srv.store.listAgents(s.id);
    const child = agents.find((a) => a.agentId !== 'main')!;
    expect(child).toMatchObject({ parentAgentId: 'main', label: 'Read readme', state: 'done' });
    const events = srv.store.eventsForSession(s.id);
    expect(events.filter((e) => e.kind === 'tool' && e.phase === 'end').length).toBeGreaterThanOrEqual(5);
    expect(events.some((e) => e.kind === 'report' && e.agentId === child.agentId)).toBe(true);
    expect(events.some((e) => e.tool?.failed)).toBe(true);
  });

  it('PermissionRequest with no dashboard connected returns no decision immediately', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const t = Date.now();
    const r = await srv.app.inject({ method: 'POST', url: '/hook/PermissionRequest', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: 's', tool_name: 'Bash', tool_input: { command: 'x' } } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});
    expect(Date.now() - t).toBeLessThan(500);
  });

  it('auth: /auth sets the cookie; api requires it', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    expect((await srv.app.inject({ url: '/api/sessions' })).statusCode).toBe(401);
    expect((await srv.app.inject({ url: '/auth?key=wrong' })).statusCode).toBe(401);
    const login = await srv.app.inject({ url: '/auth?key=uitok' });
    expect(login.statusCode).toBe(302);
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(cookie).toBe('ab_session=uitok');
    expect((await srv.app.inject({ url: '/api/sessions', headers: { cookie } })).statusCode).toBe(200);
  });

  it("the live stream opens only for Cora's own pages, not any page that has the cookie (audit S4)", async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const ws = (origin?: string) => srv.app.inject({ url: '/ws', headers: { cookie: 'ab_session=uitok', ...(origin ? { origin } : {}), connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
    expect((await ws('http://localhost:5173')).statusCode).toBe(403);
    expect((await ws()).statusCode).toBe(403);
    expect((await ws('http://127.0.0.1:4317')).statusCode).not.toBe(403);
  });

  it('a view-only sign-in reads, never acts (audit S2)', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-view-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', viewToken: 'viewtok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false });
    expect((await srv.app.inject({ url: '/auth?view=wrong' })).statusCode).toBe(401);
    const login = await srv.app.inject({ url: '/auth?view=viewtok' });
    const cookie = String(login.headers['set-cookie']).split(';')[0];
    expect(cookie).toBe('ab_view=viewtok');
    const origin = 'http://127.0.0.1:4317';
    expect((await srv.app.inject({ url: '/api/sessions', headers: { cookie } })).statusCode).toBe(200);
    // nothing that acts: settings, a prompt's answer, a terminal
    expect((await srv.app.inject({ method: 'POST', url: '/api/settings', headers: { cookie, origin }, payload: { autoName: true } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'POST', url: '/api/orchestrator/control', headers: { cookie, origin }, payload: { on: true } })).statusCode).toBe(401);
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: { cookie, origin }, payload: { mode: 'new', cwd: tmpdir() } })).statusCode).toBe(401);
  });

  it('action endpoints require a same-origin Origin header', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const cookie = 'ab_session=uitok';
    const bad = await srv.app.inject({ method: 'POST', url: '/api/pending/x', headers: { cookie, origin: 'https://evil.example' }, payload: { decision: 'allow' } });
    expect(bad.statusCode).toBe(403);
    const none = await srv.app.inject({ method: 'POST', url: '/api/pending/x', headers: { cookie }, payload: { decision: 'allow' } });
    expect(none.statusCode).toBe(403);
    const ok = await srv.app.inject({ method: 'POST', url: '/api/pending/x', headers: { cookie, origin: 'http://127.0.0.1:4317' }, payload: { decision: 'allow' } });
    expect(ok.statusCode).toBe(409); // authorized, but no such pending request
  });

  it('session events endpoint pages by ts', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    await replayHooks(srv);
    const [s] = srv.store.listSessions();
    const r = await srv.app.inject({ url: `/api/sessions/${s.id}/events?limit=3`, headers: { cookie: 'ab_session=uitok' } });
    expect(r.json().events).toHaveLength(3);
  });
});

describe('terminal endpoints', () => {
  const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
  const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };

  it('launches a new session in a folder and registers it immediately', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: fakeSpawn });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-term-'));
    const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd } });
    expect(r.statusCode).toBe(200);
    const t = r.json();
    expect(t).toMatchObject({ mode: 'new', alive: true, cwd });
    expect(srv.store.getSession(t.sessionId)?.cwd).toBe(cwd);
    const list = await srv.app.inject({ url: '/api/terminals', headers: { cookie: H.cookie } });
    expect(list.json().terminals).toHaveLength(1);
    const running = await srv.app.inject({ url: `/api/sessions/${t.sessionId}/running`, headers: { cookie: H.cookie } });
    expect(running.json()).toMatchObject({ hosted: true });
  });

  it('resume uses the stored session cwd; bad requests are rejected', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: fakeSpawn });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-term-'));
    srv.store.upsertSession({ id: 'old-1', cwd, title: 'Old work' });
    const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'resume', sessionId: 'old-1' } });
    expect(r.json()).toMatchObject({ sessionId: 'old-1', cwd });
    const fork = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'fork', sessionId: 'old-1' } });
    expect(srv.store.getSession(fork.json().sessionId)?.title).toBe('Old work (fork)');
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'nope' } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd: join(cwd, 'missing') } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: { cookie: H.cookie, origin: 'https://evil.example' }, payload: { mode: 'new', cwd } })).statusCode).toBe(403);
  });
  it('launch options become claude arguments; bad ones are rejected', async () => {
    const calls: string[][] = [];
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: (_f, args) => (calls.push(args), fakeSpawn()) });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-term-'));
    const ok = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd, options: { model: 'claude-opus-5-5[1m]', effort: 'high', permissionMode: 'plan' } } });
    expect(ok.statusCode).toBe(200);
    expect(calls[0].join(' ')).toContain('--model claude-opus-5-5[1m] --effort high --permission-mode plan');
    for (const options of [{ model: 'opus; rm -rf /' }, { effort: 'ludicrous' }, { permissionMode: 'yolo' }]) {
      const bad = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd, options } });
      expect(bad.statusCode).toBe(400);
    }
    expect(calls).toHaveLength(1);
  });

  it('opens a shell beside a session: its cwd, not its Claude; counted live; closed from the dashboard only', async () => {
    const pty = { exits: [] as Array<(e: { exitCode: number }) => void> };
    const spawned: string[] = [];
    srv = await startServer(cfg(), {
      tail: false,
      listen: false,
      spawn: (f) => (spawned.push(f), { onData() {}, onExit: (cb: (e: { exitCode: number }) => void) => pty.exits.push(cb), write() {}, resize() {}, kill: () => pty.exits.at(-1)?.({ exitCode: 1 }) }),
    });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-term-'));
    srv.store.upsertSession({ id: 's1', cwd, state: 'ended', lastTs: 5 });
    // a shell needs a session it belongs to
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'shell', cwd } })).statusCode).toBe(400);
    expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: { cookie: H.cookie, origin: 'https://evil.example' }, payload: { mode: 'shell', sessionId: 's1' } })).statusCode).toBe(403);
    const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'shell', sessionId: 's1' } });
    expect(r.json()).toMatchObject({ mode: 'shell', sessionId: 's1', cwd, alive: true });
    expect(spawned[0]).toMatch(/sh|powershell|pwsh/i);
    // the session itself is untouched and isn't "hosted"
    expect(srv.store.getSession('s1')?.state).toBe('ended');
    expect((await srv.app.inject({ url: '/api/sessions/s1/running', headers: { cookie: H.cookie } })).json()).toMatchObject({ hosted: false });
    const live = await srv.app.inject({ url: '/api/local/terminals', headers: { 'x-cora-token': 'hooktok' } });
    expect(live.json()).toMatchObject({ live: 1, shells: 1 });
    // its shells keep a session from being hidden (the answer says how many, so the list can offer to close them)
    const kept = await srv.app.inject({ method: 'POST', url: '/api/sessions/s1/dismiss', headers: H, payload: {} });
    expect(kept.statusCode).toBe(409);
    expect(kept.json()).toMatchObject({ shells: 1 });
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/dismiss-ended', headers: H, payload: {} })).json()).toEqual({ dismissed: 0 });
    // close: the process ends and the shell is gone from the list
    expect((await srv.app.inject({ method: 'POST', url: `/api/terminals/${r.json().terminalId}/close`, headers: { cookie: H.cookie, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await srv.app.inject({ method: 'POST', url: `/api/terminals/${r.json().terminalId}/close`, headers: H })).json()).toEqual({ ok: true });
    expect((await srv.app.inject({ url: '/api/terminals', headers: { cookie: H.cookie } })).json().terminals).toEqual([]);
    expect(srv.store.getSession('s1')?.state).toBe('ended');
    // or it goes off the list with them when you say so: they're closed
    await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'shell', sessionId: 's1' } });
    const off = await srv.app.inject({ method: 'POST', url: '/api/sessions/s1/dismiss', headers: H, payload: { closeShells: true } });
    expect(off.json().dismissedAt).toBeGreaterThan(0);
    expect((await srv.app.inject({ url: '/api/terminals', headers: { cookie: H.cookie } })).json().terminals).toEqual([]);
    // a Claude terminal isn't closed this way
    const c = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd } });
    expect((await srv.app.inject({ method: 'POST', url: `/api/terminals/${c.json().terminalId}/close`, headers: H })).statusCode).toBe(404);
  });
});

describe('shutdown endpoint', () => {
  it('requires the hook token and calls onShutdown', async () => {
    let called = 0;
    srv = await startServer(cfg(), { tail: false, listen: false, onShutdown: () => called++ });
    expect((await srv.app.inject({ method: 'POST', url: '/api/shutdown', headers: { cookie: 'ab_session=uitok' } })).statusCode).toBe(401);
    // the old header still works (the desktop app or hooks from before the rename)
    expect((await srv.app.inject({ method: 'POST', url: '/api/shutdown', headers: { 'x-agent-brain-token': 'hooktok' } })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(called).toBe(1);
  });
});

describe('launch presets', () => {
  const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
  it('are saved in settings and validated', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const preset = { id: 'p1', name: 'agent-brain', cwd: 'C:\code\agent-brain', model: 'opus', effort: 'high', permissionMode: 'acceptEdits' };
    const r = await srv.app.inject({ method: 'POST', url: '/api/settings', headers: H, payload: { presets: [preset] } });
    expect(r.statusCode).toBe(200);
    expect(r.json().presets).toEqual([preset]);
    const bad = await srv.app.inject({ method: 'POST', url: '/api/settings', headers: H, payload: { presets: [{ ...preset, effort: 'ludicrous' }] } });
    expect(bad.statusCode).toBe(400);
    expect((await srv.app.inject({ url: '/api/settings', headers: { cookie: H.cookie } })).json().presets).toEqual([preset]);
  });
});

describe('session meta, dismiss, presentations and settings', () => {
  const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
  const fresh = async () => (srv = await startServer(cfg(), { tail: false, listen: false }));

  it('sets and clears alias/colour with validation', async () => {
    await fresh();
    srv.store.upsertSession({ id: 's1', cwd: 'C:/work/x' });
    const ok = await srv.app.inject({ method: 'POST', url: '/api/sessions/s1/meta', headers: H, payload: { alias: ' Release work ', color: '#ff8800' } });
    expect(ok.json()).toMatchObject({ alias: 'Release work', color: '#ff8800' });
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/s1/meta', headers: H, payload: { color: 'red' } })).statusCode).toBe(400);
    const cleared = await srv.app.inject({ method: 'POST', url: '/api/sessions/s1/meta', headers: H, payload: { alias: null } });
    expect(cleared.json()).toMatchObject({ alias: null, color: '#ff8800' });
  });

  it('saves the session list order you arrange', async () => {
    await fresh();
    for (const id of ['a', 'b', 'c']) srv.store.upsertSession({ id, cwd: 'C:/work/x' });
    const r = await srv.app.inject({ method: 'POST', url: '/api/sessions/order', headers: H, payload: { ids: ['c', 'nope', 'a', 'b'] } });
    expect(r.json()).toEqual({ ordered: 3 });
    expect(['a', 'b', 'c'].map((id) => srv.store.getSession(id)?.order)).toEqual([2, 3, 0]);
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/order', headers: H, payload: { ids: 'a' } })).statusCode).toBe(400);
  });

  it('dismisses one session, clears all ended, and undoes', async () => {
    await fresh();
    srv.store.upsertSession({ id: 'a', state: 'ended', lastTs: 5 });
    srv.store.upsertSession({ id: 'b', state: 'ended', lastTs: 5 });
    srv.store.upsertSession({ id: 'c', state: 'idle', lastTs: 5 });
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/c/dismiss', headers: H, payload: {} })).json().dismissedAt).toBeGreaterThan(0);
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/dismiss-ended', headers: H, payload: {} })).json()).toEqual({ dismissed: 2 });
    expect((await srv.app.inject({ method: 'POST', url: '/api/sessions/c/dismiss', headers: H, payload: { undo: true } })).json().dismissedAt).toBeNull();
  });

  it('lists presentations', async () => {
    await fresh();
    // recorded before the rename (old tool name) and after
    srv.store.upsertEvent({ id: 'tool:p2:start', sessionId: 's', agentId: 'main', ts: 12, kind: 'tool', phase: 'start', toolUseId: 'p2', icon: { name: 'Presentation', family: 'plan' }, source: 'hook', tool: { name: 'mcp__cora__present', input: { title: 'Plan 2', format: 'markdown', content: '# y' }, summary: 'Plan 2' } });
    srv.store.upsertEvent({ id: 'tool:p1:start', sessionId: 's', agentId: 'main', ts: 10, kind: 'tool', phase: 'start', toolUseId: 'p1', icon: { name: 'Presentation', family: 'plan' }, source: 'hook', tool: { name: 'mcp__agent-brain__present', input: { title: 'Plan', format: 'markdown', content: '# x' }, summary: 'Plan' } });
    srv.store.upsertEvent({ id: 'tool:r1:start', sessionId: 's', agentId: 'main', ts: 11, kind: 'tool', phase: 'start', toolUseId: 'r1', icon: { name: 'FileText', family: 'look' }, source: 'hook', tool: { name: 'Read', input: {}, summary: 'a' } });
    const r = await srv.app.inject({ url: '/api/explains', headers: { cookie: H.cookie } });
    expect(r.json().explains.map((e: any) => e.toolUseId)).toEqual(['p2', 'p1']);
  });

  it('reads and validates settings', async () => {
    await fresh();
    expect((await srv.app.inject({ url: '/api/settings', headers: { cookie: H.cookie } })).json().explains.mode).toBe('markdown+html');
    const up = await srv.app.inject({ method: 'POST', url: '/api/settings', headers: H, payload: { explains: { mode: 'markdown' } } });
    expect(up.json().explains.mode).toBe('markdown');
    expect((await srv.app.inject({ method: 'POST', url: '/api/settings', headers: H, payload: { retentionDays: -1 } })).statusCode).toBe(400);
  });
});

describe('a new session with a brief', () => {
  const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
  const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };

  it('takes a long, several-line brief: typed in once Claude is ready, never a claude argument', async () => {
    const calls: string[][] = [];
    const typed: string[] = [];
    // a Claude Code that draws its input box between two rules, and keeps what's typed into it
    const readyClaude = () => ({
      onData(cb: (d: string) => void) {
        setTimeout(() => cb(`${'─'.repeat(40)}\r\n❯ \r\n${'─'.repeat(40)}\r\n`), 20);
      },
      onExit() {},
      write(d: string) {
        typed.push(d);
      },
      resize() {},
      kill() {},
    });
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: (_f, args) => (calls.push(args), readyClaude()) });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-brief-'));
    const brief = "Node v22.16.0 is missing security releases (v22.21.1 is out). Cora's server runs on it.\n\nUpdate this machine's Node (winget, the installer or nvm), then run Cora's tests.";
    const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd, brief } });
    expect(r.statusCode).toBe(200);
    expect(calls.flat().join(' ')).not.toContain('security releases');
    // ready twice in a row (half a second apart), then typed as one paste and submitted
    await new Promise((res) => setTimeout(res, 1900));
    const all = typed.join('');
    expect(all).toContain('missing security releases (v22.21.1 is out)');
    expect(all).toContain("then run Cora's tests.");
    expect(typed.at(-1)).toBe('\r');
  });

  it('refuses a brief that is not text', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: fakeSpawn });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-brief-'));
    for (const brief of [42, '   ']) {
      expect((await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd, brief } })).statusCode).toBe(400);
    }
  });
});

describe("Cora's agent's gate", () => {
  it('answers only with the hook token; for anyone but Cora on its own turn, it lets the tool run', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    expect((await srv.app.inject({ method: 'POST', url: '/agent-gate', payload: { session_id: 'x', tool_name: 'WebFetch' } })).statusCode).toBe(401);
    const r = await srv.app.inject({ method: 'POST', url: '/agent-gate', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: 'some-session', tool_name: 'WebFetch' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});
  });
});

// docs/audit-2026-10-20.md S17: Cora proves who it is without sending its key
describe('who is on the port', () => {
  it('answers a nonce with an HMAC under its hook key; nothing else', async () => {
    const { createHmac } = await import('node:crypto');
    srv = await startServer(cfg(), { tail: false, listen: false });
    const n = 'ab'.repeat(24);
    const r = await srv.app.inject({ method: 'GET', url: `/api/hello?n=${n}` });
    expect(r.json()).toEqual({ cora: true, mac: createHmac('sha256', 'hooktok').update(`cora-hello:${n}`).digest('hex') });
    expect(r.body).not.toContain('hooktok');
    expect((await srv.app.inject({ method: 'GET', url: '/api/hello?n=xyz' })).statusCode).toBe(400);
  });
});
