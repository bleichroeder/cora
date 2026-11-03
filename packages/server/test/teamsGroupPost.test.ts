import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Route, Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/** Work posted to a group, on the board: delivered only when a member has it now. */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-group-post-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max: 1 }, startup: {}, ...o });
const team = (wake: Route['wake']): Team => ({
  version: 0,
  seats: [seat('triage', 'Triage'), seat('fix', 'Fix')],
  groups: [{ id: 'fixers', name: 'Fixers', members: ['fix'], dispatch: 'claim' }],
  labels: [],
  routes: [{ id: 'work', from: ['seat:triage'], to: 'group:fixers', kinds: ['handoff'], wake }],
  fallback: 'user',
  escalation: [],
});

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const TRI = 'bbbb0000-0000-0000-0000-000000000003';
const FIX = 'cccc0000-0000-0000-0000-000000000004';

describe('work posted to a group, on the board', () => {
  let srv: Running;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const wakes = async () => (await req('GET', '/api/projects')).json().wakes as Array<{ id: string; to: string; from: string; post?: string }>;

  /** Triage and Fix seated; Fix running here (its terminal) and idle, unless `fixRunning` is false. */
  const setUp = async (wake: Route['wake'], fixRunning = true) => {
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never, pluginDir: join(dir, 'claude-plugin') });
    const now = Date.now();
    for (const [id, alias] of [[TRI, 'Triage'], [FIX, 'Fix']]) srv.store.upsertSession({ id, alias, cwd: dir, state: 'idle', startedAt: now, lastTs: now } as never);
    const p = (await req('POST', '/api/projects', { name: 'Ops', sessionId: TRI })).json().project;
    await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: FIX });
    expect(srv.projects.setTeam(p.id, team(wake), 'you').ok).toBe(true);
    srv.projects.setSeat(p.id, TRI, 'triage');
    srv.projects.setSeat(p.id, FIX, 'fix');
    if (fixRunning) expect((await req('POST', '/api/terminals', { mode: 'resume', sessionId: FIX })).statusCode).toBe(200);
    srv.store.upsertSession({ id: FIX, state: 'idle' } as never);
    return p.id as string;
  };
  const posted = (pid: string, text: string) => srv.projects.get(pid)!.thread.find((x) => x.text === text)!;

  it('offered by a wake card (a route that asks): not delivered; the card carries the post', async () => {
    const pid = await setUp('ask');
    try {
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 7 drops frames', to: ['fixers'] })).isError).toBeFalsy();
      const post = posted(pid, 'Encoder 7 drops frames');
      expect(post.to).toEqual([FIX]);
      expect(post.deliveredAt).toBeUndefined();
      expect((await wakes()).filter((w) => w.to === FIX)).toEqual([expect.objectContaining({ from: 'cora', post: post.id })]);
    } finally {
      await srv.close();
    }
  });

  it('delivered to a free member (a route that wakes on its own): delivered', async () => {
    const pid = await setUp('auto');
    try {
      await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 8 drops frames', to: ['fixers'] });
      const post = posted(pid, 'Encoder 8 drops frames');
      expect(post.to).toEqual([FIX]);
      expect(post.deliveredAt).toEqual(expect.any(Number));
      expect(await wakes()).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it('nobody offered it (none running): not delivered, and nobody woken for it', async () => {
    const pid = await setUp('auto', false);
    try {
      await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 9 drops frames', to: ['fixers'] });
      const post = posted(pid, 'Encoder 9 drops frames');
      expect(post.to).toEqual([FIX]);
      expect(post.deliveredAt).toBeUndefined();
      expect(await wakes()).toEqual([]);
      expect(srv.projects.get(pid)!.waiting ?? []).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});
