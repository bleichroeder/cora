import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routeAllows, type Team } from '@cora/shared';
import { modSource } from '../src/coraPlugin';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { missingFields, parseLabels } from '../src/teamGate';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-gate-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, max = 1) => ({ id, name, instructions: '', agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max }, startup: {} });
const TEAM: Team = {
  version: 1,
  seats: [seat('monitor', 'Monitor', 3), seat('triage', 'Triage'), seat('fix', 'Fix')],
  groups: [],
  labels: [{ id: 'area', name: 'Area', values: ['encoder', 'network'] }],
  routes: [
    { id: 'alerts', from: ['seat:monitor'], to: 'seat:triage', kinds: ['report'], wake: 'auto' },
    { id: 'handoff', from: ['seat:triage'], to: 'seat:fix', kinds: ['handoff'], wake: 'auto', template: { fields: ['issue', 'evidence'] } },
    { id: 'encoder', from: ['seat:monitor'], to: 'seat:fix', kinds: 'any', labels: { area: ['encoder'] }, wake: 'auto' },
  ],
  fallback: 'user',
  escalation: [],
};

describe("the team's fallback, in a refusal", () => {
  it('names where the sender may send it instead (when it may), never where it was going', () => {
    const t: Team = { ...TEAM, fallback: 'seat:triage' };
    // Monitor may report to Triage: a handoff to Fix is refused, and Triage is named (a report is how it reaches it)
    expect(routeAllows(t, 'seat:monitor', 'seat:fix', 'report').ok).toBe(false);
    const r = routeAllows(t, 'seat:monitor', 'seat:fix', 'report');
    expect(!r.ok && r.why).toBe('Monitor may not message Fix this way (kind or labels do not match a route). It may message Triage, Fix. Send it to Triage instead.');
    // a kind the fallback's route doesn't carry: not named
    const q = routeAllows(t, 'seat:monitor', 'seat:fix', 'question');
    expect(!q.ok && q.why).not.toMatch(/instead/);
    // Fix may message nobody: refused to Triage (the fallback itself), nothing named
    const f = routeAllows(t, 'seat:fix', 'seat:triage', 'note');
    expect(!f.ok && f.why).toBe('Fix may not message Triage. It has no routes.');
    // the user as the fallback: anyone may reach the user
    const u = routeAllows(TEAM, 'seat:fix', 'seat:monitor', 'note');
    expect(!u.ok && u.why).toBe('Fix may not message Monitor. It has no routes. Send it to the user instead.');
  });
});

describe('the gate’s parts', () => {
  it('labels come from a leading [labels: ...] line', () => {
    expect(parseLabels('[labels: issue=encoder, area = network]\nthe feed froze')).toEqual({ issue: 'encoder', area: 'network' });
    expect(parseLabels('\n  [Labels: area=encoder]\nx')).toEqual({ area: 'encoder' });
    expect(parseLabels('the feed froze\n[labels: area=encoder]')).toBeUndefined();
    expect(parseLabels('no labels')).toBeUndefined();
  });

  it('a template field is there as a heading or as "field:" at a line start', () => {
    expect(missingFields(['issue', 'evidence'], '## Issue\nencoder down\n\nEvidence: the log')).toEqual([]);
    expect(missingFields(['issue', 'evidence'], '# ISSUE\nx\n**Evidence:** y')).toEqual([]);
    expect(missingFields(['issue', 'evidence'], 'Issue: encoder\nno evidence here, the evidence: none')).toEqual(['evidence']);
    expect(missingFields(['issue', 'evidence'], '### issue notes\nx')).toEqual(['issue', 'evidence']);
  });
});

describe('the mod', () => {
  /** The mod's session.send hook, run with a stand-in for Claude Code's `$` (its fetch as given). */
  const sendHook = (fetch: (url: string, init: { body: string }) => Promise<{ ok: boolean; text: string }>) => {
    const src = modSource('http://127.0.0.1:1', 'tok').replace('export function register', 'function register');
    const register = new Function(`${src}\nreturn register`)() as (on: unknown) => void;
    const hooks: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    register((name: string, fn: (...a: unknown[]) => Promise<unknown>) => ((hooks[name] = fn), { catch: () => {} }));
    const calls: string[] = [];
    // Claude Code's $ always has a clock (its wait never ends here: Cora answers first)
    const $ = { session: { id: async () => 'sid-1' }, clock: { sleep: () => new Promise<void>(() => {}) }, http: { fetch: async (url: string, init: { body: string }) => (calls.push(url), fetch(url, init)) } };
    const e = { to: 'triage', text: 'hi', origin: { kind: 'model' } };
    return { calls, run: () => hooks['session.send']($, e, async (x: unknown) => ({ passed: x })) };
  };

  it('refuses a send Cora blocks, with Cora’s reason', async () => {
    const h = sendHook(async (url) => ({ ok: true, text: url.endsWith('/api/mod/route') ? JSON.stringify({ block: 'Monitor may not message Monitor.' }) : '{}' }));
    expect(await h.run()).toEqual({ isDelivered: false, reason: 'Monitor may not message Monitor.' });
    expect(h.calls).toEqual(['http://127.0.0.1:1/api/mod/route']);
  });

  it('a Cora that never answers lets it through after its wait (about 3 seconds): it fails open, never closed', async () => {
    const src = modSource('http://127.0.0.1:1', 'tok').replace('export function register', 'function register');
    const register = new Function(`${src}\nreturn register`)() as (on: unknown) => void;
    const hooks: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    register((name: string, fn: (...a: unknown[]) => Promise<unknown>) => ((hooks[name] = fn), { catch: () => {} }));
    const slept: number[] = [];
    const $ = {
      session: { id: async () => 'sid-1' },
      clock: { sleep: async (ms: number) => void slept.push(ms) },
      // the route check hangs; the report after it answers
      http: { fetch: (url: string) => (url.endsWith('/api/mod/route') ? new Promise(() => {}) : Promise.resolve({ ok: true, text: '{}' })) },
    };
    expect(await hooks['session.send']($, { to: 'triage', text: 'hi' }, async (x: unknown) => ({ passed: x }))).toMatchObject({ passed: { to: 'triage' } });
    expect(slept).toEqual([3000]);
  });

  it('a message that went unchecked (no answer in time, a refusal of the check itself) is reported to Cora, to log', async () => {
    const src = modSource('http://127.0.0.1:1', 'tok').replace('export function register', 'function register');
    const register = new Function(`${src}\nreturn register`)() as (on: unknown) => void;
    const hooks: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
    register((name: string, fn: (...a: unknown[]) => Promise<unknown>) => ((hooks[name] = fn), { catch: () => {} }));
    const sent = (route: (url: string) => Promise<{ ok: boolean; text: string }>) => {
      const events: Array<Record<string, unknown>> = [];
      const $ = {
        session: { id: async () => 'sid-1' },
        clock: { sleep: async () => {} },
        http: { fetch: (url: string, init: { body: string }) => (url.endsWith('/api/mod/route') ? route(url) : (events.push(JSON.parse(init.body)), Promise.resolve({ ok: true, text: '{}' }))) },
      };
      return { events, go: () => hooks['session.send']($, { to: 'triage', text: 'hi' }, async (x: unknown) => ({ passed: x })) };
    };
    const late = sent(() => new Promise(() => {}));
    await late.go();
    expect(late.events.map((e) => [e.kind, e.why])).toEqual([['unchecked', 'no answer in 3 seconds'], ['send', undefined]]);
    const sick = sent(async () => ({ ok: false, text: 'oops' }));
    await sick.go();
    expect(sick.events[0]).toMatchObject({ kind: 'unchecked', why: "Cora couldn't check it" });
    const fine = sent(async () => ({ ok: true, text: '{"ok":true}' }));
    await fine.go();
    expect(fine.events.map((e) => e.kind)).toEqual(['send']);
    // a Cora that hangs: one report of it on its way at a time, not one more per message
    const hung: string[] = [];
    const $hung = { session: { id: async () => 'sid-1' }, clock: { sleep: async () => {} }, http: { fetch: (url: string, init: { body: string }) => (hung.push(JSON.parse(init.body).kind), new Promise(() => {})) } };
    for (let k = 0; k < 3; k++) await hooks['session.send']($hung, { to: 'triage', text: 'hi' }, async (x: unknown) => ({ passed: x }));
    expect(hung.filter((k) => k === 'unchecked')).toHaveLength(1);
  });

  it('lets it through when Cora allows it (and reports it), or is gone (fails open)', async () => {
    const ok = sendHook(async () => ({ ok: true, text: '{"ok":true}' }));
    expect(await ok.run()).toMatchObject({ passed: { to: 'triage' } });
    await new Promise((r) => setTimeout(r, 0));
    expect(ok.calls).toEqual(['http://127.0.0.1:1/api/mod/route', 'http://127.0.0.1:1/api/mod/event']);
    const gone = sendHook(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await gone.run()).toMatchObject({ passed: { to: 'triage' } });
    const sick = sendHook(async () => ({ ok: false, text: 'oops' }));
    expect(await sick.run()).toMatchObject({ passed: { to: 'triage' } });
    expect(modSource('u', 't')).toMatch(/on\('session\.send'[\s\S]*\.catch\(async \(\$, e, next\) => next\(e\)\)/);
  });
});

describe('routes enforced', () => {
  let srv: Running;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
  const M1 = 'aaaa0000-0000-0000-0000-000000000001';
  const M2 = 'aaaa0000-0000-0000-0000-000000000002';
  const TRI = 'bbbb0000-0000-0000-0000-000000000003';
  const FIX = 'cccc0000-0000-0000-0000-000000000004';
  const route = (body: object, headers: object = H) => srv.app.inject({ method: 'POST', url: '/api/mod/route', headers: headers as never, payload: body });
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const thread = () => srv.projects.list()[0].thread;
  const prompt = async (sid: string, n: number) => {
    const r = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/work', prompt: 'go on', prompt_id: `${sid}-${n}` } });
    return r.statusCode === 204 ? '' : ((r.json().hookSpecificOutput?.additionalContext as string | undefined) ?? '');
  };

  /** A project of four seat sessions, with the team or without. */
  const setUp = async (team = true) => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const now = Date.now();
    for (const [id, alias] of [[M1, 'Monitor 1'], [M2, 'Monitor 2'], [TRI, 'Triage'], [FIX, 'Fix']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work', state: 'idle', startedAt: now, lastTs: now } as never);
    const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Ops', sessionId: M1 } })).json().project;
    for (const sid of [M2, TRI, FIX]) await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: sid } });
    if (team) {
      expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
      srv.projects.setSeat(p.id, M1, 'monitor', 1);
      srv.projects.setSeat(p.id, M2, 'monitor', 2);
      srv.projects.setSeat(p.id, TRI, 'triage');
      srv.projects.setSeat(p.id, FIX, 'fix');
    }
    return p.id as string;
  };

  it('a message a mod let through unchecked is logged (never its text)', async () => {
    await setUp();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: { session: M1, kind: 'unchecked', why: 'no answer in 3 seconds', to: 'triage' } });
      expect(log.mock.calls.map((c) => String(c[0]))).toContainEqual(expect.stringMatching(/aaaa0000.* a message to triage went without its route check \(no answer in 3 seconds\)/));
      // one line in the log, whatever the reason holds
      log.mockClear();
      await srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: { session: M1, kind: 'unchecked', why: 'socket hang up\nfake line', to: 'tri\nage' } });
      const line = String(log.mock.calls.at(-1)![0]);
      expect(line).not.toContain('\n');
      expect(line).toContain('(socket hang up fake line)');
    } finally {
      log.mockRestore();
      await srv.close();
    }
  });

  it('a native message on no route is refused with who it may message, kept as a quiet blocked line, and is nobody’s news', async () => {
    await setUp();
    try {
      expect((await route({ session: M1, to: 'monitor-2', text: 'hi' }, { 'content-type': 'application/json' })).statusCode).toBe(401);
      const r = (await route({ session: M1, to: '@monitor-2', text: 'are you seeing this too?', origin: { kind: 'model' } })).json();
      expect(r).toEqual({ block: 'Monitor may not message Monitor. It may message Triage, Fix. Send it to the user instead.' });
      expect(thread().at(-1)).toMatchObject({ by: M1, to: [M2], kind: 'note', text: 'are you seeing this too?', blocked: true });
      expect(await prompt(M2, 1)).not.toMatch(/are you seeing this too/);
      // a direct message to triage: monitor's route there is for reports only
      expect((await route({ session: M1, to: 'triage', text: 'hello' })).json().block).toMatch(/^Monitor may not message Triage this way/);
    } finally {
      await srv.close();
    }
  });

  it('a seat answers to its name (S, or S-n in a pool); labels open a labelled route', async () => {
    await setUp();
    try {
      // fix takes anything labelled area=encoder from monitor
      expect((await route({ session: M2, to: 'fix', text: '[labels: area=encoder]\nencoder 3 is down' })).json()).toEqual({ ok: true });
      expect((await route({ session: M2, to: 'fix [abc]', text: 'encoder 3 is down' })).json().block).toMatch(/Monitor may not message Fix this way/);
      expect((await route({ session: M2, to: 'fix', text: '[labels: area=network]\nlink down' })).json().block).toBeDefined();
    } finally {
      await srv.close();
    }
  });

  it('a route with a template bounces a message missing a field, naming it', async () => {
    await setUp();
    try {
      // a native message is 'direct': triage's route to fix is for handoffs; posted as a handoff, the template applies
      const bounced = await tool(TRI, 'project_post', { kind: 'handoff', text: '## Issue\nencoder 3 is down', to: [FIX] });
      expect(bounced.isError).toBe(true);
      expect(bounced.content[0].text).toBe('This route needs: evidence.');
      expect(thread().at(-1)).toMatchObject({ by: TRI, to: [FIX], blocked: true, kind: 'note' });
      const ok = await tool(TRI, 'project_post', { kind: 'handoff', text: '## Issue\nencoder 3 is down\nEvidence: the log', to: [FIX] });
      expect(ok.isError).toBeFalsy();
      expect(thread().at(-1)).toMatchObject({ kind: 'handoff', to: [FIX] });
      expect(thread().at(-1)?.blocked).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it('project_post: a report to triage goes; to another monitor it is refused with the same text; to the user or to all, always', async () => {
    await setUp();
    try {
      expect((await tool(M1, 'project_post', { kind: 'report', text: 'encoder 3 down', to: [TRI] })).isError).toBeFalsy();
      expect(thread().at(-1)).toMatchObject({ kind: 'report', by: M1, to: [TRI] });
      const no = await tool(M1, 'project_post', { kind: 'note', text: 'psst', to: [M2] });
      expect(no.isError).toBe(true);
      expect(no.content[0].text).toBe('Monitor may not message Monitor. It may message Triage, Fix. Send it to the user instead.');
      expect((await tool(M1, 'project_post', { kind: 'question', text: 'restart it?', to: ['user'] })).isError).toBeFalsy();
      expect((await tool(M1, 'project_post', { kind: 'note', text: 'for everyone' })).isError).toBeFalsy();
      // labels as an input: they open the labelled route, and the post keeps them
      expect((await tool(M1, 'project_post', { kind: 'note', text: 'encoder 3', to: [FIX], labels: { area: 'encoder' } })).isError).toBeFalsy();
      expect(thread().at(-1)).toMatchObject({ to: [FIX], labels: { area: 'encoder' } });
    } finally {
      await srv.close();
    }
  });

  it('project_item: opening an incident owned by another member is a handoff to it', async () => {
    await setUp();
    try {
      const no = await tool(M1, 'project_item', { kind: 'incident', title: 'encoder 3', owner: M2 });
      expect(no.isError).toBe(true);
      expect(no.content[0].text).toMatch(/^Monitor may not message Monitor this way|^Monitor may not message Monitor\./);
      expect(srv.projects.list()[0].items ?? []).toHaveLength(0);
      // triage hands fix an incident with the template's fields
      expect((await tool(TRI, 'project_item', { kind: 'incident', title: 'encoder 3', owner: FIX, next: 'Issue: frozen\nEvidence: thumbnails' })).isError).toBeFalsy();
      // owning it yourself, or no owner: nothing to check
      expect((await tool(M1, 'project_item', { kind: 'incident', title: 'encoder 4' })).isError).toBeFalsy();
      expect((await tool(M1, 'project_item', { kind: 'incident', title: 'encoder 5', owner: M1 })).isError).toBeFalsy();
    } finally {
      await srv.close();
    }
  });

  it('without a team, or from a session outside a project, it is not Cora’s to judge', async () => {
    await setUp(false);
    try {
      expect((await route({ session: M1, to: 'monitor-2', text: 'hi' })).json()).toEqual({ ok: true });
      expect((await tool(M1, 'project_post', { kind: 'note', text: 'hi', to: [M2] })).isError).toBeFalsy();
      expect((await route({ session: M1, to: 'someone-else-1234', text: 'hi' })).json()).toEqual({ ok: true });
      expect((await route({ session: 'nobody', to: 'triage', text: 'hi' })).json()).toEqual({ ok: true });
      expect(thread().some((x) => x.blocked)).toBe(false);
    } finally {
      await srv.close();
    }
  });
});
