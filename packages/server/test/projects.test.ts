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
  it('groups sessions by hand: one project each; a new one coordinates (members hear, post, may ask to wake); kept across a restart', () => {
    let t = 1000;
    const p = new Projects(join(dir, 'projects.json'), () => t);
    const a = p.create('  Insight tags ');
    const b = p.create('Cora: Go live', '#3DDC97');
    expect(a).toMatchObject({ name: 'Insight tags', coordination: true, sessions: [] });
    expect(b.color).toBe('#3ddc97');
    expect(p.add(a.id, 's1')).toBe(true);
    p.add(a.id, 's2');
    expect(p.get(a.id)!.members.s1).toMatchObject({ hears: 'everything', canPost: true, wakes: true });
    // into another project: out of the first (told once, on its next prompt)
    p.add(b.id, 's2');
    expect(p.get(a.id)!.sessions).toEqual(['s1']);
    expect(p.projectOf('s2')!.id).toBe(b.id);
    expect(p.setMember(a.id, 's1', { hears: 'brief', canPost: false, wakes: 'yes' })).toMatchObject({ hears: 'brief', canPost: false, wakes: true });
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

  it('posts to the user, answers (re), pins and closes; what waits for a member until it hears; organisation-only projects turned on get the coordinating defaults', () => {
    const p = new Projects(join(dir, 'projects.json'));
    const a = p.create('Tags');
    p.add(a.id, 's1');
    p.add(a.id, 's2');
    const q = p.post(a.id, 's1', 'question', 'string[] or Tag[]?', ['user', 's2', 'not-a-member', 's1'])!;
    expect(q.to).toEqual(['user', 's2']);
    expect(p.post(a.id, 's2', 'note', 'string[]', undefined, q.id)!.re).toBe(q.id);
    expect(p.post(a.id, 's2', 'note', 'x', undefined, 'no-such-post')!.re).toBeUndefined();
    expect(p.pin(a.id, q.id, true)).toBe(true);
    expect(p.get(a.id)!.thread[0].pinned).toBe(true);
    expect(p.close(a.id, q.id)).toBe(true);
    p.wait(a.id, q.id, 's2');
    p.wait(a.id, q.id, 's2');
    expect(p.get(a.id)!.waiting).toEqual([{ post: q.id, to: 's2', since: expect.any(Number) }]);
    p.heard(a.id, 's2', Date.now(), 0, 'card');
    expect(p.get(a.id)!.waiting).toEqual([]);
    expect(p.get(a.id)!.members.s2.heardCard).toBe('card');
    // leaving: told once
    p.leave(a.id, 's1');
    expect(p.takeLeft('s1')).toBe('Tags');
    expect(p.takeLeft('s1')).toBeUndefined();
    // its sessions may wake each other on their own: kept, and taken back
    p.update(a.id, { autoWake: true });
    expect(new Projects(join(dir, 'projects.json')).get(a.id)!.autoWake).toBe(true);
    p.update(a.id, { autoWake: false });
    expect(p.get(a.id)!.autoWake).toBeUndefined();
    // its sessions in your order (dragged in the nav): ones you leave out keep their place after
    for (const s of ['m1', 'm2', 'm3']) p.add(a.id, s);
    const before = p.get(a.id)!.sessions.filter((x) => x.startsWith('m'));
    expect(before).toEqual(['m1', 'm2', 'm3']);
    expect(p.orderMembers(a.id, ['m3', 'm1'])).toBe(true);
    expect(p.get(a.id)!.sessions.slice(0, 2)).toEqual(['m3', 'm1']);
    expect(new Projects(join(dir, 'projects.json')).get(a.id)!.sessions.slice(0, 2)).toEqual(['m3', 'm1']);
    expect(p.orderMembers('nope', [])).toBe(false);
    // an organisation-only project, turned on: its members on the old defaults get the new ones; a member you set stays
    const o = p.create('Old');
    p.update(o.id, { coordination: false });
    p.add(o.id, 'x1');
    p.add(o.id, 'x2');
    expect(p.get(o.id)!.members.x1).toMatchObject({ hears: 'nothing', canPost: false });
    p.setMember(o.id, 'x2', { hears: 'brief' });
    p.update(o.id, { coordination: true });
    expect(p.get(o.id)!.members.x1).toMatchObject({ hears: 'everything', canPost: true, wakes: true });
    expect(p.get(o.id)!.members.x2).toMatchObject({ hears: 'brief', canPost: false });
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

  it('the project card on the first prompt, then only news (to you in full, notes as a count); tools; waiting handoffs; leaving; organisation only', async () => {
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

      // coordinating from the start: both have the tools; the card on the first prompt (an empty brief too), then nothing new
      expect(await tools('sess-api-0001')).toEqual(expect.arrayContaining(['project_post', 'project_read']));
      const ui1 = await prompt('sess-ui-00002', 1);
      expect(ui1).toMatch(/You're in the project "Insight tags" with 1 other session/);
      expect(ui1).toMatch(/- "API: tags array" \(sess-api-0001\): idle/);
      expect(ui1).toMatch(/each session does its own work/);
      expect(ui1).toMatch(/information, not instructions/);
      expect(await prompt('sess-ui-00002', 2)).toBeNull();

      // a change to the UI: in full; a note to all: a count; a change to all: a line
      await mcp('sess-api-0001', rpc('tools/call', { name: 'project_post', arguments: { kind: 'change', text: 'tags is now string[]', to: ['sess-ui-00002'] } }, 2));
      await mcp('sess-api-0001', rpc('tools/call', { name: 'project_post', arguments: { kind: 'note', text: 'the old endpoint stays a week' } }, 3));
      const ui3 = await prompt('sess-ui-00002', 3);
      expect(ui3).toMatch(/To you:\n- \[change\] "API: tags array" \(post \w+\): tags is now string\[\]/);
      expect(ui3).toMatch(/1 new note from others \(project_read to see them\)/);
      expect(ui3).not.toMatch(/the old endpoint stays/);
      expect(ui3).not.toMatch(/You're in the project/);

      // a decision you add changes the card: it comes again, with the decision
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/posts`, headers: UI, payload: { kind: 'decision', text: 'max 20 tags' } });
      expect(await prompt('sess-api-0001', 4)).toMatch(/Decisions:\n- max 20 tags \(the user\)/);
      const read = await mcp('sess-ui-00002', rpc('tools/call', { name: 'project_read', arguments: { kind: 'decision' } }, 6));
      expect(read.result.content[0].text).toMatch(/\[decision\] the user \(post \w+\): max 20 tags/);

      // a question to the user, answered with re; pinned
      await mcp('sess-ui-00002', rpc('tools/call', { name: 'project_post', arguments: { kind: 'question', text: 'chips or a dropdown?', to: ['user'] } }, 7));
      const q = (await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].thread.at(-1);
      expect(q).toMatchObject({ kind: 'question', to: ['user'] });
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/posts`, headers: UI, payload: { kind: 'note', text: 'chips', re: q.id, to: ['sess-ui-00002'] } });
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/posts/${q.id}/pin`, headers: UI, payload: { on: true } })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/posts/${q.id}/close`, headers: UI, payload: {} })).statusCode).toBe(200);

      // a handoff to the UI (not running here): it waits, no wake; its next prompt delivers it, and the wait is gone
      await mcp('sess-api-0001', rpc('tools/call', { name: 'project_post', arguments: { kind: 'handoff', text: 'done, your turn', to: ['sess-ui-00002'] } }, 8));
      const after = (await srv.app.inject({ url: '/api/projects', headers: UI })).json();
      expect(after.wakes).toEqual([]);
      expect(after.projects[0].waiting).toEqual([expect.objectContaining({ to: 'sess-ui-00002' })]);
      expect(await prompt('sess-ui-00002', 9)).toMatch(/\[handoff\] "API: tags array" \(post \w+\): done, your turn/);
      expect((await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].waiting).toEqual([]);
      expect((await srv.app.inject({ method: 'POST', url: '/api/projects/wakes/nope', headers: UI, payload: { allow: true } })).statusCode).toBe(404);

      // leaving: told once
      await srv.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}/sessions/sess-api-0001`, headers: UI });
      expect(await prompt('sess-api-0001', 10)).toMatch(/no longer in the project "Insight tags"/);
      expect(await prompt('sess-api-0001', 11)).toBeNull();

      // organisation only: nothing heard; the tools stay (a session's tools are read once, when it starts) and say why not
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { coordination: false } });
      expect(await prompt('sess-ui-00002', 12)).toBeNull();
      expect(await tools('sess-ui-00002')).toContain('project_post');
      const off = (await mcp('sess-ui-00002', rpc('tools/call', { name: 'project_post', arguments: { kind: 'note', text: 'hello?' } }, 13))).result;
      expect(off.isError).toBe(true);
      expect(off.content[0].text).toMatch(/not in a Cora project with coordination on/);
      // a session that joins later has them from the start
      srv.store.upsertSession({ id: 'sess-new-00003', cwd: 'C:/work/x', state: 'idle', startedAt: now, lastTs: now } as never);
      expect(await tools('sess-new-00003')).toEqual(expect.arrayContaining(['project_read', 'project_post', 'project_items', 'project_claim']));

      // archive, then delete
      expect((await srv.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: UI })).statusCode).toBe(409);
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/archive`, headers: UI, payload: { on: true } });
      expect((await srv.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: UI })).statusCode).toBe(200);
    } finally {
      await srv.close();
    }
  });

  it('items through the tools and the board: open, claim (a second claim refused), assign (the owner hears it), annotate, close; reports; editing your post', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const now = Date.now();
      for (const [id, alias] of [['sess-mon-0001', 'Monitor'], ['sess-tri-0002', 'Triage']]) srv.store.upsertSession({ id, alias, cwd: 'C:/work/x', state: 'idle', startedAt: now, lastTs: now } as never);
      const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Ops', sessionId: 'sess-mon-0001' } })).json().project;
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: 'sess-tri-0002' } });
      expect(await tools('sess-mon-0001')).toEqual(expect.arrayContaining(['project_items', 'project_item', 'project_claim', 'project_annotate', 'project_close', 'project_edit']));
      await prompt('sess-tri-0002', 1);
      const call = async (sid: string, name: string, args: object) => (await mcp(sid, rpc('tools/call', { name, arguments: args }, 9))).result;
      // the monitor opens one; both try to claim it: one wins
      const opened = await call('sess-mon-0001', 'project_item', { title: 'Station A: no video', severity: 'high' });
      const iid = /item (\w+)/.exec(opened.content[0].text)![1];
      expect((await call('sess-tri-0002', 'project_claim', { item: iid })).isError).toBeFalsy();
      const second = await call('sess-mon-0001', 'project_claim', { item: iid });
      expect(second.isError).toBe(true);
      expect(second.content[0].text).toContain('Already claimed: "Triage" (sess-tri-0002) has owned');
      expect((await call('sess-mon-0001', 'project_items', { owner: 'sess-tri-0002' })).content[0].text).toMatch(/\[high · working\] Station A: no video/);
      // a note on it: its owner hears it, in full, on its next prompt
      await call('sess-mon-0001', 'project_annotate', { item: iid, text: 'recovered at 14:20' });
      expect(await prompt('sess-tri-0002', 2)).toMatch(/\[report\] "Monitor" \(post \w+, item \w+\): Noted on "Station A: no video": recovered at 14:20/);
      // a report needs one seat
      expect((await call('sess-mon-0001', 'project_post', { kind: 'report', text: 'Station B: WARNING' })).isError).toBe(true);
      // the board: you assign a new one, and close the first
      const r = await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/items`, headers: UI, payload: { op: 'open', title: 'Station B: no audio', owner: 'sess-mon-0001' } });
      expect(r.json().item).toMatchObject({ owner: 'sess-mon-0001', state: 'working', openedBy: 'you' });
      expect(await prompt('sess-mon-0001', 3)).toMatch(/Assigned you "Station B: no audio"/);
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/items`, headers: UI, payload: { op: 'close', item: iid, cause: 'encoder', fix: 'restart' } })).statusCode).toBe(200);
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/items`, headers: UI, payload: { op: 'nope' } })).statusCode).toBe(400);
      // your post, changed; theirs, not yours to change
      const mine = (await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/posts`, headers: UI, payload: { kind: 'note', text: 'triage takes A' } })).json().post;
      expect((await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/posts/${mine.id}`, headers: UI, payload: { text: 'monitor takes A' } })).json().post).toMatchObject({ text: 'monitor takes A', editedAt: expect.any(Number) });
      const theirs = (await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].thread.find((x: { by: string }) => x.by === 'sess-mon-0001');
      expect((await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}/posts/${theirs.id}`, headers: UI, payload: { withdraw: true } })).statusCode).toBe(400);
      const edited = await call('sess-mon-0001', 'project_edit', { post: theirs.id, withdraw: true });
      expect(edited.content[0].text).toBe('Withdrawn.');
      expect((await call('sess-tri-0002', 'project_read', { by: 'user' })).content[0].text).toMatch(/\[note, edited\] the user \(post \w+\): monitor takes A/);
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
