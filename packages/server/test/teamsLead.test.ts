import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Team } from '@cora/shared';
import { Projects } from '../src/projects';
import { TeamRuntime } from '../src/teams';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-lead-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, count = { min: 1, max: 1 }) => ({ id, name: id === 'dev' ? 'Developer' : id, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count, startup: {} });
const team = (lead?: string, devCount = { min: 2, max: 2 }): Team => ({ version: 0, seats: [seat('triage'), seat('dev', devCount)], groups: [], labels: [], routes: [], fallback: 'user', escalation: [], ...(lead ? { lead } : {}) });

function setup(t: Team) {
  const projects = new Projects(null, () => 1);
  const p = projects.create('Ops');
  expect((projects.setTeam(p.id, t, 'you') as { ok?: boolean }).ok).not.toBe(false);
  const live = new Set<string>();
  const told: string[] = [];
  let n = 0;
  const rt = new TeamRuntime({
    projects, dataDir: join(dir, 'data'), pluginDir: join(dir, 'plugin'), now: () => 1,
    launch: async () => {
      const sessionId = `s${++n}`;
      live.add(sessionId);
      return { sessionId };
    },
    stop: (sid) => void live.delete(sid),
    live: (sid) => live.has(sid), idle: () => false,
    deliver: () => {}, tell: (x) => void told.push(x),
  });
  const pid = p.id;
  const lead = () => projects.get(pid)!.lead;
  const memberOf = (seatId: string, instance?: number) => Object.entries(projects.get(pid)!.members).find(([, m]) => m.seat === seatId && m.instance === instance)?.[0];
  return { rt, projects, pid, live, told, lead, memberOf };
}

describe("a team's lead seat at run time", () => {
  it("brought up: the project's lead is the lead seat's first member (instance 1)", async () => {
    const { rt, pid, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    expect(lead()).toBe(memberOf('dev', 1));
  });

  it('a lead you set that is still a live member of the project stays (whatever its seat)', async () => {
    const { rt, projects, pid, lead, memberOf } = setup(team());
    await rt.bringUp(pid);
    const triage = memberOf('triage')!;
    projects.update(pid, { lead: triage });
    await rt.applyEdit(pid, team(), team('dev'));
    expect(lead()).toBe(triage);
    await rt.bringUp(pid);
    expect(lead()).toBe(triage);
  });

  it('a lead that is gone is filled at bring-up; no lead seat: nothing is set', async () => {
    const none = setup(team());
    await none.rt.bringUp(none.pid);
    expect(none.lead()).toBeUndefined();

    const { rt, projects, pid, live, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    const triage = memberOf('triage')!;
    projects.update(pid, { lead: triage });
    live.delete(triage);
    projects.leave(pid, triage);
    await rt.bringUp(pid);
    expect(lead()).toBe(memberOf('dev', 1));
  });

  it("a lead you set whose member ended passes to the member started in its place (its seat's successor), as before", async () => {
    const { rt, projects, pid, live, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    const triage = memberOf('triage')!;
    projects.update(pid, { lead: triage });
    live.delete(triage);
    await rt.bringUp(pid);
    expect(lead()).toBe(memberOf('triage'));
    expect(lead()).not.toBe(triage);
  });

  it('applied: a team that names a lead seat fills an empty lead at once (nobody restarts)', async () => {
    const { rt, pid, lead, memberOf } = setup(team());
    await rt.bringUp(pid);
    const r = await rt.applyEdit(pid, team(), team('dev'));
    expect(r.restart).toEqual([]);
    expect(lead()).toBe(memberOf('dev', 1));
  });

  it("the lead seat changed: the lead moves to the new seat's first member (it was the team's, not yours)", async () => {
    const { rt, pid, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    expect(lead()).toBe(memberOf('dev', 1));
    await rt.applyEdit(pid, team('dev'), team('triage'));
    expect(lead()).toBe(memberOf('triage'));
  });

  it('its member goes: the lead moves to another live member of the seat', async () => {
    const { rt, pid, live, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    const first = memberOf('dev', 1)!;
    live.delete(first);
    await rt.tick(2);
    expect(lead()).toBe(memberOf('dev', 2));
  });

  it("No lead, chosen by you (Crew), stays: an Apply or a bring-up doesn't fill it again, until you pick one or the team's lead seat changes", async () => {
    const { rt, projects, pid, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    expect(lead()).toBe(memberOf('dev', 1));
    projects.update(pid, { lead: null });
    expect(projects.get(pid)!.leadNone).toBe(true);
    await rt.applyEdit(pid, team('dev'), { ...team('dev'), seats: team('dev').seats.map((s) => ({ ...s, limits: { turnsPerHour: 9 } })) });
    expect(lead()).toBeUndefined();
    await rt.bringUp(pid);
    expect(lead()).toBeUndefined();
    await rt.tick(2);
    expect(lead()).toBeUndefined();
    // you pick one: yours, and the choice is over
    projects.update(pid, { lead: memberOf('triage')! });
    expect(projects.get(pid)!.leadNone).toBeUndefined();
    expect(lead()).toBe(memberOf('triage'));
    // no lead again, then the team's lead seat changes in an applied edit: the new lead seat leads
    projects.update(pid, { lead: '' });
    expect(projects.get(pid)!.leadNone).toBe(true);
    await rt.applyEdit(pid, team('dev'), team('triage'));
    expect(projects.get(pid)!.leadNone).toBeUndefined();
    expect(lead()).toBe(memberOf('triage'));
  });

  it("a lead you set on another seat's member that goes is left to you (only the lead seat's own lead moves)", async () => {
    const { rt, projects, pid, live, lead, memberOf } = setup(team('dev'));
    await rt.bringUp(pid);
    const triage = memberOf('triage')!;
    projects.update(pid, { lead: triage });
    live.delete(triage);
    await rt.tick(2);
    expect(lead()).toBe(triage);
  });
});
