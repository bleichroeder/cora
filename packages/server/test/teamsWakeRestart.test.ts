import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/** A message held for your OK on a route that asks stays held across a restart of Cora (found live in the drill). */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-wake-restart-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max: 1 }, startup: {}, ...o });
const TEAM: Team = {
  version: 0,
  seats: [seat('triage', 'Triage'), seat('fix', 'Fix', { count: { min: 1, max: 2 } })],
  groups: [{ id: 'fixers', name: 'Fixers', members: ['fix'], dispatch: 'claim' }],
  labels: [],
  routes: [
    { id: 'work', from: ['seat:triage'], to: 'group:fixers', kinds: ['handoff'], wake: 'auto' },
    { id: 'back', from: ['group:fixers'], to: 'seat:triage', kinds: ['note', 'question', 'direct'], wake: 'ask' },
  ],
  fallback: 'user',
  escalation: [],
};

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
const LEAD = 'dddd0000-0000-0000-0000-000000000001';
const TRI = 'bbbb0000-0000-0000-0000-000000000003';
const FIX1 = 'cccc0000-0000-0000-0000-000000000004';
const FIX2 = 'cccc0000-0000-0000-0000-000000000005';

describe('held for your OK, across a restart', () => {
  let srv: Running;
  const start = async () => {
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: join(dir, 'cora.db'), hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never, pluginDir: join(dir, 'claude-plugin') });
    const now = Date.now();
    for (const [id, alias] of [[LEAD, 'Lead'], [TRI, 'Triage'], [FIX1, 'Fix 1'], [FIX2, 'Fix 2']]) srv.store.upsertSession({ id, alias, cwd: dir, state: 'idle', startedAt: now, lastTs: now } as never);
  };
  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const event = (body: object) => srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: body }).then((r) => r.json());
  /** its mod asks Cora for what it has (it waits until something comes): it's live here */
  const poll = (sid: string) => void srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).catch(() => undefined);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const wakes = async () => (await req('GET', '/api/projects')).json().wakes as Array<{ id: string; to: string; from: string; text: string }>;

  /** A team project that lets its sessions wake each other (as the drill's did); two fixers back to triage, whose route asks. */
  const setUp = async () => {
    await start();
    const p = (await req('POST', '/api/projects', { name: 'Ops', sessionId: LEAD })).json().project;
    for (const sid of [TRI, FIX1, FIX2]) await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: sid });
    await req('PATCH', `/api/projects/${p.id}`, { autoWake: true });
    expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
    srv.projects.setSeat(p.id, TRI, 'triage');
    srv.projects.setSeat(p.id, FIX1, 'fix', 1);
    srv.projects.setSeat(p.id, FIX2, 'fix', 2);
    // triage's mod is here and it's idle
    await event({ session: TRI, kind: 'start', version: { version: '2.1.316' } });
    poll(TRI);
    await tick();
    return p.id as string;
  };

  it('a note on a route that asks gets its card again after a restart, never delivered on its own', async () => {
    const pid = await setUp();
    expect((await tool(FIX1, 'project_post', { kind: 'note', text: 'fixed encoder 3', to: [TRI] })).isError).toBeFalsy();
    expect((await wakes()).filter((w) => w.to === TRI)).toHaveLength(1);
    await srv.close();

    await start();
    try {
      await event({ session: TRI, kind: 'start', version: { version: '2.1.316' } });
      poll(TRI);
      await tick();
      // anything that makes Cora look at what's waiting
      await tool(LEAD, 'project_post', { kind: 'note', text: 'back' });
      const post = srv.projects.get(pid)!.thread.find((x) => x.text === 'fixed encoder 3')!;
      expect(post.deliveredAt).toBeUndefined();
      expect((await wakes()).filter((w) => w.to === TRI)).toEqual([expect.objectContaining({ from: FIX1, text: 'fixed encoder 3' })]);
    } finally {
      await srv.close();
    }
  });

  it('its writer gone from the project (a pool shrank): still the route that asks, not the project setting', async () => {
    const pid = await setUp();
    expect((await tool(FIX2, 'project_post', { kind: 'note', text: 'fixed encoder 4', to: [TRI] })).isError).toBeFalsy();
    expect((await wakes()).filter((w) => w.to === TRI)).toHaveLength(1);
    // the pool closes its extra, then Cora restarts
    srv.projects.leave(pid, FIX2);
    await srv.close();

    await start();
    try {
      await event({ session: TRI, kind: 'start', version: { version: '2.1.316' } });
      poll(TRI);
      await tick();
      await tool(LEAD, 'project_post', { kind: 'note', text: 'look again' });
      const post = srv.projects.get(pid)!.thread.find((x) => x.text === 'fixed encoder 4')!;
      expect(post.deliveredAt).toBeUndefined();
      expect((await wakes()).filter((w) => w.to === TRI)).toEqual([expect.objectContaining({ from: FIX2, text: 'fixed encoder 4' })]);
    } finally {
      await srv.close();
    }
  });
});
