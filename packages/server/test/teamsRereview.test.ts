import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/** The re-review's fixes, through the app: hooks, MCP tools, mod events and routes. */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-rereview-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max: 1 }, startup: {}, ...o });
const TEAM: Team = {
  version: 0,
  seats: [seat('triage', 'Triage'), seat('fix', 'Fix')],
  groups: [],
  labels: [],
  routes: [{ id: 'asks', from: ['seat:triage'], to: 'seat:fix', kinds: 'any', wake: 'ask' }],
  fallback: 'user',
  escalation: [],
};

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const TRI = 'bbbb0000-0000-0000-0000-000000000003';
const FIX = 'cccc0000-0000-0000-0000-000000000004';
const NEW = 'dddd0000-0000-0000-0000-000000000005';
const OTHER = 'eeee0000-0000-0000-0000-000000000006';

describe('the re-review fixes, through the app', () => {
  let srv: Running;
  const req = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  /** a team set as you set one: a draft in the builder, applied */
  const applyTeam = async (pid: string, team: Team) => {
    const d = (await req('PUT', `/api/projects/${pid}/builder`, { team, rev: 0 })).json().draft;
    return req('POST', `/api/projects/${pid}/builder/apply`, { rev: d.rev });
  };
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  /** its mod asks Cora for what it has (it waits until something comes) */
  const poll = (sid: string) => srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).then((r) => r.json().items as Array<{ kind: string; text: string }>);
  const prompt = async (sid: string, n: number) => {
    const r = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/work', prompt: 'go on', prompt_id: `${sid}-${n}` } });
    return r.statusCode === 204 ? '' : ((r.json().hookSpecificOutput?.additionalContext as string | undefined) ?? '');
  };
  const wakes = async () => (await req('GET', '/api/projects')).json().wakes as Array<{ id: string; to: string; from: string; post?: string }>;
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const session = (id: string, alias: string, state = 'idle') => srv.store.upsertSession({ id, alias, cwd: dir, state, startedAt: Date.now(), lastTs: Date.now() } as never);

  /** Triage and Fix in a project with the team; Fix busy (what's posted to it waits). */
  const setUp = async () => {
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never, pluginDir: join(dir, 'claude-plugin') });
    session(TRI, 'Triage');
    session(FIX, 'Fix', 'working');
    const p = (await req('POST', '/api/projects', { name: 'Ops', sessionId: TRI })).json().project;
    await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: FIX });
    expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
    srv.projects.setSeat(p.id, TRI, 'triage');
    srv.projects.setSeat(p.id, FIX, 'fix');
    return p.id as string;
  };
  /** A new member of Fix's seat (joined after what was posted to Fix) takes what Fix held, and Fix leaves. */
  const replaceFix = async (pid: string, o: { wakes?: boolean } = {}) => {
    session(NEW, 'Fix (new)');
    await req('POST', `/api/projects/${pid}/sessions`, { sessionId: NEW });
    srv.projects.setSeat(pid, NEW, 'fix');
    if (o.wakes === false) srv.projects.setMember(pid, NEW, { wakes: false });
    expect(srv.projects.handOver(pid, FIX, NEW)).toBe(true);
    srv.projects.leave(pid, FIX);
  };

  it("1: a post waiting for a member handed to its replacement shows on the replacement's first prompt, and only then is cleared", async () => {
    const pid = await setUp();
    try {
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 3 needs a restart', to: [FIX] })).isError).toBeFalsy();
      const post = srv.projects.get(pid)!.thread.at(-1)!;
      expect(srv.projects.get(pid)!.waiting).toEqual([expect.objectContaining({ post: post.id, to: FIX })]);
      await replaceFix(pid);
      expect(srv.projects.get(pid)!.waiting).toEqual([expect.objectContaining({ post: post.id, to: NEW })]);
      // the thread says who has it now
      expect(srv.projects.get(pid)!.thread.find((x) => x.id === post.id)!.to).toContain(NEW);
      const first = await prompt(NEW, 1);
      expect(first).toContain('To you:');
      expect(first).toContain(`(post ${post.id}): Encoder 3 needs a restart`);
      expect(srv.projects.get(pid)!.waiting ?? []).toEqual([]);
      // and not again
      expect(await prompt(NEW, 2)).not.toContain('Encoder 3 needs a restart');
    } finally {
      await srv.close();
    }
  });

  it("1: a prompt clears only what waits on a post that names its member (one that doesn't never showed)", async () => {
    const pid = await setUp();
    try {
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'For Triage only', to: ['user'] })).isError).toBeFalsy();
      const post = srv.projects.get(pid)!.thread.at(-1)!;
      srv.projects.wait(pid, post.id, FIX);
      await prompt(FIX, 1);
      expect(srv.projects.get(pid)!.waiting).toEqual([expect.objectContaining({ post: post.id, to: FIX })]);
    } finally {
      await srv.close();
    }
  });

  it('6: a post handed to a member that may not be woken is no wake card (nor delivered): it hears it on its next prompt', async () => {
    const pid = await setUp();
    try {
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 3 needs a restart', to: [FIX] })).isError).toBeFalsy();
      const post = srv.projects.get(pid)!.thread.at(-1)!;
      await replaceFix(pid, { wakes: false });
      // the new member is idle and its mod is here: reachable
      const got = poll(NEW);
      await tick();
      // anything posted looks at what waits
      expect((await tool(TRI, 'project_post', { kind: 'note', text: 'fyi' })).isError).toBeFalsy();
      expect((await wakes()).filter((w) => w.to === NEW)).toEqual([]);
      expect(srv.projects.get(pid)!.waiting).toEqual([expect.objectContaining({ post: post.id, to: NEW })]);
      expect(await prompt(NEW, 1)).toContain('Encoder 3 needs a restart');
      // its mod was given nothing
      const raced = await Promise.race([got, new Promise<'none'>((r) => setTimeout(() => r('none'), 50))]);
      expect(raced === 'none' || (raced as Array<unknown>).length === 0).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("7: a member's wake cards follow what it held to the member that took its place; a member that leaves with nobody in its place takes its cards with it", async () => {
    const pid = await setUp();
    try {
      // Fix idle, its mod here: the route asks first, so a card
      session(FIX, 'Fix', 'idle');
      const got = poll(FIX);
      await tick();
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 3 needs a restart', to: [FIX] })).isError).toBeFalsy();
      const post = srv.projects.get(pid)!.thread.at(-1)!;
      expect(await wakes()).toEqual([expect.objectContaining({ from: TRI, to: FIX, post: post.id })]);
      void got;
      await replaceFix(pid);
      // the same card, now for the new member (not a second one)
      session(NEW, 'Fix (new)', 'idle');
      void poll(NEW);
      await tick();
      expect((await tool(TRI, 'project_post', { kind: 'note', text: 'fyi' })).isError).toBeFalsy();
      expect(await wakes()).toEqual([expect.objectContaining({ from: TRI, to: NEW, post: post.id })]);

      // a member taken out of the project with nobody in its place: its cards go
      session(OTHER, 'Other', 'idle');
      await req('POST', `/api/projects/${pid}/sessions`, { sessionId: OTHER });
      srv.projects.setSeat(pid, OTHER, 'fix');
      void poll(OTHER);
      await tick();
      expect((await tool(TRI, 'project_post', { kind: 'question', text: 'Can you check encoder 4?', to: [OTHER] })).isError).toBeFalsy();
      expect((await wakes()).filter((w) => w.to === OTHER)).toHaveLength(1);
      expect((await req('DELETE', `/api/projects/${pid}/sessions/${OTHER}`)).statusCode).toBe(200);
      expect((await wakes()).filter((w) => w.to === OTHER)).toEqual([]);
      expect(await wakes()).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });
  it('8: stood down, the flag stays through ordinary edits; a different team in its place (no seat in common) clears it', async () => {
    const pid = await setUp();
    try {
      expect((await req('POST', `/api/projects/${pid}/team/bring-up`)).statusCode).toBe(200);
      expect((await req('POST', `/api/projects/${pid}/team/stand-down`, {})).statusCode).toBe(200);
      expect(srv.projects.get(pid)!.teamStoodDown).toBe(true);
      const cur = srv.projects.get(pid)!.team!;
      // an edit: a seat renamed, one added
      const edit = { ...cur, seats: [...cur.seats.map((x) => (x.id === 'fix' ? { ...x, name: 'Fixer' } : x)), seat('extra', 'Extra')] };
      expect((await applyTeam(pid, edit)).statusCode).toBe(200);
      expect(srv.projects.get(pid)!.teamStoodDown).toBe(true);
      // a whole new team
      const other: Team = { version: 0, seats: [seat('ops', 'Ops')], groups: [], labels: [], routes: [], fallback: 'user', escalation: [] };
      expect((await applyTeam(pid, other)).statusCode).toBe(200);
      expect(srv.projects.get(pid)!.teamStoodDown).toBeUndefined();
    } finally {
      await srv.close();
    }
  });
});
