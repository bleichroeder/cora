import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hasMods, nativeName, parseVersion, writeCoraPlugin } from '../src/coraPlugin';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-native-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the Cora plugin', () => {
  it('knows which Claude Code has mods', () => {
    expect(parseVersion('2.1.316 (Claude Code)')).toEqual([2, 1, 316]);
    expect(parseVersion('nope')).toBeNull();
    expect(hasMods([2, 1, 281])).toBe(false);
    expect(hasMods([2, 1, 287])).toBe(true);
    expect(hasMods([2, 2, 0])).toBe(true);
    expect(hasMods([3, 0, 0])).toBe(true);
    expect(hasMods(null)).toBe(false);
  });

  it('names a session after its folder and id, the same every time', () => {
    expect(nativeName('C:\\code\\Blue Tags\\', '1a2b3c4d-0000-0000-0000-000000000000')).toBe('blue-tags-1a2b');
    expect(nativeName('/', 'abcdef12')).toBe('session-abcd');
  });

  it('writes the plugin (the mod with Cora’s address, the skill), and leaves unchanged files alone', () => {
    const p = writeCoraPlugin(dir, 'http://127.0.0.1:4317', 'tok');
    const mod = readFileSync(join(p, 'hooks', 'register.js'), 'utf8');
    expect(mod).toContain('const BASE = "http://127.0.0.1:4317"');
    expect(mod).toContain('if (said.hold) return { consumed: said.hold }');
    expect(mod).toMatch(/on\('session\.send'[\s\S]*\.catch/);
    expect(JSON.parse(readFileSync(join(p, 'hooks', 'hooks.json'), 'utf8')).modules).toEqual(['./register.js']);
    expect(readFileSync(join(p, 'skills', 'cora-project', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: cora-project/);
    const before = statSync(join(p, 'hooks', 'register.js')).mtimeMs;
    writeCoraPlugin(dir, 'http://127.0.0.1:4317', 'tok');
    expect(statSync(join(p, 'hooks', 'register.js')).mtimeMs).toBe(before);
  });
});

describe('native messages on the board', () => {
  let srv: Running;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const H = { 'x-cora-token': 'hooktok', 'content-type': 'application/json' };
  const API = '1a2b0000-0000-0000-0000-000000000001';
  const WEB = '9f8e0000-0000-0000-0000-000000000002';
  const mod = (body: object, headers: object = H) => srv.app.inject({ method: 'POST', url: '/api/mod/event', headers: headers as never, payload: body });
  const prompt = async (sid: string, n: number) => {
    const r = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/work/api', prompt: 'go on', prompt_id: `${sid}-${n}` } });
    return r.statusCode === 204 ? null : ((r.json().hookSpecificOutput?.additionalContext as string | undefined) ?? null);
  };

  it('the card gives each modded member its @name; a message sent and received is one post, delivered, and not news again', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    try {
      const now = Date.now();
      srv.store.upsertSession({ id: API, alias: 'API', cwd: 'C:/work/api', state: 'idle', startedAt: now, lastTs: now } as never);
      srv.store.upsertSession({ id: WEB, alias: 'Web', cwd: 'C:/work/web', state: 'idle', startedAt: now, lastTs: now } as never);
      const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Tags', sessionId: API } })).json().project;
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: WEB } });
      // they wake each other on their own (holds are the next test's)
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { autoWake: true } });

      expect((await mod({ session: API, kind: 'start' }, { 'content-type': 'application/json' })).statusCode).toBe(401);
      await mod({ session: API, kind: 'start', version: '2.1.316' });
      await mod({ session: WEB, kind: 'start', version: '2.1.316' });
      const card = await prompt(API, 1);
      expect(card).toMatch(/"Web" \(9f8e0000-0000-0000-0000-000000000002, message it as @web-9f8e\)/);
      expect(card).toMatch(/Talk to a member marked @name directly: SendMessage/);

      // the API session messages the web one natively: the sender's report makes the post, the receiver's marks it delivered
      await mod({ session: API, kind: 'send', to: 'web-9f8e', text: 'tags is now string[]', origin: { kind: 'model' } });
      let thread = (await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].thread;
      expect(thread).toEqual([expect.objectContaining({ by: API, to: [WEB], text: 'tags is now string[]', native: true })]);
      // its mod isn't asking Cora for anything here: Claude Code delivers it, and Cora counts it delivered
      await mod({ session: WEB, kind: 'receive', text: '<cross-session-message from="uds:x" from-name="api-1a2b">\ntags is now string[]\n</cross-session-message>', origin: { kind: 'peer' } });
      thread = (await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].thread;
      expect(thread).toHaveLength(1);
      expect(thread[0].deliveredAt).toEqual(expect.any(Number));
      // it has the message already: its next prompt doesn't repeat it
      expect((await prompt(WEB, 2)) ?? '').not.toMatch(/tags is now string\[\]/);

      // received with no report from the sender (a session without the mod): one post all the same
      await mod({ session: WEB, kind: 'receive', text: 'which endpoint?', from: '@api-1a2b' });
      thread = (await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].thread;
      expect(thread.at(-1)).toMatchObject({ by: API, to: [WEB], text: 'which endpoint?', native: true, deliveredAt: expect.any(Number) });

      // to someone outside the project: not Cora's to record
      await mod({ session: API, kind: 'send', to: 'someone-else-1234', text: 'hi' });
      expect((await srv.app.inject({ url: '/api/projects', headers: UI })).json().projects[0].thread).toHaveLength(2);
    } finally {
      await srv.close();
    }
  });

  it('a project post between two members with the mod goes natively; to an idle member it waits for your OK, then their mod gets it; on its own when the project lets them; busy, at once', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u' }), { tail: false, listen: false, ci: false, security: false });
    const inbox = (sid: string) => srv.app.inject({ url: `/api/mod/inbox?session=${sid}`, headers: { 'x-cora-token': 'hooktok' } }).then((r) => r.json().items as Array<{ kind: string; to?: string; text: string }>);
    const rpc = (name: string, args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    const tool = (sid: string, name: string, args: object) => srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': sid, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: rpc(name, args) });
    const projects = async () => (await srv.app.inject({ url: '/api/projects', headers: UI })).json();
    try {
      const now = Date.now();
      srv.store.upsertSession({ id: API, alias: 'API', cwd: 'C:/work/api', state: 'idle', startedAt: now, lastTs: now } as never);
      srv.store.upsertSession({ id: WEB, alias: 'Web', cwd: 'C:/work/web', state: 'idle', startedAt: now, lastTs: now } as never);
      const p = (await srv.app.inject({ method: 'POST', url: '/api/projects', headers: UI, payload: { name: 'Tags', sessionId: API } })).json().project;
      await srv.app.inject({ method: 'POST', url: `/api/projects/${p.id}/sessions`, headers: UI, payload: { sessionId: WEB } });
      for (const sid of [API, WEB]) await mod({ session: sid, kind: 'start' });
      expect((await srv.app.inject({ url: `/api/mod/inbox?session=${API}` })).statusCode).toBe(401);

      // the web session's mod is asking Cora for messages: a handoff to it, idle, waits for your OK (a card). Claude Code
      // lets a session send only when its own turn decides to, so Cora never sends it natively as its writer.
      const webAsks = inbox(WEB);
      await new Promise((r) => setTimeout(r, 30));
      await tool(API, 'project_post', { kind: 'handoff', text: 'done, your turn', to: [WEB] });
      let post = (await projects()).projects[0].thread.at(-1);
      expect(post).toMatchObject({ kind: 'handoff' });
      expect(post.sentNative).toBeUndefined();
      const { wakes } = await projects();
      expect(wakes).toEqual([expect.objectContaining({ from: API, to: WEB, post: post.id })]);
      // you OK it: the web session's mod gets it as a turn, and it's delivered
      expect((await srv.app.inject({ method: 'POST', url: `/api/projects/wakes/${wakes[0].id}`, headers: UI, payload: { allow: true } })).json()).toMatchObject({ woke: true });
      expect(await webAsks).toEqual([{ id: expect.any(String), kind: 'submit', text: '(from "API", in the project "Tags":) done, your turn' }]);
      post = (await projects()).projects[0].thread.at(-1);
      expect(post.deliveredAt).toEqual(expect.any(Number));

      // the project lets them wake each other: a direct message to the idle web session goes straight through
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { autoWake: true } });
      await mod({ session: API, kind: 'send', to: 'web-9f8e', text: 'one more thing' });
      expect((await mod({ session: WEB, kind: 'receive', text: '<cross-session-message from-name="api-1a2b">\none more thing\n</cross-session-message>' })).json().hold).toBeUndefined();
      expect((await projects()).projects[0].thread.at(-1)).toMatchObject({ text: 'one more thing', native: true, deliveredAt: expect.any(Number) });

      // a message waking an idle member arrives as a prompt: Cora's prompt hook holds it (a card), before it counts as a turn
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { autoWake: false } });
      await mod({ session: API, kind: 'send', to: 'web-9f8e', text: 'are you there?' });
      const wake = await srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: WEB, cwd: 'C:/work/web', prompt: 'Another Claude session sent a message:\n<cross-session-message from="uds:x" from-name="api-1a2b" from-mode="prompting">\nare you there?\n</cross-session-message>\n\nThis came from another Claude session.', prompt_id: 'w1' } });
      expect(wake.json()).toEqual({ decision: 'block', reason: expect.stringMatching(/OKs waking/) });
      expect((await projects()).wakes).toEqual([expect.objectContaining({ from: API, to: WEB })]);
      expect((await projects()).projects[0].thread.at(-1)).toMatchObject({ text: 'are you there?', native: true });
      expect((await projects()).projects[0].thread.at(-1).deliveredAt).toBeUndefined();
      await srv.app.inject({ method: 'POST', url: `/api/projects/wakes/${(await projects()).wakes[0].id}`, headers: UI, payload: { allow: false } });

      // busy: it reads it at its next tool round, no card, whatever the project says
      await srv.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, headers: UI, payload: { autoWake: false } });
      srv.store.upsertSession({ id: WEB, state: 'working' } as never);
      expect((await mod({ session: WEB, kind: 'receive', text: 'from-name="api-1a2b" while you work' })).json().hold).toBeUndefined();
      expect((await projects()).wakes).toEqual([]);
    } finally {
      await srv.close();
    }
  });
});
