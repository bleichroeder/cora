import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Seat, Team, Watch } from '@cora/shared';
import { Projects } from '../src/projects';
import { TeamRuntime, mailSeatWatches, seatWatchId, type TeamDeps } from '../src/teams';
import { MailWatches } from '../src/mailWatches';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-edit-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {}, ...o });
const W: Watch = { kind: 'gmail', from: 'alerts@acme.com', about: 'encoder alerts', then: 'triage it' };
const W2: Watch = { kind: 'gmail', from: 'noc@acme.com', about: 'noc pages', then: 'look' };

function makeTeam(): Team {
  return {
    version: 0,
    seats: [seat('triage', 'Triage', { startup: { watches: [W, W2] } }), seat('enc', 'Encoder fixer', { count: { min: 1, max: 3 } })],
    groups: [{ id: 'encoders', name: 'Encoders', members: ['enc'], dispatch: 'claim' }],
    labels: [],
    routes: [{ id: 'r1', from: ['seat:triage'], to: 'group:encoders', kinds: ['handoff'], wake: 'auto' }],
    fallback: 'user',
    escalation: [],
  };
}

async function setup(o: { up?: boolean } = {}) {
  let clock = 1_000_000;
  const projects = new Projects(null, () => clock);
  const p = projects.create('Ops');
  expect(projects.setTeam(p.id, makeTeam(), 'you').ok).toBe(true);
  const launches: string[] = [];
  const live = new Set<string>();
  const busy = new Set<string>();
  const stopped: string[] = [];
  const delivered: [string, string][] = [];
  const ws = new MailWatches({ now: () => clock });
  let n = 0;
  const deps: TeamDeps = {
    projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => clock,
    launch: async (l) => {
      launches.push(l.name.replace(/-[0-9a-f]{4}$/, ''));
      const sessionId = `s${++n}`;
      live.add(sessionId);
      return { sessionId };
    },
    // a stopped session takes a moment to close: it is still live right after
    stop: (sid) => void stopped.push(sid),
    live: (sid) => live.has(sid),
    idle: (sid) => !busy.has(sid),
    deliver: (sid, text) => delivered.push([sid, text]),
    tell: () => {},
    watches: mailSeatWatches({ watches: ws, tell: () => {}, now: () => clock }),
  };
  const rt = new TeamRuntime(deps);
  if (o.up !== false) {
    const up = await rt.bringUp(p.id);
    expect(up).toEqual({ started: ['s1', 's2'], problems: [] });
  }
  launches.length = 0;
  /** an edit as the API makes it: stored, then applied */
  const edit = async (change: (t: Team) => void) => {
    const t = JSON.parse(JSON.stringify(projects.get(p.id)!.team)) as Team;
    change(t);
    const r = projects.setTeam(p.id, t, 'you');
    if (!r.ok) throw new Error(`${r.error} ${r.problems?.join(' ')}`);
    return rt.applyEdit(p.id, r.previous, r.team);
  };
  const member = (sid: string, seatId: string, instance?: number) => {
    projects.add(p.id, sid);
    projects.setSeat(p.id, sid, seatId, instance);
    live.add(sid);
  };
  const closed = () => stopped.forEach((sid) => live.delete(sid));
  return { rt, deps, projects, pid: p.id, launches, live, busy, stopped, delivered, ws, edit, member, closed, at: (ms: number) => rt.tick((clock = 1_000_000 + ms)) };
}

/** Its members resume as themselves (the app's resume: launchClaude rebuilds a seat's launch from the team): those resumed, in order. */
const resumes = (s: { deps: TeamDeps; live: Set<string> }) => {
  const resumed: string[] = [];
  s.deps.resume = async (sid) => (resumed.push(sid), s.live.add(sid), { sessionId: sid });
  return resumed;
};

describe('editing a running team', () => {
  it('a team that is not up: only the changes (and its files written)', async () => {
    const s = await setup({ up: false });
    const r = await s.edit((t) => {
      t.seats.push(seat('pager', 'Pager'));
      t.seats[0].agent = { model: 'opus' };
    });
    expect(r.changes).toEqual([{ kind: 'seat-added', seat: 'pager' }, { kind: 'seat-restart-needed', seat: 'triage', detail: 'model changed' }]);
    expect(r.restart).toEqual([]);
    expect(s.launches).toEqual([]);
    expect(s.rt.restarts(s.pid)).toEqual([]);
  });

  it('a seat added starts (to its min); one removed stands down and its watches go', async () => {
    const s = await setup();
    const r = await s.edit((t) => {
      t.seats.push(seat('pager', 'Pager', { count: { min: 2, max: 2 } }));
      t.seats[0].startup = {};
      t.seats = t.seats.filter((x) => x.id !== 'triage');
      t.routes = [];
    });
    expect(r.changes.map((c) => `${c.kind} ${c.seat ?? ''}`)).toEqual(['seat-removed triage', 'seat-added pager', 'routes-changed ']);
    expect(s.stopped).toEqual(['s1']);
    expect(s.launches).toEqual(['pager-1', 'pager-2']);
    expect(s.ws.list()).toEqual([]);
    // the triage member still closing is no member any more: the tick starts nothing for it, nor for the others
    await s.at(5000);
    expect(s.launches).toEqual(['pager-1', 'pager-2']);
  });

  it('a seat retasked: each live member is told what changed in its role', async () => {
    const s = await setup();
    s.member('s9', 'enc', 2);
    const r = await s.edit((t) => (t.seats[1].instructions = 'Fix the encoders, one at a time.'));
    expect(r).toMatchObject({ changes: [{ kind: 'seat-retasked', seat: 'enc', detail: 'instructions changed' }], restart: [] });
    // a short role: both, whole
    const text = 'Your role in Ops changed: "Be enc." → "Fix the encoders, one at a time." Follow it from now on; your full instructions update when you next restart.';
    expect(s.delivered).toEqual([['s2', text], ['s9', text]]);
  });

  it('a change at the end of long instructions is what the notice says (never only their unchanged start)', async () => {
    const s = await setup();
    const role = `Watch the encoders. ${'Check each feed in turn and write down what you see. '.repeat(6)}Never restart one yourself.`;
    await s.edit((t) => (t.seats[0].instructions = role));
    s.delivered.length = 0;
    const added = 'Anything for the lead goes to it with project_post, to its id from the project card.';
    await s.edit((t) => (t.seats[0].instructions = `${role} ${added}`));
    // (where it was added, and no second full stop after its own)
    expect(s.delivered).toEqual([['s1', `Your role in Ops changed: added "${added}" after "Never restart one yourself." Follow it from now on; your full instructions update when you next restart.`]]);
    // a change in the middle: the words that changed, with a few on each side, not the whole text
    s.delivered.length = 0;
    await s.edit((t) => (t.seats[0].instructions = `${role.replace('Never restart', 'Always restart')} ${added}`));
    expect(s.delivered).toEqual([['s1', 'Your role in Ops changed: … "down what you see. Never restart one yourself. Anything" → "down what you see. Always restart one yourself. Anything" … Follow it from now on; your full instructions update when you next restart.']]);
    // at its start: its words after it, and no … before
    s.delivered.length = 0;
    const start = `${role.replace('Never restart', 'Always restart')} ${added}`.replace('Watch the encoders.', 'Watch the feeds.');
    await s.edit((t) => (t.seats[0].instructions = start));
    expect(s.delivered[0][1]).toMatch(/^Your role in Ops changed: "Watch the encoders\. Check each feed in" → "Watch the feeds\. Check each feed in" … Follow it/);
  });

  it('a change that needs a restart: collected (never restarted on its own), until the seat restarts', async () => {
    const s = await setup();
    const r = await s.edit((t) => (t.seats[1].agent = { model: 'opus' }));
    expect(r.restart).toEqual(['enc']);
    expect(s.rt.restarts(s.pid)).toEqual(['enc']);
    expect(s.stopped).toEqual([]);
    expect(s.launches).toEqual([]);
    const resumed = resumes(s);
    const again = await s.rt.restartSeats(s.pid, ['enc']);
    expect(again).toEqual({ started: [], problems: [] });
    expect(s.stopped).toEqual(['s2']);
    expect(s.rt.restarts(s.pid)).toEqual([]);
    // still closing: nothing new starts in its place
    await s.at(1000);
    expect(s.launches).toEqual([]);
    expect(resumed).toEqual([]);
    // closed: back as itself (its memory), on the new definition (resumeSeat rebuilds its launch), and told
    s.closed();
    await s.at(2000);
    expect(resumed).toEqual(['s2']);
    expect(s.launches).toEqual([]);
    expect(s.delivered.at(-1)).toEqual(['s2', expect.stringMatching(/^You're back on duty as Encoder fixer in Ops/)]);
    // standing a seat down clears it too
    await s.edit((t) => (t.seats[0].skills = ['runbook']));
    expect(s.rt.restarts(s.pid)).toEqual(['triage']);
    await s.rt.standDown(s.pid, 'triage');
    expect(s.rt.restarts(s.pid)).toEqual([]);
  });

  it('restarting a pool seat with no minimum brings back as many as were running, as themselves (it is not stood down)', async () => {
    const s = await setup();
    s.member('s9', 'enc', 2);
    await s.edit((t) => {
      t.seats[1].count = { min: 0, max: 3 };
      t.seats[1].agent = { model: 'opus' };
    });
    expect(s.rt.restarts(s.pid)).toEqual(['enc']);
    s.launches.length = 0;
    const resumed = resumes(s);
    await s.rt.restartSeats(s.pid, ['enc']);
    expect(s.stopped).toEqual(['s2', 's9']);
    s.closed();
    await s.at(2000);
    expect(resumed.sort()).toEqual(['s2', 's9']);
    expect(s.launches).toEqual([]);
    // all back: the restart is over (a later tick resumes or starts nothing more for it)
    await s.at(9000);
    expect(resumed).toHaveLength(2);
    expect(s.launches).toEqual([]);
  });

  it("a restarted member that can't be resumed: a new one starts in its place", async () => {
    const s = await setup();
    s.deps.resume = async () => ({ error: 'no conversation to resume' });
    await s.rt.restartSeats(s.pid, ['enc']);
    s.closed();
    await s.at(2000);
    expect(s.launches).toEqual(['enc-1']);
  });

  it('a pool resized: up to its new min now; members above its new max close once idle', async () => {
    const s = await setup();
    await s.edit((t) => (t.seats[1].count = { min: 3, max: 3 }));
    expect(s.launches).toEqual(['enc-2', 'enc-3']);
    // s2, s3, s4; s3 busy
    s.busy.add('s3');
    await s.edit((t) => (t.seats[1].count = { min: 1, max: 1 }));
    expect(s.stopped).toEqual([]);
    await s.at(5000);
    // newest first, idle ones only (no idleCloseMin needed)
    expect(s.stopped).toEqual(['s4']);
    s.closed();
    s.busy.delete('s3');
    await s.at(10_000);
    expect(s.stopped).toEqual(['s4', 's3']);
    s.closed();
    // once: a member added later above max isn't closed by it
    s.member('s9', 'enc', 2);
    await s.at(15_000);
    expect(s.stopped).toEqual(['s4', 's3']);
  });

  it('kept through a Cora restart: the seats waiting for a restart (still asked for), and a pool made smaller (its extras still close)', async () => {
    const s = await setup();
    await s.edit((t) => (t.seats[1].agent = { model: 'opus' }));
    await s.edit((t) => (t.seats[1].count = { min: 3, max: 3 }));
    s.busy.add('s3');
    s.busy.add('s4');
    await s.edit((t) => (t.seats[1].count = { min: 1, max: 1 }));
    // Cora restarts: a new runtime over the same projects, its terminals still running
    const again = new TeamRuntime(s.deps);
    again.resume();
    expect(again.restarts(s.pid)).toEqual(['enc']);
    s.busy.clear();
    await again.tick(1_000_000 + 5000);
    expect(s.stopped).toEqual(['s4', 's3']);
    // once restarted, it isn't asked for again (here or after another restart)
    await again.restartSeats(s.pid, ['enc']);
    const third = new TeamRuntime(s.deps);
    third.resume();
    expect(third.restarts(s.pid)).toEqual([]);
  });

  it('watches changed: set again with their new words; removed ones dropped', async () => {
    const s = await setup();
    expect(s.ws.list().map((w) => w.id)).toEqual([seatWatchId(s.pid, 'triage', 0), seatWatchId(s.pid, 'triage', 1)]);
    const r = await s.edit((t) => (t.seats[0].startup = { watches: [{ ...W, about: 'all alerts', from: 'ALL@acme.com', query: 'subject:alert', then: 'triage them' }] }));
    expect(r.changes).toEqual([{ kind: 'watches-changed', seat: 'triage' }]);
    expect(s.ws.list()).toHaveLength(1);
    expect(s.ws.get(seatWatchId(s.pid, 'triage', 0))).toMatchObject({ about: 'all alerts', from: 'all@acme.com', query: 'subject:alert', then: 'triage them', sessionId: 's1' });
  });
});

describe('a seat watch kept up to date', () => {
  it('ensure sets a watch again when its words changed (not when only its case did)', () => {
    let clock = 1_000_000;
    const ws = new MailWatches({ now: () => clock });
    const sw = mailSeatWatches({ watches: ws, tell: () => {}, now: () => clock });
    const s = seat('triage', 'Triage');
    sw.ensure('p1', s, 's1', 0, W);
    const id = seatWatchId('p1', 'triage', 0);
    const first = ws.get(id)!;
    clock += 60_000;
    sw.ensure('p1', s, 's1', 0, { ...W, from: 'Alerts@Acme.com' });
    expect(ws.get(id)!.until).toBe(first.until);
    sw.ensure('p1', s, 's1', 0, { ...W, then: 'page someone' });
    expect(ws.get(id)).toMatchObject({ then: 'page someone' });
    sw.ensure('p1', s, 's1', 0, { ...W, then: 'page someone', query: 'label:pager' });
    expect(ws.get(id)).toMatchObject({ query: 'label:pager' });
    sw.ensure('p1', s, 's1', 0, { ...W, then: 'page someone', query: 'label:pager', about: 'pages' });
    expect(ws.get(id)).toMatchObject({ about: 'pages' });
    // dropping from a place on
    sw.ensure('p1', s, 's1', 1, W2);
    sw.drop('p1', 'triage', 1);
    expect(ws.list().map((w) => w.id)).toEqual([id]);
  });

  describe('a seat only renamed (a new id, the same name or instructions): its sessions are kept, adopted into the new id', () => {
    /** Encoder fixer's id becomes "fixer" (its group and routes follow) */
    const rename = (t: Team, also: (s: Seat) => void = () => {}) => {
      const s = t.seats.find((x) => x.id === 'enc')!;
      s.id = 'fixer';
      t.groups[0].members = ['fixer'];
      also(s);
    };

    it('two live members: the same sessions, the new seat, their instances and started handles kept; no stop, no launch; each told', async () => {
      const s = await setup();
      s.member('s9', 'enc', 2);
      const inst = s.projects.get(s.pid)!.members.s2.instance;
      const r = await s.edit((t) => rename(t));
      expect(r.changes).toEqual([{ kind: 'seat-renamed', seat: 'fixer', from: 'enc', detail: 'renamed from enc' }]);
      expect(r.restart).toEqual([]);
      expect(s.stopped).toEqual([]);
      expect(s.launches).toEqual([]);
      const m = s.projects.get(s.pid)!.members;
      expect(m.s2).toMatchObject({ seat: 'fixer', instance: inst, handle: expect.stringMatching(/^enc-/) });
      expect(m.s9).toMatchObject({ seat: 'fixer', instance: 2, handle: expect.stringMatching(/^enc-2-/) });
      expect(s.delivered.map(([sid]) => sid).sort()).toEqual(['s2', 's9']);
      expect(s.delivered.find(([sid]) => sid === 's9')![1]).toMatch(/^Your seat in Ops is Encoder fixer \(its id is fixer now, was enc\) now: the same work under a new name\. You keep this session and what it runs; your handle for messages stays enc-2-\w+ until you next restart\.$/);
      // its standing (min 1) is met by the kept members: a tick starts nobody for it
      await s.at(5000);
      expect(s.launches).toEqual([]);
      // resumed later, it comes back as the new seat, under its new handle
      expect(s.rt.resumeSeat('s9')).toMatchObject({ name: expect.stringMatching(/^fixer-2-/) });
      expect(s.projects.get(s.pid)!.members.s9.handle).toBeUndefined();
    });

    it('renamed with new tools: kept, and a restart is offered for the tools; new instructions: kept, and told them', async () => {
      const s = await setup();
      const r = await s.edit((t) => rename(t, (x) => (x.agent = { tools: ['Read'] })));
      expect(r.changes).toEqual([{ kind: 'seat-renamed', seat: 'fixer', from: 'enc', detail: 'renamed from enc' }, { kind: 'seat-restart-needed', seat: 'fixer', detail: 'tools changed' }]);
      expect(r.restart).toEqual(['fixer']);
      expect(s.rt.restarts(s.pid)).toEqual(['fixer']);
      expect(s.stopped).toEqual([]);
      expect(s.launches).toEqual([]);
      // the same name, new instructions under the new id: still the same seat (by its name), told its new role
      s.delivered.length = 0;
      const r2 = await s.edit((t) => {
        const x = t.seats.find((y) => y.id === 'fixer')!;
        x.id = 'encoders-fixer';
        x.instructions = 'Fix the encoders, oldest first.';
        t.groups[0].members = ['encoders-fixer'];
      });
      expect(r2.changes.map((c) => c.kind)).toEqual(['seat-renamed', 'seat-retasked']);
      expect(s.stopped).toEqual([]);
      expect(s.launches).toEqual([]);
      expect(s.delivered.map(([, t]) => t)).toEqual([expect.stringMatching(/^Your seat in Ops is Encoder fixer \(its id is encoders-fixer now, was fixer\)/), expect.stringMatching(/^Your role in Ops changed: "Be enc\." → "Fix the encoders, oldest first\."/)]);
      // a restart still waiting moves with it, and its handle is still the one it started with
      expect(s.rt.restarts(s.pid)).toEqual(['encoders-fixer']);
      expect(s.projects.get(s.pid)!.members.s2.handle).toMatch(/^enc-/);
    });

    it('its watches are set again under the new id', async () => {
      const s = await setup();
      await s.edit((t) => {
        t.seats[0].id = 'tri';
        t.routes[0].from = ['seat:tri'];
      });
      expect(s.stopped).toEqual([]);
      expect(s.ws.list().map((w) => w.id)).toEqual([seatWatchId(s.pid, 'tri', 0), seatWatchId(s.pid, 'tri', 1)]);
    });

    it("a seat removed while it's stood down: its ended member leaves now, and what waited for it goes to the fallback", async () => {
      const s = await setup();
      await s.rt.standDown(s.pid, 'enc');
      s.closed();
      expect(s.projects.get(s.pid)!.sessions).toContain('s2');
      const post = s.projects.post(s.pid, 's1', 'handoff', 'encoder 3 is yours', ['s2'])!;
      s.projects.wait(s.pid, post.id, 's2');
      await s.edit((t) => {
        t.seats = t.seats.filter((x) => x.id !== 'enc');
        t.groups[0].members = [];
        t.fallback = 'seat:triage';
      });
      const p = s.projects.get(s.pid)!;
      expect(p.sessions).not.toContain('s2');
      expect(p.members.s2).toBeUndefined();
      expect(p.waiting).toEqual([expect.objectContaining({ post: post.id, to: 's1' })]);
    });

    it('an unrelated seat gone and another new (another name and instructions) still stands one down and starts the other', async () => {
      const s = await setup();
      const r = await s.edit((t) => {
        t.seats = t.seats.filter((x) => x.id !== 'enc');
        t.seats.push(seat('pager', 'Pager'));
        t.groups[0].members = ['pager'];
      });
      expect(r.changes.map((c) => c.kind)).toEqual(['seat-removed', 'seat-added', 'routes-changed']);
      expect(s.stopped).toEqual(['s2']);
      expect(s.launches).toEqual(['pager']);
    });
  });
});
