import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-user-post-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {} });
// Triage may only send direct messages to Monitor (no route the other way)
const TEAM: Team = {
  version: 0,
  seats: [seat('triage', 'Triage'), seat('monitor', 'Monitor')],
  groups: [],
  labels: [],
  routes: [{ id: 'r1', from: ['seat:triage'], to: 'seat:monitor', kinds: ['direct'], wake: 'auto' }],
  fallback: 'user',
  escalation: [],
};

describe("your posts and direct messages on a team's board", () => {
  let srv: Running;
  let pid: string;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const TRI = 'bbbb0000-0000-0000-0000-000000000003';
  const MON = 'aaaa0000-0000-0000-0000-000000000001';
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  /** what Cora hands a session's mod next (its mod asking now: it's live) */
  const inbox = (sid: string) => srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).then((r) => r.json().items as Array<{ kind: string; text: string }>);
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

  it('your post to an idle seat wakes it: a turn from you (no card asking you), whatever its kind, routes or not', async () => {
    const asks = inbox(MON);
    await new Promise((r) => setTimeout(r, 30));
    const r = await req('POST', `/api/projects/${pid}/posts`, { kind: 'note', text: 'Start on encoder 3.', to: [MON] });
    expect(r.json().ok).toBe(true);
    expect(await asks).toEqual([{ id: expect.any(String), kind: 'submit', text: '(from the user, in the project "Ops":) Start on encoder 3.' }]);
    const p = srv.projects.get(pid)!;
    expect(p.thread.at(-1)!.deliveredTo).toEqual([MON]);
    expect(p.waiting ?? []).toEqual([]);
    expect((await req('GET', '/api/projects')).json().wakes).toEqual([]);
  });

  it("a member Crew says may not be woken is never typed into, even by you: it reads your post at its next prompt", async () => {
    srv.projects.setMember(pid, MON, { wakes: false });
    void inbox(MON).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    await req('POST', `/api/projects/${pid}/posts`, { kind: 'note', text: 'Over to you.', to: [MON] });
    await new Promise((r) => setTimeout(r, 30));
    const p = srv.projects.get(pid)!;
    expect(p.thread.at(-1)!.deliveredAt).toBeUndefined();
    expect(p.waiting ?? []).toEqual([]);
    expect((await req('GET', '/api/projects')).json().wakes).toEqual([]);
    // its next prompt has it, to it
    const r = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: MON, cwd: 'C:/work', prompt: 'go on', prompt_id: `${MON}-1` } });
    expect(r.json().hookSpecificOutput.additionalContext).toMatch(/To you:\n- \[note\] the user \(post \w+\): Over to you\./);
  });

  it('your post to a busy seat waits for its turn to end (never a card asking you to OK your own words)', async () => {
    srv.store.upsertSession({ id: MON, state: 'working' } as never);
    await req('POST', `/api/projects/${pid}/posts`, { kind: 'note', text: 'When you are free: encoder 4.', to: [MON] });
    expect(srv.projects.get(pid)!.waiting).toEqual([{ post: expect.any(String), to: MON, since: expect.any(Number) }]);
  });

  it('direct is a kind of post: a route that allows only direct messages carries one, from a seat or from the board', async () => {
    const ok = await tool(TRI, 'project_post', { kind: 'direct', text: 'encoder 3 is yours', to: [MON] });
    expect(ok.isError).toBeFalsy();
    expect(srv.projects.get(pid)!.thread.at(-1)).toMatchObject({ kind: 'direct', by: TRI, to: [MON] });
    // the same words as a note: not on the route
    const no = await tool(TRI, 'project_post', { kind: 'note', text: 'psst', to: [MON] });
    expect(no.isError).toBe(true);
    // to a group on a route that carries only direct messages: offered, and on the board as direct (never a handoff)
    const t = { ...TEAM, groups: [{ id: 'mons', name: 'Monitors', members: ['monitor'], dispatch: 'claim' as const }], routes: [...TEAM.routes, { id: 'r2', from: ['seat:triage' as const], to: 'group:mons' as const, kinds: ['direct' as const], wake: 'never' as const }] };
    expect(srv.projects.setTeam(pid, t, 'you').ok).toBe(true);
    const g = await tool(TRI, 'project_post', { kind: 'direct', text: 'one of you, look at encoder 9', to: ['Monitors'] });
    expect(g.isError).toBeFalsy();
    expect(srv.projects.get(pid)!.thread.at(-1)).toMatchObject({ kind: 'direct', by: TRI, item: expect.any(String) });
    // a direct message goes to someone: from the board too
    const nobody = await req('POST', `/api/projects/${pid}/posts`, { kind: 'direct', text: 'Anyone?' });
    expect(nobody.statusCode).toBe(400);
    expect(nobody.json().error).toBe('A direct message goes to someone: pick who it is for.');
    // yours, from the board
    const mine = await req('POST', `/api/projects/${pid}/posts`, { kind: 'direct', text: 'Look at encoder 5.', to: [TRI] });
    expect(mine.json().post).toMatchObject({ kind: 'direct', by: 'you' });
  });
});

describe('wake cards kept through a Cora restart', () => {
  it("a card asking you to wake a member is there again after Cora restarts (not lost, not doubled)", async () => {
    const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
    const A = 'aaaa0000-0000-0000-0000-00000000000a';
    const B = 'bbbb0000-0000-0000-0000-00000000000b';
    // (kept on disk, as Cora keeps them)
    const start = () => startServer(loadConfig({ dataDir: dir, dbPath: join(dir, 'cora.db'), hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    let srv = await start();
    const now = Date.now();
    for (const id of [A, B]) srv.store.upsertSession({ id, alias: id.slice(0, 4), cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
    const pid = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Ops', sessionId: A } })).json().project.id;
    await srv.app.inject({ method: 'POST', url: `/api/projects/${pid}/sessions`, headers: UI, payload: { sessionId: B } });
    // B's mod is here (asking): a handoff to it, idle, asks you first
    const asks = srv.app.inject({ url: `/api/mod/inbox?session=${B}`, headers: { 'x-cora-token': 'hooktok' } });
    await new Promise((r) => setTimeout(r, 30));
    await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': A, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'project_post', arguments: { kind: 'handoff', text: 'your turn', to: [B] } } } });
    const before = (await srv.app.inject({ url: '/api/projects', headers: UI })).json().wakes;
    expect(before).toEqual([expect.objectContaining({ project: pid, from: A, to: B, text: 'your turn' })]);
    void asks;
    await srv.close();
    srv = await start();
    try {
      expect((await srv.app.inject({ url: '/api/projects', headers: UI })).json().wakes).toEqual(before);
    } finally {
      await srv.close();
    }
  });
});
