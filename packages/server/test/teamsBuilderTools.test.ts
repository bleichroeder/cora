import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clone, newSeat } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { builderMcpHeaders } from '../src/builder';
import { drill } from '@cora/shared/test/fixtures';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-builder-tools-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BS = 'dddd0000-0000-0000-0000-000000000009';
const OTHER = 'aaaa0000-0000-0000-0000-000000000001';

describe("the builder session's tools", () => {
  let srv: Running;
  let pid: string;
  let key: string;
  // a builder session sends its proof (builderMcpHeaders) beside its id; `extra` replaces it
  const rpc = (sid: string, method: string, params: object, extra?: Record<string, string>) =>
    srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, ...(extra ?? (sid === BS ? builderMcpHeaders(key, BS) : {})), accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method, params } }).then((r) => r.json().result);
  const tool = (sid: string, name: string, args: object, extra?: Record<string, string>) => rpc(sid, 'tools/call', { name, arguments: args }, extra) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const names = async (sid: string, extra?: Record<string, string>) => ((await rpc(sid, 'tools/list', {}, extra)).tools as Array<{ name: string }>).map((t) => t.name).sort();
  beforeEach(async () => {
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    const cfg = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope') });
    key = cfg.agentToken;
    srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never });
    pid = srv.projects.create('Drill').id;
    expect(srv.projects.setTeam(pid, drill(), 'you').ok).toBe(true);
    srv.projects.setDraftSession(pid, BS);
  });
  afterEach(async () => srv.close());

  it('the builder session gets its three tools and nothing else; no other session gets them', async () => {
    expect(await names(BS)).toEqual(['team_draft_get', 'team_draft_set', 'team_trace']);
    expect((await names(OTHER)).filter((n) => n.startsWith('team_'))).toEqual([]);
  });

  it('the session id alone, or a wrong proof, does not give the tools', async () => {
    const own = { ...builderMcpHeaders(key, BS) };
    expect(await names(BS, {})).toEqual(expect.not.arrayContaining(['team_draft_get']));
    expect(await names(BS, { 'x-cora-builder': 'nope' })).toEqual(expect.not.arrayContaining(['team_draft_get']));
    expect(await names(BS, builderMcpHeaders(key, OTHER))).toEqual(expect.not.arrayContaining(['team_draft_get']));
    expect(await names(BS, builderMcpHeaders('another-key', BS))).toEqual(expect.not.arrayContaining(['team_draft_get']));
    expect((await tool(BS, 'team_draft_set', { team: drill(), base: 0 }, {})).isError).toBe(true);
    expect(srv.projects.draft(pid)!.rev).toBe(0);
    // another session sending the builder's real proof under its own id gets nothing either
    expect(await names(OTHER, own)).toEqual(expect.not.arrayContaining(['team_draft_get']));
    expect(await names(BS, own)).toEqual(['team_draft_get', 'team_draft_set', 'team_trace']);
  });

  it('a draft has a size limit (string, object) and bad JSON is refused plainly', async () => {
    const huge = clone(drill());
    huge.seats[0].instructions = 'x'.repeat(210_000);
    const o = await tool(BS, 'team_draft_set', { team: huge, base: 0 });
    expect(o.isError).toBe(true);
    expect(o.content[0].text).toContain('too big to save');
    const str = await tool(BS, 'team_draft_set', { team: JSON.stringify(huge), base: 0 });
    expect(str.isError).toBe(true);
    const bad = await tool(BS, 'team_draft_set', { team: '{not json', base: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain('not valid JSON');
    expect(srv.projects.draft(pid)!.rev).toBe(0);
  });

  it('team_trace takes at most 20 labels', async () => {
    const labels = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'v']));
    expect((await tool(BS, 'team_trace', { from: 'seat:monitor-a', to: 'user', kind: 'direct', labels })).isError).toBe(true);
  });

  it('another session cannot call them, and the builder loses them when its session is cleared', async () => {
    const r = await tool(OTHER, 'team_draft_get', {});
    expect(r.isError).toBe(true);
    await tool(OTHER, 'team_draft_set', { team: drill(), base: 0 });
    expect(srv.projects.draft(pid)!.rev).toBe(0);
    srv.projects.setDraftSession(pid, null);
    expect((await names(BS)).filter((n) => n.startsWith('team_'))).toEqual([]);
  });

  it("a proven builder session whose draft has gone gets no tools at all (never the ordinary ones)", async () => {
    srv.projects.discardDraft(pid);
    expect(await names(BS)).toEqual([]);
    expect((await tool(BS, 'sessions', {})).isError).toBe(true);
    // its id without the proof is an ordinary session's
    expect((await names(BS, {})).length).toBeGreaterThan(0);
  });

  it('team_draft_get: the revision, the team in words, its checks and its JSON', async () => {
    const t = (await tool(BS, 'team_draft_get', {})).content[0].text;
    expect(t).toContain('revision 0 (built on version 1)');
    expect(t).toContain('- Monitor A and Monitor B report to Triage; Triage is woken for them.');
    expect(t).toContain('- warning: Analysts splits by issue but has nothing for ingest, and no else.');
    expect(t).toContain('"id":"r-handoff"');
  });

  it('team_draft_get: a draft whose team moved on since says so (the user rebases it before applying)', async () => {
    expect(srv.projects.setDraft(pid, drill(), 'you', { expect: 0 }).ok).toBe(true);
    const moved = clone(drill());
    moved.seats[0].name = 'Monitor Alpha';
    expect(srv.projects.setTeam(pid, moved, 'cora').ok).toBe(true);
    const t = (await tool(BS, 'team_draft_get', {})).content[0].text;
    expect(t).toContain('revision 1 (built on version 1; the team is version 2 now: the user rebases the draft onto it before applying)');
  });

  it('team_draft_set refuses an invalid team (its problems, for her to fix) and a stale revision', async () => {
    const bad = clone(drill());
    bad.seats[2].count = { min: 3, max: 1 };
    const r1 = await tool(BS, 'team_draft_set', { team: bad, base: 0 });
    expect(r1.isError).toBe(true);
    expect(r1.content[0].text).toContain('Not saved: the team has problems.');
    expect(r1.content[0].text).toContain('Seat "triage" has count.min 3 above count.max 1.');
    expect(srv.projects.draft(pid)!.rev).toBe(0);
    expect(srv.projects.setDraft(pid, drill(), 'you', { expect: 0 }).ok).toBe(true);
    const r2 = await tool(BS, 'team_draft_set', { team: drill(), base: 0 });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toMatch(/^The draft changed since you read revision 0 \(it is at 1 now\)/);
  });

  it("a problem the draft had already (the user's unfinished seat) doesn't stop her change: only a problem she adds does, and the rest is said as still to fix", async () => {
    const mine = clone(drill());
    mine.seats.push(newSeat('scribe', 'Scribe', ''));
    expect(srv.projects.setDraft(pid, mine, 'you', { expect: 0 }).ok).toBe(true);
    const hers = clone(mine);
    hers.seats.push(newSeat('reviewer', 'Reviewer', 'C:/w'));
    const r = await tool(BS, 'team_draft_set', { team: hers, base: 1 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('Still to fix (it was so before your change):\n- Seat "scribe" needs folder.path (the folder it works in).');
    expect(srv.projects.draft(pid)!.team.seats.map((s) => s.id)).toContain('reviewer');
    // one she adds: refused, naming only hers
    const worse = clone(hers);
    worse.seats.find((s) => s.id === 'reviewer')!.count = { min: 3, max: 1 };
    const r2 = await tool(BS, 'team_draft_set', { team: worse, base: 2 });
    expect(r2.isError).toBe(true);
    expect(r2.content[0].text).toContain('Seat "reviewer" has count.min 3 above count.max 1.');
    expect(r2.content[0].text).not.toContain('scribe');
  });

  it("a valid one is published and becomes a turn, and the project's team is untouched", async () => {
    const seen: string[] = [];
    const prev = srv.projects.onDraft;
    srv.projects.onDraft = (p) => (seen.push(p), prev?.(p));
    const t = clone(drill());
    t.seats.push(newSeat('monitor-c', 'Monitor C', 'C:/w'));
    t.routes[0].from.push('seat:monitor-c');
    const r = await tool(BS, 'team_draft_set', { team: JSON.stringify(t), base: 0 });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/^Saved as revision 1: added Monitor C · changed route Monitor A, Monitor B, Monitor C → Triage\./);
    expect(seen).toEqual([pid]);
    expect(srv.projects.draft(pid)).toMatchObject({ rev: 1, by: 'cora' });
    expect(srv.projects.get(pid)!.team!.seats).toHaveLength(5);
    expect(srv.projects.get(pid)!.team!.version).toBe(1);
    const mine = clone(srv.projects.draft(pid)!.team);
    mine.seats[2].instructions = 'Yours.';
    srv.projects.setDraft(pid, mine, 'you', { expect: 1 });
    expect((await tool(BS, 'team_draft_get', {})).content[0].text).toContain('Since your last change the user changed Triage.');
  });

  it('team_trace: the dry run, numbered', async () => {
    const r = await tool(BS, 'team_trace', { from: 'seat:monitor-a', to: 'seat:monitor-b', kind: 'direct' });
    expect(r.content[0].text.split('\n')[0]).toBe('1. Monitor A may not message Monitor B. It may message Triage. Send it to Triage instead.');
    expect((await tool(BS, 'team_trace', { from: 'seat:nobody', to: 'user', kind: 'direct' })).isError).toBe(true);
  });
});
