import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_HEADER, BUILDER_FIRST_PROMPT, type TerminalInfo } from '@cora/shared';
import { drill } from '@cora/shared/test/fixtures';
import { loadConfig, type Config } from '../src/config';
import { startServer, type Running } from '../src/server';
import { BUILDER_ALLOWED, BUILDER_HEADER, BuilderSessions, builderMcpHeaders } from '../src/builder';
import { Projects } from '../src/projects';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-builder-session-'))));
afterEach(() => (vi.useRealTimers(), rmSync(dir, { recursive: true, force: true })));

/** Terminals as the builder sees them: launched, listed, typed into, ended. */
function fakePtys() {
  const terms: TerminalInfo[] = [];
  const launched: Array<Record<string, unknown>> = [];
  const typed: string[] = [];
  const ended: string[] = [];
  let screen: string[] = [];
  let n = 0;
  // an ended terminal exits at once, unless told it lingers (as a real one does, for a moment)
  let lingers = false;
  return {
    terms, launched, typed, ended, setScreen: (s: string[]) => (screen = s), linger: () => (lingers = true),
    ptys: {
      launch: (req: Record<string, unknown>) => {
        launched.push(req);
        const t = { terminalId: `t${++n}`, sessionId: (req.mode === 'resume' ? req.sessionId : req.newId) as string, cwd: req.cwd as string, mode: req.mode, alive: true, startedAt: 1000 } as TerminalInfo;
        terms.push(t);
        return t;
      },
      list: () => terms,
      write: (_id: string, d: string) => void typed.push(d),
      screenLines: () => screen,
      end: (id: string) => {
        ended.push(id);
        const t = terms.find((x) => x.terminalId === id);
        if (t && !lingers) t.alive = false;
        return true;
      },
    },
  };
}

describe('the builder session', () => {
  /** `unheard`: no screen takes what Talk is told */
  const make = (o: { unheard?: boolean } = {}) => {
    vi.useFakeTimers();
    let now = 1000;
    let seen = false;
    const dismissed: string[] = [];
    const troubles: Array<[string, string]> = [];
    const pr = new Projects(null);
    const pid = pr.create('Drill').id;
    pr.setTeam(pid, drill(), 'you');
    const f = fakePtys();
    const b = new BuilderSessions({ dataDir: dir, projectsDir: join(dir, 'projects'), port: 4317, hookToken: 'hooktok', key: 'agentkey', ptys: f.ptys as never, projects: pr, model: () => 'opus', seenSince: () => seen, dismiss: (sid) => void dismissed.push(sid), trouble: (p, e) => (troubles.push([p, e]), !o.unheard), now: () => now });
    return { b, pr, pid, f, dismissed, troubles, up: () => (seen = true), later: (ms: number) => (now += ms) };
  };

  it('started on your first words: its own folder, its first prompt, only its tools; your words wait until it is up', () => {
    const { b, pr, pid, f, up, later } = make();
    expect(b.say(pid, 'I need a team that watches our encoders')).toEqual({ ok: true, started: true });
    const req = f.launched[0];
    const sid = pr.draft(pid)!.session!;
    expect(req).toMatchObject({ mode: 'new', newId: sid, bare: true, prompt: BUILDER_FIRST_PROMPT, cwd: join(dir, 'builder', pid) });
    const args = req.args as string[];
    expect(args).toEqual(expect.arrayContaining(['--strict-mcp-config', '--tools', 'Skill', '--allowedTools', BUILDER_ALLOWED, '--model', 'opus']));
    expect(readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8')).toMatch(/^You are Cora/);
    // its MCP config names it and carries its proof (so Cora's server gives it its three tools), never Cora's agent key
    const headers = JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.cora.headers;
    expect(headers['x-cora-session']).toBe(sid);
    expect(headers[BUILDER_HEADER]).toBe(builderMcpHeaders('agentkey', sid)[BUILDER_HEADER]);
    expect(headers[AGENT_HEADER]).toBeUndefined();
    expect(readFileSync(join(dir, 'builder', pid, '.claude', 'skills', 'team-building', 'SKILL.md'), 'utf8')).toMatch(/^---\nname: team-building\n/);
    // it knows the team may name its lead, so it can set one when the user asks
    expect(readFileSync(join(dir, 'builder', pid, '.claude', 'skills', 'team-building', 'SKILL.md'), 'utf8')).toContain('- **lead** (optional): the id of the seat that leads');
    b.tick();
    expect(f.typed).toEqual([]);
    up();
    b.tick();
    later(1600);
    b.tick();
    expect(f.typed[0]).toContain('I need a team that watches our encoders');
    vi.advanceTimersByTime(200);
    expect(f.typed.at(-1)).toBe('\r');
  });

  it('started once: while it runs, your next words go to the same session', () => {
    const { b, pid, f } = make();
    b.say(pid, 'one');
    expect(b.say(pid, 'two')).toEqual({ ok: true });
    expect(f.launched).toHaveLength(1);
  });

  it("its folder's trust question is answered (the folder is Cora's own); nothing else is typed meanwhile", () => {
    const { b, pid, f, up } = make();
    b.say(pid, 'hello');
    up();
    f.setScreen(['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit']);
    b.tick();
    expect(f.typed).toEqual(['\r']);
  });

  it("a trust question in any other folder is never answered", () => {
    const { b, pid, f, up } = make();
    b.say(pid, 'hello');
    up();
    f.terms[0].cwd = join(dir, 'elsewhere');
    f.setScreen(['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit']);
    b.tick();
    expect(f.typed).toEqual([]);
  });

  it('resumed the next time (its session kept while the builder was closed); a new one when there is no transcript', () => {
    const { b, pr, pid, f } = make();
    b.say(pid, 'one');
    const sid = pr.draft(pid)!.session!;
    b.rest(pid);
    expect(f.ended).toEqual(['t1']);
    expect(pr.draft(pid)!.session).toBe(sid);
    mkdirSync(join(dir, 'projects', 'x'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'x', `${sid}.jsonl`), '');
    expect(b.say(pid, 'two')).toEqual({ ok: true, started: true });
    expect(f.launched[1]).toMatchObject({ mode: 'resume', sessionId: sid });
    expect(f.launched[1].prompt).toBeUndefined();
    b.rest(pid);
    rmSync(join(dir, 'projects'), { recursive: true });
    b.say(pid, 'three');
    expect(f.launched[2].mode).toBe('new');
    expect(pr.draft(pid)!.session).not.toBe(sid);
  });

  it('ended for good (applied or discarded): its terminal ends and it leaves the session lists', () => {
    const { b, pr, pid, f, dismissed } = make();
    b.say(pid, 'one');
    const sid = pr.draft(pid)!.session!;
    expect(existsSync(join(dir, 'builder', pid))).toBe(true);
    pr.discardDraft(pid);
    b.end(pid, sid);
    expect(f.ended).toEqual(['t1']);
    expect(dismissed).toEqual([sid]);
    // its folder goes with it (its terminal has gone)
    expect(existsSync(join(dir, 'builder', pid))).toBe(false);
  });

  it('kept out of the session lists once its terminal has exited (its exit is newer than the dismissal)', () => {
    const { b, pr, pid, f, dismissed } = make();
    b.say(pid, 'one');
    const sid = pr.draft(pid)!.session!;
    f.linger();
    pr.discardDraft(pid);
    b.end(pid, sid);
    expect(dismissed).toEqual([sid]);
    vi.advanceTimersByTime(1000);
    expect(dismissed).toEqual([sid]);
    // its folder stays while its terminal is still on its way out
    expect(existsSync(join(dir, 'builder', pid))).toBe(true);
    f.terms[0].alive = false;
    vi.advanceTimersByTime(500);
    expect(dismissed).toEqual([sid, sid]);
    expect(existsSync(join(dir, 'builder', pid))).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(dismissed).toEqual([sid, sid]);
  });

  it("ready on screen counts as heard from: a resumed session says nothing until it is spoken to, so it is not waited on for ever", () => {
    const { b, pid, f, later } = make();
    const RULE = "─".repeat(60);
    f.setScreen(["older lines", RULE, "❯ ", RULE, "  ? for shortcuts"]);
    b.say(pid, "add an analyst");
    b.tick();
    later(1600);
    b.tick();
    vi.advanceTimersByTime(1000);
    expect(f.typed.filter((x) => x !== '\r')).toEqual(['add an analyst']);
  });

  it('your words are typed as words: a leading "/", "!" or "#" never runs as a command, a shell line or a memory', () => {
    // (typed key by key: a second message into her terminal waits until the first is sent)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const { b, pid, f, up, later } = make();
      b.say(pid, '/clear');
      b.say(pid, '!rm -rf .');
      up();
      b.tick();
      later(1600);
      b.tick();
      b.tick();
      vi.advanceTimersByTime(2000);
      expect(f.typed.filter((x) => x !== '\r')).toEqual(['\u200B/clear', '\u200B!rm -rf .']);
      expect(f.typed.filter((x) => x === '\r')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never heard from in 90 seconds: your words are given up on, Talk is told why, and it ends; your next words start it afresh', () => {
    const { b, pid, f, troubles, up, later } = make();
    b.say(pid, 'hello');
    later(89_000);
    b.tick();
    expect(troubles).toEqual([]);
    later(1_000);
    b.tick();
    expect(troubles).toEqual([[pid, "Cora's session didn't start: nothing was heard from it in 90 seconds."]]);
    expect(f.ended).toEqual(['t1']);
    expect(f.typed).toEqual([]);
    // the open builder showed why: what you say next is never dropped
    expect(b.say(pid, 'again')).toEqual({ ok: true, started: true });
    expect(f.launched).toHaveLength(2);
    up();
    b.tick();
    later(1600);
    b.tick();
    expect(f.typed[0]).toBe('again');
  });

  it('a failure no screen heard: your next Talk is told why instead (once), then it starts afresh', () => {
    const { b, pid, f, later } = make({ unheard: true });
    b.say(pid, 'hello');
    later(90_000);
    b.tick();
    expect(b.say(pid, 'again')).toEqual({ ok: false, error: "Cora's session didn't start: nothing was heard from it in 90 seconds. Say it again." });
    expect(b.say(pid, 'again')).toEqual({ ok: true, started: true });
    expect(f.launched).toHaveLength(2);
  });

  it('its terminal gone before your words reached it: Talk is told', () => {
    const { b, pid, f, troubles } = make();
    b.say(pid, 'hello');
    f.terms[0].alive = false;
    b.tick();
    expect(troubles).toEqual([[pid, "Cora's session ended before she heard you."]]);
  });

  it('words it cannot take (nothing readable once control characters go): Talk is told', () => {
    const { b, pid, f, troubles, up, later } = make();
    b.say(pid, '\x01\x02');
    up();
    b.tick();
    later(1600);
    b.tick();
    expect(f.typed).toEqual([]);
    expect(troubles).toEqual([[pid, "Cora couldn't take what you said: it has no words she can read."]]);
  });

  it('closed and talked to again at once: it waits for the old terminal to go, then resumes; nothing is typed into the old one', () => {
    const { b, pr, pid, f, up, later } = make();
    b.say(pid, 'one');
    const sid = pr.draft(pid)!.session!;
    mkdirSync(join(dir, 'projects', 'x'), { recursive: true });
    writeFileSync(join(dir, 'projects', 'x', `${sid}.jsonl`), '');
    f.linger();
    b.rest(pid);
    up();
    expect(b.say(pid, 'two')).toEqual({ ok: true, started: true });
    later(1600);
    b.tick();
    expect(f.launched).toHaveLength(1);
    expect(f.typed).toEqual([]);
    f.terms[0].alive = false;
    vi.advanceTimersByTime(500);
    expect(f.launched[1]).toMatchObject({ mode: 'resume', sessionId: sid });
    later(1600);
    b.tick();
    expect(f.typed[0]).toBe('two');
  });

  it('closed and talked to again, but the old terminal never goes: after 90 seconds your words are given up on, and Talk is told why', () => {
    const { b, pid, f, troubles, later } = make();
    b.say(pid, 'one');
    f.linger();
    b.rest(pid);
    expect(b.say(pid, 'two')).toEqual({ ok: true, started: true });
    later(89_000);
    b.tick();
    expect(troubles).toEqual([]);
    later(1_000);
    b.tick();
    expect(troubles).toEqual([[pid, "Cora's session didn't start again: her last one still hadn't closed after 90 seconds."]]);
    expect(f.launched).toHaveLength(1);
    expect(f.typed).toEqual([]);
  });

  it("a trust question with No highlighted: down to Yes first", () => {
    const { b, pid, f } = make();
    b.say(pid, 'hello');
    f.setScreen(['Do you trust the files in this folder?', '  1. Yes, proceed', '❯ 2. No, exit']);
    b.tick();
    expect(f.typed).toEqual(['\x1b[B']);
  });

  it("Cora can't start it: said so, nothing queued", () => {
    const { b, pid, f } = make();
    f.ptys.launch = () => {
      throw new Error('folder not found');
    };
    expect(b.say(pid, 'hello')).toEqual({ ok: false, error: "Cora couldn't start: folder not found" });
  });
});

describe('the builder session, through the app', () => {
  let srv: Running;
  let cfg: Config;
  let spawned: string[][];
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const req = (method: 'POST' | 'DELETE' | 'PUT', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  beforeEach(async () => {
    spawned = [];
    const fakeSpawn = (file: string, args: string[]) => (spawned.push([file, ...args]), { onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    cfg = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope'), projectsDir: join(dir, 'projects') });
    srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never });
  });
  afterEach(async () => srv.close());

  it('Talk starts it once; Discard ends it and takes it out of the session lists', async () => {
    const pid = (await req('POST', '/api/projects', { name: 'Drill' })).json().project.id;
    srv.projects.setTeam(pid, drill(), 'you');
    expect((await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'hello' })).json()).toEqual({ ok: true, started: true });
    expect((await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'again' })).json()).toEqual({ ok: true });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toEqual(expect.arrayContaining(['--strict-mcp-config', '--tools', 'Skill', BUILDER_FIRST_PROMPT]));
    const sid = srv.projects.draft(pid)!.session!;
    expect(existsSync(join(dir, 'builder', pid, 'mcp.json'))).toBe(true);
    // its proof is made with Cora's own server-only key: Cora's MCP server gives it the builder's tools
    expect(JSON.parse(readFileSync(join(dir, 'builder', pid, 'mcp.json'), 'utf8')).mcpServers.cora.headers).toMatchObject(builderMcpHeaders(cfg.agentToken, sid));
    srv.store.upsertSession({ id: sid, cwd: join(dir, 'builder', pid), state: 'idle', startedAt: Date.now(), lastTs: Date.now() } as never);
    expect((await req('POST', `/api/projects/${pid}/builder/close`, {})).json()).toEqual({ ok: true });
    expect(srv.projects.draft(pid)!.session).toBe(sid);
    expect((await req('DELETE', `/api/projects/${pid}/builder`)).json()).toEqual({ ok: true });
    expect(srv.store.getSession(sid)!.dismissedAt).toBeGreaterThan(0);
    expect((await req('POST', `/api/projects/${pid}/builder/talk`, { text: ' ' })).statusCode).toBe(400);
  });
});

describe("the builder session is nobody else's", () => {
  let srv: Running;
  let cfg: Config;
  const AGENT = 'cora-agent-0001';
  const PLAIN = 'sess-plain-0001';
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const req = (method: 'POST' | 'DELETE' | 'GET', url: string, payload?: object) => srv.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  const hook = (event: string, sid: string, cwd: string, extra: object = {}) => srv.app.inject({ method: 'POST', url: `/hook/${event}`, headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd, ...extra } });
  // Cora's own agent calling her tools (her session id and her own key)
  const asCora = (name: string, args: object) =>
    srv.app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'hooktok', 'x-cora-session': AGENT, [AGENT_HEADER]: cfg.agentToken, accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } } }).then((r) => r.json().result as { isError?: boolean; content: Array<{ text: string }> });
  beforeEach(async () => {
    mkdirSync(join(dir, 'orchestrator'), { recursive: true });
    writeFileSync(join(dir, 'orchestrator', 'state.json'), JSON.stringify({ sessionId: AGENT }));
    const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
    cfg = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope'), projectsDir: join(dir, 'projects') });
    srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never });
  });
  afterEach(async () => (vi.restoreAllMocks(), srv.close()));

  /** a project whose builder session is running (Cora heard from it), and a plain session beside it */
  const setup = async () => {
    const pid = (await req('POST', '/api/projects', { name: 'Drill' })).json().project.id as string;
    srv.projects.setTeam(pid, drill(), 'you');
    await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'hello' });
    const sid = srv.projects.draft(pid)!.session!;
    const bdir = join(dir, 'builder', pid);
    await hook('UserPromptSubmit', sid, bdir, { prompt: BUILDER_FIRST_PROMPT, prompt_id: `${sid}-p1` });
    await hook('UserPromptSubmit', PLAIN, 'C:/work/x', { prompt: 'fix the bug', prompt_id: `${PLAIN}-p1` });
    return { pid, sid, bdir };
  };

  it("Cora's sessions tool never lists it and her send tool can't type into it", async () => {
    const { sid } = await setup();
    expect((await req('POST', '/api/settings', { orchestrator: { enabled: true } })).statusCode).toBe(200);
    const listed =(await asCora('sessions', {})).content[0].text;
    expect(listed).toContain(PLAIN);
    expect(listed).not.toContain(sid);
    const sent = await asCora('send_to_session', { id: sid, text: 'do something else' });
    expect(sent.isError).toBe(true);
    expect(sent.content[0].text).toMatch(/No session/);
  });

  it('its turns ending never ping you as "finished" (a plain session\'s do)', async () => {
    const { CoraBot } = await import('../src/slackBot');
    const alert = vi.spyOn(CoraBot.prototype, 'alert');
    const { sid, bdir } = await setup();
    await hook('Stop', sid, bdir);
    await hook('Stop', PLAIN, 'C:/work/x');
    const finished = alert.mock.calls.map((c) => c[0] as { kind: string; sessionId?: string }).filter((a) => a.kind === 'finished');
    expect(finished.map((a) => a.sessionId)).toEqual([PLAIN]);
  });

  it("History never lists its transcripts, and it can't be resumed as a plain session", async () => {
    const { sid, bdir } = await setup();
    const put = (cwd: string, id: string) => {
      const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
      mkdirSync(join(dir, 'projects', slug), { recursive: true });
      writeFileSync(join(dir, 'projects', slug, `${id}.jsonl`), `${JSON.stringify({ type: 'user', cwd, message: { content: 'hi' } })}\n`);
    };
    put(bdir, sid);
    put(join(dir, 'work'), PLAIN);
    const ids = (await req('GET', '/api/history')).json().sessions.map((h: { sessionId: string }) => h.sessionId);
    expect(ids).toEqual([PLAIN]);
    const r = await req('POST', '/api/terminals', { mode: 'resume', cwd: bdir, sessionId: sid });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.json())).toMatch(/team builder/);
  });
});

describe('the builder session through the app: when Cora cannot start it, and when its project goes', () => {
  let srv: Running | undefined;
  let cfg: Config;
  const UI = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const req = (method: 'POST' | 'DELETE', url: string, payload?: object) => srv!.app.inject({ method, url, headers: UI, ...(payload ? { payload } : {}) });
  /** `fail`: Claude can't be started; otherwise a terminal exits on Ctrl+C, as Claude Code does */
  const boot = async (o: { fail?: boolean } = {}) => {
    const fakeSpawn = () => {
      if (o.fail) throw new Error('claude was not found');
      let exit: ((e: { exitCode: number }) => void) | null = null;
      return { onData() {}, onExit: (cb: (e: { exitCode: number }) => void) => void (exit = cb), write: (d: string) => void (d === '\x03' && setTimeout(() => exit?.({ exitCode: 0 }), 10)), resize() {}, kill() {} };
    };
    cfg = loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'u', clientDir: join(tmpdir(), 'nope'), projectsDir: join(dir, 'projects') });
    srv = await startServer(cfg, { tail: false, listen: false, ci: false, security: false, spawn: fakeSpawn as never });
    const pid = (await req('POST', '/api/projects', { name: 'Drill' })).json().project.id as string;
    srv.projects.setTeam(pid, drill(), 'you');
    return { pid, s: srv };
  };
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it("Cora can't start it: 503 with a plain reason", async () => {
    const { pid } = await boot({ fail: true });
    const r = await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'hello' });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toMatch(/^Cora couldn't start: /);
  });

  it('terminals off: 503 with a plain reason', async () => {
    const { pid, s } = await boot();
    const { buildApp } = await import('../src/app');
    const { Hub } = await import('../src/hub');
    const bare = await buildApp({ config: cfg, store: s.store, hub: new Hub(s.store, () => [], 50, () => []), pipeline: s.pipeline, pending: s.pending, projects: s.projects });
    try {
      const r = await bare.inject({ method: 'POST', url: `/api/projects/${pid}/builder/talk`, headers: UI, payload: { text: 'hello' } });
      expect(r.statusCode).toBe(503);
      expect(r.json().error).toBe("Cora can't start a session here (terminals are off).");
    } finally {
      await bare.close();
    }
  });

  it('archived: its session rests (the draft stays); removed: it ends, leaves the lists, and its folder goes', async () => {
    const { pid, s } = await boot();
    const bdir = join(dir, 'builder', pid);
    const running = () => s.ptys.list().some((t) => t.alive && t.cwd === bdir);
    await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'hello' });
    const sid = s.projects.draft(pid)!.session!;
    expect(running()).toBe(true);
    expect((await req('POST', `/api/projects/${pid}/archive`, { on: true })).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(running()).toBe(false));
    expect(s.projects.draft(pid)!.session).toBe(sid);
    expect(existsSync(bdir)).toBe(true);
    // talked to while archived: refused plainly (nothing starts)
    const refused = await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'still there?' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('The project is archived: bring it back to talk to Cora about its team.');
    expect(running()).toBe(false);
    // back from the archive and talked to: it starts again; archived and removed, it goes for good
    await req('POST', `/api/projects/${pid}/archive`, { on: false });
    expect((await req('POST', `/api/projects/${pid}/builder/talk`, { text: 'again' })).json()).toMatchObject({ ok: true, started: true });
    const sid2 = s.projects.draft(pid)!.session!;
    s.store.upsertSession({ id: sid2, cwd: bdir, state: 'idle', startedAt: Date.now(), lastTs: Date.now() } as never);
    await req('POST', `/api/projects/${pid}/archive`, { on: true });
    await vi.waitFor(() => expect(running()).toBe(false));
    expect((await req('DELETE', `/api/projects/${pid}`)).json()).toEqual({ ok: true });
    await vi.waitFor(() => expect(existsSync(bdir)).toBe(false));
    expect(s.store.getSession(sid2)!.dismissedAt).toBeGreaterThan(0);
  });
});
