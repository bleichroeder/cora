import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSlackLink, rankByName, slackWebUrl, toMrkdwn } from '@cora/shared';
import { registerMcp, type McpSlack } from '../src/mcp';
import { Outbox, Slack, SlackError, sections, slackApi } from '../src/slack';
import { applyPatch } from '../src/prefs';
import { readSecret } from '../src/secrets';

/** A small fake Slack workspace behind the Web API methods Cora uses; records what was posted. */
function fakeSlack() {
  const posted: any[] = [];
  const searchNow = Date.now() / 1000;
  const opened: string[] = [];
  const deleted: any[] = [];
  let canSearch = true;
  const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
    if (token !== 'xoxp-good') throw new SlackError('invalid_auth');
    switch (method) {
      case 'auth.test':
        return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      case 'users.list':
        return {
          ok: true,
          members: [
            { id: 'U1', name: 'dana', profile: { display_name: 'Dana', real_name: 'Dana Scully', email: 'dana@acme.com' } },
            { id: 'U0', name: 'david', profile: { display_name: 'David', real_name: 'David Example', email: 'david@acme.com' } },
            { id: 'U2', name: 'dan.m', profile: { display_name: 'Dan', real_name: 'Dan Miller', email: 'dmiller@acme.com' } },
            { id: 'U3', name: 'oldtimer', deleted: true, profile: {} },
            { id: 'B1', name: 'jirabot', is_bot: true, profile: {} },
          ],
        };
      case 'conversations.list':
        return { ok: true, channels: [{ id: 'C1', name: 'deploys' }, { id: 'C2', name: 'dev-team', is_private: true }, { id: 'G1', name: 'mpdm-dana--david', is_mpim: true }] };
      case 'conversations.open':
        opened.push(p.users);
        return { ok: true, channel: { id: `D-${p.users}` } };
      case 'chat.postMessage':
        posted.push(p);
        return { ok: true, ts: '1700000000.000200' };
      case 'chat.getPermalink':
        return { ok: true, permalink: `https://acme.slack.com/archives/${p.channel}/p1700000000000200` };
      case 'conversations.history':
        return { ok: true, messages: [{ ts: '1700000100.000000', user: 'U2', text: 'second' }, { ts: '1700000000.000000', user: 'U1', text: 'hi <@U2>, see <https://x.io|the doc>', reply_count: 2 }] };
      case 'chat.delete':
        deleted.push(p);
        return { ok: true };
      case 'search.messages': {
        if (!canSearch) throw new SlackError('missing_scope');
        // one "now" for the whole workspace: two searches must see the same message at the same ts
        const now = searchNow;
        const dm = { ts: `${(now - 600).toFixed(6)}`, user: 'U1', username: 'dana', text: 'can you look at\nthe release?', channel: { id: 'D1', is_im: true }, permalink: 'https://acme.slack.com/archives/D1/p1' };
        const mention = { ts: `${(now - 1200).toFixed(6)}`, user: 'U2', username: 'dan.m', text: '<@U0> pipeline is red', channel: { id: 'C1', name: 'deploys' }, permalink: 'https://acme.slack.com/archives/C1/p2' };
        const old = { ts: `${(now - 3 * 86400).toFixed(6)}`, user: 'U1', text: 'old', channel: { id: 'D1', is_im: true } };
        const mine = { ts: `${(now - 60).toFixed(6)}`, user: 'U0', text: 'my own', channel: { id: 'D1', is_im: true } };
        return { ok: true, messages: { matches: String(p.query).startsWith('to:me') ? [dm, old, mine] : [mention, dm] } };
      }
      case 'conversations.replies':
        return { ok: true, messages: [{ ts: p.ts, user: 'U1', text: 'question?' }, { ts: '1700000050.000000', user: 'U0', text: 'answer' }] };
      default:
        throw new SlackError(`unknown_method:${method}`);
    }
  };
  return { api, posted, opened, deleted, noSearch: () => (canSearch = false) };
}

const dir = () => mkdtempSync(join(tmpdir(), 'cora-slack-'));
async function connected() {
  const f = fakeSlack();
  const changes: number[] = [];
  const slack = new Slack({ dataDir: dir(), api: f.api, onChange: () => changes.push(1) });
  await slack.connect('xoxp-good');
  return { ...f, slack, changes };
}

describe('Slack helpers', () => {
  it('reads message links, with and without a thread', () => {
    expect(parseSlackLink('https://acme.slack.com/archives/C0123ABC/p1700000000123456')).toEqual({ channel: 'C0123ABC', ts: '1700000000.123456' });
    expect(parseSlackLink('https://acme.slack.com/archives/C0123ABC/p1700000050000100?thread_ts=1700000000.123456&cid=C0123ABC')).toEqual({ channel: 'C0123ABC', ts: '1700000050.000100', threadTs: '1700000000.123456' });
    expect(parseSlackLink('https://example.com/archives/C1/p1')).toBeNull();
  });
  it('builds web app links', () => {
    expect(slackWebUrl('T1', 'C1')).toBe('https://app.slack.com/client/T1/C1');
    expect(slackWebUrl('T1', 'C1', '1700000000.000100')).toBe('https://app.slack.com/client/T1/C1/thread/C1-1700000000.000100');
  });
  it("turns Claude's markdown into Slack's, leaving code alone", () => {
    expect(toMrkdwn('## Deploy\n**done** and ~~late~~, see [the MR](https://gitlab.com/x) and `**not bold**`')).toBe('*Deploy*\n*done* and ~late~, see <https://gitlab.com/x|the MR> and `**not bold**`');
    expect(toMrkdwn('```\n**keep**\n```')).toBe('```\n**keep**\n```');
  });
  it('ranks names: exact, then starts with, then a word, then contains', () => {
    const items = [{ names: ['dev-team'] }, { names: ['deploys'] }, { names: ['web-dev'] }, { names: ['undev'] }, { names: ['dev'] }];
    expect(rankByName(items, 'dev').map((x) => x.names[0])).toEqual(['dev', 'dev-team', 'web-dev', 'undev']);
    expect(rankByName(items, '  ')).toEqual([]);
  });
  it('calls the Web API form-encoded with the token, retrying once when rate-limited', async () => {
    const calls: any[] = [];
    let n = 0;
    const fetchFn = (async (url: string, init: any) => {
      calls.push({ url, auth: init.headers.authorization, body: String(init.body) });
      if (n++ === 0) return new Response('', { status: 429, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify({ ok: true, ts: '1' }), { status: 200 });
    }) as typeof fetch;
    const r = await slackApi('xoxp-1', 'https://slack.test/api', fetchFn)('chat.postMessage', { channel: 'C1', text: 'hi & bye', thread_ts: undefined });
    expect(r.ts).toBe('1');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ url: 'https://slack.test/api/chat.postMessage', auth: 'Bearer xoxp-1', body: 'channel=C1&text=hi+%26+bye' });
    const bad = slackApi('xoxp-1', 'https://slack.test/api', (async () => new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }))) as typeof fetch);
    await expect(bad('chat.postMessage')).rejects.toThrow('channel_not_found');
  });
});

describe('the Slack connection', () => {
  it('takes only a user token, checks it and keeps it in the data folder', async () => {
    const f = fakeSlack();
    const d = dir();
    const slack = new Slack({ dataDir: d, api: f.api });
    await expect(slack.connect('xoxb-123')).rejects.toThrow(/bot token/);
    await expect(slack.connect('nope')).rejects.toThrow(/xoxp-/);
    await expect(slack.connect('xoxp-bad')).rejects.toThrow('invalid_auth');
    expect(slack.status()).toEqual({ connected: false });
    expect(await slack.connect(' xoxp-good ')).toEqual({ connected: true, team: 'Acme', teamId: 'T1', user: 'david', userId: 'U0', url: 'https://acme.slack.com/' });
    expect(JSON.parse(readSecret(join(d, 'slack.json'))).token).toBe('xoxp-good');
    // a restart picks it up
    expect(new Slack({ dataDir: d, api: f.api }).status().connected).toBe(true);
    slack.disconnect();
    expect(existsSync(join(d, 'slack.json'))).toBe(false);
  });

  it('finds people (not bots or deactivated ones) and channels', async () => {
    const { slack } = await connected();
    expect((await slack.find('dan')).map((t) => t.label)).toEqual(['Dan', 'Dana', 'dana, david']);
    expect((await slack.find('#dep')).map((t) => `${t.kind} ${t.label}`)).toEqual(['channel #deploys']);
    expect(await slack.find('jirabot')).toEqual([]);
    expect(await slack.find('oldtimer')).toEqual([]);
  });

  it('resolves who a message is for, and says so when a name is ambiguous or unknown', async () => {
    const { slack } = await connected();
    expect(await slack.resolve('#deploys')).toMatchObject({ kind: 'channel', id: 'C1', label: '#deploys' });
    expect(await slack.resolve('@dana')).toMatchObject({ kind: 'person', id: 'U1', label: 'Dana' });
    expect(await slack.resolve('dmiller@acme.com')).toMatchObject({ id: 'U2' });
    expect(await slack.resolve('Dana Scully')).toMatchObject({ id: 'U1' });
    expect(await slack.resolve('U2')).toMatchObject({ id: 'U2', label: 'Dan' });
    expect(await slack.resolve('C2')).toMatchObject({ id: 'C2', detail: 'private' });
    await expect(slack.resolve('da')).rejects.toThrow(/could mean: .*Dan.*Dana/);
    await expect(slack.resolve('zebra')).rejects.toThrow(/no person or channel/);
  });

  it('posts as Slack markup, with real mentions, opening a DM for a person', async () => {
    const { slack, posted, opened } = await connected();
    const r = await slack.post({ kind: 'person', id: 'U1', label: 'Dana' }, '**Deployed**, thanks @dan.m (cc @nobody)');
    expect(opened).toEqual(['U1']);
    expect(posted[0]).toEqual({ channel: 'D-U1', text: '*Deployed*, thanks <@U2> (cc @nobody)' });
    expect(r.link).toBe('https://acme.slack.com/archives/D-U1/p1700000000000200');
    await slack.post({ kind: 'channel', id: 'C1', label: '#deploys' }, 'in thread', '1700000000.000100');
    expect(posted[1]).toEqual({ channel: 'C1', text: 'in thread', thread_ts: '1700000000.000100' });
  });

  it('reads a conversation oldest first, with names, and a thread from its link', async () => {
    const { slack } = await connected();
    const r = await slack.read({ to: '#deploys' });
    expect(r.lines).toEqual(['[2023-11-14 22:13] Dana: hi @Dan, see the doc (https://x.io) (2 replies, thread 1700000000.000000)', '[2023-11-14 22:15] Dan: second']);
    const t = await slack.read({ link: 'https://acme.slack.com/archives/C1/p1700000000000000' });
    expect(t.thread).toBe('1700000000.000000');
    expect(t.lines.map((l) => l.split('] ')[1])).toEqual(['Dana: question?', 'David: answer']);
  });

  it('forgets a token Slack no longer accepts', async () => {
    const f = fakeSlack();
    const d = dir();
    const slack = new Slack({ dataDir: d, api: f.api });
    await slack.connect('xoxp-good');
    // the app was removed: every call now fails
    (slack as any).auth.token = 'xoxp-revoked';
    await expect(slack.find('dan')).rejects.toThrow('invalid_auth');
    expect(slack.status()).toEqual({ connected: false, error: expect.stringMatching(/connect again/) });
    expect(existsSync(join(d, 'slack.json'))).toBe(false);
  });
});

describe('the outbox', () => {
  let timers: NodeJS.Timeout[] = [];
  afterEach(() => timers.forEach(clearTimeout));

  it('holds a draft until you send it, then posts what you sent', async () => {
    const { slack, posted } = await connected();
    let changes = 0;
    const outbox = new Outbox({ slack, onChange: () => changes++ });
    const out = outbox.request({ sessionId: 's1', to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'Deployed 2.10' });
    const [d] = outbox.list();
    expect(d).toMatchObject({ sessionId: 's1', text: 'Deployed 2.10', waiting: true });
    expect(posted).toEqual([]);
    expect(await outbox.decide(d.id, { action: 'send', text: 'Deployed 2.10 to QA' })).toEqual({ ok: true, link: expect.stringContaining('/archives/C1/') });
    expect(await out).toMatchObject({ sent: true, text: 'Deployed 2.10 to QA', edited: true });
    expect(posted[0].text).toBe('Deployed 2.10 to QA');
    expect(outbox.list()).toEqual([]);
    expect(changes).toBe(2);
    expect((await outbox.decide(d.id, { action: 'send' })).ok).toBe(false);
  });

  it("marks what Cora sends for you with a line under it (your sign-off, on your behalf); never what you typed yourself", async () => {
    const { slack, posted } = await connected();
    let sign = ':cora:';
    const outbox = new Outbox({ slack, onChange: () => {}, sign: () => sign });
    const to = { kind: 'channel' as const, id: 'C1', label: '#deploys' };
    const out = outbox.request({ sessionId: 's1', to, text: 'Deployed 2.10' });
    await outbox.decide(outbox.list()[0].id, { action: 'send' });
    // the message as written; under it, Slack's small grey line
    expect(posted[0].text).toBe('Deployed 2.10');
    expect(posted[0].blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Deployed 2.10' } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: ":cora:  Sent from Cora on David's behalf" }] },
    ]);
    // what the session hears is what it wrote
    expect(await out).toMatchObject({ sent: true, text: 'Deployed 2.10', edited: false });
    await outbox.sendNow({ to, text: 'On it', own: true });
    expect(posted[1].blocks.at(-1).type).toBe('context');
    await outbox.sendNow({ to, text: 'Thanks, will look', typed: true });
    expect(posted[2]).toMatchObject({ text: 'Thanks, will look' });
    expect(posted[2].blocks).toBeUndefined();
    sign = '';
    await outbox.sendNow({ to, text: 'No sign-off' });
    expect(posted[3].blocks).toBeUndefined();
    expect(() => applyPatch(DEFAULT_SETTINGS, { slack: { sign: 'x'.repeat(41) } })).toThrow(/slack.sign/);
    expect(applyPatch(DEFAULT_SETTINGS, { slack: { sign: ' :robot_face: ' } }).slack).toEqual({ follow: [], sign: ':robot_face:' });
    expect(DEFAULT_SETTINGS.slack.sign).toBe(':cora:');
  });

  it('a draft waiting for you is still there after a restart, and still sends (audit U3)', async () => {
    const { slack, posted } = await connected();
    const draftsFile = join(mkdtempSync(join(tmpdir(), 'cora-drafts-')), 'slack-drafts.json');
    const before = new Outbox({ slack, onChange: () => {}, draftsFile });
    void before.request({ sessionId: 's1', to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'Deployed 2.10' });
    const after = new Outbox({ slack, onChange: () => {}, draftsFile });
    const [d] = after.list();
    expect(d).toMatchObject({ sessionId: 's1', text: 'Deployed 2.10', waiting: false });
    expect(await after.decide(d.id, { action: 'send' })).toMatchObject({ ok: true });
    expect(posted.at(-1).text).toBe('Deployed 2.10');
    expect(JSON.parse(readFileSync(draftsFile, 'utf8'))).toEqual([]);
  });

  it('can go to someone else, be discarded, or be taken to Slack', async () => {
    const { slack, posted } = await connected();
    const outbox = new Outbox({ slack, onChange: () => {} });
    const a = outbox.request({ sessionId: null, to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'x' });
    await outbox.decide(outbox.list()[0].id, { action: 'send', to: { kind: 'person', id: 'U1', label: 'Dana' } });
    expect(await a).toMatchObject({ sent: true, edited: true, to: { id: 'U1' } });
    expect(posted[0].channel).toBe('D-U1');
    const b = outbox.request({ sessionId: null, to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'y' });
    await outbox.decide(outbox.list()[0].id, { action: 'discard' });
    expect(await b).toEqual({ sent: false, why: 'discarded', text: 'y', to: expect.anything() });
    const c = outbox.request({ sessionId: null, to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'z', threadTs: '1700000000.000100' });
    expect(await outbox.decide(outbox.list()[0].id, { action: 'opened' })).toEqual({ ok: true, url: 'https://app.slack.com/client/T1/C1/thread/C1-1700000000.000100' });
    expect((await c).sent).toBe(false);
    expect(posted).toHaveLength(1);
  });

  it("tells the session it's waiting after a while, and keeps the draft for you", async () => {
    const { slack, posted } = await connected();
    const outbox = new Outbox({ slack, onChange: () => {}, waitMs: 20 });
    const out = await outbox.request({ sessionId: 's1', to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'later' });
    expect(out).toEqual({ sent: false, why: 'waiting' });
    expect(outbox.list()[0]).toMatchObject({ text: 'later', waiting: false });
    expect((await outbox.decide(outbox.list()[0].id, { action: 'send' })).ok).toBe(true);
    expect(posted[0].text).toBe('later');
  });

  it("knows whose a draft is from the session's own call when the MCP request didn't say", async () => {
    const { slack } = await connected();
    const outbox = new Outbox({ slack, onChange: () => {} });
    outbox.noteCall('s-before', { to: '#deploys', text: 'seen first' });
    void outbox.request({ sessionId: null, to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'seen first' });
    void outbox.request({ sessionId: null, to: { kind: 'channel', id: 'C1', label: '#deploys' }, text: 'seen after' });
    outbox.noteCall('s-after', { to: '#deploys', text: 'seen after' });
    expect(outbox.list().map((d) => d.sessionId)).toEqual(['s-before', 's-after']);
  });
});

describe('the Slack tools', () => {
  const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
  const H = { 'x-cora-token': 'tok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  async function setup(connect = true, cora?: { turn: () => boolean }, toYou?: McpSlack['toYou']) {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api });
    if (connect) await slack.connect('xoxp-good');
    const outbox = new Outbox({ slack, onChange: () => {} });
    const app = Fastify();
    // Cora's own agent is the session "cora"
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack, outbox, ...(toYou ? { toYou } : {}) }, cora ? { isAgent: (sid) => sid === 'cora-agent-1', deps: () => ({}) as never, userTurn: cora.turn } : undefined);
    const call = async (name: string, args: object, headers: Record<string, string> = H) => {
      const r = await app.inject({ method: 'POST', url: '/mcp', headers, payload: rpc('tools/call', { name, arguments: args }) });
      return JSON.parse(r.body).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    return { ...f, slack, outbox, app, call };
  }

  it('are listed, and say how to connect when Slack is not connected', async () => {
    const { app, call } = await setup(false);
    const list = await app.inject({ method: 'POST', url: '/mcp', headers: H, payload: rpc('tools/list') });
    expect(JSON.parse(list.body).result.tools.map((t: any) => t.name).sort()).toEqual(['deploys', 'environment', 'open_tab', 'slack_find', 'slack_inbox', 'slack_read', 'slack_search', 'slack_send', 'slack_watch', 'speak']);
    const r = await call('slack_send', { to: '#deploys', text: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Settings → Slack/);
  });

  it('find and read', async () => {
    const { call } = await setup();
    expect((await call('slack_find', { query: 'dana' })).content[0].text.split('\n')).toEqual(['Dana — person U1 (Dana Scully · @dana · dana@acme.com)', 'dana, david — group G1 (group DM)']);
    expect((await call('slack_read', { to: 'C1', limit: 5 })).content[0].text.split('\n')[0]).toBe('#deploys');
  });

  it('send waits for your answer and reports it; the draft says which session asked', async () => {
    const { call, outbox, posted } = await setup();
    const pending = call('slack_send', { to: '@dana', text: 'Fix is in QA' }, { ...H, 'x-cora-session': 'sess-1234', 'x-cora-agent': 'tok' });
    await new Promise((r) => setTimeout(r, 50));
    const [d] = outbox.list();
    expect(d).toMatchObject({ sessionId: 'sess-1234', to: { id: 'U1', label: 'Dana' }, text: 'Fix is in QA' });
    await outbox.decide(d.id, { action: 'send', text: 'Fix is in QA now' });
    const r = await pending;
    expect(r.content[0].text).toMatch(/^Sent to Dana\. https:\/\/acme\.slack\.com\/archives\/D-U1\/.* The user changed it before sending; what went to Dana:\nFix is in QA now$/s);
    expect(posted[0].text).toBe('Fix is in QA now');
  });

  it('replies in a thread from a link, and reports a discard', async () => {
    const { call, outbox } = await setup();
    const pending = call('slack_send', { to: 'ignored', text: 'on it', thread: 'https://acme.slack.com/archives/C1/p1700000050000100?thread_ts=1700000000.000100' });
    await new Promise((r) => setTimeout(r, 50));
    expect(outbox.list()[0]).toMatchObject({ to: { id: 'C1' }, threadTs: '1700000000.000100' });
    await outbox.decide(outbox.list()[0].id, { action: 'discard' });
    expect((await pending).content[0].text).toMatch(/discarded/);
  });

  it('a message to you yourself goes at once, with no draft (any session: nobody else reads it)', async () => {
    const { call, outbox, posted } = await setup();
    const r = await call('slack_send', { to: 'U0', text: 'Done: the README is on GitHub' });
    expect(r.content[0].text).toMatch(/^Sent to the user's own DM, straight away/);
    expect(outbox.list()).toEqual([]);
    expect(posted.at(-1)).toMatchObject({ channel: 'D-U0' });
    expect(posted.at(-1).text).toMatch(/^Done: the README is on GitHub/);
  });

  it("a message to you goes through Cora's bot when it's set up (it pings you; your own DM doesn't), else to your own DM saying so", async () => {
    const sent: Array<{ sessionId: string | null; text: string }> = [];
    const bot = await setup(true, undefined, async (d) => (sent.push(d), { ok: true, link: 'https://acme.slack.com/archives/D-BOT/p1' }));
    const r = await bot.call('slack_send', { to: 'U0', text: '#421 check 1/3: OK' }, { ...H, 'x-cora-session': 'race-1234' });
    expect(r.content[0].text).toMatch(/^Sent to the user through Cora's bot .*pings their phone.* https:\/\/acme\.slack\.com\/archives\/D-BOT\/p1$/);
    expect(sent).toEqual([{ sessionId: 'race-1234', text: '#421 check 1/3: OK' }]);
    // a plain one, when the user asked for no banner
    await bot.call('slack_send', { to: 'U0', text: 'plain please', banner: false }, { ...H, 'x-cora-session': 'race-1234' });
    expect(sent.at(-1)).toEqual({ sessionId: 'race-1234', text: 'plain please', banner: false });
    expect(bot.posted).toEqual([]);
    // no bot: your own DM, and the session is told it won't ping you
    const none = await setup(true, undefined, async () => null);
    const r2 = await none.call('slack_send', { to: 'U0', text: 'check 2/3: OK' });
    expect(r2.content[0].text).toMatch(/own DM.*doesn't ping them/);
    expect(none.posted.at(-1)).toMatchObject({ channel: 'D-U0' });
  });

  it('a message for later: the draft carries its time (Slack holds it once you OK it); not to yourself, not with files', async () => {
    const { call, outbox } = await setup();
    void call('slack_send', { to: '#deploys', text: '2.10.4 is on prod', at: 'in 2h' });
    await new Promise((r) => setTimeout(r, 50));
    const d = outbox.list()[0];
    expect(d.at).toBeGreaterThan(Date.now() + 119 * 60_000);
    expect((await call('slack_send', { to: 'U0', text: 'later', at: 'in 2h' })).content[0].text).toMatch(/can't be scheduled/);
    expect((await call('slack_send', { to: '#deploys', text: 'x', at: 'whenever' })).content[0].text).toMatch(/at: a time like/);
  });

  it('asks for an id when a name is ambiguous, without making a draft', async () => {
    const { call, outbox } = await setup();
    const r = await call('slack_send', { to: 'da', text: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/could mean/);
    expect(outbox.list()).toEqual([]);
  });
});

describe('Cora sending, reading and catching up', () => {
  const rpc = (method: string, params: object = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
  const H = { 'x-cora-token': 'tok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
  async function setup(turn: () => boolean) {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api });
    await slack.connect('xoxp-good');
    const outbox = new Outbox({ slack, onChange: () => {} });
    const app = Fastify();
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack, outbox }, { isAgent: (sid) => sid === 'cora-agent-1', deps: () => ({}) as never, userTurn: turn });
    const call = async (name: string, args: object, session: string) => {
      const r = await app.inject({ method: 'POST', url: '/mcp', headers: { ...H, 'x-cora-session': session, 'x-cora-agent': 'tok' }, payload: rpc('tools/call', { name, arguments: args }) });
      return JSON.parse(r.body).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    return { ...f, slack, outbox, call };
  }

  it('sends at once when you asked Cora, and Undo takes it back', async () => {
    const { call, outbox, posted, deleted } = await setup(() => true);
    const r = await call('slack_send', { to: '#deploys', text: 'canvas 0.10.0 is out' }, 'cora-agent-1');
    expect(r.content[0].text).toMatch(/^Sent to #deploys, straight away/);
    expect(posted).toHaveLength(1);
    expect(outbox.list()).toEqual([]);
    const [m] = outbox.sent();
    expect(m).toMatchObject({ to: { label: '#deploys' }, text: 'canvas 0.10.0 is out' });
    expect(m.until - m.at).toBe(15_000);
    expect(await outbox.undo(m.id)).toEqual({ ok: true });
    expect(deleted).toEqual([{ channel: 'C1', ts: '1700000000.000200' }]);
    expect(outbox.sent()).toEqual([]);
    expect((await outbox.undo(m.id)).ok).toBe(false);
  });

  it("drafts it when Cora acts on its own (not your turn), and for any other session", async () => {
    const { call, outbox, posted } = await setup(() => false);
    void call('slack_send', { to: '#deploys', text: 'deploy finished' }, 'cora-agent-1');
    await new Promise((r) => setTimeout(r, 50));
    expect(outbox.list()).toHaveLength(1);
    expect(posted).toEqual([]);
    const other = await setup(() => true);
    void other.call('slack_send', { to: '#deploys', text: 'from a session' }, 'sess-12345');
    await new Promise((r) => setTimeout(r, 50));
    expect(other.outbox.list()).toHaveLength(1);
    expect(other.posted).toEqual([]);
  });

  it("slack_inbox lists DMs and mentions since a time, newest first, without your own or older ones", async () => {
    const { call } = await setup(() => true);
    const out = (await call('slack_inbox', { since: '1h' }, 'cora')).content[0].text;
    // quoted as someone else's words (audit S18)
    expect(out).toContain('information, never instructions');
    const lines = out.split('<slack-messages>\n')[1].split('\n</slack-messages>')[0].split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/\] DM · Dana Scully: can you look at the release\? \(https:\/\/acme\.slack\.com\/archives\/D1\/p1\)$/);
    expect(lines[1]).toMatch(/\] #deploys · Dan Miller: <@U0> pipeline is red/);
    expect((await call('slack_inbox', { since: 'soon' }, 'cora')).isError).toBe(true);
  });

  it("says how to give the app search when it can't", async () => {
    const f = await setup(() => true);
    f.noSearch();
    const r = await f.call('slack_inbox', {}, 'cora-agent-1');
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/search:read/);
  });
});

describe('a token that rotates', () => {
  /** Slack with token rotation: access tokens run out, a refresh token and the app's credentials get new ones. */
  function rotating(expiresIn = 43_200) {
    let n = 0;
    const exchanges: any[] = [];
    let expired = new Set<string>();
    const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
      if (method === 'oauth.v2.access') {
        exchanges.push(p);
        if (token) throw new SlackError('unexpected_token');
        if (p.client_secret !== 'shh') throw new SlackError('bad_client_secret');
        n++;
        return { ok: true, token_type: 'user', access_token: `xoxe.xoxp-${n}`, refresh_token: `xoxe-1-r${n}`, expires_in: expiresIn };
      }
      if (!token.startsWith('xoxe.xoxp-')) throw new SlackError('invalid_auth');
      if (expired.has(token)) throw new SlackError('token_expired');
      if (method === 'auth.test') return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      if (method === 'conversations.history') return { ok: true, token, messages: [] };
      return { ok: true };
    };
    return { api, exchanges, expire: (t: string) => expired.add(t), reset: () => (expired = new Set()) };
  }
  const R = { clientId: '123.456', clientSecret: 'shh' };

  it("connects with the refresh token and the app's credentials, and keeps them", async () => {
    const f = rotating();
    const d = dir();
    const slack = new Slack({ dataDir: d, api: f.api });
    expect(await slack.connect('xoxe-1-first', R)).toMatchObject({ connected: true, user: 'david' });
    expect(f.exchanges[0]).toEqual({ client_id: '123.456', client_secret: 'shh', grant_type: 'refresh_token', refresh_token: 'xoxe-1-first' });
    expect(JSON.parse(readSecret(join(d, 'slack.json')))).toMatchObject({ token: 'xoxe.xoxp-1', refresh: 'xoxe-1-r1', clientId: '123.456', clientSecret: 'shh' });
  });

  it("refuses a refresh token without the credentials, an access token that's about to run out, and a wrong secret", async () => {
    const slack = new Slack({ dataDir: dir(), api: rotating().api });
    await expect(slack.connect('xoxe-1-first')).rejects.toThrow(/Client ID and Client Secret/);
    await expect(slack.connect('xoxe.xoxp-1-abc')).rejects.toThrow(/Refresh Token/);
    await expect(slack.connect('xoxe-1-first', { clientId: '1', clientSecret: 'wrong' })).rejects.toThrow(/bad_client_secret/);
    expect(slack.status().connected).toBe(false);
  });

  it('renews the token before it runs out, each time with the newest refresh token, and after a restart', async () => {
    const f = rotating(300); // five minutes: inside the renewal window, so every call renews
    const d = dir();
    const slack = new Slack({ dataDir: d, api: f.api });
    await slack.connect('xoxe-1-first', R);
    await slack.checkSearch();
    const used = f.exchanges.map((x) => x.refresh_token);
    expect(used.length).toBeGreaterThanOrEqual(2);
    used.slice(1).forEach((t, i) => expect(t).toBe(`xoxe-1-r${i + 1}`));
    const again = new Slack({ dataDir: d, api: f.api });
    await again.checkSearch();
    expect(f.exchanges.at(-1).refresh_token).toBe(`xoxe-1-r${f.exchanges.length - 1}`);
    expect(again.status()).toMatchObject({ connected: true, search: true });
  });

  it('renews once and retries when Slack says the token expired', async () => {
    const f = rotating();
    const slack = new Slack({ dataDir: dir(), api: f.api });
    await slack.connect('xoxe-1-first', R);
    await new Promise((r) => setTimeout(r, 20));
    f.expire('xoxe.xoxp-1');
    expect(await slack.checkSearch()).toBe(true);
    expect(f.exchanges.map((x) => x.refresh_token)).toEqual(['xoxe-1-first', 'xoxe-1-r1']);
    expect(slack.status().connected).toBe(true);
  });
});

describe('Cora carrying on a conversation', () => {
  const rpc = (method: string, params: object = {}) => ({ jsonrpc: '2.0', id: 1, method, params });
  const H = { 'x-cora-token': 'tok', accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'x-cora-session': 'cora-agent-1', 'x-cora-agent': 'tok' };
  async function setup() {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api });
    await slack.connect('xoxp-good');
    const file = join(dir(), 'grants.json');
    const outbox = new Outbox({ slack, onChange: () => {}, file });
    const turn = { now: true };
    const app = Fastify();
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack, outbox }, { isAgent: (sid) => sid === 'cora-agent-1', deps: () => ({}) as never, userTurn: () => turn.now });
    const call = async (name: string, args: object) => {
      const r = await app.inject({ method: 'POST', url: '/mcp', headers: H, payload: rpc('tools/call', { name, arguments: args }) });
      return JSON.parse(r.body).result as { isError?: boolean; content: Array<{ text: string }> };
    };
    return { ...f, slack, outbox, turn, call, file };
  }

  it('in a DM: a named thread is where it goes (a link to a reply: its thread); no thread: the conversation itself', async () => {
    const { call, posted } = await setup();
    const r = await call('slack_send', { to: 'x', text: 'on that', thread: 'https://acme.slack.com/archives/D0DANA001/p1700000050000100' });
    expect(r.content[0].text).toMatch(/in the thread/);
    expect(posted[0]).toMatchObject({ channel: 'D0DANA001', text: 'on that', thread_ts: '1700000050.000100' });
    await call('slack_send', { to: 'x', text: 'in it', thread: 'https://acme.slack.com/archives/D0DANA001/p1700000060000100?thread_ts=1700000000.000100&cid=D0DANA001' });
    expect(posted[1]).toMatchObject({ channel: 'D0DANA001', thread_ts: '1700000000.000100' });
    const plain = await call('slack_send', { to: '@dana', text: 'sure' });
    expect(plain.content[0].text).not.toMatch(/thread/);
    expect(posted[2]).toMatchObject({ channel: 'D-U1', text: 'sure' });
    expect(posted[2].thread_ts).toBeUndefined();
  });

  it('sends without asking in a conversation you let it carry on, until you stop it', async () => {
    const { call, outbox, posted, turn, file } = await setup();
    expect((await call('slack_allow', { to: '@dana', about: 'soup' })).content[0].text).toMatch(/^You can carry on the conversation with Dana by yourself until/);
    expect(outbox.grants()).toMatchObject([{ channel: 'D-U1', label: 'Dana', about: 'soup' }]);
    expect(existsSync(file)).toBe(true);
    // later: a reply came in, not the user's turn
    turn.now = false;
    const r = await call('slack_send', { to: '@dana', text: 'tangy, then' });
    expect(r.content[0].text).toMatch(/on your own/);
    expect(posted).toHaveLength(1);
    expect(outbox.sent()[0]).toMatchObject({ own: 'D-U1' });
    // somewhere else: a draft, as before
    void call('slack_send', { to: '#deploys', text: 'not this' });
    await new Promise((res) => setTimeout(res, 50));
    expect(outbox.list()).toHaveLength(1);
    // only when the user just asked
    expect((await call('slack_allow', { to: '#deploys' })).isError).toBe(true);
    // stopped: back to drafts
    expect((await call('slack_allow', { stop: true })).content[0].text).toMatch(/^Stopped/);
    void call('slack_send', { to: '@dana', text: 'one more' });
    await new Promise((res) => setTimeout(res, 50));
    expect(posted).toHaveLength(1);
    expect(outbox.list()).toHaveLength(2);
  });

  it('only Cora has slack_allow', async () => {
    const f = fakeSlack();
    const slack = new Slack({ dataDir: dir(), api: f.api });
    const app = Fastify();
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack, outbox: new Outbox({ slack, onChange: () => {} }) }, { isAgent: (sid) => sid === 'cora-agent-1', deps: () => ({}) as never, userTurn: () => true });
    const names = async (sid: string) => JSON.parse((await app.inject({ method: 'POST', url: '/mcp', headers: { ...H, 'x-cora-session': sid }, payload: rpc('tools/list') })).body).result.tools.map((t: any) => t.name);
    expect(await names('cora-agent-1')).toContain('slack_allow');
    expect(await names('sess-12345')).not.toContain('slack_allow');
  });
});

describe('images on Slack messages', () => {
  it('names files on the lines, and shows Claude the images (not a sign-in page, not a huge one)', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const api = (token: string) => async (method: string, p: Record<string, any> = {}) => {
      if (token !== 'xoxp-good') throw new SlackError('invalid_auth');
      if (method === 'auth.test') return { ok: true, team: 'Acme', team_id: 'T1', user: 'david', user_id: 'U0', url: 'https://acme.slack.com/' };
      if (method === 'users.list') return { ok: true, members: [{ id: 'U1', name: 'dana', profile: { real_name: 'Dana Scully' } }] };
      if (method === 'conversations.list') return { ok: true, channels: [{ id: 'C0DEPLOYS', name: 'deploys' }] };
      if (method === 'conversations.replies')
        return {
          ok: true,
          messages: [
            { ts: p.ts, user: 'U1', text: 'it looks like this', files: [{ name: 'shot.png', mimetype: 'image/png', size: png.length, url_private: 'https://files.slack.com/files-pri/T1-F1/shot.png' }, { name: 'notes.pdf', mimetype: 'application/pdf', size: 900, url_private: 'https://files.slack.com/files-pri/T1-F2/notes.pdf' }] },
            { ts: '1700000100.000000', user: 'U1', text: 'and this', files: [{ name: 'huge.jpg', mimetype: 'image/jpeg', size: 9e6, url_private: 'https://files.slack.com/files-pri/T1-F3/huge.jpg' }, { name: 'private.png', mimetype: 'image/png', size: 10, url_private: 'https://files.slack.com/files-pri/T1-F4/private.png' }] },
          ],
        };
      return { ok: true };
    };
    const fetched: Array<{ url: string; auth: string | null }> = [];
    const fakeFetch = (async (url: string, init?: any) => {
      fetched.push({ url, auth: init?.headers?.authorization ?? null });
      if (url.endsWith('private.png')) return new Response('<html>sign in</html>', { headers: { 'content-type': 'text/html' } });
      return new Response(png, { headers: { 'content-type': 'image/png' } });
    }) as typeof fetch;
    const slack = new Slack({ dataDir: dir(), api, fetch: fakeFetch });
    await slack.connect('xoxp-good');
    const app = Fastify();
    registerMcp(app, 'tok', () => DEFAULT_SETTINGS, { slack, outbox: new Outbox({ slack, onChange: () => {} }) });
    const H = { 'x-cora-token': 'tok', accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const r = await app.inject({ method: 'POST', url: '/mcp', headers: H, payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'slack_read', arguments: { link: 'https://acme.slack.com/archives/C0DEPLOYS/p1700000000000100' } } } });
    const content = JSON.parse(r.body).result.content as any[];
    expect(content[0].text).toMatch(/Dana Scully: it looks like this \[image: shot\.png\] \[file: notes\.pdf\]/);
    expect(content[0].text).toMatch(/\(shot\.png attached below; 2 more not shown\)/);
    expect(content.slice(1)).toEqual([{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }]);
    // the huge one isn't even fetched; what is fetched carries the token
    expect(fetched.map((f) => f.url.split('/').pop()).sort()).toEqual(['private.png', 'shot.png']);
    expect(fetched.every((f) => f.auth === 'Bearer xoxp-good')).toBe(true);
  });
});

describe('a long message in blocks', () => {
  it('is split between paragraphs into sections of at most 3000 characters', () => {
    const para = 'x'.repeat(1400);
    const parts = sections([para, para, para].join('\n\n'));
    expect(parts.length).toBe(2);
    expect(parts.every((p) => p.text.text.length <= 3000)).toBe(true);
    expect(parts.map((p) => p.text.text).join('\n\n')).toBe([para, para, para].join('\n\n'));
  });
});
