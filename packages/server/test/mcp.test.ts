import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => srv?.close());

const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const H = { 'x-cora-token': 'hooktok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };

async function call(body: object, headers: Record<string, string> = H) {
  const r = await srv.app.inject({ method: 'POST', url: '/mcp', headers, payload: body });
  return { status: r.statusCode, json: r.body ? JSON.parse(r.body) : null };
}

describe('MCP tools', () => {
  it('a live explain: its folder and files for a session; none without one, nor with HTML explains off', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-mcp-'));
    srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    const r = await call(rpc('tools/call', { name: 'live_explain', arguments: { title: 'Release 2.4' } }, 2), { ...H, 'x-cora-session': 'sess-live-1' });
    const text = r.json.result.content[0].text as string;
    expect(text).toContain(join(dataDir, 'explains', 'sess-live-1', 'release-24', 'page.html'));
    expect(text).toContain(join(dataDir, 'explains', 'sess-live-1', 'release-24', 'data.json'));
    expect(text).toMatch(/cora\.onData/);
    const listed = async (headers: Record<string, string>) => ((await call(rpc('tools/list', {}, 3), headers)).json.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(await listed({ ...H, 'x-cora-session': 'sess-live-1' })).toContain('live_explain');
    expect(await listed(H)).not.toContain('live_explain');
  });

  it('a debrief: checked against the files, saved, listed, its markdown; a bad one comes back named', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-mcp-'));
    const cwd = mkdtempSync(join(tmpdir(), 'ab-mcp-repo-'));
    writeFileSync(join(cwd, 'a.ts'), 'one\ntwo\nthree\n');
    srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    srv.store.upsertSession({ id: 'sess-debrief-1', cwd });
    await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    const S = { ...H, 'x-cora-session': 'sess-debrief-1' };
    const step = { title: 'The change', kind: 'change', path: 'a.ts', range: [2, 3], beats: [{ text: 'Two and three.' }], why: 'Because.' };
    const script = { title: 'Counting', task: 'Count to three.', depth: 'quick', steps: [step] };
    const bad = await call(rpc('tools/call', { name: 'debrief', arguments: { ...script, steps: [{ ...step, range: [2, 9] }] } }, 2), S);
    expect(bad.json.result.isError).toBe(true);
    expect(bad.json.result.content[0].text).toContain('step 1: lines 2-9 are past the end of a.ts (3 lines)');
    const ok = await call(rpc('tools/call', { name: 'debrief', arguments: script }, 3), S);
    expect(ok.json.result.content[0].text).toMatch(/^Saved "Counting" \(1 steps\)/);
    const list = (await srv.app.inject({ url: '/api/debriefs/sess-debrief-1', headers: { cookie: 'ab_session=u' } })).json().list;
    expect(list).toMatchObject([{ title: 'Counting', depth: 'quick', steps: 1 }]);
    const md = await srv.app.inject({ url: `/api/debriefs/sess-debrief-1/${list[0].id}/markdown`, headers: { cookie: 'ab_session=u' } });
    expect(md.body).toContain('`a.ts:2-3`');
    expect(md.body).toContain('```\ntwo\nthree\n```');
    expect((await srv.app.inject({ url: '/api/debriefs/sess-debrief-1/nope', headers: { cookie: 'ab_session=u' } })).statusCode).toBe(404);
    // no IDE open on the folder: the dashboard hears so (and offers to add one)
    const show = await srv.app.inject({ method: 'POST', url: '/api/ide/debrief/show', headers: { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' }, payload: { sessionId: 'sess-debrief-1', id: list[0].id, step: 0 } });
    expect(show.json()).toEqual({ ok: false, reason: 'no-ide' });
    const past = await srv.app.inject({ method: 'POST', url: '/api/ide/debrief/show', headers: { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' }, payload: { sessionId: 'sess-debrief-1', id: list[0].id, step: 5 } });
    expect(past.statusCode).toBe(404);
    // the bubble's buttons come only from the IDE's extension (its own key)
    expect((await srv.app.inject({ method: 'POST', url: '/api/ide/bridge/debrief', payload: { sessionId: 'sess-debrief-1', act: 'next' } })).statusCode).toBe(401);
  });

  it("secrets: a session sees names, never values; its first use waits for the user (no dashboard: no); an expired one is refused", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-mcp-'));
    srv = await startServer(loadConfig({ dataDir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    srv.store.upsertSession({ id: 'sess-secret-1', cwd: dataDir });
    const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
    const add = (payload: object) => srv.app.inject({ method: 'POST', url: '/api/secrets', headers: UI, payload });
    expect((await add({ name: 'GITHUB_PAT', value: 'ghp_very-secret', note: 'GitHub sandbox' })).statusCode).toBe(200);
    const old = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 1000 })).toString('base64url')}.c2ln`;
    expect((await add({ name: 'OLD_JWT', value: old })).json()).toMatchObject({ name: 'OLD_JWT', expiresAt: 1_000_000 });
    expect((await add({ name: 'bad', value: 'x' })).statusCode).toBe(400);
    const listed = (await srv.app.inject({ url: '/api/secrets', headers: { cookie: 'ab_session=u' } })).body;
    expect(listed).toContain('GITHUB_PAT');
    expect(listed).not.toContain('ghp_very-secret');
    expect((await srv.app.inject({ method: 'POST', url: '/api/secrets/GITHUB_PAT/reveal', headers: UI })).json()).toEqual({ value: 'ghp_very-secret' });
    await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    const S = { ...H, 'x-cora-session': 'sess-secret-1' };
    const tool = async (name: string, args: object, id: number) => (await call(rpc('tools/call', { name, arguments: args }, id), S)).json.result;
    const names = (await tool('secrets', {}, 2)).content[0].text as string;
    expect(names).toContain('GITHUB_PAT: GitHub sandbox');
    expect(names).toContain('OLD_JWT · EXPIRED');
    expect(names).not.toContain('pat-na1');
    expect((await tool('secret_run', { command: 'echo $OLD_JWT', secrets: ['OLD_JWT'] }, 3)).content[0].text).toMatch(/expired/);
    expect((await tool('secret_run', { command: 'echo $NOPE', secrets: ['NOPE'] }, 4)).content[0].text).toMatch(/No secret NOPE/);
    // nobody at the dashboard to OK its first use: refused, nothing run
    const r = await tool('secret_run', { command: 'echo $GITHUB_PAT', secrets: ['GITHUB_PAT'] }, 5);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/didn't allow GITHUB_PAT/);
  }, 30_000);

  it("sessions read the user's notes and add to them (marked, never editing)", async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-mcp-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    const tool = async (name: string, args: object, id: number) => (await call(rpc('tools/call', { name, arguments: args }, id), { ...H, 'x-cora-session': 'sess-notes-1' })).json.result.content[0].text as string;
    expect(await tool('notes_add', { text: 'reconciler times out past 4k companies' }, 2)).toBe('Added to Scratch.');
    expect(await tool('notes_add', { note: 'Deploy notes', text: 'webapi only' }, 3)).toBe('Made a new note "Deploy notes".');
    expect(await tool('notes_add', { note: 'deploy', text: 'then staging' }, 4)).toBe('Added to the end of "Deploy notes".');
    expect(await tool('notes_list', {}, 5)).toMatch(/^- Scratch \(1 jots\).*\n- Deploy notes/s);
    expect(await tool('notes_search', { query: 'reconciler' }, 6)).toMatch(/## Scratch\n- \[.+\] reconciler times out/);
    expect(await tool('notes_read', { note: 'Deploy notes' }, 7)).toMatch(/^# Deploy notes\n> \*\*Added by .+\*\* · .+\n> webapi only\n\n> \*\*Added by .+\n> then staging/);
  });

  it('rejects requests without the token', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-mcp-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    expect((await call(rpc('tools/list'), { accept: H.accept, 'content-type': H['content-type'] })).status).toBe(401);
  });

  it('still answers sessions started before the rename (old token header)', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-mcp-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    const old = { 'x-agent-brain-token': 'hooktok', accept: H.accept, 'content-type': H['content-type'] };
    expect((await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }), old)).status).toBe(200);
  });

  it('initializes and lists its tools (no present: explains are written in the reply)', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-mcp-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    const init = await call(rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }));
    expect(init.status).toBe(200);
    expect(init.json.result.serverInfo.name).toBe('cora');
    const list = await call(rpc('tools/list', {}, 2));
    expect(list.json.result.tools.map((t: any) => t.name).sort()).toEqual(['deploys', 'environment', 'notes_add', 'notes_list', 'notes_read', 'notes_search', 'open_tab', 'slack_find', 'slack_inbox', 'slack_read', 'slack_search', 'slack_send', 'slack_watch', 'speak']);
  });

  it('open_tab: opens a web address for the user (and only web addresses)', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-mcp-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    const list = await call(rpc('tools/list', {}, 2));
    const tool = list.json.result.tools.find((t: any) => t.name === 'open_tab');
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['reason', 'url']);
    const ok = await call(rpc('tools/call', { name: 'open_tab', arguments: { url: 'https://gitlab.com/g/p/-/merge_requests/35' } }, 3));
    expect(ok.json.result.content[0].text).toMatch(/Opened https:\/\/gitlab\.com/);
    const file = await call(rpc('tools/call', { name: 'open_tab', arguments: { url: 'file:///c:/secret.txt' } }, 4));
    expect(file.json.result?.isError ?? !!file.json.error).toBe(true);
  });

  it('speak: says a short line when voice reads summaries, an error otherwise (so Claude stops)', async () => {
    srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-mcp-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false });
    const list = await call(rpc('tools/list', {}, 2));
    const tool = list.json.result.tools.find((t: any) => t.name === 'speak');
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['text']);
    expect(tool.description).toMatch(/no markdown/);
    const say = (id: number, text = 'I fixed the login bug and the tests pass.') => call(rpc('tools/call', { name: 'speak', arguments: { text } }, id));
    // voice is off by default
    expect((await say(3)).json.result.isError).toBe(true);
    const ui = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
    expect((await srv.app.inject({ method: 'POST', url: '/api/settings', headers: ui, payload: { voice: { enabled: true, read: 'summaries' } } })).statusCode).toBe(200);
    const ok = await say(4);
    expect(ok.json.result.isError).toBeFalsy();
    expect(ok.json.result.content[0].text).toBe('Said to the user.');
    const long = await say(5, 'x'.repeat(301));
    expect(long.json.result?.isError ?? !!long.json.error).toBe(true);
    await srv.app.inject({ method: 'POST', url: '/api/settings', headers: ui, payload: { voice: { read: 'full' } } });
    expect((await say(6)).json.result.isError).toBe(true);
  });
});
