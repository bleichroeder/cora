import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clone, newSeat, type Team } from '@cora/shared';
import { GUEST_NEVER } from '../src/app';
import { Hub } from '../src/hub';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { builderTools } from '../src/builder';
import { drill, drillDraft, drillProposal, drillTheirs } from '@cora/shared/test/fixtures';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-builder-api-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const LEAD = 'eeee0000-0000-0000-0000-000000000005';

describe('the builder, through the app', () => {
  let srv: Running;
  let pid: string;
  const req = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const B = () => `/api/projects/${pid}/builder`;
  beforeEach(async () => {
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never });
    pid = (await req('POST', '/api/projects', { name: 'Drill' })).json().project.id;
    expect(srv.projects.setTeam(pid, drill(), 'you').ok).toBe(true);
  });
  afterEach(async () => srv.close());

  it('a layout is saved without a version bump or a history entry', async () => {
    expect((await req('PUT', `/api/projects/${pid}/team/layout`, { layout: { pos: { triage: { x: 4, y: 8 } } } })).json()).toEqual({ ok: true });
    expect(srv.projects.get(pid)!.team!.version).toBe(1);
    expect((await req('GET', `/api/projects/${pid}/team/history`)).json().versions).toEqual([]);
    expect(srv.projects.get(pid)!.teamLayout).toEqual({ pos: { triage: { x: 4, y: 8 } } });
    expect((await req('PUT', `/api/projects/${pid}/team/layout`, { layout: 3 })).statusCode).toBe(400);
  });

  it('the draft: none, then yours (published), a stale edit refused with the draft, then discarded', async () => {
    const seen: string[] = [];
    const prev = srv.projects.onDraft;
    srv.projects.onDraft = (p) => (seen.push(p), prev?.(p));
    expect((await req('GET', B())).json()).toEqual({ draft: null });
    const put = await req('PUT', B(), { team: drillDraft(), rev: 0 });
    expect(put.json()).toMatchObject({ ok: true, draft: { rev: 1, base: 1, by: 'you' } });
    expect(seen).toEqual([pid]);
    expect((await req('GET', B())).json().draft.rev).toBe(1);
    const stale = await req('PUT', B(), { team: drillDraft(), rev: 0 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().draft.rev).toBe(1);
    expect((await req('PUT', B(), { team: { seats: [] }, rev: 1 })).statusCode).toBe(400);
    expect((await req('DELETE', B())).json()).toEqual({ ok: true });
    expect((await req('GET', B())).json()).toEqual({ draft: null });
  });

  it('the projects list never carries the draft; it carries the builder session', async () => {
    await req('PUT', B(), { team: drillDraft(), rev: 0 });
    srv.projects.setDraftSession(pid, 'dddd0000-0000-0000-0000-000000000009');
    const p = (await req('GET', '/api/projects')).json().projects[0];
    expect(p.builderDraft).toBeUndefined();
    expect(p.builderSession).toBe('dddd0000-0000-0000-0000-000000000009');
  });

  it("apply: the draft becomes the team's next version, and goes", async () => {
    const d = (await req('PUT', B(), { team: drillDraft(), rev: 0 })).json().draft;
    const r = await req('POST', `${B()}/apply`, { rev: d.rev });
    expect(r.json()).toMatchObject({ ok: true, version: 2 });
    expect(srv.projects.get(pid)!.team!.routes.find((x) => x.id === 'r-back')!.wake).toBe('ask');
    expect((await req('GET', B())).json()).toEqual({ draft: null });
  });

  it("a refused apply (the team changed meanwhile), what changed under you, the rebase, then apply", async () => {
    const d = (await req('PUT', B(), { team: drillDraft(), rev: 0 })).json().draft;
    expect(srv.projects.setTeam(pid, drillTheirs(), 'cora').ok).toBe(true);
    const refused = await req('POST', `${B()}/apply`, { rev: d.rev });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ conflict: true, version: 2 });
    const dry = (await req('POST', `${B()}/rebase`, { dry: true })).json();
    expect(dry.theirs).toHaveLength(2);
    expect(dry.conflicts).toEqual(['Route Analysts → Triage, wake: they set never, your draft has ask. Yours is kept.']);
    const real = (await req('POST', `${B()}/rebase`, {})).json();
    expect(real.draft).toMatchObject({ base: 2, rev: 2 });
    expect((await req('POST', `${B()}/apply`, { rev: 2 })).json()).toMatchObject({ ok: true, version: 3 });
    const team = srv.projects.get(pid)!.team!;
    expect(team.routes.find((x) => x.id === 'r-back')!.wake).toBe('ask');
    expect(team.seats.find((s) => s.id === 'analyst-net')!.limits).toEqual({ turnsPerHour: 20 });
  });

  it("apply: the draft is gone before the running team takes it, so Cora's change made meanwhile is refused (never lost unseen)", async () => {
    const d = (await req('PUT', B(), { team: drillDraft(), rev: 0 })).json().draft;
    const tools = builderTools(srv.projects, 'k');
    let cora: { ok: boolean; error?: string } | undefined;
    const setTeam = srv.projects.setTeam.bind(srv.projects);
    // Cora's turn lands while the running team is taking the new version (the apply's first wait)
    srv.projects.setTeam = (...a: Parameters<typeof setTeam>) => {
      const r = setTeam(...a);
      void Promise.resolve().then(() => (cora = tools.set(pid, clone(drillDraft()), d.rev)));
      return r;
    };
    expect((await req('POST', `${B()}/apply`, { rev: d.rev })).json()).toMatchObject({ ok: true, version: 2 });
    expect(cora?.ok).toBe(false);
    expect(cora?.error).toMatch(/applied/);
    expect(srv.projects.draft(pid)).toBeUndefined();
  });

  it("the builder's Claude reads the checks as this PC answers them: a monitor on a file that isn't there", async () => {
    const d = (await req('PUT', B(), { team: drillDraft(), rev: 0 })).json().draft;
    const there = builderTools(srv.projects, 'k', { fileExists: () => true }).get(pid);
    expect(there.ok && there.text).not.toMatch(/monitor reads feed-a/);
    const gone = builderTools(srv.projects, 'k', { fileExists: () => false });
    const r = gone.get(pid);
    expect(r.ok && r.text).toMatch(/- warning: Monitor A's monitor reads feed-a\.log, which isn't on this PC and no seat says it makes it/);
    const s = gone.set(pid, clone(drillDraft()), d.rev);
    expect(s.ok && s.text).toMatch(/Checks still say:[\s\S]*Monitor A's monitor reads feed-a\.log/);
  });

  it("apply refuses a draft that changed since you looked", async () => {
    await req('PUT', B(), { team: drillDraft(), rev: 0 });
    expect((await req('POST', `${B()}/apply`, { rev: 0 })).json()).toMatchObject({ rev: 1 });
  });

  it("Undo of Cora's turn", async () => {
    const t = clone(drill());
    t.seats.push(newSeat('monitor-c', 'Monitor C', 'C:/w'));
    const c = srv.projects.setDraft(pid, t, 'cora');
    if (!c.ok) throw new Error(c.error);
    const u = (await req('POST', `${B()}/undo`, { turns: [c.draft.turns[0].id] })).json();
    expect(u.draft.team.seats.map((s: { id: string }) => s.id)).not.toContain('monitor-c');
    expect(u.draft.turns[0].before).toBeUndefined();
  });

  it('which folders are not on this PC (a path that is not a full one is never looked up, here or under Cora)', async () => {
    expect((await req('POST', `${B()}/folders`, { paths: [dir, join(dir, 'nope'), 'packages', 'nope'], worktrees: ['packages'] })).json()).toEqual({ missing: [join(dir, 'nope')], notRepo: [], missingFiles: [] });
  });

  it("which files seats' monitors read aren't on this PC (a path that isn't a full one is never looked up)", async () => {
    writeFileSync(join(dir, 'ci.log'), '');
    const r = await req('POST', `${B()}/folders`, { paths: [], files: [join(dir, 'ci.log'), join(dir, 'gone.log'), 'gone.log', 7] });
    expect(r.json()).toEqual({ missing: [], notRepo: [], missingFiles: [join(dir, 'gone.log')] });
  });

  it("which folders a seat wants a worktree of aren't git repositories (one not there yet is only missing)", async () => {
    const repo = join(dir, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const r = await req('POST', `${B()}/folders`, { paths: [dir, repo, join(dir, 'nope')], worktrees: [dir, repo, join(dir, 'nope'), 7] });
    expect(r.json()).toEqual({ missing: [join(dir, 'nope')], notRepo: [dir], missingFiles: [] });
  });

  it("a lead's proposal approved with your edits: applied as you left it, and the lead told", async () => {
    srv.store.upsertSession({ id: LEAD, alias: 'Lead', cwd: dir, state: 'idle', startedAt: Date.now(), lastTs: Date.now() } as never);
    await req('POST', `/api/projects/${pid}/sessions`, { sessionId: LEAD });
    const proposed = { ...drillProposal(), version: 1 } as Team;
    srv.projects.setTeamProposal(pid, { team: proposed, why: 'ingest work', by: LEAD, at: 5, base: 1 });
    const edited = clone(proposed);
    edited.seats.find((s) => s.id === 'analyst-ing')!.count = { min: 0, max: 2 };
    const r = await req('POST', `/api/projects/${pid}/team/proposal/approve`, { at: 5, team: edited });
    expect(r.json()).toMatchObject({ ok: true, version: 2, edited: true });
    expect(srv.projects.get(pid)!.team!.seats.find((s) => s.id === 'analyst-ing')!.count).toEqual({ min: 0, max: 2 });
    const note = srv.projects.get(pid)!.thread.at(-1)!;
    expect(note).toMatchObject({ by: 'you', kind: 'note', to: [LEAD] });
    expect(note.text).toMatch(/^Approved your team change, with my edits:\n- Ingest analyst count: 0 to 1 → 0 to 2/);
    expect(srv.projects.get(pid)!.teamProposal).toBeUndefined();
  });

  it('apply with nothing to apply is a 404; an applied draft is one history entry', async () => {
    expect((await req('POST', `${B()}/apply`, { rev: 0 })).statusCode).toBe(404);
    const d = (await req('PUT', B(), { team: drillDraft(), rev: 0 })).json().draft;
    expect((await req('POST', `${B()}/apply`, { rev: d.rev })).json()).toMatchObject({ ok: true, version: 2 });
    expect((await req('GET', `/api/projects/${pid}/team/history`)).json().versions).toHaveLength(1);
  });

  it('apply with bringUp: the team is applied and what the bring-up did is told', async () => {
    const d = (await req('PUT', B(), { team: drillDraft(), rev: 0 })).json().draft;
    const r = await req('POST', `${B()}/apply`, { rev: d.rev, bringUp: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, version: 2, started: expect.any(Array) });
    expect(srv.projects.get(pid)!.team!.version).toBe(2);
    expect((await req('GET', B())).json()).toEqual({ draft: null });
  });

  it("a lead's proposal made on an older version is set aside when the team changes (the lead is told), never shown as undoing the new one", async () => {
    srv.store.upsertSession({ id: LEAD, alias: 'Lead', cwd: dir, state: 'idle', startedAt: Date.now(), lastTs: Date.now() } as never);
    await req('POST', `/api/projects/${pid}/sessions`, { sessionId: LEAD });
    const proposed = { ...drillProposal(), version: 1 } as Team;
    srv.projects.setTeamProposal(pid, { team: proposed, why: 'x', by: LEAD, at: 5, base: 1 });
    const d = (await req('PUT', B(), { team: drillTheirs(), rev: 0 })).json().draft;
    expect((await req('POST', `${B()}/apply`, { rev: d.rev })).json()).toMatchObject({ ok: true, version: 2 });
    expect(srv.projects.get(pid)!.teamProposal).toBeUndefined();
    expect((await req('GET', `/api/projects/${pid}/team`)).json().proposal).toBeUndefined();
    const note = srv.projects.get(pid)!.thread.at(-1)!;
    expect(note).toMatchObject({ by: 'cora', kind: 'note', to: [LEAD] });
    expect(note.text).toBe('The team changed since your proposal (it was made on version 1; the team is version 2 now), so it was set aside. Read the team again and propose your change on top of it if it still matters.');
    expect((await req('POST', `/api/projects/${pid}/team/proposal/approve`, { at: 5 })).statusCode).toBe(404);
    expect(srv.projects.get(pid)!.team!.version).toBe(2);
  });

  it("approving a proposal isn't setting it aside: the lead isn't told it was", async () => {
    srv.store.upsertSession({ id: LEAD, alias: 'Lead', cwd: dir, state: 'idle', startedAt: Date.now(), lastTs: Date.now() } as never);
    await req('POST', `/api/projects/${pid}/sessions`, { sessionId: LEAD });
    srv.projects.setTeamProposal(pid, { team: { ...drillProposal(), version: 1 } as Team, why: 'x', by: LEAD, at: 5, base: 1 });
    expect((await req('POST', `/api/projects/${pid}/team/proposal/approve`, { at: 5 })).json()).toMatchObject({ ok: true, version: 2 });
    expect(srv.projects.get(pid)!.thread.some((x) => /set aside/.test(x.text))).toBe(false);
  });
});

describe('the builder and Go-live guests', () => {
  it('a guest screen never receives the draft; yours does', () => {
    const hub = new Hub({} as never, () => []);
    hub.guests = { live: () => true, on: () => true, allows: (t) => !GUEST_NEVER.has(t), name: () => 'g' };
    const got = (seat: string) => {
      const out: string[] = [];
      hub.add({ send: (x: string) => out.push(x), on() {}, readyState: 1 }, seat);
      return out;
    };
    const guest = got('guest:g1');
    const mine = got('pc');
    hub.publishBuilder({ t: 'builder', project: 'p', draft: null });
    expect(guest.filter((x) => x.includes('"builder"'))).toEqual([]);
    expect(mine.filter((x) => x.includes('"builder"'))).toHaveLength(1);
  });

  it("a guest's screen never gets a private session's row, events, prompts or terminal (the builder's); yours gets them all", () => {
    const S = (id: string) => ({ id, state: 'idle' }) as never;
    const ev = (sessionId: string) => ({ id: `e-${sessionId}`, seq: 1, sessionId, agentId: 'main', ts: 1 }) as never;
    const store = { listSessions: () => [S('b1'), S('s1')], listAgents: () => [], eventsForSession: (sid: string) => [ev(sid)], lastSeq: () => 1, eventsSince: () => [] };
    const pend = [{ id: 'p1', sessionId: 'b1' }, { id: 'p2', sessionId: 's1' }] as never;
    const terms = [{ terminalId: 't1', sessionId: 'b1' }, { terminalId: 't2', sessionId: 's1' }] as never;
    const hub = new Hub(store as never, () => pend, 0, () => terms);
    hub.guests = { live: () => true, on: () => true, allows: (t) => !GUEST_NEVER.has(t), name: () => 'g' };
    hub.isPrivate = (sid) => sid === 'b1';
    const got = (seat: string) => {
      const out: Array<Record<string, any>> = [];
      let onMsg: (d: string) => void = () => {};
      hub.add({ send: (x: string) => out.push(JSON.parse(x)), on: (ev: string, fn: (d?: any) => void) => void (ev === 'message' && (onMsg = fn)), readyState: 1 }, seat);
      onMsg(JSON.stringify({ t: 'hello', lastSeq: 0 }));
      return out;
    };
    const guest = got('guest:g1');
    const mine = got('pc');
    const snap = guest.find((m) => m.t === 'snapshot')!;
    expect(snap.sessions.map((x: { id: string }) => x.id)).toEqual(['s1']);
    expect(Object.keys(snap.recent)).toEqual(['s1']);
    expect(snap.pending.map((x: { id: string }) => x.id)).toEqual(['p2']);
    expect(snap.terminals.map((x: { terminalId: string }) => x.terminalId)).toEqual(['t2']);
    expect(mine.find((m) => m.t === 'snapshot')!.sessions).toHaveLength(2);
    hub.publishSession(S('b1'));
    hub.publish(ev('b1'));
    hub.publish(ev('s1'));
    hub.flush();
    hub.publishPending(pend);
    hub.publishTerminals(terms);
    const after = (out: Array<Record<string, any>>) => out.filter((m) => m.t !== 'snapshot');
    expect(after(guest).find((m) => m.t === 'session')).toBeUndefined();
    expect(after(guest).find((m) => m.t === 'events')!.events.map((e: { sessionId: string }) => e.sessionId)).toEqual(['s1']);
    expect(after(guest).find((m) => m.t === 'pending')!.pending).toHaveLength(1);
    expect(after(guest).find((m) => m.t === 'terminals')!.terminals).toHaveLength(1);
    expect(after(mine).find((m) => m.t === 'session')!.session.id).toBe('b1');
    expect(after(mine).find((m) => m.t === 'events')!.events).toHaveLength(2);
    expect(after(mine).find((m) => m.t === 'terminals')!.terminals).toHaveLength(2);
  });

  it("nor a private session's memes, debriefs, debrief videos or live documents as they come", () => {
    const hub = new Hub({} as never, () => []);
    hub.guests = { live: () => true, on: () => true, allows: (t) => !GUEST_NEVER.has(t), name: () => 'g' };
    hub.isPrivate = (sid) => sid === 'b1';
    const got = (seat: string) => {
      const out: Array<Record<string, any>> = [];
      hub.add({ send: (x: string) => out.push(JSON.parse(x)), on() {}, readyState: 1 }, seat);
      return out;
    };
    const guest = got('guest:g1');
    const mine = got('pc');
    for (const sid of ['b1', 's1']) {
      hub.publishMeme(sid);
      hub.publishDebriefs({ t: 'debriefs', sessionId: sid, list: [] });
      hub.publishExplainData({ t: 'explain-data', sessionId: sid, slug: 'x', data: 1 });
    }
    hub.publishVideos({ t: 'videos', jobs: [{ id: 'v1', sessionId: 'b1' }, { id: 'v2', sessionId: 's1' }] as never, ffmpeg: {} as never });
    const sids = (out: Array<Record<string, any>>, t: string) => out.filter((m) => m.t === t).map((m) => m.sessionId);
    for (const t of ['meme', 'debriefs', 'explain-data']) {
      expect(sids(guest, t), t).toEqual(['s1']);
      expect(sids(mine, t), t).toEqual(['b1', 's1']);
    }
    expect(guest.find((m) => m.t === 'videos')!.jobs.map((j: { id: string }) => j.id)).toEqual(['v2']);
    expect(mine.find((m) => m.t === 'videos')!.jobs).toHaveLength(2);
  });

  it("says whether a screen of yours got it (a guest's never counts): Talk's trouble is told on your next Talk otherwise", () => {
    const hub = new Hub({} as never, () => []);
    hub.guests = { live: () => true, on: () => true, allows: (t) => !GUEST_NEVER.has(t), name: () => 'g' };
    hub.add({ send() {}, on() {}, readyState: 1 }, 'guest:g1');
    expect(hub.publishBuilder({ t: 'builder', project: 'p', draft: null, talkError: 'x' })).toBe(false);
    hub.add({ send() {}, on() {}, readyState: 1 }, 'pc');
    expect(hub.publishBuilder({ t: 'builder', project: 'p', draft: null, talkError: 'x' })).toBe(true);
  });
});
