import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { BrainEvent, SessionInfo } from '@cora/shared';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';
import { isNamerCwd, isNamerSlug, namePrompt, Namer, namerArgs, namerDir, namerEnv, parseNamed, sanitizeName, wantsAutoName, type RunFn } from '../src/namer';

describe('namer helpers', () => {
  it('builds the prompt around the message, trimmed to ~1500 characters', () => {
    expect(namePrompt('  fix the hooks sink  ')).toBe('Name the session that begins with this message:\n\n<message>\nfix the hooks sink\n</message>');
    const long = namePrompt('x'.repeat(5000));
    expect(long).toContain('x'.repeat(1500) + '…');
    expect(long).not.toContain('x'.repeat(1501));
  });

  it('sanitizes the reply: quotes, markdown, labels, trailing punctuation', () => {
    expect(sanitizeName('"Fix hooks sink."')).toBe('Fix hooks sink');
    expect(sanitizeName('**Jira 2.9 prod audit**\n')).toBe('Jira 2.9 prod audit');
    expect(sanitizeName('Name: Add dark mode toggle!')).toBe('Add dark mode toggle');
    expect(sanitizeName('# `Cora` session names')).toBe('Cora session names');
    expect(sanitizeName('\n\nFix hooks sink\nBecause the prompt is about hooks.')).toBe('Fix hooks sink');
    expect(sanitizeName('I18n string cleanup')).toBe('I18n string cleanup');
    expect(sanitizeName('fix_snake_case names')).toBe('fix_snake_case names');
  });

  it('caps names at 40 characters on a word boundary', () => {
    const n = sanitizeName('Investigate intermittent websocket reconnection storms')!;
    expect(n.length).toBeLessThanOrEqual(40);
    expect(n).toBe('Investigate intermittent websocket');
    expect(sanitizeName('Supercalifragilisticexpialidocious-and-more-and-more')).toBeNull();
  });

  it('falls back to nothing on junk', () => {
    expect(sanitizeName('')).toBeNull();
    expect(sanitizeName('  \n ')).toBeNull();
    expect(sanitizeName('"..."')).toBeNull();
    expect(sanitizeName("I can't help with that request.")).toBeNull();
    expect(sanitizeName('Sure! Here is a name')).toBeNull();
    expect(sanitizeName('This session is about fixing the hook sink so that events are not dropped')).toBeNull();
  });

  it("recognises the namer's folder by cwd and by its projects slug", () => {
    const dir = 'C:\\Users\\you\\.cora\\namer';
    expect(namerDir('C:\\Users\\you\\.cora')).toBe(join('C:\\Users\\you\\.cora', 'namer'));
    expect(isNamerCwd('c:/users/you/.cora/namer/', dir)).toBe(true);
    expect(isNamerCwd('C:\\Users\\you\\.cora', dir)).toBe(false);
    expect(isNamerCwd(undefined, dir)).toBe(false);
    expect(isNamerSlug('C--Users-you--cora-namer', dir)).toBe(true);
    expect(isNamerSlug('c--users-you--cora-namer', dir)).toBe(true);
    expect(isNamerSlug('C--code-cora', dir)).toBe(false);
  });

  it('runs headless Haiku with no tools, no transcript and no hooks', () => {
    const a = namerArgs('D');
    expect(a.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(a[a.indexOf('--tools') + 1]).toBe('');
    for (const f of ['--no-session-persistence', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands']) expect(a).toContain(f);
    expect(a[a.indexOf('--settings') + 1]).toBe(join('D', 'settings.json'));
  });

  it("drops Claude Code session markers and Cora's variables from the environment", () => {
    const env = namerEnv({ PATH: 'p', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CORA_TOKEN: 't', AGENT_BRAIN_TOKEN: 't', CORA_HOME: 'h', CLAUDE_CODE_USE_BEDROCK: '1' });
    expect(env).toEqual({ PATH: 'p', CLAUDE_CODE_USE_BEDROCK: '1' });
  });

  it('auto-names only a fresh first prompt, when on, for an unnamed session', () => {
    const now = 1_000_000;
    const e = { kind: 'prompt', agentId: 'main', ts: now - 1000, text: 'fix the hooks sink' } as BrainEvent;
    const s = { id: 's1' } as SessionInfo;
    const on = { autoName: true };
    expect(wantsAutoName(e, s, on, false, now)).toBe(true);
    expect(wantsAutoName(e, s, { autoName: false }, false, now)).toBe(false);
    expect(wantsAutoName(e, undefined, on, false, now)).toBe(false);
    expect(wantsAutoName(e, { ...s, alias: 'mine' }, on, false, now)).toBe(false);
    expect(wantsAutoName(e, { ...s, autoName: 'Done already' }, on, false, now)).toBe(false);
    expect(wantsAutoName(e, s, on, true, now)).toBe(false); // not the first prompt
    expect(wantsAutoName({ ...e, ts: now - 3600_000 }, s, on, false, now)).toBe(false); // backfill
    expect(wantsAutoName({ ...e, agentId: 'a1' }, s, on, false, now)).toBe(false);
    expect(wantsAutoName({ ...e, text: 'hi' }, s, on, false, now)).toBe(false);
  });
});

/** A stand-in for `claude -p`: records calls, answers after `ms`. */
function fakeRun(reply: string | ((input: string) => string), ms = 5) {
  const calls: Array<{ cmd: string[]; cwd: string; input: string; env: NodeJS.ProcessEnv }> = [];
  let running = 0;
  let maxRunning = 0;
  const run: RunFn = async (cmd, o) => {
    calls.push({ cmd, cwd: o.cwd, input: o.input, env: o.env });
    running++;
    maxRunning = Math.max(maxRunning, running);
    await new Promise((r) => setTimeout(r, ms));
    running--;
    return { code: 0, stdout: typeof reply === 'string' ? reply : reply(o.input), timedOut: false };
  };
  return { run, calls, max: () => maxRunning };
}

describe('Namer', () => {
  it('runs one at a time, in its own folder, once per session', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-namer-'));
    const f = fakeRun((input) => (input.includes('alpha') ? '"Alpha work."' : 'Beta work'));
    const names: Record<string, string> = {};
    const n = new Namer({ dataDir, run: f.run, claudeCmd: ['claude'], onName: (sid, name) => (names[sid] = name) });
    n.auto('s1', 'alpha task');
    n.auto('s1', 'alpha task again');
    const beta = n.suggest('s2', 'beta task');
    expect(await beta).toBe('Beta Work');
    expect(names).toEqual({ s1: 'Alpha Work', s2: 'Beta Work' });
    expect(f.calls).toHaveLength(2);
    expect(f.max()).toBe(1);
    expect(f.calls[0].cwd).toBe(n.dir);
    expect(f.calls[0].cmd.slice(0, 4)).toEqual(['claude', '-p', '--model', 'haiku']);
    expect(f.calls[0].input).toContain('alpha task');
  });

  it('gives nothing on a timeout or a failed run', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-namer-'));
    let names = 0;
    const timedOut: RunFn = async () => ({ code: null, stdout: 'Half a name', timedOut: true });
    expect(await new Namer({ dataDir, run: timedOut, claudeCmd: ['claude'], onName: () => names++ }).suggest('s', 'x y z')).toBeNull();
    const failed: RunFn = async () => ({ code: 1, stdout: 'Not logged in', timedOut: false });
    expect(await new Namer({ dataDir, run: failed, claudeCmd: ['claude'], onName: () => names++ }).suggest('s', 'x y z')).toBeNull();
    expect(names).toBe(0);
  });
});

describe('auto-names in the server', () => {
  let srv: Running | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });
  const cfg = () => loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'ab-nm-')), dbPath: ':memory:', hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope-client') });
  const ui = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
  const prompt = (sid: string, text: string, cwd = 'C:\\code\\x', id = `${sid}-p1`) =>
    srv!.pipeline.ingestHook('UserPromptSubmit', { session_id: sid, cwd, transcript_path: `C:\\t\\${sid}.jsonl`, hook_event_name: 'UserPromptSubmit', prompt_id: id, prompt: text });
  const settle = () => new Promise((r) => setTimeout(r, 40));

  it('names a new session from its first prompt when the setting is on', async () => {
    const f = fakeRun('Fix hooks sink');
    srv = await startServer(cfg(), { tail: false, listen: false, namerRun: f.run });
    prompt('s0', 'the hooks sink drops events');
    await settle();
    expect(f.calls).toHaveLength(0); // off by default
    expect((await srv.app.inject({ method: 'POST', url: '/api/settings', headers: ui, payload: { autoName: true } })).json().autoName).toBe(true);
    prompt('s1', 'the hooks sink drops events');
    prompt('s1', 'and add a test', 'C:\\code\\x', 'p2');
    await settle();
    expect(f.calls).toHaveLength(1);
    expect(srv.store.getSession('s1')?.autoName).toBe('Fix Hooks Sink');
    expect(srv.store.getSession('s0')?.autoName).toBeUndefined();
  });

  it("never turns the namer's own run into a session (hooks or transcript)", async () => {
    const config = cfg();
    srv = await startServer(config, { tail: false, listen: false, namerRun: fakeRun('x').run });
    const dir = namerDir(config.dataDir);
    prompt('ghost', 'Name the session that begins with this message', dir);
    srv.pipeline.ingestHook('SessionStart', { session_id: 'ghost', cwd: dir, hook_event_name: 'SessionStart' });
    srv.pipeline.ingestTranscript('t.jsonl', [{ type: 'user', sessionId: 'ghost2', message: { role: 'user', content: 'hi' }, uuid: 'u1', timestamp: new Date().toISOString() }], {
      sessionId: 'ghost2', agentId: 'main', projectSlug: dir.replace(/[^a-zA-Z0-9]/g, '-'),
    });
    srv.pipeline.ingestTranscript('t2.jsonl', [{ type: 'user', sessionId: 'ghost3', cwd: dir, message: { role: 'user', content: 'hi' }, uuid: 'u2', timestamp: new Date().toISOString() }], {
      sessionId: 'ghost3', agentId: 'main', projectSlug: 'somewhere-else',
    });
    const r = await srv.app.inject({ method: 'POST', url: '/hook/PermissionRequest', headers: { 'x-cora-token': 'h' }, payload: { session_id: 'ghost', cwd: dir, tool_name: 'Bash', tool_input: {} } });
    expect(r.json()).toEqual({});
    expect(srv.store.listSessions()).toEqual([]);
    expect(srv.pending.list()).toEqual([]);
  });

  it('"Suggest a name" works with the setting off and replaces the alias', async () => {
    const f = fakeRun('Jira 2.9 prod audit');
    srv = await startServer(cfg(), { tail: false, listen: false, namerRun: f.run });
    const none = await srv.app.inject({ method: 'POST', url: '/api/sessions/nope/autoname', headers: ui });
    expect(none.statusCode).toBe(404);
    prompt('s1', 'audit the chat 2.9 prod rollout');
    srv.store.upsertSession({ id: 's1', alias: 'mine' });
    const r = await srv.app.inject({ method: 'POST', url: '/api/sessions/s1/autoname', headers: ui });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 's1', autoName: 'Jira 2.9 Prod Audit', alias: null });
    expect(f.calls[0].input).toContain('audit the chat 2.9 prod rollout');
  });
});

describe('a name in Title Case, and an icon', () => {
  it('reads "Name | Icon": Title Case, the icon checked against the list (any case or dashes), none when unknown', () => {
    expect(parseNamed('Ship release 2.4 | Rocket')).toEqual({ name: 'Ship Release 2.4', icon: 'Rocket' });
    expect(parseNamed('"fix the login redirect" | key-round\nbecause…')).toEqual({ name: 'Fix the Login Redirect', icon: 'KeyRound' });
    expect(parseNamed('Load test search API | Speedometer')).toEqual({ name: 'Load Test Search API', icon: null });
    expect(parseNamed('Add dark mode toggle')).toEqual({ name: 'Add Dark Mode Toggle', icon: null });
    expect(parseNamed("I can't help with that | Bug")).toBeNull();
  });

  it("tells the model the icons other sessions use, and hands the icon on with the name", async () => {
    expect(namePrompt('fix it', ['Rocket', 'Gauge', 'Rocket'])).toContain("Icons the user's other open sessions use: Rocket, Gauge");
    expect(namePrompt('fix it')).not.toContain('Icons the user');
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-namer-'));
    const got: Array<[string, string, string | null]> = [];
    let input = '';
    const run: RunFn = async (_c, o) => ((input = o.input), { code: 0, stdout: 'Wire the http sink | Webhook', timedOut: false });
    await new Namer({ dataDir, run, claudeCmd: ['claude'], onName: (sid, name, icon) => got.push([sid, name, icon]), iconsInUse: () => ['Rocket'] }).suggest('s1', 'wire the sink');
    expect(got).toEqual([['s1', 'Wire the Http Sink', 'Webhook']]);
    expect(input).toContain('Rocket');
  });
});

describe('icons for sessions named before icons', () => {
  it('asks for just an icon: the name stays, and an unknown icon gives nothing', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-namer-'));
    const named: string[] = [];
    const icons: Array<[string, string]> = [];
    let reply = 'Ship Release 2.4 | Rocket';
    const run: RunFn = async () => ({ code: 0, stdout: reply, timedOut: false });
    const n = new Namer({ dataDir, run, claudeCmd: ['claude'], onName: (sid) => named.push(sid), onIcon: (sid, icon) => icons.push([sid, icon]) });
    n.iconFor('s1', 'Ship Release 2.4\n\ncut the 2.4 release');
    await new Promise((r) => setTimeout(r, 50));
    reply = 'Something | NotAnIcon';
    n.iconFor('s2', 'Something');
    await new Promise((r) => setTimeout(r, 50));
    expect(icons).toEqual([['s1', 'Rocket']]);
    expect(named).toEqual([]);
  });
});
