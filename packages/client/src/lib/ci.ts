import { ciActive, ciFinished, ciRef, ciRepoName, failedStage, type CiJob, type CiLink, type CiPipeline, type CiStage, type CiStatus, type CiWhy } from '@cora/shared';
import type { Marker } from './markers';

/** Status colours: queued grey, running blue, passed green, failed red, canceled/skipped dim, manual amber. */
export const CI_COLOR: Record<CiStatus, string> = {
  created: '#64748b', waiting_for_resource: '#94a3b8', preparing: '#94a3b8', pending: '#94a3b8', scheduled: '#94a3b8',
  running: '#60a5fa', success: '#4ade80', failed: '#f87171', canceled: '#475569', skipped: '#334155', manual: '#fbbf24',
};

const LABEL: Partial<Record<CiStatus, string>> = { success: 'passed', waiting_for_resource: 'waiting', created: 'created', canceled: 'canceled' };
export const ciLabel = (s: CiStatus) => LABEL[s] ?? s;

/** A failed job that doesn't fail the pipeline (allowed to fail) is shown as a warning, not a failure. */
export const jobColor = (j: Pick<CiJob, 'status' | 'allowFailure'>) => (j.status === 'failed' && j.allowFailure ? '#fb923c' : CI_COLOR[j.status]);

/** A finished pipeline stays on show this long after it finished (or after the session last looked at it). */
export const SHOW_MS = 30 * 60_000;
/** …and in the session header, a little longer (dimmed). */
export const HEADER_MS = 4 * 3600_000;

/**
 * How long it has run (or ran): from its start (or creation) to its end (or now). Parked (waiting on a manual job,
 * scheduled), the time it actually ran, as GitLab counts it: not the hours it has been waiting.
 */
export function elapsed(p: Pick<CiPipeline, 'createdAt' | 'startedAt' | 'finishedAt' | 'status' | 'duration'>, now: number): number {
  if (!p.finishedAt && !ciActive(p.status) && p.duration != null) return p.duration * 1000;
  return Math.max(0, (p.finishedAt ?? now) - (p.startedAt ?? p.createdAt));
}

export const jobElapsed = (j: CiJob, now: number) => (j.startedAt ? Math.max(0, (j.finishedAt ?? now) - j.startedAt) : null);

/** When it last mattered: still on its way (now), or the later of its end and when the session looked at it. */
const lastNews = (p: CiPipeline, at: number, now: number) => (ciActive(p.status) ? now : Math.max(p.finishedAt ?? p.createdAt, at));

export type Followed = { p: CiPipeline; why: CiWhy; at: number };

/**
 * The one pipeline to show for a session: anything on its way (the one it started or looked at most recently),
 * else the one with the latest news, if that's recent enough (`within`). Quiet otherwise.
 */
export function followed(link: CiLink | undefined, pipelines: Record<string, CiPipeline>, now: number, within = SHOW_MS): Followed | null {
  if (!link) return null;
  const list = link.pipelines.flatMap((x) => (pipelines[x.key] ? [{ p: pipelines[x.key], why: x.why, at: x.at }] : []));
  const active = list.filter((x) => ciActive(x.p.status)).sort((a, b) => b.at - a.at || b.p.createdAt - a.p.createdAt);
  if (active.length) return active[0];
  const done = list.map((x) => ({ ...x, news: lastNews(x.p, x.at, now) })).filter((x) => now - x.news < within).sort((a, b) => b.news - a.news);
  return done[0] ? { p: done[0].p, why: done[0].why, at: done[0].at } : null;
}

/** Pipelines that just finished: on their way in `prev`, done in `next`. */
export function ciTransitions(prev: Record<string, CiPipeline>, next: Record<string, CiPipeline>): CiPipeline[] {
  return Object.values(next).filter((p) => ciFinished(p.status) && prev[p.key] && !ciFinished(prev[p.key].status));
}

/** Whether a pipeline finishing is worth saying: one the session started or looked at, or its own branch's (not the default branch's: everyone's merges land there). */
export function worthTelling(link: CiLink, key: string, p: CiPipeline): boolean {
  const x = link.pipelines.find((y) => y.key === key);
  if (!x) return false;
  if (x.why !== 'branch') return true;
  return !link.repo?.defaultBranch || p.ref !== link.repo.defaultBranch;
}

/**
 * The finishes to tell about: each pipeline once (`told` remembers), however many sessions follow it, for the session
 * you're looking at if it's one of them (else the first).
 */
export function finishesToTell(prev: Record<string, CiPipeline>, next: Record<string, CiPipeline>, links: Record<string, CiLink>, focus: string | null, told: Set<string>): Array<{ p: CiPipeline; sessionId: string }> {
  const out: Array<{ p: CiPipeline; sessionId: string }> = [];
  for (const p of ciTransitions(prev, next)) {
    if (told.has(p.key)) continue;
    const sids = Object.values(links).filter((l) => worthTelling(l, p.key, p)).map((l) => l.sessionId);
    if (!sids.length) continue;
    told.add(p.key);
    out.push({ p, sessionId: focus && sids.includes(focus) ? focus : sids[0] });
  }
  return out;
}

/** Said out loud: "The pipeline passed in orion-services." / "The pipeline failed at the test stage in orion-services." */
export function ciAnnouncement(p: CiPipeline): string {
  const where = ciRepoName(p.project);
  if (p.status === 'success') return `The pipeline passed in ${where}.`;
  if (p.status === 'failed') {
    const s = failedStage(p.stages);
    return s ? `The pipeline failed at the ${s.name} stage in ${where}.` : `The pipeline failed in ${where}.`;
  }
  if (p.status === 'canceled') return `The pipeline was canceled in ${where}.`;
  return `The pipeline was skipped in ${where}.`;
}

/** Timeline markers: when each of the session's pipelines started, and how it ended. */
export function ciMarkers(link: CiLink | undefined, pipelines: Record<string, CiPipeline>): Marker[] {
  const out: Marker[] = [];
  for (const x of link?.pipelines ?? []) {
    const p = pipelines[x.key];
    if (!p) continue;
    const what = `Pipeline #${p.id} · ${ciRef(p.ref)}`;
    const st = p.startedAt ?? p.createdAt;
    if (st) out.push({ key: `ci:${p.key}`, kind: 'ci', ts: st, agentId: 'main', icon: 'GitBranch', title: `${what} started`, detail: ciRepoName(p.project) });
    if (p.finishedAt && ciFinished(p.status)) {
      const fs = failedStage(p.stages);
      out.push({
        key: `ci-end:${p.key}`, kind: 'ci', ts: p.finishedAt, agentId: 'main', icon: p.status === 'success' ? 'CircleCheck' : 'CircleX', title: `${what} ${ciLabel(p.status)}`,
        detail: `${ciRepoName(p.project)}${fs ? ` · at ${fs.name}` : ''} · ${dur(elapsed(p, p.finishedAt))}`, bad: p.status !== 'success',
      });
    }
  }
  return out;
}

/** "3m 12s" */
export function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60 ? ` ${s % 60}s` : ''}` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The stage the pipeline is at: the one running (or next to run); none once it's finished. */
export function currentStage(p: CiPipeline): number {
  if (!ciActive(p.status)) return -1;
  const i = p.stages.findIndex((s) => s.status === 'running');
  return i >= 0 ? i : p.stages.findIndex((s) => ciActive(s.status));
}
