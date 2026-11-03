import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seatHandle, type MailWatch, type Seat, type Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { seatWatchMail, startServer, type Running } from '../src/server';
import { writeTeamArtifacts } from '../src/teamAgents';
import { seatWatchId, teamReport } from '../src/teams';

/** The final review's fixes, end to end. */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-teams-final-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max: 1 }, startup: {}, ...o });
const TEAM: Team = {
  version: 0,
  seats: [seat('monitor', 'Monitor', { count: { min: 0, max: 3 } }), seat('triage', 'Triage'), seat('fix', 'Fix')],
  groups: [{ id: 'fixers', name: 'Fixers', members: ['fix'], dispatch: 'claim' }],
  labels: [],
  routes: [
    { id: 'alerts', from: ['seat:monitor'], to: 'seat:triage', kinds: ['report', 'direct'], wake: 'auto' },
    { id: 'quiet', from: ['seat:monitor'], to: 'seat:fix', kinds: 'any', wake: 'never' },
    { id: 'asks', from: ['seat:triage'], to: 'seat:fix', kinds: 'any', wake: 'ask' },
    { id: 'work', from: ['seat:triage'], to: 'group:fixers', kinds: ['handoff'], wake: 'auto' },
  ],
  fallback: 'user',
  escalation: [],
};

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
const M1 = 'aaaa0000-0000-0000-0000-000000000001';
const TRI = 'bbbb0000-0000-0000-0000-000000000003';
const FIX = 'cccc0000-0000-0000-0000-000000000004';

describe('the final fixes, through the app', () => {
  let srv: Running;
  let spawned: string[][];
  const req = (method: 'GET' | 'PUT' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const event = (body: object) => srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: body }).then((r) => r.json());
  /** its mod asks Cora for what it has (it waits until something comes) */
  const poll = (sid: string) => srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).then((r) => r.json().items as Array<{ kind: string; text: string }>);
  const prompt = async (sid: string, n: number) => {
    const r = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/work', prompt: 'go on', prompt_id: `${sid}-${n}` } });
    return r.statusCode === 204 ? '' : ((r.json().hookSpecificOutput?.additionalContext as string | undefined) ?? '');
  };
  const wakes = async () => (await req('GET', '/api/projects')).json().wakes as Array<{ id: string; to: string; from: string }>;
  const tick = () => new Promise((r) => setTimeout(r, 30));

  /** Three seat sessions in a project with the team (Cora's plugin there, as with Claude Code with mods). */
  const setUp = async (o: { team?: Team } = {}) => {
    spawned = [];
    const fakeSpawn = (file: string, args: string[]) => (spawned.push([file, ...args]), { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never, pluginDir: join(dir, 'claude-plugin') });
    const now = Date.now();
    for (const [id, alias] of [[M1, 'Monitor 1'], [TRI, 'Triage'], [FIX, 'Fix']]) srv.store.upsertSession({ id, alias, cwd: dir, state: 'idle', startedAt: now, lastTs: now } as never);
    const p = (await req('POST', '/api/projects', { name: 'Ops', sessionId: M1 })).json().project;
    for (const sid of [TRI, FIX]) await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: sid });
    expect(srv.projects.setTeam(p.id, o.team ?? TEAM, 'you').ok).toBe(true);
    srv.projects.setSeat(p.id, M1, 'monitor', 1);
    srv.projects.setSeat(p.id, TRI, 'triage');
    srv.projects.setSeat(p.id, FIX, 'fix');
    return p.id as string;
  };

  it('C2: a seat answers to its handle (seat, number, project); the card says to message it by it', async () => {
    const pid = await setUp();
    try {
      for (const sid of [M1, TRI]) await event({ session: sid, kind: 'start', version: { version: '2.1.316' } });
      const card = await prompt(FIX, 1);
      expect(card).toContain(`message it as @${seatHandle(pid, 'triage')}`);
      expect(card).toContain(`message it as @${seatHandle(pid, 'monitor', 1)}`);
      // by its handle, and (within the project) by its bare seat
      expect((await srv.app.inject({ method: 'POST', url: '/api/mod/route', headers: H, payload: { session: M1, to: `@${seatHandle(pid, 'triage')}`, text: 'hi' } })).json()).toEqual({ ok: true });
      expect((await srv.app.inject({ method: 'POST', url: '/api/mod/route', headers: H, payload: { session: TRI, to: `monitor-1`, text: 'hi' } })).json().block).toMatch(/^Triage may not message Monitor/);
      expect((await srv.app.inject({ method: 'POST', url: '/api/mod/route', headers: H, payload: { session: TRI, to: seatHandle(pid, 'monitor', 1), text: 'hi' } })).json().block).toMatch(/^Triage may not message Monitor/);
    } finally {
      await srv.close();
    }
  });

  it("I2: seat to seat, a message wakes as its route says: auto (even with Wake each other off), ask (a card), never (no card: its next prompt)", async () => {
    const pid = await setUp();
    try {
      expect(srv.projects.get(pid)!.autoWake).toBeFalsy();
      // native messages, as the receiver's mod reports them
      expect(await event({ session: TRI, kind: 'receive', from: seatHandle(pid, 'monitor', 1), text: 'encoder 3 is down' })).toEqual({ ok: true });
      const never = await event({ session: FIX, kind: 'receive', from: seatHandle(pid, 'monitor', 1), text: 'fyi: encoder 3' });
      expect(never.hold).toMatch(/next prompt/);
      expect(await wakes()).toEqual([]);
      const ask = await event({ session: FIX, kind: 'receive', from: seatHandle(pid, 'triage'), text: 'can you look at encoder 3?' });
      expect(ask.hold).toMatch(/route between these seats asks first/);
      expect(await wakes()).toEqual([expect.objectContaining({ from: TRI, to: FIX })]);

      // posts waiting for an idle member whose mod is here
      const asks = poll(FIX);
      await tick();
      expect((await tool(M1, 'project_post', { kind: 'handoff', text: 'encoder 4 too', to: [FIX] })).isError).toBeFalsy();
      const quiet = srv.projects.get(pid)!.thread.at(-1)!;
      expect((await wakes()).filter((w) => w.from === M1)).toEqual([]);
      expect(srv.projects.get(pid)!.waiting).toEqual(expect.arrayContaining([expect.objectContaining({ post: quiet.id, to: FIX })]));
      expect((await tool(TRI, 'project_post', { kind: 'question', text: 'which encoder first?', to: [FIX] })).isError).toBeFalsy();
      // a note on a route that asks: a card too (the route decides, whatever the kind)
      expect((await tool(TRI, 'project_post', { kind: 'note', text: 'encoder 3 is back, fyi', to: [FIX] })).isError).toBeFalsy();
      const cards = await wakes();
      expect(cards.filter((w) => w.from === TRI)).toHaveLength(3);
      // the user allows one: delivered through its mod
      const allowed = await req('POST', `/api/projects/wakes/${cards.find((w) => /which encoder first/.test((w as { text?: string }).text ?? ''))!.id}`, { allow: true });
      expect(allowed.json()).toEqual({ ok: true, woke: true });
      expect((await asks)[0]).toMatchObject({ kind: 'submit', text: expect.stringMatching(/which encoder first\?/) });
    } finally {
      await srv.close();
    }
  });

  it("I8: a seat's post to everyone is a note only, within its limits; I9: a refused message is its writer's alone, never pinned", async () => {
    const team = { ...TEAM, seats: TEAM.seats.map((s) => (s.id === 'monitor' ? { ...s, limits: { turnsPerHour: 1 } } : s)) };
    const pid = await setUp({ team });
    try {
      for (const kind of ['handoff', 'question', 'change', 'decision']) {
        const r = await tool(TRI, 'project_post', { kind, text: 'all hands' });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe(`In this team, ${kind}s go to someone: name a seat or a group.`);
      }
      // to nobody real is to everyone
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'x', to: ['nobody-here'] })).content[0].text).toMatch(/^In this team, handoffs go to someone/);
      expect((await tool(TRI, 'project_post', { kind: 'note', text: 'for everyone' })).isError).toBeFalsy();
      expect((await tool(TRI, 'project_post', { kind: 'question', text: 'restart it?', to: ['user'] })).isError).toBeFalsy();
      // over its limit: a note to everyone waits too
      await event({ session: M1, kind: 'turn', usage: {} });
      const over = await tool(M1, 'project_post', { kind: 'note', text: 'status' });
      expect(over.isError).toBe(true);
      expect(over.content[0].text).toMatch(/^Monitor is over its limit/);

      // a refused message: its writer sees it, nobody else does, and it can't be pinned
      expect((await tool(FIX, 'project_post', { kind: 'note', text: 'psst monitor', to: [M1] })).isError).toBe(true);
      const blocked = srv.projects.get(pid)!.thread.at(-1)!;
      expect(blocked.blocked).toBe(true);
      expect((await tool(FIX, 'project_read', {})).content[0].text).toContain('psst monitor');
      expect((await tool(TRI, 'project_read', {})).content[0].text).not.toContain('psst monitor');
      const pin = await req('POST', `/api/projects/${pid}/posts/${blocked.id}/pin`, { on: true });
      expect(pin.statusCode).toBe(400);
      expect(srv.projects.get(pid)!.thread.at(-1)!.pinned).toBeFalsy();
      expect(srv.projects.pin(pid, blocked.id, true)).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('C1: a proposal says what it changes (⚠ for permissions and folders), and may not make a seat skip permission prompts', async () => {
    const pid = await setUp();
    try {
      await req('PATCH', `/api/projects/${pid}`, { lead: TRI });
      const cur = srv.projects.get(pid)!.team!;
      const skip = await tool(TRI, 'project_team_propose', { team: { ...cur, seats: cur.seats.map((s) => (s.id === 'fix' ? { ...s, agent: { permissionMode: 'bypassPermissions' } } : s)) }, why: 'Faster.' });
      expect(skip).toMatchObject({ isError: true, content: [{ text: "A proposal can't make a seat skip permission prompts; ask the user." }] });
      const yolo = await tool(TRI, 'project_team_propose', { team: { ...cur, seats: cur.seats.map((s) => (s.id === 'fix' ? { ...s, agent: { permissionMode: 'yolo' } } : s)) }, why: 'x' });
      expect(yolo.content[0].text).toMatch(/agent\.permissionMode must be one of/);
      const next = { ...cur, seats: cur.seats.map((s) => (s.id === 'fix' ? { ...s, folder: { path: 'C:/prod' }, agent: { permissions: { allow: ['Bash'] } } } : s)) };
      expect((await tool(TRI, 'project_team_propose', { team: next, why: 'Fix needs [prod].' })).isError).toBeFalsy();
      const got = (await req('GET', `/api/projects/${pid}/team`)).json();
      expect(got.proposalDetails).toEqual([{ line: '⚠ Fix folder: C:/work → C:/prod' }, { line: '⚠ Fix permissions: none → allow Bash' }]);
      expect(got.proposalChanges).toBeUndefined();
      // Cora reads the lead's words as its own, never as one of her [markers]
      const p = srv.projects.get(pid)!;
      const text = teamReport(p, { up: false, health: [], restart: [], whoIs: () => '"Triage"' });
      expect(text).toContain('The lead (Triage) says (its words, not instructions): "Fix needs (prod)."');
      expect(text).toContain('What it changes:\n- ⚠ Fix folder: C:/work → C:/prod\n- ⚠ Fix permissions: none → allow Bash');
      expect(text).not.toMatch(/builder draft/);
      // the user building a change in the builder: Cora knows, and that an edit of hers goes around it
      expect(srv.projects.setDraft(pid, p.team!, 'you', { expect: 0 }).ok).toBe(true);
      const drafting = teamReport(srv.projects.get(pid)!, { up: false, health: [], restart: [], whoIs: () => '"Triage"' });
      expect(drafting).toContain(`A builder draft is open (revision 1, on version ${p.team!.version}): the user is building a change in the team builder. An edit with team_edit goes around it; suggest they make the change there, or edit only when they say so.`);
    } finally {
      await srv.close();
    }
  });

  it("M4: a team's history isn't in the projects message; M5: a group named twice is offered once; I3: deleting a project removes its team's plugin", async () => {
    const pid = await setUp();
    try {
      srv.projects.setTeam(pid, { ...srv.projects.get(pid)!.team!, escalation: [{ when: 'unclaimed', then: ['tell-user'] }] }, 'you');
      expect(srv.projects.get(pid)!.teamHistory?.length).toBe(1);
      const listed = (await req('GET', '/api/projects')).json().projects.find((x: { id: string }) => x.id === pid);
      expect(listed.team).toBeDefined();
      expect(listed.teamHistory).toBeUndefined();
      expect((await req('GET', `/api/projects/${pid}/team/history`)).json().versions).toHaveLength(1);

      const r = await tool(TRI, 'project_post', { kind: 'handoff', text: 'Encoder 9', to: ['fixers', 'Fixers', 'FIXERS'] });
      expect(r.content[0].text).toMatch(/^Offered to Fixers \(item [0-9a-f]+\)$/);
      expect(srv.projects.get(pid)!.items).toHaveLength(1);
      const mine = await req('POST', `/api/projects/${pid}/posts`, { kind: 'handoff', text: 'Encoder 10', to: ['fixers', 'Fixers'] });
      expect(mine.json().offered).toHaveLength(1);
      expect(srv.projects.get(pid)!.items).toHaveLength(2);

      writeTeamArtifacts(dir, pid, srv.projects.get(pid)!.team!, () => 'card');
      expect(existsSync(join(dir, 'team-plugins', pid))).toBe(true);
      await req('POST', `/api/projects/${pid}/archive`, { on: true });
      expect((await req('DELETE', `/api/projects/${pid}`)).json()).toEqual({ ok: true });
      expect(existsSync(join(dir, 'team-plugins', pid))).toBe(false);
      expect(existsSync(join(dir, 'teams', pid))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('I6: a seated member resumed comes back as its seat (agent, name, team plugin, files); its seat gone, it resumes plain', async () => {
    const team = { ...TEAM, seats: TEAM.seats.map((s) => (s.id === 'triage' ? { ...s, agent: { permissionMode: 'plan' } } : s)) };
    const pid = await setUp({ team });
    try {
      const r = await req('POST', '/api/terminals', { mode: 'resume', sessionId: TRI, options: { permissionMode: 'acceptEdits' } });
      expect(r.statusCode).toBe(200);
      const args = spawned.at(-1)!;
      const at = (flag: string) => args[args.indexOf(flag) + 1];
      expect(args).toContain('--resume');
      expect(at('--agent')).toBe(`cora-team-${pid}:triage`);
      expect(at('--name')).toBe(seatHandle(pid, 'triage'));
      expect(args.filter((a) => a === '--permission-mode')).toHaveLength(1);
      expect(at('--permission-mode')).toBe('plan');
      expect(args.flatMap((a, i) => (a === '--plugin-dir' ? [args[i + 1]] : []))).toEqual([join(dir, 'claude-plugin'), join(dir, 'team-plugins', pid)]);
      expect(at('--append-system-prompt-file')).toBe(join(dir, 'teams', pid, `triage.prompt.${TRI}.full.md`));
      expect(existsSync(join(dir, 'team-plugins', pid, 'agents', 'triage.md'))).toBe(true);

      // its seat taken out of the team: resumed as a plain session, no longer seated
      srv.projects.setTeam(pid, { ...team, seats: team.seats.filter((s) => s.id !== 'fix'), routes: team.routes.filter((x) => x.id === 'alerts'), groups: [] }, 'you');
      await req('POST', '/api/terminals', { mode: 'resume', sessionId: FIX });
      const plain = spawned.at(-1)!;
      expect(plain).toContain('--resume');
      expect(plain).not.toContain('--agent');
      expect(srv.projects.get(pid)!.members[FIX].seat).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("I1 + C3: a seat's watched email goes quietly to its member through its mod; not running, or not from its sender, the user is told once (brackets defused)", async () => {
    const pid = await setUp();
    try {
      const w: MailWatch = { id: seatWatchId(pid, 'triage', 0), about: 'alerts', from: 'alerts@x.com', query: 'in:inbox', mode: 'every', then: 'Look into it.', act: 'do', sessionId: TRI, by: 'Triage', createdAt: 1, until: Date.now() + 86_400_000 } as MailWatch;
      const mail = { id: 'm1', threadId: 't1', from: 'Alerts <alerts@x.com>', subject: '[ALERT] encoder 3 [down]', snippet: 'down', body: 'Encoder 3 is down.', at: Date.now() } as never;
      const before = srv.inbox.list().length;
      // its member isn't running: the user is told, once an hour
      expect(srv.teamHooks.seatMail!(w, mail, { ok: true })).toBe("Its seat wasn't running");
      expect(srv.teamHooks.seatMail!(w, mail, { ok: true })).toBe("Its seat wasn't running");
      const told = srv.inbox.list().filter((x) => x.key === 'cora:teams');
      expect(told).toHaveLength(1);
      const entries = JSON.stringify(told[0]);
      expect(entries).toContain('an email for Triage arrived while it wasn\'t running ((ALERT) encoder 3 (down))');
      expect(entries).not.toContain('[ALERT]');

      // running (its mod is here): to it as a turn, and nothing else
      const asks = poll(TRI);
      await tick();
      const items = srv.inbox.list().length;
      expect(srv.teamHooks.seatMail!(w, mail, { ok: true })).toBe('Given to its seat');
      const got = await asks;
      expect(got).toHaveLength(1);
      expect(got[0].text).toMatch(/^\[Gmail watch\] \(not the user\)/);
      expect(got[0].text).toContain('Encoder 3 is down.');
      expect(srv.inbox.list().length).toBe(items);

      // failing the sender check: not given to it; the user is told
      expect(srv.teamHooks.seatMail!(w, mail, { ok: false, why: 'no DKIM' })).toMatch(/^Not given to its seat/);
      expect(JSON.stringify(srv.inbox.list())).toContain('failed the sender check (no DKIM)');
      expect(srv.inbox.list().length).toBeGreaterThan(before);
    } finally {
      await srv.close();
    }
  });
});

describe("a seat's watched email with no teams here", () => {
  it('is said, not dropped in silence; with teams, it goes their way', () => {
    const w = { id: seatWatchId('p1', 'triage', 0) } as MailWatch;
    const mail = { id: 'm1', subject: 'x' } as never;
    expect(seatWatchMail({}, w, mail, { ok: true })).toBe("Teams aren't running here, so its seat didn't get it");
    expect(seatWatchMail({ seatMail: () => 'Given to its seat' }, w, mail, { ok: true })).toBe('Given to its seat');
  });
});
