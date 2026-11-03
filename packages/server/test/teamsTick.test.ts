import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Escalation, Seat, Team } from '@cora/shared';
import { modSource } from '../src/coraPlugin';
import { loadConfig } from '../src/config';
import { changeItem, claimItem, closeItem, openItem } from '../src/projectItems';
import { Projects } from '../src/projects';
import { startServer, type Running } from '../src/server';
import { TeamRuntime, TeamUsage, mailSeatWatches, parseSeatWatchId, seatWatchId, type TeamDeps } from '../src/teams';
import { MailWatches } from '../src/mailWatches';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-tick-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 60_000;
/** a while after the team was brought up (its first starts out of the 10-minute window) */
const T = 15 * MIN;
const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {}, ...o });

function makeTeam(escalation: Escalation[] = [], enc: Partial<Seat> = {}): Team {
  return {
    version: 0,
    seats: [seat('triage', 'Triage'), seat('enc', 'Encoder fixer', { count: { min: 1, max: 3 }, ...enc })],
    groups: [{ id: 'encoders', name: 'Encoders', members: ['enc'], dispatch: 'claim' }],
    labels: [],
    routes: [{ id: 'r1', from: ['seat:triage'], to: 'group:encoders', kinds: ['handoff'], wake: 'auto' }],
    fallback: 'user',
    escalation,
  };
}

async function setup(o: { escalation?: Escalation[]; enc?: Partial<Seat>; usage?: TeamUsage; asking?: Map<string, number> } = {}) {
  let clock = 1_000_000;
  const projects = new Projects(join(dir, 'projects.json'), () => clock);
  const p = projects.create('Ops');
  const r = projects.setTeam(p.id, makeTeam(o.escalation, o.enc), 'you');
  expect(r.ok, JSON.stringify(r)).toBe(true);
  const launches: string[] = [];
  const live = new Set<string>();
  const busy = new Set<string>();
  const stopped: string[] = [];
  const delivered: [string, string][] = [];
  const told: [string, { dm?: boolean } | undefined][] = [];
  const fail = { error: '' };
  let n = 0;
  const deps: TeamDeps = {
    projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => clock,
    launch: async (l) => {
      launches.push(l.name.replace(/-[0-9a-f]{4}$/, ''));
      if (fail.error) return { error: fail.error };
      const sessionId = `s${++n}`;
      live.add(sessionId);
      return { sessionId };
    },
    stop: (sid) => (stopped.push(sid), live.delete(sid)),
    live: (sid) => live.has(sid),
    idle: (sid) => !busy.has(sid),
    watch: () => {}, deliver: (sid, text) => delivered.push([sid, text]), tell: (text, opts) => told.push([text, opts]),
    ...(o.usage ? { usage: o.usage } : {}),
    ...(o.asking ? { askingSince: (sid: string) => o.asking!.get(sid) ?? null } : {}),
  };
  const rt = new TeamRuntime(deps);
  const up = await rt.bringUp(p.id);
  expect(up.problems).toEqual([]);
  // s1 triage, s2 enc-1
  expect(up.started).toEqual(['s1', 's2']);
  launches.length = 0;
  const at = (ms: number) => rt.tick((clock = 1_000_000 + ms));
  /** a member of a seat that Cora didn't start here (a pool's extra copy) */
  const member = (sid: string, seatId: string, instance?: number) => {
    projects.add(p.id, sid);
    projects.setSeat(p.id, sid, seatId, instance);
    live.add(sid);
  };
  const open = (title: string, f: Record<string, unknown> = {}) => {
    const r = projects.item(p.id, (proj, now) => openItem(proj, 'you', { kind: 'incident', title, ...f }, now));
    if (!r.ok) throw new Error(r.error);
    return r.item.id;
  };
  return { rt, projects, pid: p.id, launches, live, busy, stopped, delivered, told, fail, at, member, open, now: () => clock };
}

describe('escalation', () => {
  it('unclaimed: re-offers at N, tells the user at 2N (no lead), each once', async () => {
    const s = await setup({ escalation: [{ when: 'unclaimed', after: 10, then: ['reoffer', 'tell-lead'] }] });
    s.busy.add('s2');
    const r = await s.rt.dispatch(s.pid, 's1', 'encoders', 'Encoder 7 drops frames\nSince 09:00.');
    if ('error' in r) throw new Error(r.error);
    expect(r.offeredTo).toEqual([]);
    s.busy.delete('s2');
    await s.at(9 * MIN);
    expect(s.delivered).toEqual([]);
    await s.at(10 * MIN);
    expect(s.delivered).toEqual([['s2', `(from Cora:) Still unclaimed, for Encoders: Encoder 7 drops frames. Claim it with project_claim item ${r.item} if you're free; otherwise leave it.\n\nEncoder 7 drops frames\nSince 09:00.`]]);
    await s.at(15 * MIN);
    expect(s.delivered).toHaveLength(1);
    expect(s.told).toEqual([]);
    await s.at(20 * MIN);
    expect(s.told).toEqual([['Ops: "Encoder 7 drops frames" has had no owner for 20 min.', undefined]]);
    await s.at(40 * MIN);
    await s.at(90 * MIN);
    expect(s.delivered).toHaveLength(1);
    expect(s.told).toHaveLength(1);
  });

  it('tell-lead goes to the lead when the project has one', async () => {
    const s = await setup({ escalation: [{ when: 'unclaimed', after: 5, then: ['tell-lead'] }] });
    s.projects.update(s.pid, { lead: 's1' });
    s.open('Disk full on box 3');
    await s.at(5 * MIN);
    expect(s.delivered).toEqual([['s1', '"Disk full on box 3" needs a hand: has had no owner for 5 min.']]);
    expect(s.told).toEqual([]);
  });

  it("tell-lead with the lead not running: you're told instead (nobody would read it)", async () => {
    const s = await setup({ escalation: [{ when: 'unclaimed', after: 5, then: ['tell-lead'] }] });
    s.projects.add(s.pid, 'lead-1');
    s.projects.update(s.pid, { lead: 'lead-1' });
    s.open('Disk full on box 3');
    await s.at(5 * MIN);
    expect(s.delivered).toEqual([]);
    expect(s.told).toEqual([[`${s.projects.get(s.pid)!.name}: "Disk full on box 3" has had no owner for 5 min.`, undefined]]);
  });

  it('a claimed item is not unclaimed; a closed one is left alone', async () => {
    const s = await setup({ escalation: [{ when: 'unclaimed', after: 5, then: ['tell-user'] }] });
    const a = s.open('A');
    const b = s.open('B');
    s.projects.item(s.pid, (p, now) => claimItem(p, 's2', a, now));
    s.projects.item(s.pid, (p, now) => closeItem(p, 'you', b, 'x', 'y', now));
    await s.at(30 * MIN);
    expect(s.told).toEqual([]);
  });

  it('critical: fires every step at once, on open, once', async () => {
    const s = await setup({ escalation: [{ when: 'critical', after: 60, then: ['tell-user', 'dm-user'] }] });
    s.open('Everything is down', { severity: 'critical' });
    s.open('Minor thing', { severity: 'high' });
    await s.at(0);
    expect(s.told).toEqual([
      ['Ops: "Everything is down" is critical.', undefined],
      ['Ops: "Everything is down" is critical.', { dm: true }],
    ]);
    await s.at(5 * MIN);
    expect(s.told).toHaveLength(2);
  });

  it('stale: nudges the owner at N, then tells the user at 2N', async () => {
    const s = await setup({ escalation: [{ when: 'stale', after: 30, then: ['nudge-owner', 'tell-user'] }] });
    const id = s.open('Encoder 3 frozen');
    await s.at(10 * MIN);
    s.projects.item(s.pid, (p, now) => claimItem(p, 's2', id, now));
    await s.at(39 * MIN);
    expect(s.delivered).toEqual([]);
    await s.at(40 * MIN);
    expect(s.delivered).toEqual([['s2', 'Still on "Encoder 3 frozen"? Post an update (project_item next/state) or close it.']]);
    await s.at(70 * MIN);
    expect(s.told).toEqual([['Ops: "Encoder 3 frozen" has had no update from its owner for 60 min.', undefined]]);
    expect(s.delivered).toHaveLength(1);
  });

  it('scope: by severity (medium when unset) and by the group it was offered to', async () => {
    const s = await setup({ escalation: [
      { when: 'unclaimed', after: 5, scope: { severity: ['high', 'critical'] }, then: ['tell-user'] },
      { when: 'unclaimed', after: 5, scope: { group: 'encoders' }, then: ['dm-user'] },
    ] });
    s.open('Medium one');
    s.open('High one', { severity: 'high' });
    await s.at(5 * MIN);
    expect(s.told).toEqual([['Ops: "High one" has had no owner for 5 min.', undefined]]);
    s.busy.add('s2');
    const r = await s.rt.dispatch(s.pid, 's1', 'encoders', 'Offered one');
    if ('error' in r) throw new Error(r.error);
    await s.at(10 * MIN);
    expect(s.told.at(-1)).toEqual(['Ops: "Offered one" has had no owner for 5 min.', { dm: true }]);
    expect(s.told).toHaveLength(2);
  });

  it('scope: by the route it came on (work offered to a group on that route), never anything else', async () => {
    const s = await setup({ escalation: [{ when: 'unclaimed', after: 5, scope: { route: 'r1' }, then: ['tell-user'] }] });
    s.open('Opened by hand');
    s.busy.add('s2');
    const r = await s.rt.dispatch(s.pid, 's1', 'encoders', 'Offered on r1');
    if ('error' in r) throw new Error(r.error);
    await s.at(5 * MIN);
    expect(s.told).toEqual([['Ops: "Offered on r1" has had no owner for 5 min.', undefined]]);
  });

  it('blocked: an item whose owner’s seat is over its limit, after N', async () => {
    const usage = new TeamUsage();
    const s = await setup({ escalation: [{ when: 'blocked', after: 5, then: ['tell-user'] }], enc: { limits: { turnsPerHour: 2 } }, usage });
    const id = s.open('Encoder 3 frozen');
    s.projects.item(s.pid, (p, now) => claimItem(p, 's2', id, now));
    await s.at(MIN);
    usage.turn('s2', s.now());
    usage.turn('s2', s.now());
    await s.at(2 * MIN);
    await s.at(6 * MIN);
    expect(s.told).toEqual([]);
    await s.at(7 * MIN);
    expect(s.told).toEqual([['Ops: "Encoder 3 frozen" is waiting on a limit or an approval for 5 min.', undefined]]);
  });

  it('blocked: an item whose owner has had an approval waiting longer than N', async () => {
    const asking = new Map<string, number>();
    const s = await setup({ escalation: [{ when: 'blocked', after: 5, then: ['tell-user'] }], asking });
    const id = s.open('Encoder 3 frozen');
    s.projects.item(s.pid, (p, now) => claimItem(p, 's2', id, now));
    await s.at(10 * MIN);
    expect(s.told).toEqual([]);
    // asking since minute 11 (an approval of another session doesn't count)
    asking.set('s2', 1_000_000 + 11 * MIN);
    asking.set('s1', 1_000_000);
    await s.at(15 * MIN);
    expect(s.told).toEqual([]);
    await s.at(16 * MIN);
    expect(s.told).toEqual([['Ops: "Encoder 3 frozen" is waiting on a limit or an approval for 5 min.', undefined]]);
  });
});

describe('lifecycle', () => {
  it('a dead standing seat is started again', async () => {
    const s = await setup();
    s.live.delete('s1');
    await s.at(T);
    expect(s.launches).toEqual(['triage']);
    expect(s.rt.health(s.pid)).toEqual([{ seat: 'triage', failing: false }, { seat: 'enc', failing: false }]);
  });

  it("a standing seat below its minimum says so (short) while it waits out its back-off, so Bring up can start it now; not once it's running, stood down, or the team is", async () => {
    const s = await setup();
    expect(s.rt.health(s.pid).map((h) => h.short)).toEqual([undefined, undefined]);
    // died within minutes of its start: a failed start, its next try a minute away
    s.live.delete('s1');
    await s.at(5000);
    expect(s.launches).toEqual([]);
    expect(s.rt.health(s.pid)[0]).toMatchObject({ seat: 'triage', failing: false, short: true, nextTryAt: 1_000_000 + 5000 + MIN });
    expect(s.rt.health(s.pid)[1].short).toBeUndefined();
    // Bring up (the Team panel's offer) starts it at once
    const up = await s.rt.bringUp(s.pid);
    expect(up.problems).toEqual([]);
    expect(s.launches).toEqual(['triage']);
    expect(s.rt.health(s.pid)[0].short).toBeUndefined();
    // a seat stood down on its own isn't short, nor any seat of a team stood down
    await s.rt.standDown(s.pid, 'triage');
    expect(s.rt.health(s.pid)[0].short).toBeUndefined();
    await s.rt.standDown(s.pid);
    expect(s.rt.health(s.pid).map((h) => h.short)).toEqual([undefined, undefined]);
  });

  it('backs off 1, then 2 minutes; three failures in 10 minutes stop it, told once; Bring up resets it', async () => {
    const s = await setup();
    s.live.delete('s1');
    s.fail.error = 'claude not found.';
    await s.at(T);
    expect(s.launches).toHaveLength(1);
    expect(s.rt.health(s.pid)[0]).toEqual({ seat: 'triage', failing: false, short: true, lastError: 'claude not found.', nextTryAt: 1_000_000 + T + MIN });
    await s.at(T + 30_000);
    expect(s.launches).toHaveLength(1);
    await s.at(T + MIN);
    expect(s.launches).toHaveLength(2);
    await s.at(T + 2 * MIN);
    expect(s.launches).toHaveLength(2);
    await s.at(T + 3 * MIN);
    expect(s.launches).toHaveLength(3);
    expect(s.told).toEqual([['Ops: Triage keeps failing to start: claude not found. Fix it, then Bring up the team.', undefined]]);
    expect(s.rt.health(s.pid)[0]).toMatchObject({ seat: 'triage', failing: true, lastError: 'claude not found.' });
    await s.at(T + 60 * MIN);
    await s.at(T + 120 * MIN);
    expect(s.launches).toHaveLength(3);
    expect(s.told).toHaveLength(1);
    s.fail.error = '';
    const up = await s.rt.bringUp(s.pid);
    expect(up.problems).toEqual([]);
    expect(s.rt.health(s.pid)[0]).toEqual({ seat: 'triage', failing: false });
  });

  it('a seat that dies right after a successful start backs off too, and stops after three starts in 10 minutes', async () => {
    const s = await setup();
    /** every triage member gone (s2 is the encoder fixer) */
    const kill = () => [...s.live].filter((sid) => sid !== 's2').forEach((sid) => s.live.delete(sid));
    kill();
    await s.at(T);
    expect(s.launches).toHaveLength(1);
    kill();
    await s.at(T + 5000);
    expect(s.rt.health(s.pid)[0]).toEqual({ seat: 'triage', failing: false, short: true, lastError: 'it stopped within 3 minutes of starting', nextTryAt: 1_000_000 + T + 5000 + MIN });
    await s.at(T + 30_000);
    expect(s.launches).toHaveLength(1);
    await s.at(T + 65_000);
    expect(s.launches).toHaveLength(2);
    kill();
    await s.at(T + 70_000);
    await s.at(T + 120_000);
    await s.at(T + 185_000);
    expect(s.launches).toHaveLength(2);
    await s.at(T + 190_000);
    expect(s.launches).toHaveLength(3);
    kill();
    await s.at(T + 195_000);
    expect(s.told).toEqual([['Ops: Triage keeps failing to start: it stopped within 3 minutes of starting. Fix it, then Bring up the team.', undefined]]);
    expect(s.rt.health(s.pid)[0]).toMatchObject({ seat: 'triage', failing: true });
    for (let m = 4; m <= 60; m++) await s.at(T + m * MIN);
    expect(s.launches).toHaveLength(3);
    expect(s.told).toHaveLength(1);
  });

  it('a success resets the back-off once its member stays up', async () => {
    const s = await setup();
    s.live.delete('s1');
    s.fail.error = 'boom';
    await s.at(T);
    s.fail.error = '';
    await s.at(T + MIN);
    expect(s.launches).toHaveLength(2);
    expect(s.rt.health(s.pid)[0]).toEqual({ seat: 'triage', failing: false });
    await s.at(T + 5 * MIN);
    // it stayed up, then died: tried again at once
    s.live.delete('s3');
    s.launches.length = 0;
    await s.at(T + 5 * MIN + 5000);
    expect(s.launches).toEqual(['triage']);
  });

  it('a team stood down (or never brought up) is not restarted', async () => {
    const s = await setup();
    await s.rt.standDown(s.pid);
    await s.at(10 * MIN);
    expect(s.launches).toEqual([]);
  });

  it('closes an idle extra member after idleCloseMin, never below count.min nor one owning an open incident', async () => {
    const s = await setup({ enc: { idleCloseMin: 10 } });
    s.member('s8', 'enc', 2);
    s.member('s9', 'enc', 3);
    const id = s.open('Encoder 3 frozen');
    s.projects.item(s.pid, (p, now) => claimItem(p, 's9', id, now));
    s.busy.add('s2');
    await s.at(0);
    // s8 was busy for a moment: its idle time starts over
    s.busy.add('s8');
    await s.at(5 * MIN);
    s.busy.delete('s8');
    await s.at(6 * MIN);
    await s.at(15 * MIN);
    expect(s.stopped).toEqual([]);
    await s.at(16 * MIN);
    expect(s.stopped).toEqual(['s8']);
    // its incident closed, s9 goes too; s2 is the last, at count.min
    s.projects.item(s.pid, (p, now) => closeItem(p, 'you', id, 'x', 'y', now));
    s.busy.delete('s2');
    await s.at(30 * MIN);
    await s.at(45 * MIN);
    expect(s.stopped).toEqual(['s8', 's9']);
    expect(s.live.has('s2')).toBe(true);
  });

  it('never one owning an open task (idle while it waits on review keeps its memory); once its task is done, it closes', async () => {
    const s = await setup({ enc: { idleCloseMin: 10 } });
    s.member('s9', 'enc', 2);
    const t = s.projects.item(s.pid, (p, now) => openItem(p, 'you', { kind: 'task', title: 'Work panel', owner: 's9' }, now));
    if (!t.ok) throw new Error(t.error);
    s.projects.item(s.pid, (p, now) => changeItem(p, 's9', t.item.id, { state: 'review' }, now));
    await s.at(0);
    await s.at(30 * MIN);
    await s.at(60 * MIN);
    expect(s.stopped).toEqual([]);
    s.projects.item(s.pid, (p, now) => closeItem(p, 'you', t.item.id, undefined, undefined, now, 'merged as abc1234'));
    await s.at(61 * MIN);
    expect(s.stopped).toEqual(['s9']);
  });

  it('a pool made smaller: its extra that owns an open task stays until the task is done', async () => {
    const s = await setup();
    s.member('s9', 'enc', 2);
    s.member('s10', 'enc', 3);
    const t = s.projects.item(s.pid, (p, now) => openItem(p, 'you', { kind: 'task', title: 'Work panel', owner: 's10' }, now));
    if (!t.ok) throw new Error(t.error);
    const prev = s.projects.get(s.pid)!.team!;
    const next = { ...prev, seats: prev.seats.map((x) => (x.id === 'enc' ? { ...x, count: { min: 1, max: 1 } } : x)) };
    expect(s.projects.setTeam(s.pid, next, 'you').ok).toBe(true);
    await s.rt.applyEdit(s.pid, prev, s.projects.get(s.pid)!.team!);
    await s.at(5000);
    expect(s.stopped).toEqual(['s9']);
    s.projects.item(s.pid, (p, now) => closeItem(p, 'you', t.item.id, undefined, undefined, now, 'merged'));
    await s.at(10_000);
    expect(s.stopped).toEqual(['s9', 's10']);
  });
});

describe('shrinking closes the extras', () => {
  it('the standing member idle longer stays; the extra closes after its own idle time', async () => {
    const s = await setup({ enc: { idleCloseMin: 3 } });
    // s2 (enc-1, standing) idle from the start; s8 (enc-2, grown for load) busy until 2 min
    s.member('s8', 'enc', 2);
    s.busy.add('s8');
    await s.at(0);
    await s.at(2 * MIN);
    s.busy.delete('s8');
    await s.at(2 * MIN + 1);
    await s.at(4 * MIN);
    expect(s.stopped).toEqual([]);
    await s.at(5 * MIN + 1);
    expect(s.stopped).toEqual(['s8']);
    expect(s.live.has('s2')).toBe(true);
  });
});

describe('one launch at a time, and remembering a team is up', () => {
  /** a runtime whose launches take a moment (a member is live once its launch is done) */
  function slow(projects: Projects, launches: string[], live: Set<string>) {
    let n = 0;
    return new TeamRuntime({
      projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => 1_000_000,
      launch: async (l) => {
        launches.push(l.name.replace(/-[0-9a-f]{4}$/, ''));
        await new Promise((r) => setTimeout(r, 5));
        const sessionId = `s${++n}`;
        live.add(sessionId);
        return { sessionId };
      },
      stop: (sid) => live.delete(sid), live: (sid) => live.has(sid), idle: () => false,
      watch: () => {}, deliver: () => {}, tell: () => {},
    });
  }

  it('two bringUps at once start count.min, not twice', async () => {
    const projects = new Projects(null, () => 1_000_000);
    const p = projects.create('Ops');
    expect(projects.setTeam(p.id, makeTeam(), 'you').ok).toBe(true);
    const launches: string[] = [];
    const rt = slow(projects, launches, new Set());
    const [a, b] = await Promise.all([rt.bringUp(p.id), rt.bringUp(p.id)]);
    expect(launches).toEqual(['triage', 'enc-1']);
    expect(a.started).toEqual(['s1', 's2']);
    expect(b.started).toEqual([]);
  });

  it('two dispatches that grow a pool at once take different instance numbers', async () => {
    const projects = new Projects(null, () => 1_000_000);
    const p = projects.create('Ops');
    const t = makeTeam();
    t.groups[0].grow = { seat: 'enc', max: 3 };
    expect(projects.setTeam(p.id, t, 'you').ok).toBe(true);
    const launches: string[] = [];
    const rt = slow(projects, launches, new Set());
    await rt.bringUp(p.id);
    launches.length = 0;
    // enc-1 is busy (idle: never), so each grows the pool
    const [a, b] = await Promise.all([rt.dispatch(p.id, 's1', 'encoders', 'one'), rt.dispatch(p.id, 's1', 'encoders', 'two')]);
    expect(launches).toEqual(['enc-2', 'enc-3']);
    expect('grew' in a && a.grew).toBeTruthy();
    expect('grew' in b && b.grew).toBeTruthy();
  });

  it('Bring up marks the team up (kept with the project); standing a seat down does not; the whole team does', async () => {
    const file = join(dir, 'projects.json');
    const projects = new Projects(file, () => 1_000_000);
    const p = projects.create('Ops');
    expect(projects.setTeam(p.id, makeTeam(), 'you').ok).toBe(true);
    const rt = slow(projects, [], new Set());
    expect(rt.isUp(p.id)).toBe(false);
    await rt.bringUp(p.id);
    expect(rt.isUp(p.id)).toBe(true);
    expect(new Projects(file).get(p.id)!.teamUp).toBe(true);
    expect(new Projects(file).get(p.id)!.teamStoodDown).toBeUndefined();
    await rt.standDown(p.id, 'enc');
    expect(new Projects(file).get(p.id)!.teamUp).toBe(true);
    expect(new Projects(file).get(p.id)!.teamStoodDown).toBeUndefined();
    await rt.standDown(p.id);
    expect(rt.isUp(p.id)).toBe(false);
    expect(new Projects(file).get(p.id)!.teamUp).toBeFalsy();
    // stood down on purpose (kept): not a team that never ran
    expect(new Projects(file).get(p.id)!.teamStoodDown).toBe(true);
    await rt.bringUp(p.id);
    expect(new Projects(file).get(p.id)!.teamStoodDown).toBeUndefined();
  });

  it('after a restart, a team that was up is kept running again; one stood down is not', async () => {
    const file = join(dir, 'projects.json');
    const before = new Projects(file, () => 1_000_000);
    const up = before.create('Up');
    const down = before.create('Down');
    expect(before.setTeam(up.id, makeTeam(), 'you').ok).toBe(true);
    expect(before.setTeam(down.id, makeTeam(), 'you').ok).toBe(true);
    const first = slow(before, [], new Set());
    await first.bringUp(up.id);
    await first.bringUp(down.id);
    await first.standDown(down.id);
    // Cora restarts: the members it started are gone
    const projects = new Projects(file, () => 1_000_000);
    const launches: string[] = [];
    const rt = slow(projects, launches, new Set());
    expect(rt.resume()).toEqual([up.id]);
    expect(rt.isUp(up.id)).toBe(true);
    await rt.tick(1_000_000);
    expect(launches).toEqual(['triage', 'enc-1']);
  });
});

describe('standing watches, and standing down in order', () => {
  const DAY = 24 * 60 * MIN;
  const W = { kind: 'gmail' as const, from: 'alerts@acme.com', about: 'encoder alerts', then: 'triage it' };
  /** a team whose triage seat (one) and encoder pool (min 1, max 3) each watch for alerts; real email watches */
  function setupW(o: { file?: string; launchMs?: number } = {}) {
    let clock = 1_000_000;
    const projects = new Projects(o.file ?? null, () => clock);
    const p = projects.create('Ops');
    const t = makeTeam([], { startup: { watches: [W] } });
    t.seats[0].startup = { watches: [W] };
    expect(projects.setTeam(p.id, t, 'you').ok).toBe(true);
    const ws = new MailWatches({ now: () => clock });
    const told: string[] = [];
    const live = new Set<string>();
    const stopped: string[] = [];
    let n = 0;
    const deps: TeamDeps = {
      projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => clock,
      launch: async () => {
        if (o.launchMs) await new Promise((r) => setTimeout(r, o.launchMs));
        const sessionId = `s${++n}`;
        live.add(sessionId);
        return { sessionId };
      },
      stop: (sid) => (stopped.push(sid), live.delete(sid)), live: (sid) => live.has(sid), idle: () => false,
      deliver: () => {}, tell: (x) => told.push(x),
      watches: mailSeatWatches({ watches: ws, tell: (x) => told.push(x), now: () => clock }),
    };
    const rt = new TeamRuntime(deps);
    const at = (ms: number) => rt.tick((clock = 1_000_000 + ms));
    return { rt, projects, pid: p.id, ws, told, live, stopped, at, deps, now: () => clock };
  }

  it('each seat has one watch, on its member; it is set again after it fired, and refreshed before it runs out', async () => {
    const s = setupW();
    await s.rt.bringUp(s.pid);
    const tri = seatWatchId(s.pid, 'triage', 0);
    const enc = seatWatchId(s.pid, 'enc', 0);
    expect(s.ws.list().map((w) => [w.id, w.sessionId])).toEqual([[tri, 's1'], [enc, 's2']]);
    expect(s.ws.get(tri)).toMatchObject({ from: 'alerts@acme.com', query: 'in:inbox', act: 'do', mode: 'every', by: 'Triage' });
    expect(parseSeatWatchId(tri)).toEqual({ pid: s.pid, seat: 'triage' });
    expect(parseSeatWatchId('a1b2c3d4')).toBeNull();
    // its emails came: an 'every' watch goes on
    s.ws.hit(tri, 'thread-1');
    s.ws.hit(tri, 'thread-2');
    expect(s.ws.get(tri)).toMatchObject({ sessionId: 's1', hits: 2 });
    // gone anyway (removed by hand): the next tick sets it again, for the same member
    s.ws.remove(tri);
    await s.at(5000);
    expect(s.ws.get(tri)).toMatchObject({ sessionId: 's1', hits: 0 });
    // nearly out of time (3 days): refreshed with less than a day left
    const until = s.ws.get(enc)!.until;
    await s.at(until - 1_000_000 - DAY - MIN);
    expect(s.ws.get(enc)!.until).toBe(until);
    await s.at(until - 1_000_000 - DAY + MIN);
    expect(s.ws.get(enc)!.until).toBeGreaterThan(until);
    expect(s.ws.list()).toHaveLength(2);
    expect(s.told).toEqual([]);
  });

  it('a pool seat has one watch, on its lowest live member; it moves when that member goes', async () => {
    const s = setupW();
    await s.rt.bringUp(s.pid);
    // another encoder fixer joins (enc-2)
    s.projects.add(s.pid, 's9');
    s.projects.setSeat(s.pid, 's9', 'enc', 2);
    s.live.add('s9');
    await s.at(5000);
    expect(s.ws.list().filter((w) => w.id.startsWith(`team-${s.pid}-enc-`)).map((w) => w.sessionId)).toEqual(['s2']);
    s.live.delete('s2');
    await s.at(10_000);
    expect(s.ws.list().filter((w) => w.id.startsWith(`team-${s.pid}-enc-`)).map((w) => w.sessionId)).toEqual(['s9']);
  });

  it('standing a seat down removes its watches; the whole team, all of them', async () => {
    const s = setupW();
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid, 'enc');
    expect(s.ws.list().map((w) => w.id)).toEqual([seatWatchId(s.pid, 'triage', 0)]);
    // not set again by the tick
    await s.at(5000);
    expect(s.ws.list()).toHaveLength(1);
    await s.rt.standDown(s.pid);
    expect(s.ws.list()).toEqual([]);
  });

  it('no watch for a team stood down, nor a seat stood down on its own, even when work grows its pool', async () => {
    const s = setupW();
    const t = s.projects.get(s.pid)!.team!;
    t.groups[0].grow = { seat: 'enc', max: 3 };
    expect(s.projects.setTeam(s.pid, t, 'you').ok).toBe(true);
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid, 'enc');
    // its seat is down: the pool doesn't grow for work posted to it, and no watch
    const r = await s.rt.dispatch(s.pid, 'you', 'encoders', 'Encoder 7');
    expect('grew' in r && r.grew).toBeFalsy();
    await s.at(5000);
    expect(s.ws.list().map((w) => w.id)).toEqual([seatWatchId(s.pid, 'triage', 0)]);
    await s.rt.standDown(s.pid);
    await s.rt.dispatch(s.pid, 'you', 'encoders', 'Encoder 8');
    await s.at(10_000);
    expect(s.ws.list()).toEqual([]);
  });

  it('a seat stood down on its own stays down after a restart; Bring up clears it', async () => {
    const file = join(dir, 'projects.json');
    const s = setupW({ file });
    await s.rt.bringUp(s.pid);
    await s.rt.standDown(s.pid, 'enc');
    expect(new Projects(file).get(s.pid)!.teamDown).toEqual(['enc']);
    // Cora restarts; its members are gone
    const projects = new Projects(file);
    const launches: string[] = [];
    const live = new Set<string>();
    let n = 0;
    const rt = new TeamRuntime({ ...s.deps, projects, live: (sid) => live.has(sid), launch: async (l) => (launches.push(l.name.replace(/-[0-9a-f]{4}$/, '')), live.add(`r${++n}`), { sessionId: `r${n}` }) });
    expect(rt.resume()).toEqual([s.pid]);
    await rt.tick(1_000_000);
    expect(launches).toEqual(['triage']);
    await rt.bringUp(s.pid);
    expect(launches).toEqual(['triage', 'enc-1']);
    expect(new Projects(file).get(s.pid)!.teamDown).toBeUndefined();
  });

  it('standing down while a bring up is starting seats: waits for it, then stops what it started', async () => {
    const s = setupW({ launchMs: 5 });
    const up = s.rt.bringUp(s.pid);
    const down = s.rt.standDown(s.pid);
    await Promise.all([up, down]);
    expect(s.stopped.sort()).toEqual(['s1', 's2']);
    expect(s.live.size).toBe(0);
    expect(s.rt.isUp(s.pid)).toBe(false);
    expect(s.ws.list()).toEqual([]);
    await s.at(5000);
    expect(s.live.size).toBe(0);
  });
});

describe('TeamUsage', () => {
  const triage = (limits: Seat['limits']) => seat('triage', 'Triage', { limits });
  const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();

  it('turns per hour, across the seat’s members, over the last hour', () => {
    const u = new TeamUsage();
    const t = local(31, 12);
    u.turn('a', t - 61 * MIN);
    u.turn('a', t - 30 * MIN);
    u.turn('b', t - 10 * MIN);
    expect(u.over(triage({ turnsPerHour: 3 }), ['a', 'b'], t)).toBeNull();
    u.turn('b', t - MIN);
    expect(u.over(triage({ turnsPerHour: 3 }), ['a', 'b'], t)).toBe('Triage is over its limit (3 turns this hour). Try again after 12:30.');
    // another seat's turns don't count
    expect(u.over(triage({ turnsPerHour: 3 }), ['a'], t)).toBeNull();
    expect(u.over(triage(undefined), ['a', 'b'], t)).toBeNull();
  });

  it('cost per day, since local midnight', () => {
    const u = new TeamUsage();
    u.cost('a', 3, local(30, 23));
    u.cost('a', 3, local(31, 1));
    expect(u.over(triage({ costPerDay: 5 }), ['a'], local(31, 9))).toBeNull();
    u.cost('b', 2.5, local(31, 8));
    expect(u.over(triage({ costPerDay: 5 }), ['a', 'b'], local(31, 9))).toBe('Triage is over its limit ($5.50 today). Try again tomorrow.');
  });

  it('quiet hours, across midnight or not', () => {
    const u = new TeamUsage();
    const night = triage({ quiet: { from: '22:00', to: '06:00' } });
    const why = 'Triage is in its quiet hours (22:00–06:00): try again after 06:00.';
    expect(u.over(night, [], local(31, 23, 30))).toBe(why);
    expect(u.over(night, [], local(31, 5, 59))).toBe(why);
    expect(u.over(night, [], local(31, 6))).toBeNull();
    expect(u.over(night, [], local(31, 12))).toBeNull();
    const lunch = triage({ quiet: { from: '12:00', to: '13:00' } });
    expect(u.over(lunch, [], local(31, 12, 30))).toBe('Triage is in its quiet hours (12:00–13:00): try again after 13:00.');
    expect(u.over(lunch, [], local(31, 13, 30))).toBeNull();
  });

  it('overSince: when it was first seen over, until it is not', () => {
    const u = new TeamUsage();
    const s = triage({ turnsPerHour: 1 });
    const t = local(31, 12);
    expect(u.overSince('p|triage', s, ['a'], t)).toBeNull();
    u.turn('a', t);
    expect(u.overSince('p|triage', s, ['a'], t + MIN)).toBe(t + MIN);
    expect(u.overSince('p|triage', s, ['a'], t + 5 * MIN)).toBe(t + MIN);
    expect(u.overSince('p|triage', s, ['a'], t + 61 * MIN)).toBeNull();
  });
});

describe('the mod counts turns', () => {
  const turnHook = () => {
    const src = modSource('http://127.0.0.1:1', 'tok').replace('export function register', 'function register');
    const register = new Function(`${src}\nreturn register`)() as (on: unknown) => void;
    const hooks: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    register((name: string, fn: (...a: unknown[]) => Promise<unknown>) => ((hooks[name] = fn), { catch: () => {} }));
    const bodies: unknown[] = [];
    const $ = { session: { id: async () => 'sid-1' }, http: { fetch: async (_url: string, init: { body: string }) => (bodies.push(JSON.parse(init.body)), { ok: true, text: '{}' }) } };
    return { bodies, run: (e: object) => hooks['turn.complete']($, e, async (x: unknown) => ({ passed: x })) };
  };

  it('reports a main-thread turn with its usage, never a subagent’s, and always passes it on', async () => {
    const h = turnHook();
    expect(await h.run({ usage: { costUSD: 0.12 } })).toEqual({ passed: { usage: { costUSD: 0.12 } } });
    expect(await h.run({ agentId: 'sub-1', usage: { costUSD: 0.5 } })).toMatchObject({ passed: { agentId: 'sub-1' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.bodies).toEqual([{ session: 'sid-1', kind: 'turn', usage: { costUSD: 0.12 } }]);
    expect(modSource('u', 't')).toMatch(/on\('turn\.complete'[\s\S]*?\.catch\(async \(\$, e, next\) => next\(e\)\)/);
  });
});

describe('limits at the route gate', () => {
  let srv: Running;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
  const M1 = 'aaaa0000-0000-0000-0000-000000000001';
  const M2 = 'aaaa0000-0000-0000-0000-000000000002';
  const TRI = 'bbbb0000-0000-0000-0000-000000000003';
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const event = (body: object) => srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: body });
  const route = (body: object) => srv.app.inject({ method: 'POST', url: '/api/mod/route', headers: H, payload: body });
  const TEAM: Team = {
    version: 1,
    seats: [seat('monitor', 'Monitor', { count: { min: 0, max: 2 }, limits: { turnsPerHour: 2 } }), seat('triage', 'Triage', { count: { min: 0, max: 1 } })],
    groups: [],
    labels: [],
    routes: [
      { id: 'alerts', from: ['seat:monitor'], to: 'seat:triage', kinds: 'any', wake: 'auto' },
      { id: 'back', from: ['seat:triage'], to: 'seat:monitor', kinds: 'any', wake: 'auto' },
    ],
    fallback: 'user',
    escalation: [],
  };

  it('blocks an over-limit seat’s messages to other seats with its reason; the user still hears from it', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const now = Date.now();
      for (const [id, alias] of [[M1, 'Monitor 1'], [M2, 'Monitor 2'], [TRI, 'Triage']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
      const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Ops', sessionId: M1 } })).json().project;
      for (const sid of [M2, TRI]) await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: sid } });
      expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
      srv.projects.setSeat(p.id, M1, 'monitor', 1);
      srv.projects.setSeat(p.id, M2, 'monitor', 2);
      srv.projects.setSeat(p.id, TRI, 'triage');

      expect((await tool(M1, 'project_post', { kind: 'report', text: 'encoder 3 down', to: [TRI] })).isError).toBeFalsy();
      // the seat's two members, a turn each (a measure without cost is ignored)
      expect((await event({ session: M1, kind: 'turn', usage: { costUSD: 0.2 } })).json()).toEqual({ ok: true });
      expect((await event({ session: M2, kind: 'turn' })).json()).toEqual({ ok: true });
      expect((await event({ session: M2, kind: 'measure', usage: {} })).json()).toEqual({ ok: true });
      const no = await tool(M1, 'project_post', { kind: 'report', text: 'encoder 4 down', to: [TRI] });
      expect(no.isError).toBe(true);
      const why = no.content[0].text;
      expect(why).toMatch(/^Monitor is over its limit \(2 turns this hour\)\. Try again after \d\d:\d\d\.$/);
      expect(srv.projects.list()[0].thread.at(-1)).toMatchObject({ by: M1, to: [TRI], blocked: true });
      expect((await route({ session: M2, to: 'triage', text: 'still down' })).json()).toEqual({ block: why });
      // to the user, it still goes; another seat isn't held
      expect((await tool(M1, 'project_post', { kind: 'question', text: 'restart it?', to: ['user'] })).isError).toBeFalsy();
      expect((await route({ session: TRI, to: 'monitor-1', text: 'on it' })).json()).toEqual({ ok: true });
    } finally {
      await srv.close();
    }
  });
});
