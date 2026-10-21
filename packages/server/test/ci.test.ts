import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrainEvent, CiMsg, SessionInfo } from '@cora/shared';
import { CiWatcher, RUN_MS, classify, toPipeline, type Exec } from '../src/ci';

const P = 'acme/internal/orion/orion-services';
const E = encodeURIComponent(P);

const session = (id: string, cwd = 'C:/repo', state: SessionInfo['state'] = 'working'): SessionInfo => ({
  id, cwd, project: 'repo', title: '', state, startedAt: 0, lastTs: Date.now(), cliVersion: '', transcriptPath: '', needsYou: 0,
});

const pipe = (id: number, status: string, ref = 'feat') => ({ id, status, ref, sha: 'abc', source: 'push', web_url: `https://gitlab.com/${P}/-/pipelines/${id}`, created_at: new Date(Date.now()).toISOString(), started_at: null, finished_at: null });
const job = (id: number, stage: string, status: string, extra: object = {}) => ({ id, name: `${stage}-${id}`, stage, status, web_url: `https://gitlab.com/${P}/-/jobs/${id}`, ...extra });

/** A fake git + glab: answers from `api` (path → JSON or an error), records every call. */
function fake(api: Record<string, unknown>, git: { branch?: string; remotes?: string } = {}) {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    if (file === 'git') {
      const a = args.slice(2).join(' ');
      if (a === 'rev-parse --abbrev-ref HEAD') return { stdout: `${git.branch ?? 'feat'}\n`, stderr: '' };
      if (a === 'remote -v') return { stdout: git.remotes ?? `origin\thttps://gitlab.com/${P}.git (fetch)\n`, stderr: '' };
      throw Object.assign(new Error('no upstream'), { stderr: 'fatal: no upstream' });
    }
    const path = args[args.length - 1];
    calls.push(path);
    const r = api[path];
    if (r instanceof Error) throw r;
    if (r === undefined) throw Object.assign(new Error('exit 1'), { stderr: 'glab: 404 Not Found (HTTP 404)' });
    return { stdout: typeof r === 'string' ? r : JSON.stringify(r), stderr: '' };
  };
  return { exec, calls };
}

/** By default each session has committed on its branch (feat), so that branch's pipelines are its own. */
const committed = (sid: string) => [toolEnd(sid, 'git commit -m wip', '[feat abc1234] wip\n 1 file changed')];
function watcher(exec: Exec, sessions: SessionInfo[], clients = { n: 1 }, gitWork: (sid: string) => BrainEvent[] = committed) {
  const msgs: CiMsg[] = [];
  const w = new CiWatcher({ exec, publish: (m) => msgs.push(m), hasClients: () => clients.n > 0, sessions: () => sessions, gitWork });
  return { w, msgs, last: () => mergeMsgs(msgs) };
}

/** What a client would hold after all the messages. */
function mergeMsgs(msgs: CiMsg[]) {
  const pipelines = new Map<string, any>();
  const links = new Map<string, any>();
  let health: any;
  for (const m of msgs) {
    for (const p of m.pipelines ?? []) pipelines.set(p.key, p);
    for (const l of m.links ?? []) links.set(l.sessionId, l);
    for (const g of m.goneLinks ?? []) links.delete(g);
    if (m.health) health = m.health;
  }
  return { pipelines, links, health };
}

const BASE = {
  [`projects/${E}`]: { default_branch: 'main' },
  [`projects/${E}/merge_requests?source_branch=feat&state=opened&per_page=1`]: [],
};

const toolEnd = (sid: string, command: string, preview = ''): BrainEvent => ({
  id: `e${Math.random()}`, seq: 1, sessionId: sid, agentId: 'main', ts: Date.now(), kind: 'tool', phase: 'end', toolUseId: 't', icon: { name: 'x', family: 'run' }, source: 'hook',
  tool: { name: 'Bash', input: { command }, summary: command, preview },
});

beforeEach(() => vi.useFakeTimers({ now: new Date('2026-10-14T12:00:00Z') }));
afterEach(() => vi.useRealTimers());

describe('pipelines from the API', () => {
  it('groups jobs into stages in run order with their status', () => {
    const p = toPipeline(P, pipe(1, 'running'), [job(13, 'deploy', 'created'), job(12, 'test', 'running'), job(11, 'build', 'success'), job(14, 'build', 'failed', { allow_failure: true })]);
    expect(p.stages.map((s) => [s.name, s.status])).toEqual([['build', 'success'], ['test', 'running'], ['deploy', 'created']]);
    expect(p.key).toBe(`${P}#1`);
  });

  it('says what a glab failure means', () => {
    expect(classify(Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' })).kind).toBe('no-glab');
    expect(classify({ stderr: 'glab: 401 Unauthorized' }).kind).toBe('signed-out');
    expect(classify({ stderr: 'glab: 404 Not Found (HTTP 404)' }).kind).toBe('missing');
    expect(classify({ stderr: 'dial tcp: lookup gitlab.com: no such host' }).kind).toBe('offline');
    expect(classify({ stderr: 'something odd\nmore' })).toMatchObject({ kind: 'error', message: 'something odd' });
  });
});

describe('the poller', () => {
  it("follows a session's branch pipeline until it finishes, then leaves it alone", async () => {
    const api: Record<string, unknown> = {
      ...BASE,
      [`projects/${E}/pipelines?ref=feat&per_page=1`]: [pipe(10, 'running')],
      [`projects/${E}/pipelines/10`]: pipe(10, 'running'),
      [`projects/${E}/pipelines/10/jobs?per_page=100`]: [job(1, 'build', 'running')],
    };
    const f = fake(api);
    const { w, last } = watcher(f.exec, [session('s1')]);
    w.start();
    await vi.advanceTimersByTimeAsync(1500);
    let st = last();
    expect(st.links.get('s1')).toMatchObject({ repo: { project: P, branch: 'feat', defaultBranch: 'main' }, pipelines: [{ key: `${P}#10`, why: 'branch' }] });
    expect(st.pipelines.get(`${P}#10`).stages[0]).toMatchObject({ name: 'build', status: 'running' });
    // read again while it runs
    api[`projects/${E}/pipelines/10`] = { ...pipe(10, 'success'), finished_at: new Date().toISOString() };
    api[`projects/${E}/pipelines/10/jobs?per_page=100`] = [job(1, 'build', 'success')];
    await vi.advanceTimersByTimeAsync(RUN_MS + 1000);
    st = last();
    expect(st.pipelines.get(`${P}#10`).status).toBe('success');
    const reads = f.calls.filter((c) => c === `projects/${E}/pipelines/10`).length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.calls.filter((c) => c === `projects/${E}/pipelines/10`).length).toBe(reads);
    // the idle branch is checked again only after a couple of minutes
    const branchReads = () => f.calls.filter((c) => c.startsWith(`projects/${E}/pipelines?ref=feat`)).length;
    expect(branchReads()).toBe(1);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(branchReads()).toBe(2);
    w.stop();
  });

  it('after a push looks soon, and lists the new pipeline as started by the session', async () => {
    const api: Record<string, unknown> = {
      ...BASE,
      [`projects/${E}/pipelines?ref=feat&per_page=1`]: [{ ...pipe(10, 'success'), created_at: '2026-10-14T10:00:00Z' }],
      [`projects/${E}/pipelines/10`]: pipe(10, 'success'),
      [`projects/${E}/pipelines/10/jobs?per_page=100`]: [],
    };
    const f = fake(api);
    const { w, last } = watcher(f.exec, [session('s1')]);
    w.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().links.get('s1').pipelines).toEqual([{ key: `${P}#10`, why: 'branch', at: Date.parse('2026-10-14T10:00:00Z') }]);
    api[`projects/${E}/pipelines?ref=feat&per_page=1`] = [pipe(11, 'pending')];
    api[`projects/${E}/pipelines/11`] = pipe(11, 'pending');
    api[`projects/${E}/pipelines/11/jobs?per_page=100`] = [job(5, 'build', 'pending')];
    w.event(toolEnd('s1', 'git push'));
    await vi.advanceTimersByTimeAsync(4500);
    const l = last().links.get('s1');
    expect(l.pipelines[0]).toMatchObject({ key: `${P}#11`, why: 'push' });
    // the branch's previous pipeline gave way to the new one
    expect(l.pipelines.map((x: any) => x.key)).toEqual([`${P}#11`]);
    w.stop();
  });

  it('shares reads between sessions on the same branch, and stops for ended sessions', async () => {
    const api: Record<string, unknown> = { ...BASE, [`projects/${E}/pipelines?ref=feat&per_page=1`]: [] };
    const f = fake(api);
    const sessions = [session('s1'), session('s2', 'C:/repo2')];
    const { w, last } = watcher(f.exec, sessions);
    w.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.calls.filter((c) => c.includes('pipelines?ref=feat')).length).toBe(1);
    expect([...last().links.keys()].sort()).toEqual(['s1', 's2']);
    w.sessionChanged({ ...sessions[0], state: 'ended' });
    w.sessionChanged({ ...sessions[1], state: 'ended' });
    sessions.length = 0;
    await vi.advanceTimersByTimeAsync(130_000);
    expect(f.calls.filter((c) => c.includes('pipelines?ref=feat')).length).toBe(1);
    expect(last().links.size).toBe(0);
    w.stop();
  });

  it("leaves a branch it hasn't worked on alone (another session's, in the same folder) until it commits there", async () => {
    const api: Record<string, unknown> = {
      ...BASE,
      [`projects/${E}/pipelines?ref=feat&per_page=1`]: [pipe(10, 'running')],
      [`projects/${E}/pipelines/10`]: pipe(10, 'running'),
      [`projects/${E}/pipelines/10/jobs?per_page=100`]: [job(1, 'build', 'running')],
    };
    const f = fake(api);
    // it once committed, but on another branch (its history names it)
    const { w, last } = watcher(f.exec, [session('s1')], { n: 1 }, (sid) => [toolEnd(sid, 'git commit -am fix', '[other 1234567] fix')]);
    w.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().links.get('s1')).toMatchObject({ repo: { branch: 'feat' }, pipelines: [] });
    expect(f.calls.some((c) => c.includes('pipelines?ref=feat'))).toBe(false);
    // it commits on feat now (git names the branch): its pipelines are its own from here
    w.event(toolEnd('s1', 'git add . && git commit -m "more"', '[feat 89abcde] more'));
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().links.get('s1').pipelines).toMatchObject([{ key: `${P}#10`, why: 'branch' }]);
    w.stop();
  });

  it('a push of the checked-out branch makes it its own', async () => {
    const api: Record<string, unknown> = {
      ...BASE,
      [`projects/${E}/pipelines?ref=feat&per_page=1`]: [pipe(11, 'pending')],
      [`projects/${E}/pipelines/11`]: pipe(11, 'pending'),
      [`projects/${E}/pipelines/11/jobs?per_page=100`]: [],
    };
    const f = fake(api);
    const { w, last } = watcher(f.exec, [session('s1')], { n: 1 }, () => []);
    w.start();
    await vi.advanceTimersByTimeAsync(1500);
    expect(last().links.get('s1').pipelines).toEqual([]);
    w.event(toolEnd('s1', 'git push'));
    await vi.advanceTimersByTimeAsync(4500);
    expect(last().links.get('s1').pipelines[0]).toMatchObject({ key: `${P}#11` });
    w.stop();
  });

  it('reads nothing while no dashboard is open', async () => {
    const f = fake({ ...BASE, [`projects/${E}/pipelines?ref=feat&per_page=1`]: [] });
    const clients = { n: 0 };
    const { w } = watcher(f.exec, [session('s1')], clients);
    w.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.calls).toEqual([]);
    clients.n = 1;
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.calls.length).toBeGreaterThan(0);
    w.stop();
  });

  it('glab missing: says so once and backs off instead of retrying every second', async () => {
    const missing = Object.assign(new Error('spawn glab ENOENT'), { code: 'ENOENT' });
    const calls: string[] = [];
    const exec: Exec = async (file, args) => {
      if (file === 'git') return fake({}).exec(file, args, { timeout: 1 });
      calls.push(file);
      throw missing;
    };
    const { w, msgs, last } = watcher(exec, [session('s1')]);
    w.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(last().health).toMatchObject({ state: 'no-glab' });
    expect(msgs.filter((m) => m.health).length).toBe(1);
    // on PATH, then its install folder: a couple of tries, then quiet for minutes
    expect(calls.length).toBeLessThanOrEqual(4);
    w.stop();
  });

  it("follows pipelines a command's output links to, and a job's pipeline", async () => {
    const api: Record<string, unknown> = {
      ...BASE,
      [`projects/${E}/pipelines?ref=feat&per_page=1`]: [],
      [`projects/a%2Fb/pipelines/7`]: pipe(7, 'failed', 'main'),
      [`projects/a%2Fb/pipelines/7/jobs?per_page=100`]: [job(70, 'test', 'failed')],
      [`projects/a%2Fb/jobs/71`]: { id: 71, pipeline: { id: 8 } },
      [`projects/a%2Fb/pipelines/8`]: pipe(8, 'running', 'main'),
      [`projects/a%2Fb/pipelines/8/jobs?per_page=100`]: [],
    };
    const f = fake(api);
    const { w, last } = watcher(f.exec, [session('s1')]);
    w.start();
    await vi.advanceTimersByTimeAsync(1500);
    w.event(toolEnd('s1', 'glab ci list -R a/b', 'see https://gitlab.com/a/b/-/pipelines/7 and https://gitlab.com/a/b/-/jobs/71'));
    await vi.advanceTimersByTimeAsync(2500);
    const keys = last().links.get('s1').pipelines.map((x: any) => [x.key, x.why]);
    expect(keys).toEqual(expect.arrayContaining([['a/b#7', 'url'], ['a/b#8', 'url']]));
    expect(await w.jobLog('a/b', 999)).toEqual({ error: 'not a job of a pipeline Cora follows' });
    api[`projects/a%2Fb/jobs/70/trace`] = 'line 1\nline 2\n';
    expect(await w.jobLog('a/b', 70)).toEqual({ lines: ['line 1', 'line 2'] });
    w.stop();
  });
});
