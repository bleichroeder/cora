import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { registerMcp } from '../src/mcp';
import { Outbox, Slack, SlackError } from '../src/slack';
import { attachmentRoots, checkAttachments } from '../src/slackFiles';
import { agentArgs, orchestratorDir } from '../src/orchestrator/files';
import { readFileSync } from 'node:fs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const dir = () => mkdtempSync(join(tmpdir(), 'cora-files-'));
const file = (d: string, name: string, data: Buffer | string = PNG) => {
  const p = join(d, name);
  writeFileSync(p, data);
  return p;
};

describe('which files a message may carry', () => {
  it('takes files from its folders, and says why it refuses the rest', () => {
    const ok = dir();
    const elsewhere = dir();
    const shot = file(ok, 'shot.png');
    const log = file(ok, 'build.log', 'all green');
    expect(checkAttachments([shot, log], [ok])).toEqual([
      { name: 'shot.png', path: expect.stringMatching(/shot\.png$/), size: PNG.length, image: true },
      { name: 'build.log', path: expect.stringMatching(/build\.log$/), size: 9, image: false },
    ]);
    expect(() => checkAttachments([file(elsewhere, 'x.png')], [ok])).toThrow(/session's folder, the temp folder/);
    expect(() => checkAttachments(['shot.png'], [ok])).toThrow(/full path/);
    expect(() => checkAttachments([join(ok, 'nope.png')], [ok])).toThrow(/no such file/);
    expect(() => checkAttachments([file(ok, '.env', 'KEY=1')], [ok])).toThrow(/secret/);
    expect(() => checkAttachments([file(ok, 'id_rsa', 'x')], [ok])).toThrow(/secret/);
    mkdirSync(join(ok, '.ssh'));
    expect(() => checkAttachments([file(join(ok, '.ssh'), 'shot.png')], [ok])).toThrow(/secret/);
    // a picture is a picture, whatever it's called
    expect(checkAttachments([file(ok, 'token-usage.png')], [ok])[0].image).toBe(true);
    expect(() => checkAttachments(Array(11).fill(shot), [ok])).toThrow(/at most 10/);
  });

  it("roots: temp, Cora's attachments and Playwright's folder, Pictures, Downloads, Desktop, the session's folder (not Cora's data)", () => {
    const home = dir();
    const roots = attachmentRoots(join(home, 'code', 'app'), home, join(home, '.cora'));
    expect(roots).toEqual(expect.arrayContaining([tmpdir(), join(home, '.cora', 'attachments'), join(home, '.cora', 'orchestrator', '.playwright-mcp'), join(home, 'Pictures'), join(home, 'code', 'app')].map((p) => expect.stringMatching(new RegExp(`^${p.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`, 'i')))));
    expect(attachmentRoots(join(home, '.cora', 'orchestrator'), home, join(home, '.cora'))).not.toContain(join(home, '.cora', 'orchestrator'));
  });
});

/** A fake Slack for uploads: the three-step flow, files.info's shares, deletes. */
function fakeSlack() {
  const calls: Array<{ method: string; p: any }> = [];
  const uploads: Array<{ url: string; bytes: number; type: string | null }> = [];
  let n = 0;
  const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
    calls.push({ method, p });
    if (token !== 'xoxp-good') throw new SlackError('invalid_auth');
    switch (method) {
      case 'auth.test':
        return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      case 'users.list':
        return { ok: true, members: [{ id: 'U1', name: 'nick', profile: { display_name: 'Nick', real_name: 'Nicholas Chen' } }] };
      case 'conversations.list':
        return { ok: true, channels: [] };
      case 'conversations.open':
        return { ok: true, channel: { id: 'D0NICK0001' } };
      case 'files.getUploadURLExternal':
        n++;
        return { ok: true, upload_url: `https://files.slack.com/upload/v1/F${n}`, file_id: `F${n}` };
      case 'files.completeUploadExternal':
        return { ok: true, files: JSON.parse(p.files).map((f: any) => ({ id: f.id })) };
      case 'files.info':
        return { ok: true, file: { id: p.file, permalink: `https://acme.slack.com/files/U0/${p.file}/x`, shares: { private: { D0NICK0001: [{ ts: '1792170000.000100' }] } } } };
      case 'chat.getPermalink':
        return { ok: true, permalink: `https://acme.slack.com/archives/${p.channel}/p${String(p.message_ts).replace('.', '')}` };
      case 'chat.postMessage':
        return { ok: true, ts: '1792170000.000200' };
      default:
        return { ok: true };
    }
  };
  const fetchFn = (async (url: string, init?: any) => {
    uploads.push({ url, bytes: (init?.body as Buffer).length, type: init?.headers?.['content-type'] ?? null });
    return new Response(`OK - ${(init?.body as Buffer).length}`, { status: 200 });
  }) as typeof fetch;
  return { api, fetchFn, calls, uploads };
}

describe('sending files to Slack', () => {
  const rpc = (args: object) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_send', arguments: args } });
  async function setup(turn = true) {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api, fetch: f.fetchFn, shareWaitMs: 1 });
    await slack.connect('xoxp-good');
    const outbox = new Outbox({ slack, onChange: () => {} });
    const work = dir();
    const app = Fastify();
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack, outbox, cwdOf: () => work }, { isAgent: (sid) => sid === 'cora-agent-1', deps: () => ({}) as never, userTurn: () => turn });
    const call = async (args: object, sid = 'cora-agent-1') => {
      const r = await app.inject({ method: 'POST', url: '/mcp', headers: { 'x-cora-token': 'tok', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-cora-session': sid, 'x-cora-agent': 'tok' }, payload: rpc(args) });
      return JSON.parse(r.body).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    return { ...f, slack, outbox, work, call };
  }

  it('uploads them with the message (Slack\'s external flow), into the DM, and Undo takes back the message and the files', async () => {
    const { call, calls, uploads, outbox, work } = await setup();
    const shot = file(work, 'cora.png');
    const r = await call({ to: '@nick', text: 'here is the dashboard', files: [shot] });
    expect(r.content[0].text).toMatch(/^Sent to Nick with cora\.png, straight away/);
    expect(calls.find((c) => c.method === 'files.getUploadURLExternal')?.p).toEqual({ filename: 'cora.png', length: PNG.length });
    expect(uploads).toEqual([{ url: 'https://files.slack.com/upload/v1/F1', bytes: PNG.length, type: 'application/octet-stream' }]);
    const done = calls.find((c) => c.method === 'files.completeUploadExternal')!.p;
    expect(JSON.parse(done.files)).toEqual([{ id: 'F1', title: 'cora.png' }]);
    expect(done).toMatchObject({ channel_id: 'D0NICK0001', initial_comment: 'here is the dashboard' });
    expect(calls.some((c) => c.method === 'chat.postMessage')).toBe(false);
    const [m] = outbox.sent();
    expect(m).toMatchObject({ link: 'https://acme.slack.com/archives/D0NICK0001/p1792170000000100', files: [{ name: 'cora.png', image: true }] });
    expect(outbox.attachment('sent', m.id, 0)?.name).toBe('cora.png');
    expect(await outbox.undo(m.id)).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === 'chat.delete' || c.method === 'files.delete').map((c) => [c.method, c.p])).toEqual([
      ['chat.delete', { channel: 'D0NICK0001', ts: '1792170000.000100' }],
      ['files.delete', { file: 'F1' }],
    ]);
  });

  it('a draft carries its files to your OK, and sending it uploads them (in its thread)', async () => {
    const { call, calls, outbox, work } = await setup(false);
    const shot = file(work, 'a.png');
    const log = file(work, 'run.log', 'ok');
    void call({ to: 'x', text: 'two things', files: [shot, log], thread: 'https://acme.slack.com/archives/C0DEVTEAM1/p1792160000000100' }, 'sess-12345');
    await new Promise((res) => setTimeout(res, 50));
    const [d] = outbox.list();
    expect(d.files?.map((f) => f.name)).toEqual(['a.png', 'run.log']);
    expect(outbox.attachment('draft', d.id, 1)?.name).toBe('run.log');
    expect((await outbox.decide(d.id, { action: 'send' })).ok).toBe(true);
    const done = calls.find((c) => c.method === 'files.completeUploadExternal')!.p;
    expect(done).toMatchObject({ channel_id: 'C0DEVTEAM1', thread_ts: '1792160000.000100' });
    expect(JSON.parse(done.files)).toHaveLength(2);
  });

  it("refuses a file it shouldn't send, and sends nothing", async () => {
    const { call, calls, work } = await setup();
    const r = await call({ to: '@nick', text: 'my keys', files: [file(work, '.env', 'KEY=1')] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Not sent: .*secret/);
    expect(calls.some((c) => c.method.startsWith('files.') || c.method === 'chat.postMessage')).toBe(false);
  });
});

describe("Cora's agent and its browser", () => {
  it('may look at and click through pages with Playwright (no scripts or typing), and knows how to open Cora', () => {
    const d = orchestratorDir(dir());
    const a = agentArgs({ port: 4317, hookToken: 't', sessionId: 's', model: 'opus', dir: d, speak: false, viewToken: 'view-key' });
    const allowed = a[a.indexOf('--allowedTools') + 1].split(',');
    expect(allowed).toEqual(expect.arrayContaining(['mcp__playwright__browser_navigate', 'mcp__playwright__browser_take_screenshot', 'mcp__playwright__browser_click']));
    expect(allowed.filter((t) => /evaluate|run_code|file_upload|browser_type|fill_form/.test(t))).toEqual([]);
    const prompt = readFileSync(a[a.indexOf('--append-system-prompt-file') + 1], 'utf8');
    // a view-only link, never the user's sign-in (audit S2)
    expect(prompt).toMatch(/http:\/\/127\.0\.0\.1:4317\/auth\?view=view-key/);
    expect(prompt).not.toMatch(/auth\?key=/);
    expect(prompt).toMatch(/slack_send's `files`/);
  });
});

describe("Cora's own data folder (audit S9)", () => {
  it("a session running in your home folder can't attach Cora's keys or database, only its attachments and screenshots", () => {
    const home = dir();
    const data = join(home, '.cora');
    mkdirSync(join(data, 'hosted-mcp'), { recursive: true });
    mkdirSync(join(data, 'attachments', 's1'), { recursive: true });
    const key = file(join(data, 'hosted-mcp'), 'abc.json', '{"headers":{"x-cora-token":"t"}}');
    const db = file(data, 'brain.db', 'x');
    const pasted = file(join(data, 'attachments', 's1'), 'paste.png');
    const roots = attachmentRoots(home, home, data);
    expect(() => checkAttachments([key], roots, data)).toThrow(/Cora's own data folder/);
    expect(() => checkAttachments([db], roots, data)).toThrow(/Cora's own data folder/);
    expect(checkAttachments([pasted], roots, data)[0].name).toBe('paste.png');
  });

  it("nothing from ~/.claude (Claude Code's own config and sign-in)", () => {
    const home = dir();
    mkdirSync(join(home, '.claude'), { recursive: true });
    const cfg = file(join(home, '.claude'), 'settings.json', '{}');
    expect(() => checkAttachments([cfg], attachmentRoots(home, home, join(home, '.cora')), join(home, '.cora'))).toThrow(/looks like a secret/);
  });
});
