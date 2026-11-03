import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seatCard, type Seat, type Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-api-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max: 1 }, startup: {}, ...o });
const TEAM: Team = {
  version: 0,
  seats: [seat('triage', 'Triage'), seat('monitor', 'Monitor'), seat('enc', 'Encoder fixer', { count: { min: 0, max: 3 } })],
  groups: [{ id: 'encoders', name: 'Encoders', members: ['enc'], dispatch: 'claim' }],
  labels: [],
  routes: [
    { id: 'r1', from: ['seat:triage'], to: 'group:encoders', kinds: ['handoff'], wake: 'auto' },
    { id: 'r2', from: ['seat:monitor'], to: 'seat:triage', kinds: ['report'], wake: 'auto' },
  ],
  fallback: 'user',
  escalation: [],
};

describe('the team API', () => {
  let srv: Running;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const TRI = 'bbbb0000-0000-0000-0000-000000000003';
  const MON = 'aaaa0000-0000-0000-0000-000000000001';
  const req = (method: 'GET' | 'PUT' | 'POST', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  /** a team set as you set one: a draft in the builder, applied */
  const applyTeam = async (pid: string, team: Team) => {
    const d = (await req('PUT', `/api/projects/${pid}/builder`, { team, rev: 0 })).json().draft;
    return req('POST', `/api/projects/${pid}/builder/apply`, { rev: d.rev });
  };
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };

  const setUp = async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const now = Date.now();
    for (const [id, alias] of [[TRI, 'Triage'], [MON, 'Monitor']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
    const p = (await req('POST', '/api/projects', { name: 'Ops', sessionId: TRI })).json().project;
    await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: MON });
    return p.id as string;
  };

  it('GET reads the team (versioned; none yet: version 0); an invalid one is never applied (400, its problems); there is no PUT', async () => {
    const pid = await setUp();
    try {
      const empty = (await req('GET', `/api/projects/${pid}/team`)).json();
      expect(empty).toMatchObject({ version: 0, up: false });
      expect(empty.team).toBeUndefined();
      const put = await applyTeam(pid, TEAM);
      expect(put.statusCode).toBe(200);
      expect(put.json()).toMatchObject({ ok: true, version: 1 });
      const got = (await req('GET', `/api/projects/${pid}/team`)).json();
      expect(got).toMatchObject({ version: 1, up: false, team: { version: 1 } });
      expect(got.health).toEqual([{ seat: 'triage', failing: false }, { seat: 'monitor', failing: false }, { seat: 'enc', failing: false }]);
      const bad = await applyTeam(pid, { ...TEAM, seats: [] });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().problems.length).toBeGreaterThan(0);
      expect((await req('GET', `/api/projects/${pid}/team`)).json().version).toBe(1);
      // the team is set through the builder (or by Cora, or a proposal approved): no route sets it straight
      expect((await req('PUT', `/api/projects/${pid}/team`, { team: TEAM, version: 1 })).statusCode).toBe(404);
      expect((await req('GET', '/api/projects/nope/team')).statusCode).toBe(404);
    } finally {
      await srv.close();
    }
  });

  it('Bring up needs Claude Code with mods; stand down; history and rollback', async () => {
    const pid = await setUp();
    try {
      await applyTeam(pid, TEAM);
      const up = await req('POST', `/api/projects/${pid}/team/bring-up`, {});
      expect(up.json()).toEqual({ started: [], problems: ['Teams need Claude Code 2.1.287 or later (claude update).'] });
      // (Launch was another name for it: gone)
      expect((await req('POST', `/api/projects/${pid}/team/launch`, {})).statusCode).toBe(404);
      expect((await req('GET', `/api/projects/${pid}/team`)).json().up).toBe(false);
      expect(srv.projects.get(pid)!.teamUp).toBeFalsy();
      expect((await req('POST', `/api/projects/${pid}/team/stand-down`, { seat: 'nope' })).statusCode).toBe(400);
      expect((await req('POST', `/api/projects/${pid}/team/stand-down`, { seat: 'triage' })).json()).toEqual({ ok: true });
      expect((await req('POST', `/api/projects/${pid}/team/stand-down`, {})).json()).toEqual({ ok: true });

      const v2 = { ...TEAM, seats: TEAM.seats.map((s) => (s.id === 'triage' ? { ...s, name: 'Triage desk' } : s)) };
      expect((await applyTeam(pid, v2)).json()).toMatchObject({ version: 2 });
      const h = (await req('GET', `/api/projects/${pid}/team/history`)).json();
      expect(h.current).toBe(2);
      expect(h.versions.map((x: { version: number }) => x.version)).toEqual([1]);
      expect(h.versions[0]).toMatchObject({ by: 'you' });
      expect(typeof h.versions[0].at).toBe('number');
      const back = await req('POST', `/api/projects/${pid}/team/rollback`, { version: 1 });
      expect(back.json()).toMatchObject({ ok: true, version: 3 });
      expect(srv.projects.get(pid)!.team!.seats[0].name).toBe('Triage');
      expect((await req('POST', `/api/projects/${pid}/team/rollback`, { version: 9 })).statusCode).toBe(400);
      expect((await req('GET', `/api/projects/${pid}/team/history`)).json().versions.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    } finally {
      await srv.close();
    }
  });

  it('project_post to a group (by name or id) offers it as work; a route that forbids it refuses it', async () => {
    const pid = await setUp();
    try {
      await applyTeam(pid, TEAM);
      srv.projects.setSeat(pid, TRI, 'triage');
      srv.projects.setSeat(pid, MON, 'monitor');
      const r = await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 7 drops frames\nSince 09:00.', to: ['encoders'.toUpperCase()] });
      expect(r.isError).toBeFalsy();
      const item = srv.projects.get(pid)!.items!.at(-1)!;
      expect(item).toMatchObject({ kind: 'incident', title: 'Encoder 7 drops frames', body: 'Encoder 7 drops frames\nSince 09:00.', offeredTo: 'encoders', openedBy: TRI });
      expect(r.content[0].text).toBe(`Offered to Encoders (item ${item.id})`);
      // on the board: who offered what (the incident); nobody in the group running, nobody has it yet: not delivered
      const shown = srv.projects.get(pid)!.thread.at(-1)!;
      expect(shown).toMatchObject({ by: TRI, kind: 'handoff', text: 'Encoder 7 drops frames\nSince 09:00.', item: item.id });
      expect(shown.deliveredAt).toBeUndefined();
      // by its name too
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 8 too', to: ['Encoders'] })).content[0].text).toMatch(/^Offered to Encoders \(item /);
      expect(srv.projects.get(pid)!.items).toHaveLength(2);
      // the monitor has no route to the group
      const no = await tool(MON, 'project_post', { kind: 'handoff', text: 'Encoder 9', to: ['encoders'] });
      expect(no.isError).toBe(true);
      expect(no.content[0].text).toMatch(/^Monitor may not message Encoders/);
      expect(srv.projects.get(pid)!.items).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it('Apply and rollback answer what changed and the seats needing a restart; GET says which wait; the restart route', async () => {
    const pid = await setUp();
    try {
      const first = (await applyTeam(pid, TEAM)).json();
      expect(first).toMatchObject({ ok: true, version: 1, restart: [] });
      expect(first.changes).toEqual([
        { kind: 'seat-added', seat: 'triage' }, { kind: 'seat-added', seat: 'monitor' }, { kind: 'seat-added', seat: 'enc' },
        { kind: 'routes-changed', detail: 'routes, groups changed' },
      ]);
      const v2 = { ...TEAM, seats: TEAM.seats.map((s) => (s.id === 'enc' ? { ...s, agent: { model: 'opus' }, count: { min: 0, max: 2 } } : s)) };
      const put = (await applyTeam(pid, v2)).json();
      // the team isn't up: nothing is running to restart
      expect(put).toMatchObject({ ok: true, version: 2, restart: [], changes: [{ kind: 'seat-restart-needed', seat: 'enc', detail: 'model changed' }, { kind: 'pool-resized', seat: 'enc', detail: 'max 3→2' }] });
      expect((await req('GET', `/api/projects/${pid}/team`)).json()).toMatchObject({ version: 2, restart: [] });
      const back = (await req('POST', `/api/projects/${pid}/team/rollback`, { version: 1 })).json();
      expect(back).toMatchObject({ ok: true, version: 3, restart: [], changes: [{ kind: 'seat-restart-needed', seat: 'enc' }, { kind: 'pool-resized', seat: 'enc', detail: 'max 2→3' }] });

      expect((await req('POST', `/api/projects/${pid}/team/restart`, { seats: ['nope'] })).statusCode).toBe(400);
      expect((await req('POST', `/api/projects/${pid}/team/restart`, { seats: [] })).statusCode).toBe(400);
      expect((await req('POST', `/api/projects/${pid}/team/restart`, { seats: ['enc'] })).json()).toEqual({ started: [], problems: ["The team isn't up: bring it up instead."] });
    } finally {
      await srv.close();
    }
  });

  it('the lead proposes a team change (nobody else); you approve it (409 when stale) or reject it (the lead is told)', async () => {
    const pid = await setUp();
    try {
      await applyTeam(pid, TEAM);
      const v2 = { ...TEAM, seats: [...TEAM.seats, seat('pager', 'Pager')] };
      const why = 'Someone should page the on-call engineer.';
      expect(await tool(TRI, 'project_team_propose', { team: v2, why })).toMatchObject({ isError: true, content: [{ text: 'Only the lead proposes team changes.' }] });
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${pid}`, headers: UI, payload: { lead: TRI } });
      expect(await tool(MON, 'project_team_propose', { team: v2, why })).toMatchObject({ isError: true, content: [{ text: 'Only the lead proposes team changes.' }] });
      const bad = await tool(TRI, 'project_team_propose', { team: { ...v2, fallback: 'seat:nope' }, why });
      expect(bad.isError).toBe(true);
      expect(bad.content[0].text).toMatch(/^The team has problems:\n- The fallback "seat:nope" is not a known endpoint\./);
      expect(srv.projects.get(pid)!.teamProposal).toBeUndefined();
      // its version is the one there (it needn't say)
      const { version: _v, ...noVersion } = v2;
      const ok = await tool(TRI, 'project_team_propose', { team: noVersion, why });
      expect(ok.isError).toBeFalsy();
      // what it changes, in the lines you'll see on its card
      expect(ok.content[0].text).toMatch(/What it changes:\n- New seat: Pager \(0 to 1\)\n- Pager instructions: "Be pager\."/);
      expect(srv.projects.get(pid)!.teamProposal).toMatchObject({ why, by: TRI, base: 1, team: { seats: expect.arrayContaining([expect.objectContaining({ id: 'pager' })]) } });
      expect((await req('GET', `/api/projects/${pid}/team`)).json().proposal).toMatchObject({ why, by: TRI, base: 1 });

      // what you were shown, and nothing else: no `at`, or another proposal's, is refused
      const shown = (await req('GET', `/api/projects/${pid}/team`)).json();

      expect(shown.proposalDetails[0]).toEqual({ line: 'New seat: Pager (0 to 1)' });
      for (const body of [{}, { at: shown.proposal.at - 1 }]) {
        const r = await req('POST', `/api/projects/${pid}/team/proposal/approve`, body);
        expect(r.statusCode).toBe(409);
        expect(r.json().error).toBe('The proposal changed since you looked: review it again.');
      }
      expect(srv.projects.get(pid)!.team!.version).toBe(1);
      const approved = (await req('POST', `/api/projects/${pid}/team/proposal/approve`, { at: shown.proposal.at })).json();
      expect(approved).toMatchObject({ ok: true, version: 2, changes: [{ kind: 'seat-added', seat: 'pager' }], restart: [] });
      expect(srv.projects.get(pid)!.teamProposal).toBeUndefined();
      expect(srv.projects.get(pid)!.team!.seats.map((s) => s.id)).toContain('pager');
      expect((await req('POST', `/api/projects/${pid}/team/proposal/approve`, { at: shown.proposal.at })).statusCode).toBe(404);

      // proposed on version 2; you changed the team since: it's set aside (nothing left to approve)
      expect((await tool(TRI, 'project_team_propose', { team: TEAM, why: 'No pager after all.' })).isError).toBeFalsy();
      const at = srv.projects.get(pid)!.teamProposal!.at;
      await applyTeam(pid, { ...v2, seats: v2.seats.map((s) => (s.id === 'pager' ? { ...s, name: 'Pager duty' } : s)) });
      expect(srv.projects.get(pid)!.teamProposal).toBeUndefined();
      expect((await req('POST', `/api/projects/${pid}/team/proposal/approve`, { at })).statusCode).toBe(404);

      // rejected: the lead's mod hears it
      expect((await tool(TRI, 'project_team_propose', { team: TEAM, why: 'No pager after all.' })).isError).toBeFalsy();
      const asks = srv.app.inject({ url: `/api/mod/inbox?session=${TRI}`, headers: { 'x-cora-token': 'hooktok' } }).then((r) => r.json().items);
      await new Promise((r) => setTimeout(r, 30));
      expect((await req('POST', `/api/projects/${pid}/team/proposal/reject`)).json()).toEqual({ ok: true });
      expect(await asks).toEqual([{ id: expect.any(String), kind: 'submit', text: "Your team change wasn't taken." }]);
      expect(srv.projects.get(pid)!.teamProposal).toBeUndefined();
      expect((await req('POST', `/api/projects/${pid}/team/proposal/reject`)).statusCode).toBe(404);

      // only limits, or only a name: still a change (nothing for the running seats to act on); the same team isn't
      const cur = srv.projects.get(pid)!.team!;
      expect((await tool(TRI, 'project_team_propose', { team: cur, why: 'x' })).content[0].text).toBe("That's the team as it is: nothing to propose.");
      const limits = await tool(TRI, 'project_team_propose', { team: { ...cur, seats: cur.seats.map((s) => (s.id === 'triage' ? { ...s, limits: { turnsPerHour: 5 } } : s)) }, why: 'Fewer turns.' });
      expect(limits.isError).toBeFalsy();
      expect(limits.content[0].text).toContain('- Triage limits: none → 5 turns an hour');
      expect(srv.projects.get(pid)!.teamProposal!.team.seats[0].limits).toEqual({ turnsPerHour: 5 });
      expect((await tool(TRI, 'project_team_propose', { team: { ...cur, seats: cur.seats.map((s) => (s.id === 'triage' ? { ...s, name: 'Triage desk' } : s)) }, why: 'A better name.' })).isError).toBeFalsy();
      expect(srv.projects.get(pid)!.teamProposal!.why).toBe('A better name.');
    } finally {
      await srv.close();
    }
  });

  it('a seat’s card says a group is messaged by its name', () => {
    expect(seatCard(TEAM, 'triage')).toContain('Encoders (handoffs)');
    expect(seatCard(TEAM, 'triage')).toMatch(/A group takes work by its name \(to: \["Encoders"\]\)/);
    expect(seatCard(TEAM, 'monitor')).not.toMatch(/A group takes work/);
  });
});
