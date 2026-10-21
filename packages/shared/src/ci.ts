import type { CiJob, CiStage, CiStatus } from './types';

/** Still on its way: queued, waiting for a runner, or running. */
export const ciActive = (s: CiStatus) => s === 'created' || s === 'waiting_for_resource' || s === 'preparing' || s === 'pending' || s === 'running';
/** Done for good (manual and scheduled pipelines are parked, not finished). */
export const ciFinished = (s: CiStatus) => s === 'success' || s === 'failed' || s === 'canceled' || s === 'skipped';

/** A ref as people say it: a merge request's pipeline ref (refs/merge-requests/123/head) is !123. */
export function ciRef(ref: string): string {
  const mr = ref.match(/^refs\/merge-requests\/(\d+)\/(head|merge|train)$/);
  return mr ? `!${mr[1]}` : ref;
}

/** The project's display name: the last part of its path. */
export const ciRepoName = (project: string) => project.split('/').filter(Boolean).pop() ?? project;

/**
 * A stage's status from its jobs, the way GitLab shows it: anything running makes it running; then a failure that
 * counts; then jobs still to come; a stage of only manual jobs waits for you; all skipped is skipped.
 */
export function stageStatus(jobs: Pick<CiJob, 'status' | 'allowFailure'>[]): CiStatus {
  const has = (s: CiStatus) => jobs.some((j) => j.status === s);
  if (!jobs.length) return 'created';
  if (has('running')) return 'running';
  if (jobs.some((j) => j.status === 'failed' && !j.allowFailure)) return 'failed';
  if (jobs.some((j) => j.status === 'pending' || j.status === 'preparing' || j.status === 'waiting_for_resource')) return 'pending';
  if (has('created') || has('scheduled')) return 'created';
  const live = jobs.filter((j) => j.status !== 'skipped');
  if (!live.length) return 'skipped';
  if (live.every((j) => j.status === 'manual')) return 'manual';
  if (live.every((j) => j.status === 'canceled' || j.status === 'manual')) return 'canceled';
  return 'success';
}

/**
 * Jobs grouped into stages. GitLab's REST API doesn't say what order stages run in, but it creates a pipeline's jobs
 * stage by stage, so a stage's lowest job id places it (a retried job gets a new, higher id, but its stage keeps the
 * original's). Jobs keep their creation order inside a stage.
 */
export function groupStages(jobs: CiJob[]): CiStage[] {
  const by = new Map<string, CiJob[]>();
  for (const j of [...jobs].sort((a, b) => a.id - b.id)) {
    const l = by.get(j.stage);
    if (l) l.push(j);
    else by.set(j.stage, [j]);
  }
  return [...by].map(([name, js]) => ({ name, status: stageStatus(js), jobs: js }));
}

/** The first stage that failed (for "failed at the test stage"). */
export const failedStage = (stages: CiStage[]) => stages.find((s) => s.status === 'failed') ?? null;
