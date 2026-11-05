import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { Projects } from '../src/projects';
import { startServer, type Running } from '../src/server';
import { TeamRuntime } from '../src/teams';

/**
 * Seats addressed by their names (the test PC, 0.1.23): a post's `to` and an item's owner take a seat's id or its name,
 * a note to a group goes to its members, and what waited for a member that left with nobody in its place (its seat
 * renamed away) goes to the team's fallback.
 */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-addressing-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const seat = (id: string, name: string, max = 1): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max }, startup: {} });
const TEAM: Team = {
  version: 1,
  seats: [seat('analyst-01', 'Analyst 01'), seat('triage', 'Triage'), seat('infra-monitor', 'Infrastructure Monitor'), seat('station-monitor', 'Station Monitor'), seat('fixer', 'Fixer', 2)],
  groups: [{ id: 'monitors', name: 'Monitors', members: ['infra-monitor', 'station-monitor'], dispatch: 'direct' }],
  labels: [],
  routes: [
    { id: 'r-analyst-to-triage', from: ['seat:analyst-01'], to: 'seat:triage', kinds: ['question', 'direct', 'note'], wake: 'auto' },
    { id: 'r-analyst-to-monitors', from: ['seat:analyst-01'], to: 'group:monitors', kinds: ['question', 'note'], wake: 'auto' },
    { id: 'r-triage-to-analyst', from: ['seat:triage'], to: 'seat:analyst-01', kinds: 'any', wake: 'auto' },
    { id: 'r-triage-to-fixer', from: ['seat:triage'], to: 'seat:fixer', kinds: ['handoff'], wake: 'auto' },
  ],
  fallback: 'seat:analyst-01',
  escalation: [],
};

describe('a seat by its name, through the tools', () => {
  let srv: Running;
  const A = 'aaaa0000-0000-0000-0000-000000000001';
  const T = 'bbbb0000-0000-0000-0000-000000000002';
  const IM = 'cccc0000-0000-0000-0000-000000000003';
  const SM = 'dddd0000-0000-0000-0000-000000000004';
  const F1 = 'eeee0000-0000-0000-0000-000000000005';
  const F2 = 'ffff0000-0000-0000-0000-000000000006';
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const thread = () => srv.projects.list()[0].thread;
  afterEach(async () => srv?.close());

  async function setUp() {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false });
    const now = Date.now();
    for (const [id, alias] of [[A, 'Analyst 01'], [T, 'Triage'], [IM, 'Infra'], [SM, 'Station'], [F1, 'Fixer 1'], [F2, 'Fixer 2']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
    const p = srv.projects.create('Broadcast Operations');
    for (const sid of [A, T, IM, SM, F1, F2]) srv.projects.add(p.id, sid);
    srv.projects.update(p.id, { coordination: true });
    expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
    srv.projects.setSeat(p.id, A, 'analyst-01');
    srv.projects.setSeat(p.id, T, 'triage');
    srv.projects.setSeat(p.id, IM, 'infra-monitor');
    srv.projects.setSeat(p.id, SM, 'station-monitor');
    srv.projects.setSeat(p.id, F1, 'fixer', 1);
    srv.projects.setSeat(p.id, F2, 'fixer', 2);
    return p.id;
  }

  it("project_post to a seat by its id or its name, however written: to that seat's member (on its route)", async () => {
    await setUp();
    for (const name of ['Triage', 'triage', ' TRIAGE ']) {
      const r = await tool(A, 'project_post', { kind: 'question', text: `which station? (${name})`, to: [name] });
      expect(r.isError, r.content[0].text).toBeFalsy();
      expect(thread().at(-1)).toMatchObject({ by: A, kind: 'question', to: [T] });
    }
    // the other way: "Analyst 01", "analyst-01"
    for (const name of ['Analyst 01', 'analyst-01']) {
      expect((await tool(T, 'project_post', { kind: 'direct', text: `handled (${name})`, to: [name] })).isError).toBeFalsy();
      expect(thread().at(-1)).toMatchObject({ by: T, to: [A] });
    }
    // a seat in a group, by its name: on the group's route (a question)
    expect((await tool(A, 'project_post', { kind: 'question', text: 'is the feed back?', to: ['Infrastructure Monitor'] })).isError).toBeFalsy();
    expect(thread().at(-1)).toMatchObject({ to: [IM] });
    // no route for it: refused by the route, not as "name a seat"
    const no = await tool(T, 'project_post', { kind: 'question', text: 'x', to: ['Station Monitor'] });
    expect(no.isError).toBe(true);
    expect(no.content[0].text).not.toContain('name a seat');
  });

  it("a note to a group goes to its members (on the group's note route), never refused as no route nor offered as work", async () => {
    const pid = await setUp();
    const r = await tool(A, 'project_post', { kind: 'note', text: 'encoder 3 is back', to: ['Monitors'] });
    expect(r.isError, r.content[0].text).toBeFalsy();
    expect(thread().at(-1)).toMatchObject({ by: A, kind: 'note', to: [IM, SM] });
    // no task or incident was opened for it
    expect(srv.projects.get(pid)!.items ?? []).toEqual([]);
  });

  it("project_item's owner by its seat's name: that seat's member; a pool's several: it says which to name", async () => {
    const pid = await setUp();
    const r = await tool(T, 'project_item', { title: 'Encoder 3 frozen', owner: 'Analyst 01' });
    // (only the lead opens incidents: make the Triage the lead, then)
    if (r.isError) {
      srv.projects.update(pid, { lead: T });
      const again = await tool(T, 'project_item', { title: 'Encoder 3 frozen', owner: 'Analyst 01' });
      expect(again.isError, again.content[0].text).toBeFalsy();
    }
    expect(srv.projects.get(pid)!.items!.at(-1)!.owner).toBe(A);
    srv.projects.update(pid, { lead: T });
    const pool = await tool(T, 'project_item', { title: 'Fix encoder 3', owner: 'Fixer' });
    expect(pool.isError).toBe(true);
    expect(pool.content[0].text).toMatch(/^Fixer has 2 members: name one \(/);
    expect((await tool(T, 'project_item', { title: 'Fix encoder 3', owner: 'fixer-2' })).isError).toBeFalsy();
    expect(srv.projects.get(pid)!.items!.at(-1)!.owner).toBe(F2);
  });

  it("a pool's member by the name the card shows it as (\"Fixer 2\"), however written: that member, as owner and in a post's to", async () => {
    const pid = await setUp();
    srv.projects.update(pid, { lead: T });
    for (const name of ['Fixer 2', 'fixer 2', ' FIXER_2 ']) {
      const r = await tool(T, 'project_item', { kind: 'task', title: `Fix encoder 3 (${name})`, owner: name });
      expect(r.isError, r.content[0].text).toBeFalsy();
      expect(srv.projects.get(pid)!.items!.at(-1)!.owner).toBe(F2);
    }
    // reassigned by it too
    const item = srv.projects.get(pid)!.items!.at(-1)!.id;
    const re = await tool(T, 'project_item', { item, owner: 'Fixer 1' });
    expect(re.isError, re.content[0].text).toBeFalsy();
    expect(srv.projects.get(pid)!.items!.find((i) => i.id === item)!.owner).toBe(F1);
    // a post to it: that member only
    expect((await tool(T, 'project_post', { kind: 'handoff', text: 'encoder 3 is yours', to: ['Fixer 1'] })).isError).toBeFalsy();
    expect(thread().at(-1)).toMatchObject({ by: T, to: [F1] });
    // a number it doesn't have: refused, as before
    const none = await tool(T, 'project_item', { kind: 'task', title: 'x', owner: 'Fixer 3' });
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/isn't in this project/);
  });
});

describe("what waited for a member that left with nobody in its place", () => {
  it("goes to the team's fallback (its seat renamed away by an edit), not nowhere; the lead isn't passed with it", async () => {
    let clock = 1_000_000;
    const projects = new Projects(null, () => clock);
    const p = projects.create('Broadcast Operations');
    const old: Team = { ...TEAM, seats: [seat('senior-system-analyst', 'Senior System Analyst')], groups: [], routes: [], fallback: 'user' };
    expect(projects.setTeam(p.id, old, 'you').ok).toBe(true);
    const live = new Set<string>(['old1', 'new1']);
    const rt = new TeamRuntime({ projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => clock, launch: async () => ({ error: 'no' }), stop: () => {}, live: (sid) => live.has(sid), idle: () => true, deliver: () => {}, tell: () => {} });
    projects.add(p.id, 'old1');
    projects.setSeat(p.id, 'old1', 'senior-system-analyst');
    projects.update(p.id, { coordination: true, lead: 'old1' });
    // a handoff waits for it
    const post = projects.post(p.id, 'you', 'handoff', 'take the encoder incident', ['old1'])!;
    projects.wait(p.id, post.id, 'old1');
    // v2: the seats renamed; the new analyst is up (the fallback)
    const v2: Team = { ...TEAM, seats: [seat('analyst-01', 'Analyst 01')], groups: [], routes: [], fallback: 'seat:analyst-01' };
    const prev = projects.get(p.id)!.team!;
    expect(projects.setTeam(p.id, v2, 'you').ok).toBe(true);
    projects.add(p.id, 'new1');
    projects.setSeat(p.id, 'new1', 'analyst-01');
    rt.resume();
    await rt.bringUp(p.id).catch(() => {});
    await rt.applyEdit(p.id, prev, projects.get(p.id)!.team!);
    // the old member closes; the next tick lets it go
    live.delete('old1');
    await rt.tick((clock += 5000));
    const now = projects.get(p.id)!;
    expect(now.sessions).not.toContain('old1');
    expect(now.waiting).toEqual([expect.objectContaining({ post: post.id, to: 'new1' })]);
    expect(now.thread.find((x) => x.id === post.id)!.to).toContain('new1');
    // (the lead isn't the fallback's to take)
    expect(now.lead).not.toBe('new1');
  });
});
