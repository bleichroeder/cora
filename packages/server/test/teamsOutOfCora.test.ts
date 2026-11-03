import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Team } from '@cora/shared';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { Hub } from '../src/hub';
import { Inbox } from '../src/inbox';
import { EventFeed } from '../src/orchestrator/feed';
import { projectCard } from '../src/projectCard';
import { startServer, type Running } from '../src/server';

/**
 * A team is its design, and Cora (the orchestrator agent) isn't in it: nothing a team project does reaches her feed.
 * What's for the user reaches them itself (their Inbox). A project without a team keeps Cora posted as before.
 */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-out-of-teams-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const ENG = 'eeee0000-0000-0000-0000-000000000001';
const REV = 'rrrr0000-0000-0000-0000-000000000002';
const seat = (id: string, name: string) => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 1, max: 1 }, startup: {} });
const TEAM: Team = {
  version: 0,
  seats: [seat('eng', 'Engineer'), seat('rev', 'Reviewer')],
  groups: [],
  labels: [],
  routes: [
    { id: 'r1', from: ['seat:eng'], to: 'seat:rev', kinds: ['handoff', 'question'], wake: 'never' },
    { id: 'r2', from: ['seat:eng', 'seat:rev'], to: 'user', kinds: 'any', wake: 'never' },
  ],
  fallback: 'user',
  escalation: [],
};

/** Any method, any depth: what the app asks of Cora's agent that these tests don't watch. */
const anything = (): any => new Proxy(function () {}, { get: (_t, k) => (k === 'then' ? undefined : anything()), apply: () => undefined });

describe("a team project and Cora's feed", () => {
  let srv: Running;
  let app: FastifyInstance;
  let notes: string[];
  let inbox: Inbox;
  afterEach(async () => {
    await app?.close();
    await srv?.close();
  });

  /** An app whose Cora's agent is on and keeps what's noted to her feed; two sessions in a project, seated or not. */
  async function setup(team: boolean) {
    const cfg = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') });
    srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false });
    notes = [];
    // (a clock that always moves: what came after you read it is after, even within a millisecond)
    let tick = Date.now();
    inbox = new Inbox({ now: () => ++tick });
    const known = { status: () => ({ enabled: true }), isAgent: () => false, ignores: () => false, feed: new Proxy({ note: (line: string) => void notes.push(line) }, { get: (t, k) => (k in t ? (t as any)[k] : anything()) }) };
    const orchestrator = new Proxy(known, { get: (t, k) => (k in t ? (t as any)[k] : anything()) });
    app = await buildApp({ config: cfg, store: srv.store, hub: new Hub(srv.store, () => [], 50, () => []), pipeline: srv.pipeline, pending: srv.pending, projects: srv.projects, inbox, orchestrator: orchestrator as never });
    const now = Date.now();
    for (const [id, alias] of [[ENG, 'Engineer'], [REV, 'Reviewer']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'working', startedAt: now, lastTs: now } as never);
    const p = srv.projects.create('Ops');
    srv.projects.add(p.id, ENG);
    srv.projects.add(p.id, REV);
    srv.projects.update(p.id, { coordination: true });
    if (team) {
      expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
      srv.projects.setSeat(p.id, ENG, 'eng');
      srv.projects.setSeat(p.id, REV, 'rev');
    }
    return p.id;
  }
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const post = async (sid: string, args: object) => {
    const r = (await app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc('project_post', args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError, r.content?.[0]?.text).toBeFalsy();
  };
  const teamEntries = (pid: string) => inbox.list().find((i) => i.key === `cora:team:${pid}`)?.entries ?? [];

  it("its handoffs, questions and posts to the user never reach Cora's feed; what's for the user is in their Inbox", async () => {
    const pid = await setup(true);
    await post(ENG, { kind: 'handoff', text: 'branch: fix/x\ncommits: abc123\nyour turn', to: [REV] });
    await post(ENG, { kind: 'question', text: 'which branch?', to: [REV] });
    await post(REV, { kind: 'question', text: 'May I merge fix/x?', to: ['user'] });
    await post(ENG, { kind: 'handoff', text: 'done, over to you', to: ['user'] });
    expect(notes).toEqual([]);
    const entries = teamEntries(pid);
    expect(entries.map((e) => [e.who, e.text])).toEqual(
      expect.arrayContaining([
        [expect.stringContaining('Reviewer'), 'May I merge fix/x?'],
        [expect.stringContaining('Engineer'), 'done, over to you'],
      ]),
    );
    // only what's for the user: none of the seats' posts to each other
    expect(entries).toHaveLength(2);
    expect(inbox.list().find((i) => i.key === `cora:team:${pid}`)).toMatchObject({ source: 'cora', title: 'Ops · your team' });
  });

  it("its Inbox item's reason covers what's in it you haven't read, not only the latest", async () => {
    const pid = await setup(true);
    const why = () => inbox.list().find((i) => i.key === `cora:team:${pid}`)!.why;
    await post(REV, { kind: 'question', text: 'May I merge fix/x?', to: ['user'] });
    expect(why()).toBe('a question for you');
    await post(ENG, { kind: 'handoff', text: 'done, over to you', to: ['user'] });
    expect(why()).toBe('a question and a handoff for you');
    await post(ENG, { kind: 'question', text: 'and fix/y?', to: ['user'] });
    expect(why()).toBe('two questions and a handoff for you');
    // read: what comes next is all that's new
    inbox.read({ keys: [`cora:team:${pid}`] });
    await post(ENG, { kind: 'handoff', text: 'fix/y too', to: ['user'] });
    expect(why()).toBe('handed to you');
  });

    it('a project without a team keeps Cora posted as before (and puts nothing in the Inbox itself)', async () => {
    const pid = await setup(false);
    await post(ENG, { kind: 'handoff', text: 'your turn', to: [REV] });
    await post(REV, { kind: 'question', text: 'May I merge?', to: ['user'] });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toMatch(/^\[Project "Ops"\] .* \(handoff, post \w+\): your turn$/);
    expect(notes[1]).toMatch(/→ the user \(question, post \w+\): May I merge\?$/);
    expect(teamEntries(pid)).toEqual([]);
  });

  it("a team's alerts (teamTell) go to the Inbox, never Cora's feed", async () => {
    const pid = await setup(true);
    // a seat in its quiet hours (now, whenever now is): its messages are refused, and the user is told (teamTell)
    const hm = (ms: number) => {
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    const quiet = { from: hm(Date.now() - 60 * 60_000), to: hm(Date.now() + 60 * 60_000) };
    expect(srv.projects.setTeam(pid, { ...TEAM, seats: TEAM.seats.map((s) => (s.id === 'eng' ? { ...s, limits: { quiet } } : s)) }, 'you').ok).toBe(true);
    const r = (await app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': ENG, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc('project_post', { kind: 'handoff', text: 'branch: b\ncommits: c', to: [REV] }) })).json().result;
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/quiet hours/);
    const teams = inbox.list().find((i) => i.key === 'cora:teams');
    expect(teams).toMatchObject({ source: 'cora', title: 'Your teams' });
    expect(teams!.entries.map((e) => e.text)).toEqual([expect.stringMatching(/^Ops: Engineer's messages to other seats are refused for now: Engineer is in its quiet hours/)]);
    expect(notes).toEqual([]);
  });

  it("the card tells a team's members a post to the user reaches them on the board, not through Cora", async () => {
    const pid = await setup(true);
    const card = (sid: string) => projectCard(srv.projects.get(pid)!, sid, (x) => ({ name: x, state: 'idle' }), (x) => x, true);
    expect(card(ENG)).toContain("To reach the user: to: [user] (it shows on the board and in the user's Needs you).");
    expect(card(ENG)).not.toContain('Cora tells them');
  });

  it('a project without a team still says Cora tells them', async () => {
    const pid = await setup(false);
    expect(projectCard(srv.projects.get(pid)!, ENG, (x) => ({ name: x, state: 'idle' }), (x) => x, true)).toContain('To reach the user: to: [user] (Cora tells them).');
  });
});

describe("a team seat's own activity and Cora's feed (EventFeed)", () => {
  it("a seat's failures, stalls and waiting prompts aren't Cora's news; another session's still are", () => {
    const pushed: string[] = [];
    let now = 1_000_000;
    const feed = new EventFeed({ deliver: (t) => (pushed.push(t), true), agentBusy: () => false, mode: () => 'important', isWorker: () => false, isAgent: () => false, inTeam: (sid) => sid === 'seat', name: (sid) => sid, now: () => now, flushMs: 0 });
    for (const sid of ['seat', 'mine'])
      for (let i = 0; i < 5; i++) feed.event({ id: `${sid}-${i}`, sessionId: sid, agentId: 'main', kind: 'tool', phase: 'end', ts: now, tool: { name: 'Bash', failed: true, summary: 'npm test', resultSummary: 'exit 1' } } as never);
    feed.pending([{ id: 'p1', sessionId: 'seat', toolName: 'Bash', toolInput: { command: 'ls' }, kind: 'permission', createdAt: now - 60 * 60_000 } as never, { id: 'p2', sessionId: 'mine', toolName: 'Bash', toolInput: { command: 'ls' }, kind: 'permission', createdAt: now - 60 * 60_000 } as never], new Map());
    now += 1000;
    feed.tick();
    const said = pushed.join('\n');
    expect(said).toContain('"mine"');
    expect(said).not.toContain('"seat"');
  });
});
