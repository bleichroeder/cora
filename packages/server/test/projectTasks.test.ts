import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { projectCard, itemsSummary } from '../src/projectCard';
import { annotateItem, changeItem, claimItem, closeItem, itemLine, mergeItem, openItem, queryItems } from '../src/projectItems';
import { Projects } from '../src/projects';
import { startServer, type Running } from '../src/server';
import { TeamRuntime } from '../src/teams';

/** Tasks: a dev team's work queue on the project board (queued in rank order, owned, moved on, closed as done). */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-tasks-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const seat = (id: string, name: string) => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {} });
const TEAM: Team = {
  version: 0,
  seats: [seat('eng', 'Engineer'), seat('rev', 'Reviewer')],
  groups: [{ id: 'builders', name: 'Builders', members: ['eng'], dispatch: 'claim' }],
  labels: [],
  routes: [],
  fallback: 'user',
  escalation: [],
};

const setup = (o: { lead?: boolean } = { lead: true }) => {
  const t = 1_000_000;
  const ps = new Projects(join(dir, 'projects.json'), () => t);
  const p = ps.create('Dev');
  for (const s of ['lead', 'eng', 'rev']) ps.add(p.id, s);
  if (o.lead) ps.update(p.id, { lead: 'lead' });
  return { ps, p: ps.get(p.id)!, t };
};
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
};
const bad = (r: { ok: true } | { ok: false; error: string }) => (r.ok ? '(it was allowed)' : r.error);

describe('tasks: who may do what', () => {
  it('the lead (or you) opens a task: queued, last in rank, its owner told; nobody else may', () => {
    const { p, t } = setup();
    const a = ok(openItem(p, 'lead', { kind: 'task', title: 'Work panel', body: 'A Work panel on the board.', owner: 'eng', link: 'feat/work-items' }, t));
    expect(a.item).toMatchObject({ kind: 'task', state: 'queued', rank: 1, owner: 'eng', link: 'feat/work-items', body: 'A Work panel on the board.' });
    expect(a.item.severity).toBeUndefined();
    expect(a.tell).toEqual({ to: 'eng', text: 'Assigned you the task "Work panel"' });
    expect(ok(openItem(p, 'you', { kind: 'task', title: 'Team map' }, t)).item.rank).toBe(2);
    expect(bad(openItem(p, 'eng', { kind: 'task', title: 'My own idea' }, t))).toBe('Only the lead (lead) opens tasks in this project: post it to the lead instead.');
    // no severity: its rank is its order
    expect(bad(openItem(p, 'lead', { kind: 'task', title: 'x', severity: 'high' }, t))).toMatch(/no severity/);
  });

  it('with no lead, its opener runs it (as an incident)', () => {
    const { p, t } = setup({ lead: false });
    const a = ok(openItem(p, 'eng', { kind: 'task', title: 'Fix the label' }, t)).item;
    expect(ok(changeItem(p, 'eng', a.id, { rank: 5 }, t)).item.rank).toBe(5);
    expect(bad(changeItem(p, 'rev', a.id, { rank: 1 }, t))).toMatch(/Only the task's opener/);
  });

  it("owner, rank, title and body are the lead's; state, next step and link the owner's (or the lead's); anyone annotates", () => {
    const { p, t } = setup();
    const a = ok(openItem(p, 'lead', { kind: 'task', title: 'Work panel', owner: 'eng' }, t)).item;
    // the owner moves it on
    expect(ok(changeItem(p, 'eng', a.id, { state: 'building', next: 'server first', link: 'feat/work-items' }, t)).item).toMatchObject({ state: 'building', next: 'server first', link: 'feat/work-items' });
    for (const s of ['review', 'testing', 'blocked', 'queued']) expect(ok(changeItem(p, 'eng', a.id, { state: s }, t)).item.state).toBe(s);
    // not to done (that's closing), nor an incident's states
    expect(bad(changeItem(p, 'eng', a.id, { state: 'done' }, t))).toMatch(/close it with project_close/);
    expect(bad(changeItem(p, 'eng', a.id, { state: 'working' }, t))).toMatch(/queued, building, review, testing, blocked/);
    // the owner can't rank, reassign or retitle it
    expect(bad(changeItem(p, 'eng', a.id, { rank: 0 }, t))).toMatch(/Only the lead \(lead\) changes a task's owner, rank, title or description/);
    expect(bad(changeItem(p, 'eng', a.id, { owner: 'rev' }, t))).toMatch(/Only the lead/);
    // someone else can't move it on
    expect(bad(changeItem(p, 'rev', a.id, { state: 'review' }, t))).toMatch(/It's eng's: only its owner \(or the lead\)/);
    expect(bad(changeItem(p, 'rev', a.id, { link: 'x' }, t))).toMatch(/only its owner/);
    // the lead reassigns it: the new owner is told
    expect(ok(changeItem(p, 'lead', a.id, { owner: 'rev' }, t)).tell).toEqual({ to: 'rev', text: 'Reassigned you the task "Work panel". Next: server first' });
    expect(bad(changeItem(p, 'lead', a.id, { severity: 'high' }, t))).toMatch(/no severity/);
    expect(bad(changeItem(p, 'lead', a.id, { rank: 'first' }, t))).toMatch(/Rank is a number/);
    // anyone annotates; its owner hears
    expect(ok(annotateItem(p, 'eng', a.id, 'the panel needs a Done toggle', t)).tell).toEqual({ to: 'rev', text: 'Noted on "Work panel": the panel needs a Done toggle' });
  });

  it('closed as done by the lead (or you) with its outcome; never by its owner, never without one; then nothing changes it', () => {
    const { p, t } = setup();
    const a = ok(openItem(p, 'lead', { kind: 'task', title: 'Work panel', owner: 'eng' }, t)).item;
    expect(bad(closeItem(p, 'eng', a.id, undefined, undefined, t, 'merged'))).toMatch(/Only the lead \(lead\) closes a task/);
    expect(bad(closeItem(p, 'lead', a.id, 'cause', 'fix', t))).toMatch(/Its outcome, please/);
    const done = ok(closeItem(p, 'lead', a.id, undefined, undefined, t + 60_000, 'merged as abc1234')).item;
    expect(done).toMatchObject({ state: 'done', outcome: 'merged as abc1234', closedAt: t + 60_000 });
    expect(done.cause).toBeUndefined();
    expect(bad(changeItem(p, 'eng', a.id, { state: 'review' }, t))).toBe('"Work panel" is done.');
    expect(queryItems(p, { kind: 'task' })).toEqual([]);
    expect(queryItems(p, { kind: 'task', open: false }).map((i) => i.id)).toEqual([a.id]);
    expect(itemLine(done, (x) => x, t + 120_000)).toBe(`[task · done] Work panel (item ${a.id}) · owner eng · done 1m ago · outcome: merged as abc1234`);
    // an incident still closes with its cause and fix, never an outcome alone
    const inc = ok(openItem(p, 'lead', { title: 'Station A: no video' }, t)).item;
    expect(bad(closeItem(p, 'lead', inc.id, undefined, undefined, t, 'fine now'))).toBe('An incident closes with its cause and fix.');
  });

  it('never the incident-only paths: not merged; claimed only while offered to a group its seat is in', () => {
    const { ps, p, t } = setup();
    ps.setTeam(p.id, TEAM, 'you');
    ps.setSeat(p.id, 'eng', 'eng');
    ps.setSeat(p.id, 'rev', 'rev');
    const q = ps.get(p.id)!;
    const a = ok(openItem(q, 'lead', { kind: 'task', title: 'A' }, t)).item;
    const b = ok(openItem(q, 'lead', { kind: 'task', title: 'B' }, t)).item;
    expect(bad(mergeItem(q, 'lead', b.id, a.id, t))).toMatch(/Tasks aren’t merged/);
    // nobody's: the lead assigns it (no claiming a task)
    expect(bad(claimItem(q, 'eng', a.id, t))).toBe('Nobody has it: the lead assigns tasks.');
    // offered to a group (its owner the group, nobody told by name): a member of it claims it, another seat can't
    const c = ok(openItem(q, 'lead', { kind: 'task', title: 'C', owner: 'builders' }, t));
    expect(c.item.owner).toBe('builders');
    expect(c.tell).toBeUndefined();
    // its line names the group it's offered to (never "a session")
    expect(itemLine(c.item, () => 'a session', t, q)).toContain(' · offered to Builders · ');
    // a note on it while it's offered: noted, nobody told by name (a group isn't a session)
    const noted = ok(annotateItem(q, 'lead', c.item.id, 'start with the server', t));
    expect(noted.item.notes.at(-1)!.text).toBe('start with the server');
    expect(noted.tell).toBeUndefined();
    expect(bad(claimItem(q, 'rev', c.item.id, t))).toBe('"C" is offered to builders, and your seat isn\'t in it.');
    expect(ok(claimItem(q, 'eng', c.item.id, t + 5)).item).toMatchObject({ owner: 'eng', ownedAt: t + 5, state: 'queued' });
    expect(bad(claimItem(q, 'rev', c.item.id, t))).toBe("Already eng's: the lead reassigns tasks.");
    // a group that isn't the team's is nobody
    expect(bad(openItem(q, 'lead', { kind: 'task', title: 'D', owner: 'nobody-group' }, t))).toBe("nobody-group isn't in this project.");
  });

  it('in rank order (then the oldest first), after the incidents', () => {
    const { p, t } = setup();
    const a = ok(openItem(p, 'lead', { kind: 'task', title: 'A' }, t)).item;
    const b = ok(openItem(p, 'lead', { kind: 'task', title: 'B' }, t + 1)).item;
    const c = ok(openItem(p, 'lead', { kind: 'task', title: 'C' }, t + 2)).item;
    expect(queryItems(p, { kind: 'task' }).map((i) => i.title)).toEqual(['A', 'B', 'C']);
    ok(changeItem(p, 'lead', c.id, { rank: 0 }, t));
    ok(changeItem(p, 'lead', a.id, { rank: b.rank }, t));
    expect(queryItems(p, { kind: 'task' }).map((i) => i.title)).toEqual(['C', 'A', 'B']);
    ok(openItem(p, 'lead', { title: 'Station A: no video' }, t));
    expect(queryItems(p, {}).map((i) => i.title)).toEqual(['Station A: no video', 'C', 'A', 'B']);
  });

  it("a member replaced in its seat hands its open tasks to its successor (as its incidents)", () => {
    const { ps, p, t } = setup();
    const a = ok(openItem(p, 'lead', { kind: 'task', title: 'A', owner: 'eng' }, t)).item;
    ps.add(p.id, 'eng-2');
    expect(ps.handOver(p.id, 'eng', 'eng-2')).toBe(true);
    expect(ps.get(p.id)!.items!.find((i) => i.id === a.id)!.owner).toBe('eng-2');
  });
});

describe('tasks never escalate', () => {
  it("unclaimed, stale or critical rules: a task is never re-offered, its owner never nudged, the user never told", async () => {
    let clock = 1_000_000;
    const projects = new Projects(join(dir, 'p.json'), () => clock);
    const p = projects.create('Dev');
    expect(projects.setTeam(p.id, { ...TEAM, escalation: [{ when: 'unclaimed', after: 1, then: ['reoffer', 'tell-lead', 'tell-user'] }, { when: 'stale', after: 1, then: ['nudge-owner', 'tell-user'] }, { when: 'critical', then: ['tell-user', 'dm-user'] }] } as never, 'you').ok).toBe(true);
    const told: string[] = [];
    const delivered: string[] = [];
    const rt = new TeamRuntime({ projects, dataDir: join(dir, 'data'), pluginDir: null, now: () => clock, launch: async () => ({ error: 'no' }), stop: () => {}, live: () => true, idle: () => true, deliver: (_s, x) => void delivered.push(x), tell: (x) => void told.push(x) });
    projects.add(p.id, 'eng');
    projects.setSeat(p.id, 'eng', 'eng');
    const r = projects.item(p.id, (q, now) => openItem(q, 'you', { kind: 'task', title: 'Unowned work' }, now));
    const s = projects.item(p.id, (q, now) => openItem(q, 'you', { kind: 'task', title: 'Owned work', owner: 'eng' }, now));
    const g = projects.item(p.id, (q, now) => openItem(q, 'you', { kind: 'task', title: 'Offered work', owner: 'builders' }, now));
    // (an incident beside them, as a check that these rules do fire)
    const inc = projects.item(p.id, (q, now) => openItem(q, 'you', { title: 'Station A: no video', severity: 'critical' }, now));
    expect([r.ok, s.ok, g.ok, inc.ok]).toEqual([true, true, true, true]);
    for (const m of [2, 10, 60, 600]) await rt.tick((clock = 1_000_000 + m * 60_000));
    expect(told.length).toBeGreaterThan(0);
    expect([...told, ...delivered].every((x) => x.includes('Station A'))).toBe(true);
    expect([...told, ...delivered].join('\n')).not.toMatch(/work/i);
  });
});

describe('the card: "Your work:"', () => {
  it("a member's open tasks, in rank order (not others', not done ones)", () => {
    const { p, t } = setup();
    const a = ok(openItem(p, 'lead', { kind: 'task', title: 'Second', owner: 'eng', rank: 2 }, t)).item;
    const b = ok(openItem(p, 'lead', { kind: 'task', title: 'First', owner: 'eng', rank: 1, link: 'fix/first' }, t)).item;
    ok(openItem(p, 'lead', { kind: 'task', title: 'Not mine', owner: 'rev' }, t));
    const d = ok(openItem(p, 'lead', { kind: 'task', title: 'Done already', owner: 'eng' }, t)).item;
    ok(closeItem(p, 'lead', d.id, undefined, undefined, t, 'merged'));
    ok(changeItem(p, 'eng', a.id, { state: 'building' }, t));
    const card = projectCard(p, 'eng', (x) => ({ name: x, state: 'idle' }), (x) => x, true);
    const work = card.split('Your work:\n')[1]?.split('\n\n')[0] ?? '';
    expect(work.split('\n')).toEqual([expect.stringContaining(`[task · queued · rank 1] First (item ${b.id})`), expect.stringContaining(`[task · building · rank 2] Second (item ${a.id})`)]);
    expect(work).toContain('fix/first');
    expect(card).not.toContain('Not mine');
    expect(card).not.toContain('Done already');
    // nothing of its own: no "Your work"
    expect(projectCard(p, 'lead', (x) => ({ name: x, state: 'idle' }), (x) => x, true)).not.toContain('Your work:');
    // a read of the items lists them, in order
    expect(itemsSummary(p, (x) => x)).toMatch(/Tasks, in order:\n- \[task · queued · rank 1\] First[\s\S]*\n- \[task · building · rank 2\] Second/);
  });
});

describe('tasks through the MCP tools', () => {
  let srv: Running;
  afterEach(async () => srv?.close());

  it('project_item opens and moves a task, project_items lists them (kind task), project_close takes its outcome', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false });
    const LEAD = 'llll0000-0000-0000-0000-000000000001';
    const ENG = 'eeee0000-0000-0000-0000-000000000002';
    const now = Date.now();
    for (const [id, alias] of [[LEAD, 'Lead'], [ENG, 'Engineer']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
    const p = srv.projects.create('Dev');
    srv.projects.add(p.id, LEAD);
    srv.projects.add(p.id, ENG);
    srv.projects.update(p.id, { coordination: true, lead: LEAD });
    const tool = async (sid: string, name: string, args: object) =>
      (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } })).json().result as { isError?: boolean; content: Array<{ text: string }> };
    const opened = await tool(LEAD, 'project_item', { kind: 'task', title: 'Work panel', owner: ENG, link: 'feat/work-items' });
    expect(opened.isError).toBeFalsy();
    const id = srv.projects.get(p.id)!.items![0].id;
    expect(opened.content[0].text).toMatch(/^\[task · queued · rank 1\] Work panel/);
    expect((await tool(ENG, 'project_item', { item: id, state: 'review' })).content[0].text).toMatch(/^\[task · review · rank 1\]/);
    expect((await tool(ENG, 'project_items', { kind: 'task', owner: 'me' })).content[0].text).toMatch(/^- \[task · review · rank 1\] Work panel/);
    expect((await tool(LEAD, 'project_close', { item: id })).content[0].text).toBe('Close an incident with its cause and fix, a task with its outcome.');
    expect((await tool(ENG, 'project_close', { item: id, outcome: 'merged' })).isError).toBe(true);
    expect((await tool(LEAD, 'project_close', { item: id, outcome: 'merged as abc1234' })).content[0].text).toMatch(/^\[task · done\] Work panel .* outcome: merged as abc1234$/);
    expect((await tool(ENG, 'project_items', { kind: 'task', log: true })).content[0].text).toContain('outcome: merged as abc1234');
  });
});
