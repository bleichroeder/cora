import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimItem, openItem } from '../src/projectItems';
import { Projects } from '../src/projects';
import { TeamRuntime } from '../src/teams';

/** A team's members over stand down, Bring up, dying and closing, with members that take a moment to close. */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-life-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
const seat = (id: string, o: Record<string, unknown> = {}) => ({ id, name: id, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {}, ...o });
const team = (seats: unknown[], o: Record<string, unknown> = {}) => ({ version: 0, seats, groups: [], labels: [], routes: [], fallback: 'user', escalation: [], ...o });

function setup(seats: unknown[], o: Record<string, unknown> = {}) {
  let clock = 1_000_000;
  const projects = new Projects(null, () => clock);
  const p = projects.create('Ops');
  expect(projects.setTeam(p.id, team(seats, o), 'you').ok).toBe(true);
  const live = new Set<string>();
  /** asked to stop, still closing (live until close()) */
  const closing = new Set<string>();
  const resumed: string[] = [];
  const launched: string[] = [];
  const told: string[] = [];
  let n = 0;
  const rt = new TeamRuntime({
    projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => clock,
    launch: async () => {
      const sessionId = `s${++n}`;
      launched.push(sessionId);
      live.add(sessionId);
      return { sessionId };
    },
    resume: async (sid) => (resumed.push(sid), live.add(sid), { sessionId: sid }),
    stop: (sid) => void closing.add(sid),
    dismiss: () => {},
    live: (sid) => live.has(sid), idle: () => false, deliver: () => {}, tell: (t) => void told.push(t),
  });
  /** the members asked to stop have closed */
  const close = () => {
    for (const s of closing) live.delete(s);
    closing.clear();
  };
  const at = (ms: number) => rt.tick((clock = 1_000_000 + ms));
  const liveMembers = () => Object.entries(projects.get(p.id)!.members).filter(([s]) => live.has(s)).map(([s, m]) => [s, m.instance]);
  /** an incident `sid` owns */
  const owns = (sid: string, title: string) => {
    const r = projects.item(p.id, (proj, now) => openItem(proj, 'you', { kind: 'incident', title }, now));
    if (!r.ok) throw new Error(r.error);
    const c = projects.item(p.id, (proj, now) => claimItem(proj, sid, r.item.id, now));
    if (!c.ok) throw new Error(c.error);
    return r.item.id;
  };
  const owner = (id: string) => projects.get(p.id)!.items!.find((i) => i.id === id)!.owner;
  return { rt, projects, pid: p.id, live, closing, close, resumed, launched, told, at, liveMembers, owns, owner };
}

describe('stand down, then Bring up at once (its members still closing)', () => {
  it('starts nobody new; once closed, the same members come back as themselves', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    const r = await s.rt.bringUp(s.pid);
    expect(r.started).toEqual([]);
    s.close();
    await s.at(5_000);
    await s.at(10_000);
    expect(s.launched).toEqual(['s1']);
    expect(s.resumed).toEqual(['s1']);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s1']);
    expect(s.liveMembers()).toEqual([['s1', undefined]]);
  });

  it('a pool: no two live members with the same instance, its standing members resumed', async () => {
    const s = setup([seat('a', { count: { min: 2, max: 3 } })]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    expect((await s.rt.bringUp(s.pid)).started).toEqual([]);
    s.close();
    await s.at(5_000);
    await s.at(10_000);
    expect(s.launched).toEqual(['s1', 's2']);
    expect(s.resumed).toEqual(['s1', 's2']);
    expect(s.liveMembers()).toEqual([['s1', 1], ['s2', 2]]);
    // and again: still the same two
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(20_000);
    await s.rt.bringUp(s.pid);
    expect(s.launched).toEqual(['s1', 's2']);
    expect(s.liveMembers()).toEqual([['s1', 1], ['s2', 2]]);
  });

  it('their resume is not taken for a failed start while they close', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    await s.rt.bringUp(s.pid);
    // still closing over several ticks (within the 2 minutes it is waited for)
    for (const t of [20, 40, 60, 80, 100]) await s.at(t * 1000);
    s.close();
    await s.at(110_000);
    expect(s.resumed).toEqual(['s1']);
    expect(s.told).toEqual([]);
    expect(s.rt.health(s.pid)[0].failing).toBe(false);
  });
});

describe('what a member held, when it leaves', () => {
  it('replaced by a new member of its seat: the lead, what was waiting for it and its incidents pass to it', async () => {
    const s = setup([seat('a'), seat('b')]);
    await s.rt.bringUp(s.pid);
    s.projects.update(s.pid, { lead: 's1' });
    const inc = s.owns('s1', 'Disk full');
    const post = s.projects.post(s.pid, 's2', 'handoff', 'Over to you', ['s1'])!;
    s.projects.wait(s.pid, post.id, 's1');
    // s1 dies, is brought back once, dies again: a fresh one takes its seat
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1']);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    const p = s.projects.get(s.pid)!;
    expect(p.sessions).toEqual(['s2', 's3']);
    expect(p.lead).toBe('s3');
    expect(p.waiting?.map((w) => [w.post, w.to])).toEqual([[post.id, 's3']]);
    // the post names it too: it shows as "To you" on its first prompt
    expect(p.thread.find((x) => x.id === post.id)!.to).toEqual(['s1', 's3']);
    expect(s.owner(inc)).toBe('s3');
    expect(s.told).toEqual([]);
  });

  it('Start fresh: the new member of its seat takes what the old one held', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    s.projects.update(s.pid, { lead: 's1' });
    const inc = s.owns('s1', 'Disk full');
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    await s.rt.bringUp(s.pid, { fresh: true });
    expect(s.resumed).toEqual([]);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s2']);
    expect(s.projects.get(s.pid)!.lead).toBe('s2');
    expect(s.owner(inc)).toBe('s2');
    expect(s.told).toEqual([]);
  });

  it('a pool extra let go with nobody in its place: the user is told what it held', async () => {
    const s = setup([seat('w', { name: 'Worker', count: { min: 1, max: 3 } })]);
    await s.rt.bringUp(s.pid);
    // grown for load: a second member, which leads and owns an incident
    s.projects.add(s.pid, 's9');
    s.projects.setSeat(s.pid, 's9', 'w', 2);
    s.live.add('s9');
    s.projects.update(s.pid, { lead: 's9' });
    s.owns('s9', 'Encoder 7 drops frames');
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s1']);
    expect(s.told).toEqual([`Ops: Worker 2 left the team while it was the project's lead and owned "Encoder 7 drops frames": pick a new lead and give it a new owner.`]);
  });

  it('let go holding nothing: nothing said', async () => {
    const s = setup([seat('w', { count: { min: 1, max: 3 } })]);
    await s.rt.bringUp(s.pid);
    s.projects.add(s.pid, 's9');
    s.projects.setSeat(s.pid, 's9', 'w', 2);
    s.live.add('s9');
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    expect(s.told).toEqual([]);
  });
});

describe('brought back once', () => {
  it('a member that stayed up past the settle window is brought back again the next time it dies', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1']);
    // up and healthy for a while
    await s.at(4 * MIN);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1', 's1']);
    expect(s.launched).toEqual(['s1']);
  });

  it('dying again within the settle window: replaced by a fresh one', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    await s.at(1 * MIN);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1']);
    expect(s.launched).toEqual(['s1', 's2']);
  });

  it('a member stood down and resumed by hand is no longer kept for Bring up: dying twice, it is replaced', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    // you resume it yourself
    expect(s.rt.resumeSeat('s1')).not.toBeNull();
    s.live.add('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual([]);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1']);
    s.live.delete('s1');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1']);
    expect(s.launched).toEqual(['s1', 's2']);
  });
});

describe('leftovers', () => {
  it('a seat with count.min 0: its members that ended (left over from before a Cora restart) are let go too', async () => {
    const s = setup([seat('a'), seat('w', { count: { min: 0, max: 3 } })]);
    await s.rt.bringUp(s.pid);
    s.projects.add(s.pid, 'old');
    s.projects.setSeat(s.pid, 'old', 'w', 1);
    await s.at(5_000);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s1']);
  });

  it('a min-0 seat stood down on its own keeps them until Bring up', async () => {
    const s = setup([seat('a'), seat('w', { count: { min: 0, max: 3 } })]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid, 'w');
    s.projects.add(s.pid, 'old');
    s.projects.setSeat(s.pid, 'old', 'w', 1);
    await s.at(5_000);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s1', 'old']);
  });
});

describe('Start fresh: who is being replaced', () => {
  it("is each project's own: another project's Bring up finishing meanwhile doesn't make its members come back", async () => {
    const projects = new Projects(null, () => 1_000_000);
    const a = projects.create('A');
    const b = projects.create('B');
    expect(projects.setTeam(a.id, team([seat('a1'), seat('a2')]), 'you').ok).toBe(true);
    expect(projects.setTeam(b.id, team([seat('b')]), 'you').ok).toBe(true);
    const live = new Set<string>();
    const resumed: string[] = [];
    let n = 0;
    let gate: Promise<void> | null = null;
    let open = () => {};
    let held = false;
    const rt = new TeamRuntime({
      projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => 1_000_000,
      launch: async (o) => {
        if (gate && o.label === 'a1') {
          held = true;
          await gate;
        }
        const sessionId = `s${++n}`;
        live.add(sessionId);
        return { sessionId };
      },
      resume: async (sid) => (resumed.push(sid), live.add(sid), { sessionId: sid }),
      stop: (sid) => void live.delete(sid),
      dismiss: () => {},
      live: (sid) => live.has(sid), idle: () => false, deliver: () => {}, tell: () => {},
    });
    await rt.bringUp(a.id);
    await rt.bringUp(b.id);
    await rt.standDown(a.id);
    await rt.tick();
    expect(projects.get(a.id)!.sessions).toEqual(['s1', 's2']);
    gate = new Promise((r) => (open = r));
    const fresh = rt.bringUp(a.id, { fresh: true });
    while (!held) await new Promise((r) => setTimeout(r, 0));
    // B's Bring up starts and finishes while A's is under way
    await rt.bringUp(b.id);
    open();
    await fresh;
    expect(resumed).toEqual([]);
    expect(projects.get(a.id)!.sessions).toEqual(['s4', 's5']);
  });

  it('a start that throws: what was being replaced is forgotten (the next Bring up resumes it)', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    const rt = s.rt as unknown as { d: { launch: (o: unknown) => Promise<unknown> } };
    const launch = rt.d.launch;
    rt.d.launch = async () => {
      throw new Error('spawn failed');
    };
    await expect(s.rt.bringUp(s.pid, { fresh: true })).rejects.toThrow('spawn failed');
    rt.d.launch = launch;
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s1']);
    expect(s.launched).toEqual(['s1']);
  });
});

describe('a pool grown while its members stood down still close', () => {
  const pool = (max: number) => ({ groups: [{ id: 'pool', name: 'Pool', members: ['w'], dispatch: 'claim', grow: { seat: 'w', max } }], routes: [{ id: 'in', from: ['user'], to: 'group:pool', kinds: 'any', wake: 'auto' }] });

  it('the one grown is numbered above them: once they close, no two live members share a number', async () => {
    const s = setup([seat('w', { count: { min: 2, max: 4 } })], pool(4));
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    expect((await s.rt.bringUp(s.pid)).started).toEqual([]);
    const r = await s.rt.dispatch(s.pid, 'you', 'pool', 'Encoder 3 is down');
    expect(r).toMatchObject({ grew: 's3' });
    expect(s.projects.get(s.pid)!.members.s3.instance).toBe(3);
    s.close();
    await s.at(5_000);
    await s.at(10_000);
    const numbers = s.liveMembers().map(([, i]) => i);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(s.liveMembers()).toEqual([['s1', 1], ['s3', 3]]);
  });

  it('Bring up never resumes a member whose number a live member has taken meanwhile', async () => {
    const s = setup([seat('w', { count: { min: 2, max: 4 } })]);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    // a live member numbered 1 (started while they were closing)
    s.projects.add(s.pid, 'x');
    s.projects.setSeat(s.pid, 'x', 'w', 1);
    s.live.add('x');
    await s.rt.bringUp(s.pid);
    expect(s.resumed).toEqual(['s2']);
    expect(s.liveMembers()).toEqual([['s2', 2], ['x', 1]]);
  });

  it('they count toward its grow.max', async () => {
    const s = setup([seat('w', { count: { min: 2, max: 4 } })], pool(2));
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid);
    await s.rt.bringUp(s.pid);
    const r = await s.rt.dispatch(s.pid, 'you', 'pool', 'Encoder 3 is down');
    expect(r).not.toHaveProperty('grew');
    expect(s.launched).toEqual(['s1', 's2']);
  });
});

describe('what a pool member held, by its number', () => {
  it('Start fresh: each new member takes what the old one of its number held (the lead on number 2 goes to the new number 2)', async () => {
    const s = setup([seat('w', { count: { min: 2, max: 3 } }), seat('b')]);
    await s.rt.bringUp(s.pid);
    // s1 (1), s2 (2), s3 (b)
    s.projects.update(s.pid, { lead: 's2' });
    const two = s.owns('s2', 'Encoder 2');
    const one = s.owns('s1', 'Encoder 1');
    const post = s.projects.post(s.pid, 's3', 'handoff', 'Over to you', ['s2'])!;
    s.projects.wait(s.pid, post.id, 's2');
    await s.rt.standDown(s.pid);
    s.close();
    await s.at(5_000);
    await s.rt.bringUp(s.pid, { fresh: true });
    const p = s.projects.get(s.pid)!;
    expect(s.liveMembers()).toEqual([['s4', 1], ['s5', 2], ['s6', undefined]]);
    expect(p.lead).toBe('s5');
    expect(s.owner(two)).toBe('s5');
    expect(s.owner(one)).toBe('s4');
    expect(p.waiting?.map((w) => [w.post, w.to])).toEqual([[post.id, 's5']]);
    expect(s.told).toEqual([]);
  });

  it('a member grown for load takes nothing from one of another number; that one, let go, hands to the lowest-numbered live member', async () => {
    const s = setup([seat('w', { count: { min: 1, max: 3 } })], { groups: [{ id: 'pool', name: 'Pool', members: ['w'], dispatch: 'claim', grow: { seat: 'w', max: 3 } }], routes: [{ id: 'in', from: ['user'], to: 'group:pool', kinds: 'any', wake: 'auto' }] });
    await s.rt.bringUp(s.pid);
    // number 3 ended while leading (left over)
    s.projects.add(s.pid, 'old');
    s.projects.setSeat(s.pid, 'old', 'w', 3);
    s.projects.update(s.pid, { lead: 'old' });
    const r = await s.rt.dispatch(s.pid, 'you', 'pool', 'Encoder 3 is down');
    expect(r).toMatchObject({ grew: 's2' });
    expect(s.projects.get(s.pid)!.members.s2.instance).toBe(2);
    expect(s.projects.get(s.pid)!.lead).toBe('old');
    await s.at(5_000);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s1', 's2']);
    expect(s.projects.get(s.pid)!.lead).toBe('s1');
    expect(s.told).toEqual([]);
  });
});

describe('a member stood down that never closes', () => {
  it('is waited for 2 minutes: then its seat starts another; closed at last, it leaves and hands that one what it held', async () => {
    const s = setup([seat('a')]);
    await s.rt.bringUp(s.pid);
    s.projects.update(s.pid, { lead: 's1' });
    await s.rt.standDown(s.pid);
    expect((await s.rt.bringUp(s.pid)).started).toEqual([]);
    await s.at(1 * MIN);
    expect(s.launched).toEqual(['s1']);
    await s.at(2 * MIN);
    expect(s.launched).toEqual(['s1', 's2']);
    expect(s.resumed).toEqual([]);
    s.close();
    await s.at(3 * MIN);
    expect(s.projects.get(s.pid)!.sessions).toEqual(['s2']);
    expect(s.projects.get(s.pid)!.lead).toBe('s2');
    expect(s.told).toEqual([]);
    expect(s.rt.health(s.pid)[0].failing).toBe(false);
  });
});
