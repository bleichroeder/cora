import { describe, expect, it } from 'vitest';
import { ciRef, groupStages, stageStatus, type CiJob, type CiLink, type CiPipeline, type CiStatus } from '@cora/shared';
import { SHOW_MS, finishesToTell, ciAnnouncement, ciMarkers, ciTransitions, currentStage, elapsed, followed, worthTelling } from '../src/lib/ci';

const P = 'acme/internal/orion/orion-services';
const NOW = 1_800_000_000_000;
let n = 0;
const job = (stage: string, status: CiStatus, extra: Partial<CiJob> = {}): CiJob => ({ id: ++n, name: `${stage}-${n}`, stage, status, startedAt: null, finishedAt: null, url: '', ...extra });
const pipe = (id: number, status: CiStatus, jobs: CiJob[] = [], extra: Partial<CiPipeline> = {}): CiPipeline => ({
  key: `${P}#${id}`, project: P, id, ref: 'feat', sha: 'abc', status, url: '', createdAt: NOW - 600_000, startedAt: NOW - 590_000, finishedAt: null, stages: groupStages(jobs), ...extra,
});
const link = (pipelines: CiLink['pipelines'], repo: CiLink['repo'] = { project: P, branch: 'feat', defaultBranch: 'main' }): CiLink => ({ sessionId: 's1', repo, pipelines });
const byKey = (...ps: CiPipeline[]) => Object.fromEntries(ps.map((p) => [p.key, p]));

describe('stages', () => {
  it('a stage is running while any job runs; a failure counts only when not allowed', () => {
    expect(stageStatus([{ status: 'success' }, { status: 'running' }, { status: 'failed' }])).toBe('running');
    expect(stageStatus([{ status: 'success' }, { status: 'failed' }])).toBe('failed');
    expect(stageStatus([{ status: 'success' }, { status: 'failed', allowFailure: true }])).toBe('success');
    expect(stageStatus([{ status: 'created' }, { status: 'created' }])).toBe('created');
    expect(stageStatus([{ status: 'manual' }, { status: 'skipped' }])).toBe('manual');
    expect(stageStatus([{ status: 'skipped' }])).toBe('skipped');
    expect(stageStatus([{ status: 'success' }, { status: 'manual' }])).toBe('success');
  });

  it('orders stages by their first job, keeping a retried job in its stage', () => {
    const jobs = [
      { ...job('deploy', 'failed'), id: 200 },
      { ...job('build', 'success'), id: 101 },
      { ...job('deploy', 'success'), id: 103 },
      { ...job('test', 'success'), id: 102 },
    ];
    expect(groupStages(jobs).map((s) => [s.name, s.jobs.map((j) => j.id)])).toEqual([['build', [101]], ['test', [102]], ['deploy', [103, 200]]]);
  });
});

describe('which pipeline a session shows', () => {
  it('anything on its way first, the most recently started or looked at', () => {
    const a = pipe(1, 'success', [], { finishedAt: NOW - 60_000 });
    const b = pipe(2, 'running');
    const c = pipe(3, 'pending');
    const l = link([{ key: a.key, why: 'url', at: NOW - 10_000 }, { key: b.key, why: 'branch', at: NOW - 600_000 }, { key: c.key, why: 'push', at: NOW - 5_000 }]);
    expect(followed(l, byKey(a, b, c), NOW)?.p.id).toBe(3);
    expect(followed(l, byKey(a, b), NOW)?.p.id).toBe(2);
  });

  it('a finished one for a while after it finished (or was last looked at), then nothing', () => {
    const old = pipe(1, 'failed', [], { finishedAt: NOW - 3 * 3600_000 });
    expect(followed(link([{ key: old.key, why: 'branch', at: NOW - 4 * 3600_000 }]), byKey(old), NOW)).toBeNull();
    // looked at just now: it's news again
    expect(followed(link([{ key: old.key, why: 'url', at: NOW - 60_000 }]), byKey(old), NOW)?.p.id).toBe(1);
    const recent = pipe(2, 'success', [], { finishedAt: NOW - SHOW_MS + 60_000 });
    expect(followed(link([{ key: recent.key, why: 'branch', at: NOW - 3600_000 }]), byKey(recent), NOW)?.p.id).toBe(2);
    expect(followed(link([{ key: recent.key, why: 'branch', at: NOW - 3600_000 }]), byKey(recent), NOW + 120_000)).toBeNull();
    expect(followed(undefined, {}, NOW)).toBeNull();
  });
});

describe('finishing', () => {
  it('only pipelines seen on their way and now done', () => {
    const run = pipe(1, 'running');
    const done = { ...run, status: 'failed' as const, finishedAt: NOW };
    expect(ciTransitions(byKey(run), byKey(done))).toEqual([done]);
    // already over when first seen: not a finish we watched
    expect(ciTransitions({}, byKey(done))).toEqual([]);
    expect(ciTransitions(byKey(done), byKey(done))).toEqual([]);
    expect(ciTransitions(byKey(run), byKey({ ...run, status: 'manual' }))).toEqual([]);
  });

  it("is told for what the session started or looked at, or its own branch's, not the default branch's", () => {
    const p = pipe(1, 'success');
    expect(worthTelling(link([{ key: p.key, why: 'branch', at: 0 }]), p.key, p)).toBe(true);
    expect(worthTelling(link([{ key: p.key, why: 'branch', at: 0 }]), p.key, { ...p, ref: 'main' })).toBe(false);
    expect(worthTelling(link([{ key: p.key, why: 'push', at: 0 }]), p.key, { ...p, ref: 'main' })).toBe(true);
    expect(worthTelling(link([]), p.key, p)).toBe(false);
  });

  it('tells each finish once, for the session in view when it follows it', () => {
    const run = pipe(1, 'running');
    const done = { ...run, status: 'success' as const, finishedAt: NOW };
    const links = { s1: { ...link([{ key: run.key, why: 'push', at: NOW }]), sessionId: 's1' }, s2: { ...link([{ key: run.key, why: 'branch', at: NOW }]), sessionId: 's2' } };
    const told = new Set<string>();
    expect(finishesToTell(byKey(run), byKey(done), links, 's2', told)).toEqual([{ p: done, sessionId: 's2' }]);
    expect(finishesToTell(byKey(run), byKey(done), links, 's2', told)).toEqual([]);
    expect(finishesToTell(byKey(run), byKey(done), links, null, new Set())).toEqual([{ p: done, sessionId: 's1' }]);
    // nobody follows it in a way worth telling (the default branch's own pipeline)
    const main = { ...done, ref: 'main' };
    expect(finishesToTell(byKey({ ...run, ref: 'main' }), byKey(main), { s2: links.s2 }, null, new Set())).toEqual([]);
  });

  it('says how it ended, and where it failed', () => {
    expect(ciAnnouncement(pipe(1, 'success'))).toBe('The pipeline passed in orion-services.');
    expect(ciAnnouncement(pipe(1, 'failed', [job('build', 'success'), job('test', 'failed')]))).toBe('The pipeline failed at the test stage in orion-services.');
    expect(ciAnnouncement(pipe(1, 'failed'))).toBe('The pipeline failed in orion-services.');
    expect(ciAnnouncement(pipe(1, 'canceled'))).toBe('The pipeline was canceled in orion-services.');
  });

  it('marks the timeline where each started and ended', () => {
    const p = pipe(7, 'failed', [job('test', 'failed')], { finishedAt: NOW });
    const ms = ciMarkers(link([{ key: p.key, why: 'push', at: NOW }]), byKey(p));
    expect(ms.map((m) => [m.key, m.ts, m.bad ?? false])).toEqual([[`ci:${p.key}`, NOW - 590_000, false], [`ci-end:${p.key}`, NOW, true]]);
    expect(ms[1].title).toBe('Pipeline #7 · feat failed');
    expect(ms[1].detail).toContain('at test');
  });
});

describe('the pipeline itself', () => {
  it('knows the stage it is at, and how long it ran', () => {
    const p = pipe(1, 'running', [job('a', 'success'), job('b', 'pending'), job('c', 'created')]);
    expect(currentStage(p)).toBe(1);
    expect(currentStage({ ...p, status: 'success' })).toBe(-1);
    expect(elapsed(p, NOW)).toBe(590_000);
    expect(elapsed({ ...p, finishedAt: NOW - 90_000 }, NOW)).toBe(500_000);
    // waiting on a manual job for hours: the time it ran, not the wait
    expect(elapsed({ ...p, status: 'manual', duration: 660 }, NOW)).toBe(660_000);
  });

  it('names merge request refs the way people say them', () => {
    expect(ciRef('refs/merge-requests/123/head')).toBe('!123');
    expect(ciRef('feature/x')).toBe('feature/x');
  });
});
