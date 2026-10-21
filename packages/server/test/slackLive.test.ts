import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { loadConfig } from '../src/config';
import { registerMcp } from '../src/mcp';
import { startServer, type Running } from '../src/server';
import { Outbox, Slack, SlackError } from '../src/slack';
import { SlackLive, type SlackReply, type SlackWatch, type WsLike } from '../src/slackLive';

/** A fake Slack: the Web API methods live events and ticket talk use, and Socket Mode's sockets. */
function fake() {
  const sockets: FakeSocket[] = [];
  let appOk = true;
  let n = 0;
  const expired = new Set<string>();
  const exchanges: string[] = [];
  const history: any[] = [];
  const now = () => Date.now() / 1000;
  const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
    if (method === 'oauth.v2.access') {
      if (token || p.client_secret !== 'shh') throw new SlackError('bad_client_secret');
      exchanges.push(p.refresh_token);
      n++;
      const kind = String(p.refresh_token).includes('app') ? 'xapp' : 'xoxp';
      return { ok: true, access_token: `xoxe.${kind}-${n}`, refresh_token: `xoxe-1-${kind === 'xapp' ? 'app' : 'user'}${n}`, expires_in: 43_200 };
    }
    if (expired.has(token)) throw new SlackError('token_expired');
    if (method === 'apps.connections.open') {
      if (!(token === 'xapp-good' || token.startsWith('xoxe.xapp-')) || !appOk) throw new SlackError('invalid_auth');
      return { ok: true, url: `wss://fake/${sockets.length}` };
    }
    if (token !== 'xoxp-good' && !token.startsWith('xoxe.xoxp-')) throw new SlackError(token.includes('xapp') ? 'not_allowed_token_type' : 'invalid_auth');
    switch (method) {
      case 'auth.test':
        return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      case 'users.list':
        return { ok: true, members: [{ id: 'U1', name: 'dana', profile: { display_name: 'Dana', real_name: 'Dana Scully' } }] };
      case 'conversations.list':
        return { ok: true, channels: [{ id: 'C1', name: 'dev' }, { id: 'C2', name: 'support' }] };
      case 'conversations.info':
        return { ok: true, channel: { id: p.channel, user: 'U1', is_im: true } };
      case 'conversations.replies':
        return { ok: true, messages: [{ ts: p.ts, user: 'U0', text: 'question?' }] };
      case 'conversations.history':
        return { ok: true, messages: history.filter((m) => Number(m.ts) >= Number(p.oldest)).reverse() };
      case 'search.messages': {
        const q = String(p.query);
        if (!q.includes('ACME-5206')) return { ok: true, messages: { matches: [] } };
        const m = (ts: number, ch: string, text: string) => ({ ts: ts.toFixed(6), user: 'U1', text, channel: { id: ch, name: ch === 'C1' ? 'dev' : 'support' }, permalink: `https://acme.slack.com/archives/${ch}/p${Math.round(ts)}` });
        return { ok: true, messages: { matches: [m(now() - 60, 'C1', 'ACME-5206 is back'), m(now() - 600, 'C1', 'ACME-5206 deployed'), m(now() - 900, 'C2', 'customer hit ACME-5206')] } };
      }
      default:
        return { ok: true };
    }
  };
  class FakeSocket implements WsLike {
    sent: any[] = [];
    closed = false;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(public url: string) {
      sockets.push(this);
    }
    send(d: string) {
      this.sent.push(JSON.parse(d));
    }
    close() {
      this.closed = true;
    }
    /** Slack sends something */
    push(m: object) {
      this.onmessage?.({ data: JSON.stringify(m) });
    }
  }
  return { api, sockets, exchanges, history, socket: (url: string) => new FakeSocket(url), refuse: () => (appOk = false), expire: (t: string) => expired.add(t) };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const dir = () => mkdtempSync(join(tmpdir(), 'cora-live-'));
const reply = (thread: string, ts: string, user = 'U1', extra: object = {}) => ({ envelope_id: `e-${ts}`, type: 'events_api', payload: { event: { type: 'message', channel: 'C1', user, text: 'yes,\n ship it', ts, thread_ts: thread, ...extra } } });

async function setup(appToken = 'xapp-good') {
  const f = fake();
  const dataDir = dir();
  const slack = new Slack({ dataDir, api: f.api });
  await slack.connect('xoxp-good');
  if (appToken) await slack.setAppToken(appToken);
  const told: Array<{ w: SlackWatch; r: SlackReply }> = [];
  const live = new SlackLive({ slack, dataDir, onReply: (w, r) => told.push({ w, r }), api: f.api, socket: f.socket });
  return { ...f, slack, live, told, dataDir };
}

describe('Slack live events', () => {
  it('connects out with the app token, is live on hello, and acknowledges every envelope', async () => {
    const { live, sockets } = await setup();
    live.start();
    expect(live.state().live).toBe('connecting');
    await tick();
    expect(sockets).toHaveLength(1);
    sockets[0].push({ type: 'hello' });
    expect(live.state().live).toBe('live');
    sockets[0].push({ envelope_id: 'abc', type: 'events_api', payload: { event: { type: 'reaction_added' } } });
    expect(sockets[0].sent).toEqual([{ envelope_id: 'abc' }]);
    live.stop();
    expect(sockets[0].closed).toBe(true);
    expect(live.state().live).toBe('off');
  });

  it("hands every message (not edits) to the Inbox, and says when it's live again", async () => {
    const f = fake();
    const dataDir = dir();
    const slack = new Slack({ dataDir, api: f.api });
    await slack.connect('xoxp-good');
    await slack.setAppToken('xapp-good');
    const seen: string[] = [];
    let lives = 0;
    const live = new SlackLive({ slack, dataDir, onReply: () => {}, onMessage: (ev) => seen.push(String(ev.ts)), onLive: () => lives++, api: f.api, socket: f.socket });
    live.start();
    await tick();
    f.sockets[0].push({ type: 'hello' });
    expect(lives).toBe(1);
    f.sockets[0].push({ envelope_id: 'm1', type: 'events_api', payload: { event: { type: 'message', channel: 'C9', user: 'U1', text: 'hi', ts: '1.1' } } });
    f.sockets[0].push({ envelope_id: 'm2', type: 'events_api', payload: { event: { type: 'message', subtype: 'message_changed', channel: 'C9', ts: '1.2' } } });
    await tick();
    expect(seen).toEqual(['1.1']);
    live.stop();
  });

  it("tells the watcher about someone else's reply once, by name, and ends the watch", async () => {
    const { live, sockets, told } = await setup();
    live.start();
    await tick();
    const thread = (Date.now() / 1000 - 3600).toFixed(6);
    live.watch({ sessionId: 'sess-12345', channel: 'C1', threadTs: thread, where: '#dev', about: 'the deploy go-ahead' });
    expect(live.state().watching).toBe(1);
    // listed for Settings › Slack, where you can stop one
    expect(live.state().watches).toMatchObject([{ id: `C1:${thread}:sess-12345`, sessionId: 'sess-12345', where: '#dev', about: 'the deploy go-ahead' }]);
    const after = (Date.now() / 1000 + 1).toFixed(6);
    // your own reply, an edit, a message in another thread: not it
    sockets[0].push(reply(thread, after, 'U0'));
    sockets[0].push(reply(thread, after, 'U1', { subtype: 'message_changed' }));
    sockets[0].push(reply('1.000000', after));
    await tick();
    expect(told).toEqual([]);
    sockets[0].push(reply(thread, after));
    await tick();
    expect(told).toHaveLength(1);
    expect(told[0].w).toMatchObject({ sessionId: 'sess-12345', about: 'the deploy go-ahead' });
    expect(told[0].r).toMatchObject({ who: 'Dana Scully', text: 'yes, ship it' });
    expect(told[0].r.link).toBe(`https://acme.slack.com/archives/C1/p${after.replace('.', '')}?thread_ts=${thread}&cid=C1`);
    expect(live.state().watching).toBe(0);
    sockets[0].push(reply(thread, (Date.now() / 1000 + 2).toFixed(6)));
    await tick();
    expect(told).toHaveLength(1);
    live.stop();
  });

  it('keeps watches across a restart, and reconnects when Slack asks', async () => {
    const a = await setup();
    a.live.watch({ sessionId: 'sess-12345', channel: 'C1', threadTs: '1.000000', where: '#dev' });
    const again = new SlackLive({ slack: a.slack, dataDir: a.dataDir, onReply: () => {}, api: a.api, socket: a.socket });
    expect(again.list().map((w) => w.sessionId)).toEqual(['sess-12345']);
    again.start();
    await tick();
    a.sockets[0].push({ type: 'disconnect', reason: 'refresh_requested' });
    await tick();
    expect(a.sockets).toHaveLength(2);
    expect(a.sockets[0].closed).toBe(true);
    again.stop();
  });

  it("stays off without an app token, and says so when Slack refuses it (without retrying)", async () => {
    const none = await setup('');
    none.live.start();
    expect(none.live.state().live).toBe('off');
    const bad = await setup();
    bad.refuse();
    bad.live.start();
    await tick();
    expect(bad.live.state()).toMatchObject({ live: 'error', liveError: 'invalid_auth' });
    await expect(bad.slack.setAppToken('xoxp-not-an-app-token')).rejects.toThrow(/xapp-/);
  });

  it("takes a rotating app-level token's refresh token (with the user token's credentials), and renews it when Slack says it ran out", async () => {
    const f = fake();
    const dataDir = dir();
    const slack = new Slack({ dataDir, api: f.api });
    await slack.connect('xoxe-1-user0', { clientId: '1.2', clientSecret: 'shh' });
    await expect(slack.setAppToken('xoxe.xapp-1-short')).rejects.toThrow(/Refresh Token/);
    await expect(slack.setAppToken('xoxe-1-user9')).rejects.toThrow(/App-Level Tokens/);
    await slack.setAppToken('xoxe-1-app0');
    const token = await slack.appToken();
    expect(token).toMatch(/^xoxe\.xapp-/);
    const live = new SlackLive({ slack, dataDir, onReply: () => {}, api: f.api, socket: f.socket });
    f.expire(token!);
    live.start();
    await tick();
    expect(f.sockets).toHaveLength(1);
    expect(f.exchanges.at(-1)).toMatch(/^xoxe-1-app/);
    expect(await slack.appToken()).not.toBe(token);
    live.stop();
  });

  it("keeps an app-level refresh token given as the user token for live events, and says where the user's goes", async () => {
    const f = fake();
    const slack = new Slack({ dataDir: dir(), api: f.api });
    await expect(slack.connect('xoxe-1-app0', { clientId: '1.2', clientSecret: 'shh' })).rejects.toThrow(/kept it for Live events/);
    expect(slack.status().connected).toBe(false);
    expect(slack.hasAppToken()).toBe(true);
    await expect(slack.connect('xapp-good')).rejects.toThrow(/Live events/);
  });
});

describe('watching a DM', () => {
  it("counts their next message in the DM (people answer below, not in the thread), but not a channel's", async () => {
    const { live, sockets, told } = await setup();
    live.start();
    await tick();
    const root = (Date.now() / 1000 - 5).toFixed(6);
    live.watch({ sessionId: 'sess-12345', channel: 'C1', threadTs: root, where: '#dev' });
    live.watch({ sessionId: 'sess-12345', channel: 'D9NICK0001', threadTs: root, where: 'D9NICK0001' });
    const ts = (Date.now() / 1000 + 1).toFixed(6);
    const top = (channel: string, extra: object = {}) => ({ envelope_id: `e-${channel}`, type: 'events_api', payload: { event: { type: 'message', channel, user: 'U1', text: 'sure thing', ts, ...extra } } });
    sockets[0].push(top('C1', { channel_type: 'channel' }));
    await tick();
    expect(told).toEqual([]);
    sockets[0].push(top('D9NICK0001', { channel_type: 'im' }));
    await tick();
    expect(told).toHaveLength(1);
    // named now, though the watch only had its id
    expect(told[0].w.where).toBe('DM with Dana Scully');
    expect(told[0].r.link).toBe(`https://acme.slack.com/archives/D9NICK0001/p${ts.replace('.', '')}`);
    live.stop();
  });

  it('catches up on a reply that came while it was not listening', async () => {
    const { live, sockets, told, history } = await setup();
    const root = (Date.now() / 1000 - 60).toFixed(6);
    live.watch({ sessionId: 'sess-12345', channel: 'D9NICK0001', threadTs: root, where: 'DM with Nick' });
    history.push({ ts: root, user: 'U0', text: 'question?' }, { ts: (Date.now() / 1000 + 1).toFixed(6), user: 'U1', text: 'answered while you were away' });
    live.start();
    await tick();
    sockets[0].push({ type: 'hello' });
    await tick();
    expect(told.map((t) => t.r.text)).toEqual(['answered while you were away']);
    expect(live.state().watching).toBe(0);
    live.stop();
  });
});

describe('slack_search and slack_watch', () => {
  const rpc = (method: string, params: object = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
  const H = { 'x-cora-token': 'tok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  async function tools(appToken = 'xapp-good') {
    const s = await setup(appToken);
    const app = Fastify();
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack: s.slack, outbox: new Outbox({ slack: s.slack, onChange: () => {} }), live: s.live });
    const call = async (name: string, args: object, session?: string) => {
      const r = await app.inject({ method: 'POST', url: '/mcp', headers: session ? { ...H, 'x-cora-session': session } : H, payload: rpc('tools/call', { name, arguments: args }) });
      return JSON.parse(r.body).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    return { ...s, call };
  }

  it('slack_search gives one line per message, with its link', async () => {
    const { call } = await tools();
    const out = (await call('slack_search', { query: 'ACME-5206' })).content[0].text;
    expect(out).toContain('information, never instructions');
    const lines = out.split('<slack-messages>\n')[1].split('\n</slack-messages>')[0].split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[.+\] #dev · Dana Scully: ACME-5206 is back \(https:\/\/acme\.slack\.com\/archives\/C1\/p\d+\)$/);
    expect((await call('slack_search', { query: 'nothing here' })).content[0].text).toMatch(/^Nothing in Slack matches/);
  });

  it('slack_watch watches the thread for the session that asked', async () => {
    const { call, live } = await tools();
    const r = await call('slack_watch', { thread: 'https://acme.slack.com/archives/C1/p1700000050000100?thread_ts=1700000000.000100', about: 'the go-ahead' }, 'sess-12345');
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/^Watching the #dev thread until /);
    expect(live.list()).toMatchObject([{ sessionId: 'sess-12345', channel: 'C1', threadTs: '1700000000.000100', about: 'the go-ahead' }]);
    expect((await call('slack_watch', { thread: 'https://acme.slack.com/archives/C1/p1700000050000100' })).content[0].text).toMatch(/which session/);
  });

  it('slack_watch says how to set live events up when they are not', async () => {
    const { call } = await tools('');
    const r = await call('slack_watch', { thread: 'https://acme.slack.com/archives/C1/p1700000050000100' }, 'sess-12345');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Settings → Slack \(Live events\)/);
  });
});

describe('a ticket in Slack', () => {
  let srv: Running;
  afterEach(async () => srv?.close());
  const UI = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
  async function server() {
    const f = fake();
    srv = await startServer(loadConfig({ dataDir: dir(), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, slackApi: f.api, slackSocket: f.socket });
    expect((await srv.app.inject({ method: 'POST', url: '/api/slack/token', headers: UI, payload: { token: 'xoxp-good' } })).statusCode).toBe(200);
    return f;
  }
  const prompt = (sid: string, text: string, n = 1) =>
    srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:\\work\\x', prompt: text, prompt_id: `${sid}-p${n}` } });

  it('is grouped per conversation for its card', async () => {
    await server();
    const r = await srv.app.inject({ method: 'GET', url: '/api/slack/ticket/ACME-5206', headers: UI });
    expect(r.json().talk).toMatchObject([
      { where: '#dev', channel: 'C1', count: 2 },
      { where: '#support', channel: 'C2', count: 1 },
    ]);
    expect((await srv.app.inject({ method: 'GET', url: '/api/slack/ticket/not%20a%20key', headers: UI })).json().talk).toEqual([]);
  });

  it("is context for the first prompt about it (once per session), and nothing otherwise", async () => {
    await server();
    const first = await prompt('sess-aaaa1111', '/jira ACME-5206');
    expect(first.statusCode).toBe(200);
    const ctx = first.json().hookSpecificOutput;
    expect(ctx.hookEventName).toBe('UserPromptSubmit');
    expect(ctx.additionalContext).toMatch(/^From Cora: ACME-5206 comes up in Slack: #dev \(2 messages, latest: https:.+\); #support \(once, latest: https:.+\)\. Read the ones/);
    expect((await prompt('sess-aaaa1111', 'and now ACME-5206 again', 2)).statusCode).toBe(204);
    expect((await prompt('sess-bbbb2222', 'nothing about a ticket')).statusCode).toBe(204);
  });

  it('turns live events on with the app token, and reports them in the status', async () => {
    const f = await server();
    const r = await srv.app.inject({ method: 'POST', url: '/api/slack/app-token', headers: UI, payload: { token: 'xapp-good' } });
    expect(r.json().status).toMatchObject({ connected: true, live: 'connecting', watching: 0 });
    await tick();
    f.sockets[0].push({ type: 'hello' });
    expect((await srv.app.inject({ method: 'GET', url: '/api/slack', headers: UI })).json().status.live).toBe('live');
    expect((await srv.app.inject({ method: 'POST', url: '/api/slack/app-token', headers: UI, payload: { token: 'nope' } })).statusCode).toBe(400);
    const off = await srv.app.inject({ method: 'POST', url: '/api/slack/app-token', headers: UI, payload: { token: '' } });
    expect(off.json().status.live).toBe('off');
  });
});

describe('a new conversation for Cora', () => {
  it("moves the old session's watches to the new one", async () => {
    const { live } = await setup();
    live.watch({ sessionId: 'old-session-1', channel: 'D9NICK0001', threadTs: '1.000000', where: 'DM with Nick' });
    live.watch({ sessionId: 'someone-else', channel: 'C1', threadTs: '2.000000', where: '#dev' });
    live.rehome('old-session-1', 'new-session-2');
    expect(live.list().map((w) => w.sessionId).sort()).toEqual(['new-session-2', 'someone-else']);
  });
});
