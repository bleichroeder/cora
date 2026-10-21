import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addressAllowed } from '@cora/shared';
import { Gmail, bodyText, checkConfig, mime, parseClient, watchQuery } from '../src/gmail';
import { MailWatches } from '../src/mailWatches';
import { readSecret } from '../src/secrets';

const CLIENT = JSON.stringify({ installed: { client_id: 'cid.apps.googleusercontent.com', client_secret: 'sec', project_id: 'cora-1', auth_uri: 'https://accounts.google.com/o/oauth2/auth', token_uri: 'https://oauth2.googleapis.com/token', redirect_uris: ['http://localhost'] } });
const b64 = (s: string) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
const msg = (id: string, o: { from?: string; subject?: string; labels?: string[]; snippet?: string } = {}) => ({
  id,
  threadId: `t${id}`,
  internalDate: String(Date.now()),
  labelIds: o.labels ?? ['INBOX', 'UNREAD'],
  snippet: o.snippet ?? 'hello',
  payload: { headers: [{ name: 'From', value: o.from ?? 'Ana Ruiz <ana@acme.com>' }, { name: 'To', value: 'david@acme.com' }, { name: 'Subject', value: o.subject ?? 'Hi' }, { name: 'Message-ID', value: `<m${id}@mail>` }], mimeType: 'text/plain', body: { data: b64('Body text') } },
});

/** A pretend Google: tokens, profile, history, search, messages, drafts. */
function google(o: { history?: string[]; threads?: Record<string, string>; search?: Record<string, string[]>; msgs?: Record<string, any> } = {}) {
  const calls: Array<{ url: string; body?: any }> = [];
  const fetchFn = (async (url: string, init?: any) => {
    const body = init?.body instanceof URLSearchParams ? Object.fromEntries(init.body) : init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    const ok = (j: unknown) => ({ ok: true, status: 200, json: async () => j });
    if (url.startsWith('https://oauth2.googleapis.com/token')) return ok({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, scope: 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose' });
    if (url.endsWith('/profile')) return ok({ emailAddress: 'david@acme.com', historyId: '100' });
    if (url.includes('/history?')) return ok({ historyId: '200', history: [{ messagesAdded: (o.history ?? []).map((id) => ({ message: { id, threadId: o.threads?.[id] ?? `t${id}` } })) }] });
    if (url.includes('/messages?')) {
      const q = new URL(url).searchParams.get('q') ?? '';
      const hit = Object.entries(o.search ?? {}).find(([k]) => q.includes(k));
      return ok({ messages: (hit?.[1] ?? []).map((id) => ({ id })) });
    }
    const m = /\/messages\/(\w+)\?/.exec(url);
    if (m) return ok(o.msgs?.[m[1]] ?? msg(m[1]));
    if (url.endsWith('/drafts')) return ok({ id: 'd1', message: { id: 'dm1' } });
    return { ok: false, status: 404, json: async () => ({ error: { message: 'nope' } }) };
  }) as unknown as typeof fetch;
  return { calls, fetchFn };
}

async function connected(g = google(), onMail?: (h: any[]) => void) {
  const dataDir = mkdtempSync(join(tmpdir(), 'cora-gmail-'));
  writeFileSync(join(dataDir, 'google-client.json'), CLIENT);
  const gm = new Gmail({ dataDir, fetchFn: g.fetchFn, ...(onMail ? { onMail } : {}) });
  const url = new URL(gm.authUrl('http://127.0.0.1:4317/api/gmail/callback'));
  await gm.finish(url.searchParams.get('state')!, 'code1');
  return { gm, dataDir, url, g };
}

describe('Gmail: your own Google app', () => {
  it('takes a Desktop app client, says why not for anything else', () => {
    expect(parseClient(CLIENT)).toMatchObject({ clientId: 'cid.apps.googleusercontent.com', projectId: 'cora-1' });
    expect(parseClient(JSON.stringify({ web: { client_id: 'x', client_secret: 'y' } }))).toMatchObject({ error: expect.stringMatching(/Desktop app/) });
    expect(parseClient('nope')).toHaveProperty('error');
    // Google's own addresses, whatever the file says (audit S16)
    const doctored = JSON.stringify({ installed: { client_id: 'c', client_secret: 's', token_uri: 'https://evil.example/token', auth_uri: 'https://evil.example/auth' } });
    expect(parseClient(doctored)).toMatchObject({ tokenUri: 'https://oauth2.googleapis.com/token', authUri: 'https://accounts.google.com/o/oauth2/auth' });
  });

  it("signs in with Google's page (PKCE, offline), once per state; the token stays in the data folder", async () => {
    const { gm, dataDir, url, g } = await connected();
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/auth');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(g.calls[0].body).toMatchObject({ grant_type: 'authorization_code', code: 'code1', code_verifier: expect.any(String), redirect_uri: 'http://127.0.0.1:4317/api/gmail/callback' });
    expect(gm.status()).toMatchObject({ client: true, connected: true, email: 'david@acme.com', watch: true, rules: [], important: false });
    expect(JSON.parse(readSecret(join(dataDir, 'gmail.json'))).refresh).toBe('rt');
    // the same state again (a replay) is refused
    await expect(gm.finish(url.searchParams.get('state')!, 'code1')).rejects.toThrow(/unknown or too old/);
    await gm.disconnect();
    expect(existsSync(join(dataDir, 'gmail.json'))).toBe(false);
    expect(g.calls.at(-1)!.url).toMatch(/oauth2\.googleapis\.com\/revoke\?token=rt/);
  });

  it('watches only for what you set: each rule over what just arrived (thousands of other emails ignored)', async () => {
    const told: any[] = [];
    const g = google({ history: ['a1', 'a2', 'a3'], search: { 'from:boss@acme.com': ['a2', 'old9'] } });
    const { gm } = await connected(g, (h) => told.push(...h));
    // nothing set: nothing watched
    expect(await gm.check()).toEqual([]);
    gm.setConfig({ rules: [{ id: '', label: 'Boss', query: 'from:boss@acme.com' }] });
    const hits = await gm.check();
    expect(hits.map((h) => [h.id, h.why])).toEqual([['a2', 'Boss']]);
    expect(told.map((h) => h.id)).toEqual(['a2']);
    // only the matching message was fetched, not all three
    expect(g.calls.filter((c) => /\/messages\/a\d\?/.test(c.url)).map((c) => /messages\/(\w+)/.exec(c.url)![1])).toEqual(['a2']);
  });

  it("Gmail's important as an extra: unread, inbox, not promotions, not your own", async () => {
    const g = google({
      history: ['b1', 'b2', 'b3'],
      msgs: { b1: msg('b1', { labels: ['INBOX', 'UNREAD', 'IMPORTANT'] }), b2: msg('b2', { labels: ['INBOX', 'UNREAD', 'IMPORTANT', 'CATEGORY_PROMOTIONS'] }), b3: msg('b3', { labels: ['INBOX', 'UNREAD', 'IMPORTANT'], from: 'david@acme.com' }) },
    });
    const { gm } = await connected(g);
    gm.setConfig({ important: true });
    expect((await gm.check()).map((h) => [h.id, h.why])).toEqual([['b1', 'important']]);
  });

  it('drafts: a reply in its thread with the right headers; only to whom you allow; never sent', async () => {
    const { gm, g } = await connected();
    // off until the user turns drafts on
    expect(gm.status().drafts).toBe(false);
    await expect(gm.draft({ replyTo: 'c1', body: 'x' })).rejects.toThrow(/Drafts is off/);
    expect(g.calls.some((c) => c.url.endsWith('/drafts'))).toBe(false);
    gm.setConfig({ drafts: true });
    const d = await gm.draft({ replyTo: 'c1', body: 'Sounds good.\nThanks' });
    expect(d).toMatchObject({ id: 'd1', to: 'Ana Ruiz <ana@acme.com>', subject: 'Re: Hi' });
    const sent = g.calls.find((c) => c.url.endsWith('/drafts'))!.body;
    expect(sent.message.threadId).toBe('tc1');
    const raw = Buffer.from(sent.message.raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
    expect(raw).toMatch(/^To: Ana Ruiz <ana@acme.com>\r\nSubject: Re: Hi\r\nIn-Reply-To: <mc1@mail>/);
    expect(g.calls.some((c) => /\/send/.test(c.url))).toBe(false);
    gm.setConfig({ draftTo: ['@acme.com'] });
    await expect(gm.draft({ to: 'someone@gmail.com', subject: 'x', body: 'y' })).rejects.toThrow(/only lets Cora write to @acme.com/);
    await expect(gm.draft({ to: 'ana@acme.com', cc: 'x@evil.com', subject: 'x', body: 'y' })).rejects.toThrow(/x@evil.com/);
    // your own reply (the Inbox's) isn't held to Cora's limits (audit B12)
    gm.setConfig({ drafts: false });
    await expect(gm.draft({ to: 'someone@gmail.com', subject: 'x', body: 'y' })).rejects.toThrow(/Drafts is off/);
    expect(await gm.draft({ to: 'someone@gmail.com', subject: 'x', body: 'y', byUser: true })).toMatchObject({ to: 'someone@gmail.com' });
  });

  it('email watches: a watched thread or search finds its email among what just arrived, checked for its sender; yours never count', async () => {
    const g = google({
      history: ['a1', 'a2', 'a3', 'a4'],
      threads: { a1: '18f2c0aa1' },
      search: { 'from:(qa@acme.com)': ['a2', 'old7'] },
      msgs: {
        a1: { ...msg('a1', { from: 'Ops <ops@acme.com>' }), threadId: '18f2c0aa1' },
        a2: msg('a2', { from: 'QA <qa@acme.com>', subject: 'Re: login' }),
        a3: msg('a3', { from: 'david@acme.com' }),
        a4: msg('a4', { from: 'Mark <mark@client.com>' }),
      },
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-gmail-'));
    writeFileSync(join(dataDir, 'google-client.json'), CLIENT);
    const watches = new MailWatches({});
    const seen: Array<[string, string, boolean]> = [];
    const gm = new Gmail({ dataDir, fetchFn: g.fetchFn, watches, onWatch: (w, m, t) => void seen.push([w.about, m.id, t.ok]) });
    const url = new URL(gm.authUrl('http://127.0.0.1:4317/api/gmail/callback'));
    await gm.finish(url.searchParams.get('state')!, 'c');
    watches.set({ about: 'capture 12', from: '@acme.com', thread: '18f2c0aa1', mode: 'thread', then: 'diagnose', sessionId: 's1', by: 'ops' });
    watches.set({ about: 'QA login', from: 'qa@acme.com', query: 'subject:login', then: 'look', sessionId: 's2', by: 'orion' });
    watches.set({ about: 'Mark', from: 'mark@client.com', query: 'subject:x', then: 'reply', sessionId: 's3', by: 'x' });
    await gm.check();
    // the thread's new message; the search's (not the old one); Mark's has no sender check from outside: not trusted
    expect(seen.slice(0, 2)).toEqual([['capture 12', 'a1', true], ['QA login', 'a2', true]]);
    expect(gm.status().watches.map((w) => [w.about, w.hits])).toEqual([['capture 12', 1], ['Mark', 0]]);
  });

  it('a header can never be smuggled in; non-ASCII subjects are encoded', () => {
    const m = mime({ to: 'a@b.com\r\nBcc: spy@x.com', subject: 'Café\nBcc: spy@x.com', body: 'hi' });
    expect(m.split('\r\n').filter((l) => /^Bcc:/i.test(l))).toEqual([]);
    expect(m).toMatch(/^Subject: =\?UTF-8\?B\?/m);
  });

  it('reads text (plain, or HTML flattened); rules, recipients and the watch search checked', () => {
    expect(bodyText({ mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/html', body: { data: b64('<p>Hi&nbsp;<b>there</b></p><script>x()</script>') } }] })).toBe('Hi there');
    expect(addressAllowed('ana@acme.com', ['@acme.com'])).toBe(true);
    expect(addressAllowed('ana@eu.acme.com', ['acme.com'])).toBe(true);
    expect(addressAllowed('ana@notacme.com', ['@acme.com'])).toBe(false);
    expect(addressAllowed('bob@x.com', ['bob@x.com'])).toBe(true);
    expect(addressAllowed('anyone@x.com', [])).toBe(true);
    expect(() => checkConfig({ rules: [{ id: '', label: 'x', query: ' ' }] })).toThrow(/Gmail search/);
    expect(() => checkConfig({ draftTo: ['not an address'] })).toThrow(/isn't an address/);
    expect(watchQuery({ rules: [{ id: '1', label: 'a', query: 'from:a' }, { id: '2', label: 'b', query: 'subject:x' }] })).toBe('{(from:a) (subject:x)}');
    expect(watchQuery(null)).toMatch(/^is:important/);
  });
});
