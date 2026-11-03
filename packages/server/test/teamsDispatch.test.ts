import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Projects } from '../src/projects';
import { claimItem } from '../src/projectItems';
import { TeamRuntime, type TeamDeps } from '../src/teams';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-dispatch-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Record<string, unknown> = {}) => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {}, ...o });

function makeTeam(wake: 'auto' | 'ask' | 'never' = 'auto', growMax = 2) {
  return {
    version: 0,
    seats: [
      seat('triage', 'Triage'),
      seat('enc', 'Encoder fixer', { count: { min: 1, max: 3 }, startup: { prompt: 'Begin.' } }),
      seat('gen', 'Generalist'),
    ],
    groups: [
      { id: 'dev', name: 'Developers', members: ['encoders', 'general'], dispatch: 'claim', split: { label: 'kind', to: { enc: 'encoders', gen: 'general' }, else: 'general' } },
      { id: 'encoders', name: 'Encoders', members: ['enc'], dispatch: 'claim', grow: { seat: 'enc', max: growMax } },
      { id: 'general', name: 'General', members: ['gen'], dispatch: 'claim' },
      { id: 'leads', name: 'Leads', members: ['triage'], dispatch: 'direct' },
    ],
    labels: [{ id: 'kind', name: 'Kind', values: ['enc', 'gen'] }],
    routes: [{ id: 'r1', from: ['seat:triage'], to: 'group:dev', kinds: ['handoff'], wake }],
    fallback: 'user',
    escalation: [],
  };
}

async function setup(o: { wake?: 'auto' | 'ask' | 'never'; growMax?: number; askWake?: boolean; team?: boolean; failGrow?: string } = {}) {
  let clock = 1_000_000;
  const projects = new Projects(join(dir, 'projects.json'), () => clock);
  const p = projects.create('Ops');
  if (o.team !== false) {
    const r = projects.setTeam(p.id, makeTeam(o.wake, o.growMax), 'you');
    expect(r.ok, JSON.stringify(r)).toBe(true);
  }
  const launches: any[] = [];
  const live = new Set<string>();
  const busy = new Set<string>();
  const delivered: [string, string][] = [];
  const asked: any[] = [];
  const told: string[] = [];
  let n = 0;
  const deps: TeamDeps = {
    projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => clock,
    launch: async (l) => {
      launches.push(l);
      if (o.failGrow && n >= 3) return { error: o.failGrow };
      const sessionId = `s${++n}`;
      live.add(sessionId);
      return { sessionId };
    },
    stop: (sid) => live.delete(sid),
    live: (sid) => live.has(sid),
    idle: (sid) => !busy.has(sid),
    watch: () => {}, deliver: (sid, text) => delivered.push([sid, text]), tell: (text) => told.push(text),
    ...(o.askWake ? { askWake: (pid: string, sid: string, text: string, item: string) => { asked.push([pid, sid, text, item]); } } : {}),
  };
  const rt = new TeamRuntime(deps);
  if (o.team !== false) {
    const up = await rt.bringUp(p.id);
    expect(up.problems).toEqual([]);
    // s1 triage, s2 enc-1, s3 gen
    expect(up.started).toEqual(['s1', 's2', 's3']);
    launches.length = 0;
  }
  return { rt, projects, pid: p.id, launches, live, busy, delivered, asked, told, tick: (ms: number) => (clock += ms) };
}

const offer = (from: string, group: string, title: string, id: string, full = title) => `(from ${from}:) New work for ${group}: ${title}. Claim it with project_claim item ${id} if you're free; otherwise leave it.\n\n${full}`;
const ENC = 'Encoder 7 drops frames\nSince 09:00, see logs.';

describe('dispatch to a group', () => {
  it('offers only to the idle members of the group the label picks, and opens an incident for it', async () => {
    const { rt, projects, pid, delivered, launches } = await setup();
    const r = await rt.dispatch(pid, 's1', 'dev', ENC, { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r.offeredTo).toEqual(['s2']);
    expect(r.grew).toBeUndefined();
    // the whole handoff reaches whoever claims it
    expect(delivered).toEqual([['s2', offer('Triage', 'Encoders', 'Encoder 7 drops frames', r.item, ENC)]]);
    expect(launches).toHaveLength(0);
    const item = projects.get(pid)!.items!.find((i) => i.id === r.item)!;
    expect(item).toMatchObject({ kind: 'incident', title: 'Encoder 7 drops frames', labels: { kind: 'enc' }, offeredTo: 'encoders', openedBy: 's1', updatedBy: 's1', state: 'open', body: ENC });
    expect(item.owner).toBeUndefined();

    const g = await rt.dispatch(pid, 's1', 'dev', 'Disk full on box 3', { kind: 'gen' });
    if ('error' in g) throw new Error(g.error);
    expect(g.offeredTo).toEqual(['s3']);
    expect(delivered[1]).toEqual(['s3', offer('Triage', 'General', 'Disk full on box 3', g.item)]);
  });

  it('it is saved once with its labels and the group it was offered to', async () => {
    const { rt, pid } = await setup();
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    const again = new Projects(join(dir, 'projects.json'), () => 1);
    expect(again.get(pid)!.items!.find((i) => i.id === r.item)).toMatchObject({ labels: { kind: 'enc' }, offeredTo: 'encoders' });
  });

  it('a busy member is not offered', async () => {
    const { rt, pid, busy, delivered } = await setup({ growMax: 1 });
    busy.add('s2');
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r.offeredTo).toEqual([]);
    expect(delivered).toEqual([]);
  });

  it('the first claim wins; the second is refused', async () => {
    const { rt, projects, pid, tick } = await setup();
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    tick(60_000);
    const first = projects.item(pid, (p, now) => claimItem(p, 's2', r.item, now));
    expect(first.ok).toBe(true);
    const second = projects.item(pid, (p, now) => claimItem(p, 's3', r.item, now));
    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toMatch(/^Already claimed: s2/);
    expect(projects.get(pid)!.items!.find((i) => i.id === r.item)!.owner).toBe('s2');
  });

  it('none free: the pool grows by one, numbered, with the work in its first prompt', async () => {
    const { rt, projects, pid, busy, delivered, launches } = await setup();
    busy.add('s2');
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r.offeredTo).toEqual([]);
    expect(r.grew).toBe('s4');
    expect(delivered).toEqual([]);
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ name: `enc-2-${pid.slice(0, 4)}`, seat: { agent: `cora-team-${pid}:enc` } });
    expect(launches[0].prompt).toBe(`Begin.\n\n${offer('Triage', 'Encoders', 'Encoder 7 drops frames', r.item)}`);
    expect(projects.get(pid)!.members.s4).toMatchObject({ seat: 'enc', instance: 2 });
  });

  it('grown above a standing member numbered higher (its 1 gone): the new one is numbered above it, so it is the extra that closes first', async () => {
    const { rt, projects, pid, busy, launches } = await setup({ growMax: 3 });
    projects.setSeat(pid, 's2', 'enc', 2);
    busy.add('s2');
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r.grew).toBe('s4');
    expect(launches[0]).toMatchObject({ name: `enc-3-${pid.slice(0, 4)}`, label: 'Encoder fixer 3' });
    expect(projects.get(pid)!.members.s4).toMatchObject({ seat: 'enc', instance: 3 });
  });

  it("a pool never grows past its seat's count.max, whatever grow.max says (the checks, In words and Try a message say the same)", async () => {
    const { rt, pid, busy, launches } = await setup({ growMax: 5 });
    busy.add('s2');
    const a = await rt.dispatch(pid, 's1', 'dev', 'One', { kind: 'enc' });
    expect('grew' in a && a.grew).toBe('s4');
    busy.add('s4');
    const b = await rt.dispatch(pid, 's1', 'dev', 'Two', { kind: 'enc' });
    expect('grew' in b && b.grew).toBe('s5');
    busy.add('s5');
    const c = await rt.dispatch(pid, 's1', 'dev', 'Three', { kind: 'enc' });
    expect('grew' in c && c.grew).toBeFalsy();
    expect(launches).toHaveLength(2);
  });

  it('at grow.max nothing grows (escalation picks it up)', async () => {
    const { rt, pid, busy, launches } = await setup({ growMax: 2 });
    busy.add('s2');
    const a = await rt.dispatch(pid, 's1', 'dev', 'One', { kind: 'enc' });
    expect('grew' in a && a.grew).toBe('s4');
    busy.add('s4');
    const b = await rt.dispatch(pid, 's1', 'dev', 'Two', { kind: 'enc' });
    if ('error' in b) throw new Error(b.error);
    expect(b).toEqual({ item: b.item, offeredTo: [], delivered: [] });
    expect(launches).toHaveLength(1);
  });

  it('a direct group is refused, naming its members', async () => {
    const { rt, projects, pid } = await setup();
    const r = await rt.dispatch(pid, 'you', 'leads', 'Have a look');
    expect(r).toEqual({ error: 'Name one of Triage.' });
    expect(projects.get(pid)!.items ?? []).toEqual([]);
  });

  it("route wake 'ask': the wake card is asked instead of delivering; without one it delivers", async () => {
    const { rt, pid, delivered, asked } = await setup({ wake: 'ask', askWake: true });
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r.offeredTo).toEqual(['s2']);
    expect(delivered).toEqual([]);
    expect(asked).toEqual([[pid, 's2', offer('Triage', 'Encoders', 'Encoder 7 drops frames', r.item), r.item]]);

    const plain = await setup({ wake: 'ask' });
    const q = await plain.rt.dispatch(plain.pid, 's1', 'dev', 'Again', { kind: 'enc' });
    if ('error' in q) throw new Error(q.error);
    expect(plain.delivered.map(([sid]) => sid)).toEqual(['s2']);
  });

  it("route wake 'never': idle members are not offered, and the pool doesn't grow: the work waits (escalation picks it up)", async () => {
    const { rt, projects, pid, delivered, launches } = await setup({ wake: 'never' });
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r).toEqual({ item: r.item, offeredTo: [], delivered: [] });
    expect(delivered).toEqual([]);
    expect(launches).toHaveLength(0);
    expect(projects.get(pid)!.items!.find((i) => i.id === r.item)).toMatchObject({ offeredTo: 'encoders', state: 'open' });
  });

  it("the pool doesn't grow for a seat stood down on its own, nor for a team that isn't up", async () => {
    const { rt, pid, busy, launches } = await setup();
    busy.add('s2');
    await rt.standDown(pid, 'enc');
    const r = await rt.dispatch(pid, 's1', 'dev', 'Encoder 7 drops frames', { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r).toEqual({ item: r.item, offeredTo: [], delivered: [] });
    await rt.standDown(pid);
    const q = await rt.dispatch(pid, 's1', 'dev', 'Encoder 8 drops frames', { kind: 'enc' });
    if ('error' in q) throw new Error(q.error);
    expect(q).toEqual({ item: q.item, offeredTo: [], delivered: [] });
    expect(launches).toHaveLength(0);
  });

  it('a leading [labels: ...] line is not the title (it stays in the body)', async () => {
    const { rt, projects, pid } = await setup();
    const text = '[labels: kind=gen]\nDisk full on box 3\nSince noon.';
    const r = await rt.dispatch(pid, 's1', 'dev', text, { kind: 'gen' });
    if ('error' in r) throw new Error(r.error);
    expect(projects.get(pid)!.items!.find((i) => i.id === r.item)).toMatchObject({ title: 'Disk full on box 3', body: text });
    // only the labels line: it is the title (nothing else to call it)
    const o = await rt.dispatch(pid, 'you', 'general', '[labels: kind=gen]');
    if ('error' in o) throw new Error(o.error);
    expect(projects.get(pid)!.items!.find((i) => i.id === o.item)!.title).toBe('[labels: kind=gen]');
  });

  it('the user and Cora send as themselves', async () => {
    const { rt, pid, delivered } = await setup();
    const r = await rt.dispatch(pid, 'you', 'dev', 'From you', { kind: 'gen' });
    const c = await rt.dispatch(pid, 'cora', 'general', 'From Cora');
    if ('error' in r || 'error' in c) throw new Error('refused');
    expect(delivered).toEqual([['s3', offer('the user', 'General', 'From you', r.item)], ['s3', offer('Cora', 'General', 'From Cora', c.item)]]);
  });

  it('a long first line is cut to 120 characters for the title', async () => {
    const { rt, projects, pid } = await setup();
    const r = await rt.dispatch(pid, 'you', 'general', 'x'.repeat(200));
    if ('error' in r) throw new Error(r.error);
    expect(projects.get(pid)!.items!.find((i) => i.id === r.item)!.title).toBe('x'.repeat(120));
  });

  it('a route that does not allow it is refused with why', async () => {
    const { rt, projects, pid } = await setup();
    const r = await rt.dispatch(pid, 's3', 'dev', 'Help', { kind: 'enc' });
    expect('error' in r && r.error).toMatch(/^Generalist may not message Encoders/);
    expect(projects.get(pid)!.items ?? []).toEqual([]);
  });

  it("a grown member's first prompt carries the whole handoff", async () => {
    const { rt, pid, busy, launches } = await setup();
    busy.add('s2');
    const r = await rt.dispatch(pid, 's1', 'dev', ENC, { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(launches[0].prompt).toBe(`Begin.\n\n${offer('Triage', 'Encoders', 'Encoder 7 drops frames', r.item, ENC)}`);
  });

  it('a project with a lead: a non-lead seat dispatches on the team\'s authority, recorded as the sender', async () => {
    const { rt, projects, pid, delivered } = await setup();
    projects.update(pid, { lead: 's3' });
    expect(projects.get(pid)!.lead).toBe('s3');
    const r = await rt.dispatch(pid, 's1', 'dev', ENC, { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(r.offeredTo).toEqual(['s2']);
    expect(delivered).toHaveLength(1);
    expect(projects.get(pid)!.items!.find((i) => i.id === r.item)).toMatchObject({ openedBy: 's1', updatedBy: 's1', body: ENC });
  });

  it('a pool that cannot grow says why, once', async () => {
    const { rt, pid, busy, launches, told } = await setup({ failGrow: 'The folder C:/work is missing.' });
    busy.add('s2');
    const r = await rt.dispatch(pid, 's1', 'dev', ENC, { kind: 'enc' });
    if ('error' in r) throw new Error(r.error);
    expect(launches).toHaveLength(1);
    expect(r).toEqual({ item: r.item, offeredTo: [], delivered: [], growFailed: 'The folder C:/work is missing.' });
    expect(told).toEqual(['Couldn\'t add another Encoder fixer for "Encoder 7 drops frames": The folder C:/work is missing.']);
  });

  it('an unknown group, or no team, is an error', async () => {
    const { rt, pid } = await setup();
    expect(await rt.dispatch(pid, 's1', 'nope', 'x')).toEqual({ error: 'This team has no group "nope".' });
    const bare = await setup({ team: false });
    expect(await bare.rt.dispatch(bare.pid, 'you', 'dev', 'x')).toEqual({ error: 'This project has no team.' });
  });
});
