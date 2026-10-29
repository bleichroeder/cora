import type { CiPipeline, CiStatus, DeploysMsg, ServerMsg, SlackMsg, Workload } from '@cora/shared';

/**
 * The simulator's integrations (`cora start --sim`): Slack with a draft waiting, what each environment runs, the
 * release's pipeline. Made up (fictional people, repos and clusters) and shown in place of the real ones, which the
 * simulator never connects; for trying the UI and for screenshots.
 */
const MIN = 60_000;
const P = { api: 'acme/orion-api', web: 'acme/aurora-web', cli: 'acme/nimbus-cli' };

export function simSlack(now = Date.now()): SlackMsg {
  return {
    t: 'slack',
    status: { connected: true, team: 'Acme', teamId: 'T0ACME', user: 'alex', userId: 'U0ALEX', url: 'https://acme.slack.com/', search: true, live: 'live', watching: 1 },
    drafts: [
      {
        id: 'sim-draft-1',
        sessionId: 'sim-web-0002',
        to: { kind: 'person', id: 'U0KIRA', label: 'Kira', detail: 'QA' },
        text: "2.4 is on staging :rocket: All 412 tests passed and the image is out. The login fix is in, so QA can start whenever you're ready.",
        createdAt: now - 2 * MIN,
        waiting: true,
      },
    ],
  };
}

const job = (id: number, name: string, stage: string, status: CiStatus, started: number | null, took: number) => ({ id, name, stage, status, startedAt: started, finishedAt: status === 'success' || status === 'failed' ? (started ?? 0) + took : null, url: `https://gitlab.com/${P.web}/-/jobs/${id}` });

export function simPipelines(now = Date.now(), tick = 0): ServerMsg {
  // the release's pipeline, a stage further each tick, round and round
  const stages = ['build', 'test', 'image', 'deploy'];
  const at = tick % (stages.length + 2);
  const started = now - 9 * MIN;
  const st = (i: number): CiStatus => (i < at ? 'success' : i === at ? 'running' : 'created');
  const release: CiPipeline = {
    key: `${P.web}#48231`,
    project: P.web,
    id: 48231,
    ref: 'release/2.4',
    sha: '9f3c2ab',
    status: at >= stages.length ? 'success' : 'running',
    source: 'push',
    url: `https://gitlab.com/${P.web}/-/pipelines/48231`,
    createdAt: started,
    startedAt: started,
    finishedAt: at >= stages.length ? now : null,
    duration: Math.round((now - started) / 1000),
    stages: stages.map((name, i) => ({ name, status: st(i), jobs: [job(90100 + i * 2, name === 'test' ? 'unit' : name, name, st(i), i <= at ? started + i * 2 * MIN : null, 2 * MIN), ...(name === 'test' ? [job(90101 + i * 2, 'e2e', name, st(i), i <= at ? started + i * 2 * MIN : null, 3 * MIN)] : [])] })),
  };
  const main: CiPipeline = { key: `${P.api}#48190`, project: P.api, id: 48190, ref: 'main', sha: '41d0e7c', status: 'success', source: 'push', url: `https://gitlab.com/${P.api}/-/pipelines/48190`, createdAt: now - 70 * MIN, startedAt: now - 70 * MIN, finishedAt: now - 58 * MIN, duration: 720, stages: [{ name: 'test', status: 'success', jobs: [job(90001, 'unit', 'test', 'success', now - 70 * MIN, 9 * MIN)] }] };
  return {
    t: 'ci',
    full: true,
    pipelines: [release, main],
    links: [
      { sessionId: 'sim-web-0002', repo: { project: P.web, branch: 'release/2.4', defaultBranch: 'main' }, pipelines: [{ key: release.key, why: 'push', at: started }] },
      { sessionId: 'sim-api-0004', repo: { project: P.api, branch: 'main', defaultBranch: 'main' }, pipelines: [{ key: main.key, why: 'branch', at: now - 70 * MIN }] },
    ],
    health: { state: 'ok' },
  };
}

export function simDeploys(now = Date.now()): DeploysMsg {
  const envs = [
    { id: 'dev.k8s.acme.internal', name: 'acme-dev', label: 'dev' as const, reachable: true, readAt: now - MIN },
    { id: 'staging.k8s.acme.internal', name: 'acme-staging', label: 'staging' as const, reachable: true, readAt: now - MIN },
    { id: 'prod.k8s.acme.internal', name: 'acme-prod', label: 'prod' as const, reachable: true, readAt: now - 2 * MIN },
  ];
  const tags: Record<string, Record<string, string>> = {
    'dev.k8s.acme.internal': { web: '2.4.0', api: '1.18.2', indexer: '1.18.2', worker: '1.18.2' },
    'staging.k8s.acme.internal': { web: '2.4.0', api: '1.18.1', indexer: '1.18.1', worker: '1.18.1' },
    'prod.k8s.acme.internal': { web: '2.3.2', api: '1.18.1', indexer: '1.18.1', worker: '1.17.9' },
  };
  const workloads: Workload[] = [];
  for (const e of envs)
    for (const [service, tag] of Object.entries(tags[e.id])) {
      const project = service === 'web' ? P.web : P.api;
      const rolling = e.label === 'staging' && service === 'web';
      workloads.push({ env: e.id, kind: 'deployment', namespace: service === 'web' ? 'aurora' : 'orion', name: `${service === 'web' ? 'aurora' : 'orion'}-${service}`, container: service, image: `registry.gitlab.com/${project}/${service}`, tag, project, service, desired: e.label === 'prod' ? 4 : 2, ready: rolling ? 1 : e.label === 'prod' ? 4 : 2, updated: rolling ? 1 : undefined, rolling, since: now - (e.label === 'prod' ? 26 * 60 : 40) * MIN });
    }
  return {
    t: 'deploys',
    envs,
    workloads,
    builds: [
      { project: P.web, tag: '2.4.0', at: now - 30 * MIN, status: 'success', url: `https://gitlab.com/${P.web}/-/pipelines/48231` },
      { project: P.api, tag: '1.18.2', at: now - 3 * 60 * MIN, status: 'success', url: `https://gitlab.com/${P.api}/-/pipelines/48170` },
    ],
    journeys: [
      {
        sessionId: 'sim-web-0002',
        key: 'ACME-5310',
        project: P.web,
        mrs: [{ iid: 412, title: 'Release 2.4: login fix, saved-search chips', state: 'merged', url: `https://gitlab.com/${P.web}/-/merge_requests/412`, mergedAt: now - 40 * MIN, sha: '9f3c2ab', pipeline: { status: 'success', url: `https://gitlab.com/${P.web}/-/pipelines/48231` }, dirs: ['web/src'] }],
        tags: ['2.4.0'],
        built: { tag: '2.4.0', status: 'success', url: `https://gitlab.com/${P.web}/-/pipelines/48231` },
        ready: '2.4.0',
        services: ['web'],
        shared: [],
        envs: { 'dev.k8s.acme.internal': { has: 'yes', runs: '2.4.0', of: 1, with: 1 }, 'staging.k8s.acme.internal': { has: 'yes', runs: '2.4.0', of: 1, with: 1 }, 'prod.k8s.acme.internal': { has: 'no', runs: '2.3.2', of: 1, with: 0 } },
        readAt: now - MIN,
      },
    ],
    suggestions: [],
    bumps: [{ id: 'sim-bump-1', env: 'staging.k8s.acme.internal', project: P.web, tag: '2.4.0', key: 'ACME-5310', targets: [{ kind: 'deployment', namespace: 'aurora', name: 'aurora-web', container: 'web', image: `registry.gitlab.com/${P.web}/web`, from: '2.3.2', on: true }], state: 'rolling', at: now - 2 * MIN }],
    events: [
      { at: now - 2 * MIN, env: 'staging.k8s.acme.internal', project: P.web, service: 'web', namespace: 'aurora', name: 'aurora-web', from: '2.3.2', to: '2.4.0', by: 'cora' },
      { at: now - 35 * MIN, env: 'dev.k8s.acme.internal', project: P.web, service: 'web', namespace: 'aurora', name: 'aurora-web', from: '2.3.2', to: '2.4.0' },
    ],
    health: { state: 'ok' },
  };
}

/** Show them (and keep the pipeline moving) until stopped. */
export function startSimShow(show: (m: ServerMsg) => void, stopped: () => boolean): void {
  show(simSlack());
  show(simDeploys());
  let tick = 0;
  show(simPipelines(Date.now(), tick));
  const t = setInterval(() => {
    if (stopped()) return clearInterval(t);
    show(simPipelines(Date.now(), ++tick));
  }, 20_000);
}
