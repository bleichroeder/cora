import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seatHandle, type Seat, type Team } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/**
 * Wake rails (the user's decision, task 95f3ec1d): a team has none (its routes decide; its seats' own limits hold it
 * back), and information never wakes its members; a project without a team keeps a limit you set (6 an hour unless you
 * say otherwise, or none).
 */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-wake-rails-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (id: string, name: string, o: Partial<Seat> = {}): Seat => ({ id, name, instructions: `Be ${id}.`, agent: {}, skills: [], folder: { path: 'C:/work' }, count: { min: 0, max: 1 }, startup: {}, ...o });
const TEAM: Team = {
  version: 0,
  seats: [seat('triage', 'Triage'), seat('fix', 'Fix'), seat('qa', 'QA')],
  groups: [],
  labels: [],
  routes: [
    { id: 'work', from: ['seat:triage'], to: 'seat:fix', kinds: ['handoff', 'note', 'report'], wake: 'auto' },
    { id: 'back', from: ['seat:fix'], to: 'seat:triage', kinds: 'any', wake: 'auto' },
    { id: 'qa', from: ['seat:triage'], to: 'seat:qa', kinds: ['handoff'], wake: 'never' },
  ],
  fallback: 'user',
  escalation: [],
};

const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
const LEAD = 'dddd0000-0000-0000-0000-000000000001';
const TRI = 'bbbb0000-0000-0000-0000-000000000003';
const FIX = 'cccc0000-0000-0000-0000-000000000004';
const OTHER = 'eeee0000-0000-0000-0000-000000000005';

describe('wake rails', () => {
  let srv: Running;
  const req = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const tool = async (sid: string, name: string, args: object) =>
    (await srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) })).json().result as { isError?: boolean; content: Array<{ text: string }> };
  const event = (body: object) => srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: H, payload: body }).then((r) => r.json());
  /** its mod asks Cora for what it has (it waits until something comes): it's live here */
  const poll = (sid: string) => void srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).catch(() => undefined);
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const wakes = async () => (await req('GET', '/api/projects')).json().wakes as Array<{ id: string; to: string; from: string; post?: string }>;
  const idle = (...ids: string[]) => ids.forEach((id) => srv.store.upsertSession({ id, state: 'idle' } as never));
  beforeEach(async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const now = Date.now();
    for (const [id, alias] of [[LEAD, 'Lead'], [TRI, 'Triage'], [FIX, 'Fix'], [OTHER, 'Other']]) srv.store.upsertSession({ id, alias, cwd: dir, state: 'idle', startedAt: now, lastTs: now } as never);
  });
  afterEach(async () => srv.close());

  /** A team project (Wake each other on, as Cora Development's is); Fix's mod is here and it's idle. */
  const team = async () => {
    const p = (await req('POST', '/api/projects', { name: 'Dev', sessionId: LEAD })).json().project;
    for (const sid of [TRI, FIX]) await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: sid });
    await req('PATCH', `/api/projects/${p.id}`, { autoWake: true });
    expect(srv.projects.setTeam(p.id, TEAM, 'you').ok).toBe(true);
    srv.projects.setSeat(p.id, TRI, 'triage');
    srv.projects.setSeat(p.id, FIX, 'fix');
    await event({ session: FIX, kind: 'start', version: { version: '2.1.316' } });
    poll(FIX);
    await tick();
    return p.id as string;
  };

  it("a team: a busy hour of handoffs on a route that wakes on its own all wake its member, never a card", async () => {
    const pid = await team();
    for (let i = 1; i <= 9; i++) {
      idle(FIX);
      expect((await tool(TRI, 'project_post', { kind: 'handoff', text: `encoder ${i} is yours`, to: [FIX] })).isError).toBeFalsy();
    }
    const handoffs = srv.projects.get(pid)!.thread.filter((x) => x.kind === 'handoff');
    expect(handoffs).toHaveLength(9);
    expect(handoffs.every((x) => x.deliveredTo?.includes(FIX))).toBe(true);
    expect(await wakes()).toEqual([]);
    expect(srv.projects.get(pid)!.waiting ?? []).toEqual([]);
    // native messages too (the mod's path): well past six, none held
    for (let i = 1; i <= 8; i++) {
      idle(FIX);
      expect(await event({ session: FIX, kind: 'receive', from: seatHandle(pid, 'triage'), text: `ping ${i}` })).not.toHaveProperty('hold');
    }
  });

  it("a team: a note, a note on its item (\"Noted on …\"), or the lead's note, to an idle member wakes nobody and makes no card (its next prompt has it)", async () => {
    const pid = await team();
    // an incident of Fix's (handed over: it wakes Fix, below), then notes about it
    expect((await tool(TRI, 'project_item', { kind: 'incident', title: 'Encoder 3 down', severity: 'high', owner: FIX, next: 'look at it' })).isError).toBeFalsy();
    const item = srv.projects.get(pid)!.items!.at(-1)!.id;
    idle(FIX);
    expect((await tool(TRI, 'project_post', { kind: 'note', text: 'fyi: encoder 3 is flaky', to: [FIX] })).isError).toBeFalsy();
    const note = srv.projects.get(pid)!.thread.at(-1)!;
    expect((await tool(TRI, 'project_annotate', { item, text: 'its PSU fan is loud too' })).isError).toBeFalsy();
    const noted = srv.projects.get(pid)!.thread.at(-1)!;
    expect(noted).toMatchObject({ kind: 'report', item, ping: 'note', to: [FIX], text: expect.stringMatching(/^Noted on "Encoder 3 down"/) });
    // the lead (no seat) broadcasting a note to it: the same
    expect((await tool(LEAD, 'project_post', { kind: 'note', text: 'remember the release', to: [FIX] })).isError).toBeFalsy();
    const lead = srv.projects.get(pid)!.thread.at(-1)!;
    for (const x of [note, noted, lead]) {
      expect(x.deliveredAt ?? x.deliveredTo).toBeUndefined();
      expect((srv.projects.get(pid)!.waiting ?? []).some((w) => w.post === x.id)).toBe(false);
    }
    expect(await wakes()).toEqual([]);
  });

  it("what didn't wake it isn't lost: the prompt the next wake starts has it (To you), and not the wake's own post again", async () => {
    const pid = await team();
    expect((await tool(TRI, 'project_item', { kind: 'incident', title: 'Encoder 7 down', severity: 'low', owner: FIX })).isError).toBeFalsy();
    const item = srv.projects.get(pid)!.items!.at(-1)!.id;
    // Fix takes the assignment's turn (its prompt: it has heard up to here)
    const prompt = async (n: number) =>
      (await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: FIX, cwd: dir, prompt: 'go on', prompt_id: `${FIX}-${n}` } }).then((r) => (r.body ? r.json() : {})))?.hookSpecificOutput?.additionalContext as string | undefined;
    await prompt(1);
    idle(FIX);
    const heard = srv.projects.get(pid)!.members[FIX].heardTo;
    // a note and a note on its item: neither wakes it
    await tool(TRI, 'project_post', { kind: 'note', text: 'E2E-NOTE: encoder 7 runs hot', to: [FIX] });
    await tool(TRI, 'project_annotate', { item, text: 'E2E-ANNOTATION: fan replaced' });
    expect(srv.projects.get(pid)!.members[FIX].heardTo).toBe(heard);
    // a handoff wakes it: what it carried is delivered, but what it hasn't heard stays unheard
    await new Promise((r) => setTimeout(r, 5));
    expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'E2E-HANDOFF: encoder 8 is yours', to: [FIX] })).isError).toBeFalsy();
    const handoff = srv.projects.get(pid)!.thread.at(-1)!;
    expect(handoff.deliveredTo).toEqual([FIX]);
    expect(srv.projects.get(pid)!.members[FIX].heardTo).toBe(heard);
    expect(srv.projects.get(pid)!.waiting ?? []).toEqual([]);
    // the prompt that wake starts: the note and the note on its item, to it; the handoff it already has
    const news = (await prompt(2)) ?? '';
    expect(news).toMatch(/To you:[\s\S]*E2E-NOTE: encoder 7 runs hot/);
    expect(news).toMatch(/Noted on "Encoder 7 down": E2E-ANNOTATION: fan replaced/);
    expect(news).not.toMatch(/E2E-HANDOFF/);
    // and once heard, not again
    expect((await prompt(3)) ?? '').not.toMatch(/E2E-NOTE/);
  });

  it("a post to two members: the wake that carries it to one is that one's; the other, not woken, still hears it at its next prompt", async () => {
    const pid = await team();
    await req('POST', `/api/projects/${pid}/sessions`, { sessionId: OTHER });
    srv.projects.setSeat(pid, OTHER, 'qa');
    const prompt = async (sid: string, n: number) =>
      (await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: dir, prompt: 'go on', prompt_id: `${sid}-${n}` } }).then((r) => (r.body ? r.json() : {})))?.hookSpecificOutput?.additionalContext as string | undefined;
    // both have heard the project so far
    await prompt(FIX, 1);
    await prompt(OTHER, 1);
    idle(FIX, OTHER);
    await new Promise((r) => setTimeout(r, 5));
    // to Fix (its route wakes) and QA (its route never does)
    expect((await tool(TRI, 'project_post', { kind: 'handoff', text: 'E2E-BOTH: encoder 9 for you two', to: [FIX, OTHER] })).isError).toBeFalsy();
    const post = srv.projects.get(pid)!.thread.at(-1)!;
    expect(post.deliveredTo).toEqual([FIX]);
    expect(post.deliveredAt).toBeUndefined();
    expect(await wakes()).toEqual([]);
    // QA's next prompt has it; Fix's (the one its wake started) doesn't say it again
    expect((await prompt(OTHER, 2)) ?? '').toMatch(/To you:[\s\S]*E2E-BOTH: encoder 9 for you two/);
    expect((await prompt(FIX, 2)) ?? '').not.toMatch(/E2E-BOTH/);
  });

  it('a team: work handed over wakes its idle member as a handoff does: an item assigned or reassigned to it, or an alert report', async () => {
    const pid = await team();
    // assigned: an incident opened for Fix
    expect((await tool(TRI, 'project_item', { kind: 'incident', title: 'Encoder 4 down', severity: 'high', owner: FIX })).isError).toBeFalsy();
    const assigned = srv.projects.get(pid)!.thread.at(-1)!;
    expect(assigned).toMatchObject({ kind: 'report', ping: 'assign', to: [FIX], text: expect.stringMatching(/^Assigned you "Encoder 4 down"/) });
    expect(assigned.deliveredTo).toEqual([FIX]);
    // reassigned: one Triage held, given to Fix
    idle(FIX);
    expect((await tool(TRI, 'project_item', { kind: 'incident', title: 'Encoder 6 down', severity: 'low', owner: TRI })).isError).toBeFalsy();
    const mine = srv.projects.get(pid)!.items!.at(-1)!.id;
    expect((await tool(TRI, 'project_item', { item: mine, owner: FIX })).isError).toBeFalsy();
    const reassigned = srv.projects.get(pid)!.thread.at(-1)!;
    expect(reassigned).toMatchObject({ kind: 'report', ping: 'assign', to: [FIX], text: expect.stringMatching(/^Reassigned you "Encoder 6 down"/) });
    expect(reassigned.deliveredTo).toEqual([FIX]);
    // a report that isn't about an item (an alert) wakes as its route says
    idle(FIX);
    expect((await tool(TRI, 'project_post', { kind: 'report', text: 'Encoder 5: CRITICAL', to: [FIX] })).isError).toBeFalsy();
    expect(srv.projects.get(pid)!.thread.at(-1)!.deliveredTo).toEqual([FIX]);
    expect(await wakes()).toEqual([]);
  });

  /** A project without a team, Wake each other on; `limit`: its wake limit. */
  const loose = async (limit?: number | 'none') => {
    const p = (await req('POST', '/api/projects', { name: 'Loose', sessionId: FIX })).json().project;
    for (const sid of [TRI, LEAD, OTHER]) await req('POST', `/api/projects/${p.id}/sessions`, { sessionId: sid });
    await req('PATCH', `/api/projects/${p.id}`, { autoWake: true, ...(limit !== undefined ? { wakeLimit: limit } : {}) });
    for (const s of [FIX, TRI, LEAD, OTHER]) await event({ session: s, kind: 'start' });
    return p.id as string;
  };
  const env = (t: string) => `<cross-session-message from="uds:x" from-name="sender" from-mode="prompting">\n${t}\n</cross-session-message>`;
  /** a native message from `from` reaching Fix while it's idle: held (its reason) or not */
  const wakeFix = async (from: string, t: string) => {
    idle(FIX);
    await event({ session: from, kind: 'send', to: 'fix', text: t });
    return (await event({ session: FIX, kind: 'receive', from, text: env(t) })) as { ok?: true; hold?: string };
  };

  it('a project without a team keeps its rails by default: six wakes an hour per session, then your OK', async () => {
    const pid = await loose();
    expect(srv.projects.get(pid)!.wakeLimit).toBeUndefined();
    // from three senders (never two waking each other a lot): six go through, the seventh asks you
    const from = [TRI, LEAD, OTHER];
    for (let i = 0; i < 6; i++) expect(await wakeFix(from[i % 3], `m${i}`)).not.toHaveProperty('hold');
    expect((await wakeFix(TRI, 'm6')).hold).toMatch(/woken 6 times this hour/);
  });

  it('a project without a team set to no limit: wakes freely, with no pair guard either', async () => {
    const pid = await loose('none');
    expect(srv.projects.get(pid)!.wakeLimit).toBe('none');
    for (let i = 0; i < 10; i++) expect(await wakeFix(TRI, `m${i}`)).not.toHaveProperty('hold');
  });

  it('its wake limit is a whole number from 1 to 60, none, or back to the default', async () => {
    const pid = await loose();
    const set = (wakeLimit: unknown) => req('PATCH', `/api/projects/${pid}`, { wakeLimit }).then(() => srv.projects.get(pid)!.wakeLimit);
    expect(await set(12)).toBe(12);
    expect(await set(0)).toBe(12);
    expect(await set(2.5)).toBe(12);
    expect(await set('lots')).toBe(12);
    expect(await set('none')).toBe('none');
    expect(await set(null)).toBeUndefined();
    // a limit of 2: the third asks you
    await set(2);
    expect(await wakeFix(TRI, 'a')).not.toHaveProperty('hold');
    expect(await wakeFix(LEAD, 'b')).not.toHaveProperty('hold');
    expect((await wakeFix(OTHER, 'c')).hold).toMatch(/woken 2 times this hour/);
  });
});
