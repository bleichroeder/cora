import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { colorEmoji, type SessionInfo } from '@cora/shared';
import { Outbox, Slack, SlackError, quoted, richBlocks } from '../src/slack';
import { Banners, bannerFor, bannerWords, headline } from '../src/banner';

const GIF = new Uint8Array([...Buffer.from('GIF89a'), 1, 0, 1, 0, 0, 0, 0, 0x3b]);
const dir = () => mkdtempSync(join(tmpdir(), 'cora-banner-'));

/** A fake Slack: uploads, and posting that can refuse the banner's block a few times (not ready yet). */
function fakeSlack(refuse = 0) {
  const calls: Array<{ method: string; p: any }> = [];
  const uploads: number[] = [];
  let n = 0;
  const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
    calls.push({ method, p });
    if (token !== 'xoxp-good') throw new SlackError('invalid_auth');
    switch (method) {
      case 'auth.test':
        return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      case 'users.list':
        return { ok: true, members: [{ id: 'U0', name: 'david', profile: { display_name: 'David', real_name: 'David Example' } }] };
      case 'conversations.list':
        return { ok: true, channels: [{ id: 'C1', name: 'deploys' }] };
      case 'files.getUploadURLExternal':
        n++;
        return { ok: true, upload_url: `https://files.slack.com/upload/v1/F${n}`, file_id: `F${n}` };
      case 'chat.postMessage':
        if (p.blocks?.some((b: any) => b.type === 'image') && refuse-- > 0) throw new SlackError('invalid_blocks');
        if (p.blocks?.some((b: any) => b.type === 'header' && b.text.text === 'refuse me')) throw new SlackError('invalid_blocks');
        return { ok: true, ts: '1792170000.000200' };
      case 'chat.scheduleMessage':
        return { ok: true, scheduled_message_id: 'Q1', post_at: p.post_at };
      case 'chat.getPermalink':
        return { ok: true, permalink: 'https://acme.slack.com/archives/C1/p1792170000000200' };
      default:
        return { ok: true };
    }
  };
  const fetchFn = (async (_url: string, init?: any) => (uploads.push((init?.body as Uint8Array).length), new Response('OK', { status: 200 }))) as typeof fetch;
  return { api, fetchFn, calls, uploads };
}

async function setup(o: { refuse?: number; banner?: () => Promise<Uint8Array | null> } = {}) {
  const f = fakeSlack(o.refuse);
  const slack = new Slack({ dataDir: dir(), api: f.api, fetch: f.fetchFn, shareWaitMs: 1 });
  await slack.connect('xoxp-good');
  const asked: string[] = [];
  const outbox = new Outbox({ slack, onChange: () => {}, sign: () => ':cora:', banner: o.banner ?? (async (d) => (asked.push(String(d.sessionId)), GIF)) });
  const to = { kind: 'channel' as const, id: 'C1', label: '#deploys' };
  const draft = () => (void outbox.request({ sessionId: 's1', to, text: 'Deployed 2.10' }), outbox.list().at(-1)!.id);
  const posts = () => f.calls.filter((c) => c.method === 'chat.postMessage').map((c) => c.p);
  return { ...f, outbox, draft, posts, asked };
}

describe("Cora's Slack banner", () => {
  it('a draft you send opens with it: uploaded privately (no channel, no public link), then the image, the message, the footer', async () => {
    const { outbox, draft, posts, calls, uploads, asked } = await setup();
    const id = draft();
    expect((await outbox.decide(id, { action: 'send' })).ok).toBe(true);
    expect(asked).toEqual(['s1']);
    expect(uploads).toEqual([GIF.length]);
    expect(calls.find((c) => c.method === 'files.getUploadURLExternal')!.p).toEqual({ filename: 'cora.gif', length: GIF.length });
    const done = calls.find((c) => c.method === 'files.completeUploadExternal')!.p;
    expect(done.channel_id).toBeUndefined();
    expect(JSON.parse(done.files)).toEqual([{ id: 'F1', title: 'Cora' }]);
    expect(posts()[0]).toMatchObject({ channel: 'C1', text: 'Deployed 2.10' });
    expect(posts()[0].blocks).toEqual([
      { type: 'image', slack_file: { id: 'F1' }, alt_text: 'Cora' },
      // quoted under the banner (the notification's text isn't)
      { type: 'section', text: { type: 'mrkdwn', text: '> Deployed 2.10' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: ":cora:  Sent from Cora on David's behalf" }] },
    ]);
  });

  it("what Cora sends straight away has one too (its session's); what you typed never does", async () => {
    const { outbox, posts, uploads, calls } = await setup();
    const to = { kind: 'person' as const, id: 'U0', label: 'David' };
    const sent = await outbox.sendNow({ to, text: 'Back from lunch? The deploy is done.', sessionId: 's1' });
    expect(posts()[0].blocks[0]).toEqual({ type: 'image', slack_file: { id: 'F1' }, alt_text: 'Cora' });
    await outbox.sendNow({ to, text: 'thanks', typed: true });
    expect(posts()[1].blocks).toBeUndefined();
    expect(uploads).toHaveLength(1);
    // Undo takes back the message and its banner
    expect(await outbox.undo(sent.id)).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === 'files.delete').map((c) => c.p.file)).toEqual(['F1']);
  });

  it('unticked: made as the draft came (so Send never waits), but not uploaded', async () => {
    const { outbox, draft, posts, uploads, asked } = await setup();
    await outbox.decide(draft(), { action: 'send', banner: false });
    expect(asked).toEqual(['s1']);
    expect(uploads).toEqual([]);
    expect(posts()[0].blocks.map((b: any) => b.type)).toEqual(['section', 'context']);
    expect(posts()[0].blocks[0].text.text).toBe('Deployed 2.10');
  });

  it('quotes every line, the blank ones too', () => {
    expect(quoted('Done.\n\n- one\n- two')).toBe('> Done.\n>\n> - one\n> - two');
  });

  it("Slack not ready for the image yet: tries again; still refusing, it goes without it; none made, it goes plain", async () => {
    const a = await setup({ refuse: 2 });
    expect((await a.outbox.decide(a.draft(), { action: 'send' })).ok).toBe(true);
    expect(a.posts().map((p) => p.blocks[0].type)).toEqual(['image', 'image', 'image']);
    const b = await setup({ refuse: 99 });
    expect((await b.outbox.decide(b.draft(), { action: 'send' })).ok).toBe(true);
    expect(b.posts().map((p) => p.blocks[0].type)).toEqual(['image', 'image', 'image', 'image', 'section']);
    const c = await setup({ banner: async () => null });
    await c.outbox.decide(c.draft(), { action: 'send' });
    expect(c.uploads).toEqual([]);
    expect(c.posts()[0].blocks.map((x: any) => x.type)).toEqual(['section', 'context']);
    const d = await setup({ banner: async () => Promise.reject(new Error('boom')) });
    expect((await d.outbox.decide(d.draft(), { action: 'send' })).ok).toBe(true);
  });

  it('the desktop app makes them: asked by id, a GIF back; anything else, too slow, or gone: none', async () => {
    const none = new Banners(50);
    expect(none.available).toBe(false);
    expect(await none.render({ line: 'x' })).toBeNull();

    const handlers: Record<string, (...a: any[]) => void> = {};
    const sent: any[] = [];
    const sock = { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)), close: () => {}, on: (ev: string, fn: (...a: any[]) => void) => void (handlers[ev] = fn) };
    const b = new Banners(50);
    b.attachDesktop(sock);
    expect(b.available).toBe(true);
    const one = b.render({ line: 'WEB-1 · Tags' });
    expect(sent[0]).toMatchObject({ t: 'render', q: { line: 'WEB-1 · Tags' } });
    handlers.message(JSON.stringify({ t: 'gif', id: sent[0].id, data: Buffer.from(GIF).toString('base64') }));
    expect([...((await one) ?? [])]).toEqual([...GIF]);
    const notGif = b.render({});
    handlers.message(JSON.stringify({ t: 'gif', id: sent[1].id, data: Buffer.from('<html>').toString('base64') }));
    expect(await notGif).toBeNull();
    expect(await b.render({})).toBeNull();
    const cut = b.render({});
    handlers.close();
    expect(await cut).toBeNull();
    expect(b.available).toBe(false);
  });

  it("says only what its readers should see: the ticket, else the message's own first line; your name for the session and its repo", () => {
    const s = (x: Partial<SessionInfo>) => ({ id: 'abcdef123456', cwd: 'C:\\code\\cora\\', ...x }) as SessionInfo;
    const text = 'Deployed **2.10** to <https://x.io|staging> :rocket:\n\nmore';
    expect(bannerWords({ name: 'David', session: null, text })).toEqual({ name: 'David', line: 'Deployed 2.10 to staging' });
    expect(bannerWords({ name: 'David', session: s({ ticket: { key: 'WEB-12', site: null, summary: 'Tag chips' } }), text })).toEqual({ name: 'David', line: 'WEB-12 · Tag chips', from: 'cora' });
    expect(bannerWords({ name: '', session: s({ alias: 'UI: chips', ticket: { key: 'WEB-12', site: null, summary: null } }), text })).toEqual({ line: 'WEB-12', from: 'UI: chips · cora' });
    // names made from its prompts never show: they can say anything
    expect(bannerWords({ name: 'David', session: s({ autoName: 'Read memory before responding', title: 'secret plan' }), text })).toEqual({ name: 'David', line: 'Deployed 2.10 to staging', from: 'cora' });
    // Cora's own agent (its folder in Cora's data): nothing of it
    expect(bannerWords({ name: 'David', session: s({ cwd: 'C:\\Users\\D\\.cora\\orchestrator', alias: 'Cora' }), text: ':wave: Hi Dave!', privateDir: 'C:/Users/D/.cora' })).toEqual({ name: 'David', line: 'Hi Dave!' });
    expect(headline(`# ${'word '.repeat(30)}`)).toMatch(/^word word .*…$/);
    expect(headline('')).toBe('');
  });
});

describe('structured messages in Slack blocks', () => {
  it('headers, dividers, a grid of facts, small print; code left alone; an ordinary message stays sections', () => {
    const md = ['# US broadcast health', '-# snapshot 10:15 ET', '', '**Markets:** 217', '- **Stations:** 1,892', '**Major:** 31', '---', 'Down: *KSWL* on lchmh1', '```', '# not a header', '---', '```'].join('\n');
    const b = richBlocks(md)!;
    expect(b.map((x) => x.type)).toEqual(['header', 'context', 'section', 'divider', 'section']);
    expect(b[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: 'US broadcast health', emoji: true } });
    expect((b[2] as any).fields.map((f: any) => f.text)).toEqual(['*Markets*\n217', '*Stations*\n1,892', '*Major*\n31']);
    expect((b[4] as any).text.text).toContain('```\n# not a header\n---\n```');
    expect(richBlocks('Deployed **2.10** to staging.\n\n**One:** fact')).toBeNull();
    expect(richBlocks(Array(60).fill('# h').join('\n'))).toBeNull();
  });

  it("is posted as blocks under the banner (not quoted), the footer last; what you typed never is; Slack refusing them: plain", async () => {
    const { outbox, draft, posts } = await setup();
    const to = { kind: 'channel' as const, id: 'C1', label: '#deploys' };
    void outbox.request({ sessionId: 's1', to, text: '# Release 2.10\n---\n**API:** ok\n**UI:** ok' });
    await outbox.decide(outbox.list().at(-1)!.id, { action: 'send' });
    expect(posts()[0].blocks.map((x: any) => x.type)).toEqual(['image', 'header', 'divider', 'section', 'context']);
    await outbox.sendNow({ to, text: '# not a header\n---', typed: true });
    expect(posts()[1].blocks).toBeUndefined();
    await outbox.sendNow({ to, text: '# refuse me\n---\nbody', banner: false });
    expect(posts().at(-1).blocks.map((x: any) => x.type)).toEqual(['section', 'context']);
    void draft;
  });

  it('a plain message when asked for one: no banner made or sent, the box starts unticked; ticking it puts it back', async () => {
    const { outbox, posts, asked } = await setup();
    const to = { kind: 'channel' as const, id: 'C1', label: '#deploys' };
    void outbox.request({ sessionId: 's1', to, text: 'plain one', banner: false });
    const d = outbox.list().at(-1)!;
    expect(d.banner).toBe(false);
    expect(asked).toEqual([]);
    await outbox.decide(d.id, { action: 'send' });
    expect(posts()[0].blocks.map((x: any) => x.type)).toEqual(['section', 'context']);
    void outbox.request({ sessionId: 's1', to, text: 'banner after all', banner: false });
    await outbox.decide(outbox.list().at(-1)!.id, { action: 'send', banner: true });
    expect(posts()[1].blocks[0].type).toBe('image');
    await outbox.sendNow({ to, text: 'plain now', banner: false });
    expect(posts()[2].blocks.map((x: any) => x.type)).toEqual(['section', 'context']);
  });
});

describe("a session's banner (who wrote it)", () => {
  const s = (x: Partial<SessionInfo>) => ({ id: 'abcdef123456', cwd: 'C:\code\ingest-workers', color: '#38bdf8', icon: 'Gauge', autoName: 'Ingest Lag on Node 3', ticket: { key: 'ACME-5340', site: null, summary: 'Internal codename Falcon lag' }, startedBy: 'cora', ...x }) as SessionInfo;
  const base = { name: 'David', cora: false, text: 'Found it', privateDir: 'C:/Users/D/.cora' };

  it('its colour, icon, name and a small line; never a folder, a path or the ticket summary', () => {
    const q = bannerFor({ ...base, session: s({}), outside: false, reviewed: true });
    expect(q).toEqual({ kind: 'session', color: '#38bdf8', name: 'David', icon: 'Gauge', line: 'Ingest Lag on Node 3', sub: 'started by Cora · ACME-5340' });
    expect(JSON.stringify(q)).not.toMatch(/ingest-workers|Falcon|code/);
    expect(bannerFor({ ...base, session: s({ ticket: null, issue: { project: 'acme/internal/secret', iid: 7, url: 'x', title: 'T' }, startedBy: null }), outside: false, reviewed: true }).sub).toBe('#7');
  });

  it('a name made from its prompts only when you see it before it goes; your own name for it always', () => {
    expect(bannerFor({ ...base, session: s({}), outside: false, reviewed: false }).line).toBeUndefined();
    expect(bannerFor({ ...base, session: s({ alias: 'Radar follow-up' }), outside: false, reviewed: false }).line).toBe('Radar follow-up');
  });

  it('outside your company: no name, no ticket, just who it works for', () => {
    expect(bannerFor({ ...base, session: s({ alias: 'Radar follow-up' }), outside: true, reviewed: true })).toEqual({ kind: 'session', color: '#38bdf8', name: 'David', icon: 'Gauge', sub: 'working for David' });
  });

  it("Cora's own messages keep her look", () => {
    expect(bannerFor({ ...base, session: null, outside: true, reviewed: false })).toEqual({ name: 'David', line: 'Found it' });
    expect(bannerFor({ ...base, cora: true, session: s({}), outside: false, reviewed: true }).kind).toBeUndefined();
  });

  it('the draft shows the banner it will send, signs as a session, and makes a new one when it goes to someone else', async () => {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api, fetchFn: f.fetchFn } as never);
    await slack.connect('xoxp-good');
    const asked: Array<{ to: string; reviewed: boolean }> = [];
    const outbox = new Outbox({
      slack,
      onChange: () => {},
      sign: () => ':cora:',
      bySession: (sid) => sid === 's1',
      banner: async (d) => (asked.push({ to: d.to.id, reviewed: d.reviewed }), GIF),
      bannerPreview: async () => ({ kind: 'session', line: 'Ingest Lag on Node 3' }),
    });
    const sent = outbox.request({ sessionId: 's1', to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'Found it' });
    await new Promise((r) => setTimeout(r, 20));
    const d = outbox.list()[0];
    expect(d.bannerQ).toEqual({ kind: 'session', line: 'Ingest Lag on Node 3' });
    expect(asked).toEqual([{ to: 'C1', reviewed: true }]);
    await outbox.decide(d.id, { action: 'send', to: { kind: 'person', id: 'U9', label: 'Radar' } });
    expect(asked).toEqual([{ to: 'C1', reviewed: true }, { to: 'U9', reviewed: true }]);
    expect((await sent).sent).toBe(true);
    const post = f.calls.find((c) => c.method === 'chat.postMessage')!;
    expect(JSON.stringify(post.p)).toContain('Sent from a Cora session on David');
  });
});

describe('beyond your company', () => {
  it('a shared channel, a guest, someone from another workspace, or not knowing: outside; your own team: inside', async () => {
    const info: Record<string, any> = {
      C1: { id: 'C1' },
      C2: { id: 'C2', is_ext_shared: true },
      D1: { id: 'D1', is_im: true, user: 'U1' },
    };
    const users: Record<string, any> = { U1: { id: 'U1', team_id: 'T1' }, U2: { id: 'U2', team_id: 'T1', is_restricted: true }, U3: { id: 'U3', team_id: 'T9' } };
    const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
      if (method === 'auth.test') return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      if (method === 'conversations.info') return { ok: true, channel: info[p.channel] };
      if (method === 'users.info') return { ok: true, user: users[p.user] };
      return { ok: true };
    };
    const slack = new Slack({ dataDir: dir(), api } as never);
    await slack.connect('xoxp-good');
    const t = (kind: 'channel' | 'person', id: string) => slack.outside({ kind, id, label: id });
    expect(await t('channel', 'C1')).toBe(false);
    expect(await t('channel', 'C2')).toBe(true);
    expect(await t('person', 'D1')).toBe(false);
    expect(await t('person', 'U2')).toBe(true);
    expect(await t('person', 'U3')).toBe(true);
    expect(await t('channel', 'C404')).toBe(true);
  });
});

describe('a banner that fails', () => {
  it('is tried once more when the desktop app failed to draw it, and every one dropped is logged with why', async () => {
    const handlers: Record<string, (...a: any[]) => void> = {};
    const sent: any[] = [];
    const log: string[] = [];
    const sock = { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)), close: () => {}, on: (ev: string, fn: (...a: any[]) => void) => void (handlers[ev] = fn) };
    const b = new Banners(50, (l) => log.push(l));
    b.attachDesktop(sock);
    const one = b.render({ line: 'x' });
    handlers.message(JSON.stringify({ t: 'gif', id: sent[0].id, error: 'nothing drew in 15 s (graphics unavailable?)' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(2);
    handlers.message(JSON.stringify({ t: 'gif', id: sent[1].id, data: Buffer.from(GIF).toString('base64') }));
    expect([...((await one) ?? [])]).toEqual([...GIF]);
    expect(log).toEqual(["Slack banner failed (the desktop app couldn't draw it (nothing drew in 15 s (graphics unavailable?))): trying once more"]);
    expect(await b.render({})).toBeNull();
    expect(log.at(-1)).toBe('Slack banner dropped: no banner from the desktop app in 0 s (after a retry)');
    const none = new Banners(50, (l) => log.push(l));
    expect(await none.render({})).toBeNull();
    expect(log.at(-1)).toMatch(/^Slack banner dropped: Cora's desktop app isn't connected/);
  });
});

describe("a session's message to you, through Cora's bot", () => {
  async function botWorld(scopes: string[]) {
    const calls: Array<{ token: string; method: string; p: any }> = [];
    const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
      calls.push({ token, method, p });
      if (method === 'auth.test') return token === 'xoxb-bot' ? { ok: true, team_id: 'T1', user: 'cora', user_id: 'UB' } : { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      if (method === 'conversations.open') return { ok: true, channel: { id: 'D-BOT' } };
      if (method === 'files.getUploadURLExternal') {
        if (token === 'xoxb-bot' && !scopes.includes('files:write')) throw new SlackError('missing_scope');
        return { ok: true, upload_url: 'https://files.slack.com/upload/v1/F9', file_id: 'F9' };
      }
      if (method === 'chat.postMessage') return { ok: true, ts: '1792170000.000300' };
      if (method === 'chat.getPermalink') return { ok: true, permalink: 'https://acme.slack.com/archives/D-BOT/p1' };
      return { ok: true };
    };
    const logs: string[] = [];
    const slack = new Slack({ dataDir: dir(), api, fetch: (async () => new Response('OK', { status: 200 })) as typeof fetch, shareWaitMs: 1, log: (m) => logs.push(m) });
    await slack.connect('xoxp-good');
    await slack.setBotToken('xoxb-bot');
    const send = () => slack.post({ kind: 'person', id: '', label: 'you' }, 'check 1/3: OK', undefined, { asBot: true, banner: GIF, byline: '*race* · a session in Cora' });
    const post = () => calls.filter((c) => c.method === 'chat.postMessage').at(-1)!;
    return { send, post, logs, calls };
  }

  it("shows its banner when the bot can upload (files:write), posted by the bot in its DM with you", async () => {
    const w = await botWorld(['files:write']);
    await w.send();
    expect(w.post()).toMatchObject({ token: 'xoxb-bot', p: { channel: 'D-BOT' } });
    expect(w.post().p.blocks[0]).toEqual({ type: 'image', slack_file: { id: 'F9' }, alt_text: 'Cora' });
    expect(w.calls.find((c) => c.method === 'files.getUploadURLExternal')!.token).toBe('xoxb-bot');
  });

  it("without files:write: still sent, its name on top instead, and the log says what the bot needs", async () => {
    const w = await botWorld([]);
    await w.send();
    expect(w.post().p.blocks[0]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: '*race* · a session in Cora' }] });
    expect(w.logs.join('\n')).toMatch(/banner not shown \(missing_scope\): Cora's bot needs the files:write scope/);
  });
});

describe('Slack, more of it', () => {
  async function world(o: { userPins?: boolean } = {}) {
    const calls: Array<{ token: string; method: string; p: any }> = [];
    const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
      calls.push({ token, method, p });
      if (method === 'auth.test') return token === 'xoxb-bot' ? { ok: true, team_id: 'T1', user: 'cora', user_id: 'UB' } : { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      if (method === 'conversations.open') return { ok: true, channel: { id: 'D-BOT' } };
      if (method === 'conversations.list') return { ok: true, channels: [{ id: 'C9', name: 'releases' }] };
      if (method === 'users.list') return { ok: true, members: [{ id: 'U0', name: 'david' }] };
      if (method === 'pins.add' && token === 'xoxp-good' && !o.userPins) throw new SlackError('missing_scope');
      if (method === 'users.info') return { ok: true, user: { profile: { status_text: 'Lunch', status_emoji: ':sandwich:', status_expiration: 0 } } };
      if (method === 'chat.postMessage') return { ok: true, ts: '1792170000.000400' };
      if (method === 'chat.getPermalink') return { ok: true, permalink: 'https://acme.slack.com/archives/C9/p1' };
      return { ok: true };
    };
    const slack = new Slack({ dataDir: dir(), api, fetch: (async () => new Response('OK', { status: 200 })) as typeof fetch, shareWaitMs: 1 });
    await slack.connect('xoxp-good');
    await slack.setBotToken('xoxb-bot');
    return { slack, calls, last: (m: string) => calls.filter((c) => c.method === m).at(-1)! };
  }

  it("a session's message to you comes under its own name and colour", async () => {
    const w = await world();
    await w.slack.post({ kind: 'person', id: '', label: 'you' }, 'check 1/3: OK', undefined, { asBot: true, sender: { name: 'Report Race Condition', emoji: ':large_purple_circle:' } });
    expect(w.last('chat.postMessage')).toMatchObject({ token: 'xoxb-bot', p: { channel: 'D-BOT', username: 'Report Race Condition', icon_emoji: ':large_purple_circle:' } });
    expect(colorEmoji('#a78bfa')).toBe(':large_purple_circle:');
    expect(colorEmoji('#fb7185')).toBe(':red_circle:');
    expect(colorEmoji('#a3e635')).toBe(':large_green_circle:');
    expect(colorEmoji('#38bdf8')).toBe(':large_blue_circle:');
    expect(colorEmoji('#fdba74')).toBe(':large_orange_circle:');
  });

  it('Cora posts in a channel as her bot; pins as you, else as her bot; your status read and set', async () => {
    const w = await world();
    await w.slack.post({ kind: 'channel', id: 'C9', label: '#releases' }, 'Release 2.10.4 is out', undefined, { asBot: true, inChannel: true });
    expect(w.last('chat.postMessage')).toMatchObject({ token: 'xoxb-bot', p: { channel: 'C9', text: 'Release 2.10.4 is out' } });
    expect(w.last('chat.postMessage').p.username).toBeUndefined();
    expect(await w.slack.pin('C9', '1792170000.000400')).toBe('cora');
    expect((await world({ userPins: true })).slack.pin('C9', '1.2')).resolves.toBe('you');
    expect(await w.slack.myStatus()).toEqual({ text: 'Lunch', emoji: ':sandwich:', expiration: 0 });
    await w.slack.setStatus('In a call', ':spiral_calendar_pad:', 1792173600);
    expect(w.last('users.profile.set').p.profile).toEqual({ status_text: 'In a call', status_emoji: ':spiral_calendar_pad:', status_expiration: 1792173600 });
  });
});

describe('scheduled messages', () => {
  it('Slack holds it until then; a draft carries its time to the send; Undo takes a scheduled one back', async () => {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api, fetch: f.fetchFn, shareWaitMs: 1 });
    await slack.connect('xoxp-good');
    const outbox = new Outbox({ slack, onChange: () => {} });
    const to = { kind: 'channel' as const, id: 'C1', label: '#deploys' };
    const at = Date.parse('2026-10-31T13:00:00Z');
    const pending = outbox.request({ sessionId: 's1', to, text: '2.10.4 is on prod', at });
    expect(outbox.list()[0].at).toBe(at);
    expect((await outbox.decide(outbox.list()[0].id, { action: 'send' })).ok).toBe(true);
    expect(await pending).toMatchObject({ sent: true, at });
    const sched = f.calls.filter((c) => c.method === 'chat.scheduleMessage');
    expect(sched).toHaveLength(1);
    expect(sched[0].p).toMatchObject({ channel: 'C1', post_at: at / 1000 });
    expect(f.calls.some((c) => c.method === 'chat.postMessage')).toBe(false);
    // sent at once (on your word), then undone: unscheduled
    const r = await outbox.sendNow({ to, text: 'later', postAt: at });
    expect((await outbox.undo(r.id)).ok).toBe(true);
    expect(f.calls.find((c) => c.method === 'chat.deleteScheduledMessage')?.p).toMatchObject({ channel: 'C1' });
  });
});
