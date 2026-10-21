import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { checkPrompt } from '../src/launch';
import { startServer, type Running } from '../src/server';

let srv: Running;
afterEach(async () => srv?.close());
const cfg = (dataDir = mkdtempSync(join(tmpdir(), 'ab-tix-')), dbPath = ':memory:') => loadConfig({ dataDir, dbPath, hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') });
const H = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
const fakeSpawn = () => ({ onData() {}, onExit() {}, write() {}, resize() {}, kill() {} });
const hook = (s: Running, event: string, body: Record<string, unknown>) => s.app.inject({ method: 'POST', url: `/hook/${event}`, headers: { 'x-cora-token': 'hooktok' }, payload: body });
const prompt = (s: Running, sid: string, text: string, n = 1) => hook(s, 'UserPromptSubmit', { session_id: sid, cwd: 'C:\\work\\x', prompt: text, prompt_id: `${sid}-p${n}` });
const meta = (s: Running, sid: string, body: unknown) => s.app.inject({ method: 'POST', url: `/api/sessions/${sid}/meta`, headers: H, payload: body as object });

describe('checkPrompt', () => {
  it('takes a short line of plain characters', () => {
    expect(checkPrompt(undefined)).toBeUndefined();
    expect(checkPrompt('')).toBeUndefined();
    expect(checkPrompt(' /jira ACME-5206 ')).toBe('/jira ACME-5206');
    expect(checkPrompt('look at ACME-5206, then fix it')).toBe('look at ACME-5206, then fix it');
  });
  it('refuses anything a shell or the CLI could read as more than a prompt', () => {
    for (const bad of ['--dangerously-skip-permissions', '-p hi', '/jira "x"', '/jira x & calc', '/jira x | y', '%PATH%', 'a^b', '/jira <x>', 'two\nlines', 'x'.repeat(201), 42])
      expect(() => checkPrompt(bad), String(bad)).toThrow();
  });
});

describe('a session started from a ticket', () => {
  it('gets the prompt as claude\'s positional argument, right after its session id, and is about the ticket', async () => {
    const calls: string[][] = [];
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: (_f, args) => (calls.push(args), fakeSpawn()) });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-term-'));
    const r = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload: { mode: 'new', cwd, prompt: '/jira ACME-5206', options: { model: 'opus' } } });
    expect(r.statusCode).toBe(200);
    const sid = r.json().sessionId;
    const args = calls[0];
    const at = args.indexOf('--session-id');
    expect(args.slice(at, at + 5)).toEqual(['--session-id', sid, '/jira ACME-5206', '--model', 'opus']);
    expect(srv.store.getSession(sid)?.ticket).toEqual({ key: 'ACME-5206', site: null, summary: null });
    // its own first prompt (the hook) doesn't change it
    await prompt(srv, sid, '/jira ACME-5206');
    expect(srv.store.getSession(sid)?.ticket?.key).toBe('ACME-5206');
  });

  it('refuses a bad prompt, and a prompt for anything but a new session', async () => {
    const calls: string[][] = [];
    srv = await startServer(cfg(), { tail: false, listen: false, spawn: (_f, args) => (calls.push(args), fakeSpawn()) });
    const cwd = mkdtempSync(join(tmpdir(), 'ab-term-'));
    srv.store.upsertSession({ id: 'old-1', cwd });
    for (const payload of [{ mode: 'new', cwd, prompt: '/jira x & calc' }, { mode: 'new', cwd, prompt: '--yolo' }, { mode: 'resume', sessionId: 'old-1', prompt: '/jira ACME-1' }]) {
      const bad = await srv.app.inject({ method: 'POST', url: '/api/terminals', headers: H, payload });
      expect(bad.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('a session\'s ticket from its first prompt', () => {
  it('/jira KEY or a Jira link: the first prompt only', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    await prompt(srv, 's1', '/jira https://acme.atlassian.net/browse/ACME-5065');
    expect(srv.store.getSession('s1')?.ticket).toEqual({ key: 'ACME-5065', site: 'acme.atlassian.net', summary: null });
    await prompt(srv, 's2', 'what does this repo do?', 1);
    await prompt(srv, 's2', '/jira ACME-9', 2);
    expect(srv.store.getSession('s2')?.ticket).toBeUndefined();
    await prompt(srv, 's3', '/jira acme-77');
    expect(srv.store.getSession('s3')?.ticket?.key).toBe('ACME-77');
  });

  it('a bare key once the site\'s projects are known (and sessions from before get theirs then)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'ab-tix-'));
    srv = await startServer(cfg(dataDir, join(dataDir, 'cora.db')), { tail: false, listen: false });
    await prompt(srv, 'b1', 'fix ACME-5206 please, UTF-8 too');
    expect(srv.store.getSession('b1')?.ticket).toBeUndefined();
    const r = await srv.app.inject({ method: 'POST', url: '/api/jira/projects', headers: H, payload: { projects: ['ACME', 'OPS'] } });
    expect(r.json()).toEqual({ ok: true, tagged: 1 });
    expect(srv.store.getSession('b1')?.ticket?.key).toBe('ACME-5206');
    await prompt(srv, 'b2', 'see OPS-12 and ACME-1');
    expect(srv.store.getSession('b2')?.ticket?.key).toBe('OPS-12');
    await prompt(srv, 'b3', 'UTF-8 vs SHA-256');
    expect(srv.store.getSession('b3')?.ticket).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dataDir, 'jira-projects.json'), 'utf8'))).toEqual({ projects: ['ACME', 'OPS'] });
    expect((await srv.app.inject({ method: 'POST', url: '/api/jira/projects', headers: H, payload: { projects: 'ACME' } })).statusCode).toBe(400);
  });

  it('a slash command read from the transcript (no hooks)', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    const line = {
      type: 'user', promptId: 'p1', uuid: 'u1', timestamp: '2026-09-25T19:45:32.144Z', origin: { kind: 'human' }, cwd: 'C:\\gitlab\\x', sessionId: 't1',
      message: { role: 'user', content: '<command-message>jira</command-message>\n<command-name>/jira</command-name>\n<command-args>https://acme.atlassian.net/browse/ACME-5065</command-args>' },
    };
    srv.pipeline.ingestTranscript('t1.jsonl', [line], { sessionId: 't1', agentId: 'main', projectSlug: 'C--gitlab-x' } as never);
    expect(srv.store.getSession('t1')?.ticket?.key).toBe('ACME-5065');
  });

  it('the UI fills in the summary (for the same key only); cleared, it stays cleared', async () => {
    srv = await startServer(cfg(), { tail: false, listen: false });
    await prompt(srv, 'm1', '/jira ACME-5');
    expect((await meta(srv, 'm1', { ticketSummary: { key: 'ACME-5', summary: 'Fix the\nlogin' } })).json().ticket).toEqual({ key: 'ACME-5', site: null, summary: 'Fix the login' });
    expect((await meta(srv, 'm1', { ticketSummary: { key: 'ACME-6', summary: 'Other' } })).json().ticket.summary).toBe('Fix the login');
    expect((await meta(srv, 'm1', { ticket: 'ops-3' })).json().ticket).toEqual({ key: 'OPS-3', site: null, summary: null });
    expect((await meta(srv, 'm1', { ticket: 'nope' })).statusCode).toBe(400);
    expect((await meta(srv, 'm1', { ticket: null })).json().ticket).toBeNull();
    await prompt(srv, 'm1', '/jira ACME-5', 1);
    expect(srv.store.getSession('m1')?.ticket).toBeNull();
  });
});
