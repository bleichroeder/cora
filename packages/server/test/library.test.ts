import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESENT_TOOL, type JournalEntry, type NewEvent, type VideoJob } from '@cora/shared';
import { Store } from '../src/store';
import { Debriefs } from '../src/debriefs';
import { Library, plainText } from '../src/library';
import { loadConfig } from '../src/config';
import { startServer, type Running } from '../src/server';

/** The Library: everything sessions made, in one index (searched, filtered, starred), kept up to date cheaply. */

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-library-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));

const A = 'sess-aaaa1111';
const B = 'sess-bbbb2222';
const DAY = 86_400_000;
const NOW = new Date(2026, 10, 4, 15, 0).getTime();

let n = 0;
const ev = (o: Partial<NewEvent> & Pick<NewEvent, 'sessionId' | 'ts' | 'kind'>): NewEvent => ({ id: `e${++n}`, agentId: 'main', icon: { name: 'x', family: 'look' }, source: 'hook', ...o }) as NewEvent;
const explain = (sessionId: string, ts: number, title: string, content: string, live?: string): NewEvent => {
  const id = `t${++n}`;
  return ev({ id: `tool:${id}:start`, sessionId, ts, kind: 'tool', phase: 'start', toolUseId: id, tool: { name: PRESENT_TOOL, input: { title, format: 'html', content, ...(live ? { live } : {}) }, summary: title } });
};
const debrief = (root: string, sid: string, id: string, title: string, at: number) => {
  mkdirSync(join(root, sid), { recursive: true });
  writeFileSync(join(root, sid, `${id}.json`), JSON.stringify({ id, sessionId: sid, title, task: 'Fix the login redirect', depth: 'quick', steps: [{ title: 'The guard', kind: 'change', beats: [{ text: 'It checked the wrong cookie' }] }], createdAt: at, snaps: {} }));
};

function setup() {
  const store = new Store(':memory:');
  const root = join(dir, 'debriefs');
  const debriefs = new Debriefs({ dir: root });
  let t = NOW;
  const videos: VideoJob[] = [];
  const journal: JournalEntry[] = [];
  const names: Record<string, string> = { [A]: 'Login fix', [B]: 'Charts' };
  const lib = (file: string | null = join(dir, 'stars.json')) =>
    new Library({ store, debriefs, videos: { list: () => videos }, journal: { query: () => journal }, sessionName: (sid) => names[sid] ?? 'a session', projectOf: (sid) => (sid === B ? { id: 'p1', name: 'Dashboards' } : null), file, now: () => t });
  return { store, root, debriefs, videos, journal, lib, advance: (ms: number) => (t += ms) };
}

describe('the Library index', () => {
  it('gathers every kind: explains (one per title, its newest, versions counted), live explains, debriefs, ready videos, artifacts, recaps and briefs', () => {
    const { store, root, videos, journal, lib } = setup();
    store.upsertEvent(explain(A, NOW - 3 * DAY, 'Login flow', '<h1>Login flow</h1><p>old</p>'));
    store.upsertEvent(explain(A, NOW - 60_000, 'Login flow', '<h1>Login flow</h1><script>x()</script><p>the redirect &amp; cookie</p>'));
    store.upsertEvent(explain(B, NOW - 120_000, 'CPU by host', '<div>chart</div>', 'cpu-by-host'));
    debrief(root, A, 'd1', 'How the login was fixed', NOW - 30_000);
    videos.push({ id: 'v1', sessionId: A, debriefId: 'd1', title: 'How the login was fixed', stage: 'ready', done: 1, total: 1, chars: 0, createdAt: NOW - 20_000, expiresAt: NOW + DAY, seconds: 42 } as VideoJob);
    videos.push({ id: 'v2', sessionId: A, debriefId: 'd1', title: 'Still drawing', stage: 'drawing', done: 0, total: 3, chars: 0, createdAt: NOW, expiresAt: NOW + DAY } as VideoJob);
    journal.push({ id: 'j1', at: NOW - 10 * DAY, sessionId: B, session: 'Charts', cwd: 'C:/w', repo: 'w', kind: 'entry', text: 'Published the latency report', refs: { artifacts: ['https://claude.ai/artifact/abc', 'C:/w/out/report.pdf'] } });
    store.addRecap({ id: 'r1', sessionId: B, at: NOW - 2 * DAY, text: 'Built the CPU chart; next, memory.' });
    store.upsertEvent(ev({ sessionId: 'cora-agent', ts: NOW - 5000, kind: 'prompt', text: '[Cora brief] The user asked for a brief.' }));
    store.upsertEvent(ev({ sessionId: 'cora-agent', ts: NOW - 4000, kind: 'say', text: 'Two sessions need you; the deploy passed.' }));
    store.upsertEvent(ev({ sessionId: 'cora-agent', ts: NOW - 3000, kind: 'turn_end' }));
    const { entries, kinds, total } = lib().query();
    expect(total).toBe(8);
    expect(kinds).toEqual({ explain: 1, live: 1, debrief: 1, video: 1, artifact: 2, recap: 1, brief: 1 });
    const by = (k: string) => entries.find((e) => e.kind === k)!;
    expect(by('explain')).toMatchObject({ title: 'Login flow', at: NOW - 60_000, versions: 2, sessionId: A, session: 'Login fix', project: null, snippet: 'Login flow the redirect & cookie', open: { how: 'explain', sessionId: A } });
    expect(by('live')).toMatchObject({ title: 'CPU by host', session: 'Charts', project: { id: 'p1', name: 'Dashboards' } });
    expect(by('debrief')).toMatchObject({ title: 'How the login was fixed', open: { how: 'debrief', sessionId: A, debriefId: 'd1' } });
    expect(by('video')).toMatchObject({ open: { how: 'video', videoId: 'v1' }, snippet: 'A video of its debrief, 42s' });
    expect(entries.filter((e) => e.kind === 'artifact').map((e) => e.open)).toEqual(expect.arrayContaining([{ how: 'url', url: 'https://claude.ai/artifact/abc' }, { how: 'file', path: 'C:/w/out/report.pdf' }]));
    expect(by('recap')).toMatchObject({ sessionId: B, open: { how: 'session', sessionId: B, ts: NOW - 2 * DAY } });
    expect(by('brief')).toMatchObject({ title: expect.stringMatching(/^Cora's brief, /), snippet: 'Two sessions need you; the deploy passed.', open: { how: 'session', sessionId: 'cora-agent' } });
    // newest first
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort((a, b) => b - a));
    // a guest (a live share): no file on this PC by its path, no video; the rest as for you
    // a guest (a live share): no file on this PC by its path, no video, and no brief of Cora's, even one from an agent
    // conversation that isn't her current one (so not "private" by its session); the rest as for you
    const g = lib().query({}, () => false, true);
    const guest = g.entries;
    expect(guest.some((e) => e.open.how === 'file' || e.open.how === 'video' || e.kind === 'brief')).toBe(false);
    expect(g.kinds.brief).toBeUndefined();
    expect(JSON.stringify(guest)).not.toContain('C:/w/out/report.pdf');
    expect(JSON.stringify(guest)).not.toContain('Two sessions need you');
    expect(guest.map((e) => e.kind).sort()).toEqual(['artifact', 'debrief', 'explain', 'live', 'recap']);
    // (the text a page is searched by: its words, not its markup or scripts)
    expect(plainText('<style>a{}</style><b>Hi</b> &lt;there&gt;')).toBe('Hi <there>');
  });

  it('searched by every word (title, text, session, project), by kind (with each kind counted), and by when (today, this week, older)', () => {
    const { store, journal, lib } = setup();
    store.upsertEvent(explain(A, NOW - 60_000, 'Login flow', '<p>the redirect cookie</p>'));
    store.upsertEvent(explain(B, NOW - 3 * DAY, 'CPU by host', '<p>load per host</p>'));
    journal.push({ id: 'j1', at: NOW - 10 * DAY, sessionId: B, session: 'Charts', cwd: 'C:/w', repo: 'w', kind: 'entry', text: 'Published the latency report', refs: { artifacts: ['https://claude.ai/artifact/abc'] } });
    const l = lib();
    expect(l.query({ q: 'REDIRECT login' }).entries.map((e) => e.title)).toEqual(['Login flow']);
    expect(l.query({ q: 'dashboards host' }).entries.map((e) => e.title)).toEqual(['CPU by host']);
    expect(l.query({ q: 'nothing like this' }).total).toBe(0);
    const k = l.query({ kind: 'artifact' });
    expect(k.entries.map((e) => e.kind)).toEqual(['artifact']);
    expect(k.kinds).toEqual({ explain: 2, artifact: 1 });
    expect(l.query({ when: 'today' }).entries.map((e) => e.title)).toEqual(['Login flow']);
    expect(l.query({ when: 'week' }).entries.map((e) => e.title)).toEqual(['Login flow', 'CPU by host']);
    expect(l.query({ when: 'older' }).entries.map((e) => e.kind)).toEqual(['artifact']);
    expect(l.query({ sessionId: B }).total).toBe(2);
    // a guest's: never a private session's
    expect(l.query({}, (sid) => sid === A).entries.map((e) => e.sessionId)).toEqual([B, B]);
  });

  it("kept up to date cheaply: the events read after the last one seen, a debrief folder only when it changed, the rest at most every few seconds; a brief once its turn is over", () => {
    const { store, root, debriefs, lib, advance } = setup();
    store.upsertEvent(explain(A, NOW - 60_000, 'One', 'x'));
    debrief(root, A, 'd1', 'First debrief', NOW - 30_000);
    const reads = vi.spyOn(store, 'libraryEvents');
    const gets = vi.spyOn(debriefs, 'get');
    const l = lib();
    expect(l.query().total).toBe(2);
    expect(reads.mock.calls.map((c) => c[0])).toEqual([0]);
    expect(gets).toHaveBeenCalledTimes(1);
    // asked again: nothing new, nothing read again
    l.query();
    advance(20_000);
    l.query();
    expect(reads).toHaveBeenCalledTimes(1);
    expect(gets).toHaveBeenCalledTimes(1);
    // a new explain: only what came after is read
    const seen = store.lastSeq();
    store.upsertEvent(explain(B, NOW, 'Two', 'y'));
    expect(l.query().total).toBe(3);
    expect(reads.mock.calls.at(-1)![0]).toBe(seen);
    // a brief asked: in once its turn is over
    store.upsertEvent(ev({ sessionId: 'cora-agent', ts: NOW + 1000, kind: 'prompt', text: '[Cora wrap-up] The user is wrapping up.' }));
    store.upsertEvent(ev({ sessionId: 'cora-agent', ts: NOW + 2000, kind: 'say', text: 'Done today: the login fix.' }));
    expect(l.query({ kind: 'brief' }).total).toBe(0);
    store.upsertEvent(ev({ sessionId: 'cora-agent', ts: NOW + 3000, kind: 'turn_end' }));
    expect(l.query({ kind: 'brief' }).entries.map((e) => [e.title.split(',')[0], e.snippet])).toEqual([["Cora's wrap-up", 'Done today: the login fix.']]);
    // a new debrief: that folder read again (once the look comes round)
    advance(20_000);
    debrief(root, B, 'd2', 'Second debrief', NOW);
    expect(l.query({ kind: 'debrief' }).total).toBe(2);
    expect(gets).toHaveBeenCalledTimes(2);
  });

  it('the first build over a big brain.db (1M events) is read a range at a time in the background: asked meanwhile, it answers at once with what is ready (building); no range holds the server long', async () => {
    const { store, lib } = setup();
    const db = (store as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    const ROWS = 1_000_000;
    const put = db.prepare('INSERT INTO events (id, seq, session_id, agent_id, ts, kind, tool_use_id, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const say = JSON.stringify({ kind: 'say', agentId: 'main', text: 'working on the next step of the change, reading the files it touches' });
    db.exec('BEGIN');
    for (let i = 1; i <= ROWS; i++) {
      // an explain every 50,000 events, the rest ordinary lines
      if (i % 50_000 === 0) {
        const e = { id: `tool:x${i}:start`, seq: i, sessionId: A, agentId: 'main', ts: NOW - (ROWS - i), kind: 'tool', phase: 'start', toolUseId: `x${i}`, icon: { name: 'x' }, source: 'hook', tool: { name: PRESENT_TOOL, input: { title: `Chart ${i}`, format: 'html', content: '<p>c</p>' } } };
        put.run(e.id, i, A, 'main', e.ts, 'tool', e.toolUseId, JSON.stringify(e));
      } else put.run(`e-${i}`, i, A, 'main', NOW - (ROWS - i), 'say', null, say);
    }
    db.exec('COMMIT');
    (store as unknown as { seq: number }).seq = ROWS;
    const slices: number[] = [];
    const read = store.libraryEvents.bind(store);
    vi.spyOn(store, 'libraryEvents').mockImplementation((from, to) => {
      const t0 = performance.now();
      const r = read(from, to);
      slices.push(performance.now() - t0);
      return r;
    });
    const l = lib(null);
    const t0 = performance.now();
    const first = l.query();
    const asked = performance.now() - t0;
    expect(first.building).toBe(true);
    expect(asked).toBeLessThan(200);
    await l.ready();
    const done = l.query();
    expect(done.building).toBeUndefined();
    expect(done.total).toBe(20);
    expect(slices.length).toBe(ROWS / 20_000);
    // each range: a short hold of the server, however big the table
    console.log(`library build over ${ROWS} events: ${slices.length} ranges, longest ${Math.max(...slices).toFixed(1)}ms, all ${slices.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
    expect(Math.max(...slices)).toBeLessThan(250);
  }, 120_000);

  it('a star puts an entry first, and is kept (a new Library reads it); an entry that isn\'t there: false', () => {
    const { store, lib } = setup();
    store.upsertEvent(explain(A, NOW - 3 * DAY, 'Old one', 'x'));
    store.upsertEvent(explain(A, NOW, 'New one', 'y'));
    const l = lib();
    const old = l.query().entries.find((e) => e.title === 'Old one')!;
    expect(l.star(old.id, true)).toBe(true);
    expect(l.query().entries.map((e) => [e.title, !!e.starred])).toEqual([['Old one', true], ['New one', false]]);
    expect(l.query({ starred: true }).total).toBe(1);
    expect(lib().query().entries[0]).toMatchObject({ title: 'Old one', starred: true });
    expect(l.star(old.id, false)).toBe(true);
    expect(lib().query().entries[0].title).toBe('New one');
    expect(l.star('explain:nope:none', true)).toBe(false);
  });
});

describe('the Library API', () => {
  let srv: Running | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('lists, filters and stars; refuses a kind or time it has no such thing as, and a star for no entry', async () => {
    srv = await startServer(loadConfig({ dataDir: dir, dbPath: ':memory:', hookToken: 'h', uiToken: 'u', clientDir: join(tmpdir(), 'nope') }), { tail: false, listen: false, ci: false, security: false });
    const ui = { cookie: 'ab_session=u', origin: 'http://127.0.0.1:4317' };
    srv.store.upsertSession({ id: A, cwd: 'C:/w/login', alias: 'Login fix', lastTs: Date.now(), state: 'ended' });
    srv.store.upsertEvent(explain(A, Date.now(), 'Login flow', '<p>redirect</p>'));
    const got = (await srv.app.inject({ url: '/api/library?q=redirect', headers: ui })).json();
    expect(got.total).toBe(1);
    expect(got.entries[0]).toMatchObject({ kind: 'explain', title: 'Login flow', session: 'Login fix' });
    expect((await srv.app.inject({ url: '/api/library?kind=nope', headers: ui })).statusCode).toBe(400);
    expect((await srv.app.inject({ url: '/api/library?when=yesterday', headers: ui })).statusCode).toBe(400);
    const star = (id: string) => srv!.app.inject({ method: 'POST', url: '/api/library/star', headers: ui, payload: { id, on: true } });
    expect((await star(got.entries[0].id)).statusCode).toBe(200);
    expect((await srv.app.inject({ url: '/api/library?starred=1', headers: ui })).json().entries[0].starred).toBe(true);
    expect((await star('explain:nope:x')).statusCode).toBe(404);
    expect((await srv.app.inject({ url: '/api/library' })).statusCode).toBe(401);
  });
});
