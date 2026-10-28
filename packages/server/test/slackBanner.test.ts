import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cora/shared';
import { Outbox, Slack, SlackError, quoted, richBlocks } from '../src/slack';
import { Banners, bannerWords, headline } from '../src/banner';

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
