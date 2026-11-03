import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { Projects, UNDELIVERED_MS, undeliveredWaits } from '../src/projects';
import { startServer, type Running } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-undelivered-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a post waiting for a member Cora cannot reach', () => {
  it('is found once it has waited long enough, marked once, and unmarked when its member is reachable again', () => {
    let t = 1_000_000;
    const ps = new Projects(null, () => t);
    const p = ps.create('Ops');
    for (const s of ['a', 'b', 'c']) ps.add(p.id, s);
    const x = ps.post(p.id, 'a', 'handoff', 'yours', ['b', 'c'])!;
    ps.wait(p.id, x.id, 'b');
    ps.wait(p.id, x.id, 'c');
    const up = new Set(['c']);
    const reach = (sid: string) => up.has(sid);
    // not long enough yet
    t += UNDELIVERED_MS - 1;
    expect(undeliveredWaits(ps.get(p.id)!, t, reach)).toEqual({ lost: [], back: [] });
    // b can't be reached; c can (it waits for its turn, as before)
    t += 1;
    const { lost } = undeliveredWaits(ps.get(p.id)!, t, reach);
    expect(lost.map((w) => w.to)).toEqual(['b']);
    expect(ps.undelivered(p.id, x.id, 'b', true)).toBe(true);
    expect(ps.undelivered(p.id, x.id, 'b', true)).toBe(false);
    expect(ps.get(p.id)!.waiting!.find((w) => w.to === 'b')!.undelivered).toBe(t);
    expect(undeliveredWaits(ps.get(p.id)!, t + UNDELIVERED_MS, reach)).toEqual({ lost: [], back: [] });
    // b is back
    up.add('b');
    const { back } = undeliveredWaits(ps.get(p.id)!, t, reach);
    expect(back.map((w) => w.to)).toEqual(['b']);
    expect(ps.undelivered(p.id, x.id, 'b', false)).toBe(true);
    expect(ps.get(p.id)!.waiting!.find((w) => w.to === 'b')!.undelivered).toBeUndefined();
  });
});

const seat = (id: string, name: string): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {} });
const TEAM: Team = {
  version: 0,
  seats: [seat('triage', 'Triage'), seat('monitor', 'Monitor')],
  groups: [],
  labels: [],
  routes: [{ id: 'r1', from: ['seat:triage'], to: 'seat:monitor', kinds: ['direct'], wake: 'auto' }],
  fallback: 'user',
  escalation: [],
};

describe('undelivered posts on a project board', () => {
  let srv: Running;
  let pid: string;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const TRI = 'bbbb0000-0000-0000-0000-000000000003';
  const MON = 'aaaa0000-0000-0000-0000-000000000001';
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const nudge = () => req('POST', `/api/projects/${pid}/posts`, { kind: 'note', text: 'fyi' });
  const told = () => srv.projects.get(pid)!.thread.filter((x) => x.by === 'cora' && /^Not delivered/.test(x.text));
  beforeEach(async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const now = Date.now();
    for (const [id, alias] of [[TRI, 'Triage'], [MON, 'Monitor']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
    pid = (await req('POST', '/api/projects', { name: 'Ops', sessionId: TRI })).json().project.id;
    await req('POST', `/api/projects/${pid}/sessions`, { sessionId: MON });
    expect(srv.projects.setTeam(pid, TEAM, 'you').ok).toBe(true);
    srv.projects.setSeat(pid, TRI, 'triage');
    srv.projects.setSeat(pid, MON, 'monitor');
  });
  afterEach(async () => srv.close());

  it("its sender is told once that it couldn't be delivered; it keeps waiting, and loses the mark when its member is back", async () => {
    // Monitor isn't hosted here and nothing of it asks for messages
    expect((await tool(TRI, 'project_post', { kind: 'direct', text: 'encoder 3 is yours', to: [MON] })).isError).toBeFalsy();
    const sent = srv.projects.get(pid)!.thread.at(-1)!;
    const w = srv.projects.get(pid)!.waiting!.find((x) => x.to === MON)!;
    // not long yet: nobody told
    await nudge();
    expect(told()).toEqual([]);
    w.since -= UNDELIVERED_MS + 60_000;
    await nudge();
    expect(srv.projects.get(pid)!.waiting!.find((x) => x.to === MON)).toMatchObject({ post: sent.id, undelivered: expect.any(Number) });
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatchObject({ kind: 'note', to: [TRI] });
    expect(told()[0].text).toMatch(new RegExp(`^Not delivered: your direct to "Monitor" \\(post ${sent.id}\\) has waited 11 minutes, and "Monitor" isn't running in this Cora`));
    // once
    await nudge();
    expect(told()).toHaveLength(1);
    // the board has it too
    const board = (await req('GET', '/api/projects')).json().projects.find((x: { id: string }) => x.id === pid);
    expect(board.waiting).toEqual([expect.objectContaining({ to: MON, undelivered: expect.any(Number) })]);
    // Monitor's mod starts asking (busy, so it isn't delivered yet): reachable again, the mark goes
    srv.store.upsertSession({ id: MON, state: 'working' } as never);
    void srv.app.inject({ url: `/api/mod/inbox?session=${MON}`, headers: { 'x-cora-token': 'hooktok' } }).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await nudge();
    expect(srv.projects.get(pid)!.waiting!.find((x) => x.to === MON)).toMatchObject({ post: sent.id });
    expect(srv.projects.get(pid)!.waiting!.find((x) => x.to === MON)!.undelivered).toBeUndefined();
  });

  it('your own post: you are told, on the board', async () => {
    srv.store.upsertSession({ id: MON, state: 'working' } as never);
    await req('POST', `/api/projects/${pid}/posts`, { kind: 'note', text: 'When you are free: encoder 4.', to: [MON] });
    srv.projects.get(pid)!.waiting!.find((x) => x.to === MON)!.since -= UNDELIVERED_MS;
    await nudge();
    expect(told()).toHaveLength(1);
    expect(told()[0]).toMatchObject({ to: ['user'] });
    expect(told()[0].text).toMatch(/^Not delivered: your note to "Monitor"/);
  });
});
