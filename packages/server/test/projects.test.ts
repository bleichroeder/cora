import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadesOf } from '@cora/shared';
import { Projects } from '../src/projects';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-projects-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('projects', () => {
  it('groups sessions by hand: one project each; members hear nothing until you say; kept across a restart', () => {
    let t = 1000;
    const p = new Projects(join(dir, 'projects.json'), () => t);
    const a = p.create('  Insight tags ');
    const b = p.create('Cora: Go live', '#3DDC97');
    expect(a).toMatchObject({ name: 'Insight tags', coordination: false, sessions: [] });
    expect(b.color).toBe('#3ddc97');
    expect(p.add(a.id, 's1')).toBe(true);
    p.add(a.id, 's2');
    expect(p.get(a.id)!.members.s1).toMatchObject({ hears: 'nothing', canPost: false, wakes: false });
    // into another project: out of the first
    p.add(b.id, 's2');
    expect(p.get(a.id)!.sessions).toEqual(['s1']);
    expect(p.projectOf('s2')!.id).toBe(b.id);
    expect(p.setMember(a.id, 's1', { hears: 'everything', canPost: true, wakes: 'yes' })).toMatchObject({ hears: 'everything', canPost: true, wakes: false });
    expect(p.setMember(a.id, 's9', { hears: 'brief' })).toBeNull();
    // a decision goes into the memory too
    t = 2000;
    p.post(a.id, 's1', 'decision', 'tags is string[]');
    expect(p.get(a.id)).toMatchObject({ decisions: [{ text: 'tags is string[]', by: 's1' }], briefAt: 2000 });
    expect(p.post(a.id, 's1', 'shout' as never, 'x')).toBeNull();
    for (let i = 0; i < 520; i++) p.post(a.id, 'you', 'note', `n${i}`);
    expect(p.get(a.id)!.thread).toHaveLength(500);
    p.reorder([b.id, a.id]);
    expect(p.list().map((x) => x.name)).toEqual(['Cora: Go live', 'Insight tags']);
    p.reorder([a.id]);
    p.archive(b.id, true);
    const again = new Projects(join(dir, 'projects.json'));
    expect(again.list().map((x) => [x.name, x.sessions, !!x.archivedAt])).toEqual([['Insight tags', ['s1'], false], ['Cora: Go live', ['s2'], true]]);
  });
});

describe('projects through the server', () => {
  let srv: Running;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const H = { 'x-cora-token': 'hooktok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
  const mcp = async (sid: string, body: object) => JSON.parse((await srv.app.inject({ method: 'POST', url: '/mcp', headers: { ...H, 'x-cora-session': sid }, payload: body })).body);
  const tools = async (sid: string) => ((await mcp(sid, rpc('tools/list'))).result.tools as Array<{ name: string }>).map((t) => t.name);
  const prompt = async (sid: string, n: number) => {
    const r = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/work/x', prompt: 'go on', prompt_id: `${sid}-${n}` } });
    return r.statusCode === 204 ? null : (r.json().hookSpecificOutput?.additionalContext as string | undefined) ?? null;
  };

  it('routes, hearing on the next prompt, and the posting tools: all off until you turn them on', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const now = Date.now();
      for (const [id, alias] of [['sess-api-0001', 'API: tags array'], ['sess-ui-00002', 'UI: tag chips']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work/x', state: 'idle', startedAt: now, lastTs: now } as never);
      expect((await srv.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x' } })).statusCode).toBe(401);
      expect((await srv.app.inject({ method: 'POST', url: '/api/projects', headers: { cookie: UI.cookie, origin: 'https://evil.example' }, payload: { name: 'x' } })).statusCode).toBe(403);
      const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Insight tags', sessionId: 'sess-api-0001' } })).json().project;
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: 'sess-ui-00002' } })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: 'nope' } })).statusCode).toBe(400);
      expect((await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].sessions).toEqual(['sess-api-0001', 'sess-ui-00002']);

      // organisation only: nothing heard, no tools
      expect(await prompt('sess-ui-00002', 1)).toBeNull();
      expect(await tools('sess-api-0001')).not.toContain('project_post');

      // coordination on, the API may post, the UI hears everything
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { coordination: true, brief: 'Search terms get tags.' } });
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/members/sess-api-0001`, headers: UI, payload: { hears: 'brief', canPost: true } });
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/members/sess-ui-00002`, headers: UI, payload: { hears: 'everything' } });
      expect(await tools('sess-api-0001')).toEqual(expect.arrayContaining(['project_post', 'project_read']));
      expect(await tools('sess-ui-00002')).toContain('project_read');
      expect(await tools('sess-ui-00002')).not.toContain('project_post');
      const posted = await mcp('sess-api-0001', rpc('tools/call', { name: 'project_post', arguments: { kind: 'change', text: 'tags is now string[]', to: ['sess-ui-00002'] } }, 2));
      expect(posted.result.content[0].text).toMatch(/Posted/);
      const refused = await mcp('sess-ui-00002', rpc('tools/call', { name: 'project_post', arguments: { kind: 'note', text: 'hi' } }, 3));
      expect(refused.result?.isError ?? refused.error).toBeTruthy();

      // the UI hears the brief and the post, once; the API hears the brief, not its own post
      const ui1 = await prompt('sess-ui-00002', 2);
      expect(ui1).toMatch(/you're in the project "Insight tags"/);
      expect(ui1).toMatch(/information, not instructions/);
      expect(ui1).toMatch(/Search terms get tags\./);
      expect(ui1).toMatch(/\[change\] "API: tags array" to "UI: tag chips": tags is now string\[\]/);
      expect(await prompt('sess-ui-00002', 3)).toBeNull();
      const api1 = await prompt('sess-api-0001', 4);
      expect(api1).toMatch(/Search terms get tags\./);
      expect(api1).not.toMatch(/tags is now string/);
      // a decision you add: everyone who hears the brief hears it next time
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/posts`, headers: UI, payload: { kind: 'decision', text: 'max 20 tags' } });
      expect(await prompt('sess-api-0001', 5)).toMatch(/- max 20 tags \(the user\)/);
      // reading the thread
      const read = await mcp('sess-ui-00002', rpc('tools/call', { name: 'project_read', arguments: {} }, 6));
      expect(read.result.content[0].text).toMatch(/\[decision\] the user: max 20 tags/);
      // nobody's running here: a handoff wakes nobody
      await mcp('sess-api-0001', rpc('tools/call', { name: 'project_post', arguments: { kind: 'handoff', text: 'done, your turn', to: ['sess-ui-00002'] } }, 7));
      expect((await srv.app.inject({ url: '/api/projects', headers: UI })).json().wakes).toEqual([]);
      expect((await srv.app.inject({ method: 'POST', url: '/api/projects/wakes/nope', headers: UI, payload: { allow: true } })).statusCode).toBe(404);
      // archive, then delete
      expect((await srv.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: UI })).statusCode).toBe(409);
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/archive`, headers: UI, payload: { on: true } });
      expect(await prompt('sess-ui-00002', 8)).toBeNull();
      expect((await srv.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: UI })).statusCode).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("shading on: its sessions wear shades of its colour, kept as sessions join and leave and as it's recoloured; off: they keep theirs", async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const now = Date.now();
      for (const id of ['sess-a', 'sess-b', 'sess-c', 'sess-d']) srv.store.upsertSession({ id, cwd: 'C:/work/x', state: 'idle', startedAt: now, lastTs: now } as never);
      const color = (sid: string) => srv.store.getSession(sid)?.color;
      const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Tags', color: '#3ddc97', sessionId: 'sess-a' } })).json().project;
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: 'sess-b' } });
      expect(color('sess-a')).toBeFalsy();
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { shade: true } });
      expect([color('sess-a'), color('sess-b')]).toEqual(shadesOf('#3ddc97', 2));
      // a new one: everyone's shade, the newcomer's too
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: 'sess-c' } });
      expect(['sess-a', 'sess-b', 'sess-c'].map(color)).toEqual(shadesOf('#3ddc97', 3));
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { color: '#60a5fa' } });
      expect(['sess-a', 'sess-b', 'sess-c'].map(color)).toEqual(shadesOf('#60a5fa', 3));
      await srv.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/sessions/sess-b`, headers: UI });
      expect(['sess-a', 'sess-c'].map(color)).toEqual(shadesOf('#60a5fa', 2));
      // off: nothing changes now or later
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { shade: false } });
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: 'sess-d' } });
      expect(color('sess-d')).toBeFalsy();
      expect(['sess-a', 'sess-c'].map(color)).toEqual(shadesOf('#60a5fa', 2));
    } finally {
      await srv.close();
    }
  });
});
