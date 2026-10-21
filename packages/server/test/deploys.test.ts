import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeploysMsg } from '@cora/shared';
import { Deploys, parseWorkloads, projectFor, type DeploySession } from '../src/deploys';
import type { EnvState } from '../src/environments';

const REG = 'registry.gitlab.com/acme/svc';

function dep(ns: string, name: string, image: string, o: { replicas?: number; ready?: number; updated?: number; gen?: number; observed?: number } = {}) {
  const r = o.replicas ?? 2;
  return { kind: 'Deployment', metadata: { namespace: ns, name, generation: o.gen ?? 3 }, spec: { replicas: r, template: { spec: { containers: [{ name, image }] } } }, status: { replicas: r, readyReplicas: o.ready ?? r, updatedReplicas: o.updated ?? r, observedGeneration: o.observed ?? o.gen ?? 3, conditions: [{ type: 'Progressing', lastUpdateTime: '2026-10-16T10:00:00Z' }] } };
}
const list = (...items: unknown[]) => JSON.stringify({ apiVersion: 'v1', items });

describe('deploys: reading a cluster', () => {
  it('keeps containers from GitLab registry images, with rollout state', () => {
    const out = list(
      dep('acme-dev', 'acme-api', `${REG}/orionwebapiproject:2.10.0-dev26`, { ready: 1 }),
      dep('kube-system', 'coredns', 'registry.k8s.io/coredns:1.11'),
      { kind: 'CronJob', metadata: { namespace: 'acme-dev', name: 'nightly' }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'job', image: `${REG}/nightly:2.10.0-dev20` }] } } } } } },
      { kind: 'StatefulSet', metadata: { namespace: 'acme-dev', name: 'store', generation: 1 }, spec: { replicas: 1, template: { spec: { containers: [{ name: 'store', image: `${REG}:2.10.0-dev26` }] } } }, status: { readyReplicas: 1, updatedReplicas: 1, observedGeneration: 1, currentRevision: 'a', updateRevision: 'a' } },
    );
    const ws = parseWorkloads('dev', out);
    expect(ws.map((w) => [w.kind, w.name, w.image, w.tag, w.rolling])).toEqual([
      ['deployment', 'acme-api', `${REG}/orionwebapiproject`, '2.10.0-dev26', true],
      ['cronjob', 'nightly', `${REG}/nightly`, '2.10.0-dev20', false],
      ['statefulset', 'store', REG, '2.10.0-dev26', false],
    ]);
    expect(ws[0].since).toBe(Date.parse('2026-10-16T10:00:00Z'));
  });

  it('works out the project from the ones known (the longest prefix)', () => {
    expect(projectFor('acme/svc/indexer', ['acme', 'acme/svc', 'acme/other'])).toBe('acme/svc');
    expect(projectFor('acme/svc', ['acme/svc'])).toBe('acme/svc');
    expect(projectFor('acme/svcx/a', ['acme/svc'])).toBeNull();
  });
});

/** A fake cluster per kubeconfig and a fake gitlab.com, through one exec. */
function world() {
  const clusters: Record<string, unknown[]> = {
    'dev.yaml': [dep('acme-dev', 'acme-api', `${REG}/api:2.10.0-dev24`), dep('acme-dev', 'indexer', `${REG}/indexer:2.10.0-dev24`), dep('acme-dev', 'pinned', `${REG}/api:2.10.0-dev30-x`)],
    'prod.yaml': [dep('acme-prod', 'acme-api', `${REG}/api:2.9.1`)],
  };
  const sets: string[][] = [];
  /** where each kubeconfig really points (Deploys checks before it writes) */
  const points: Record<string, string> = { 'dev.yaml': 'dev-host', 'prod.yaml': 'prod-host' };
  const gitlab: Array<[RegExp, unknown]> = [
    [/^projects\/acme%2Fsvc\/merge_requests\?state=all&search=ACME-5301/, [{ iid: 842, title: 'ACME-5301: chat events', source_branch: 'ACME-5301-chat', state: 'merged' }, { iid: 700, title: 'ACME-53011 other', source_branch: 'x', state: 'merged' }]],
    [/^projects\/acme%2Fsvc\/merge_requests\?state=all&source_branch=ACME-5301-chat/, []],
    [/^projects\/acme%2Fsvc\/merge_requests\/842$/, { iid: 842, title: 'ACME-5301: chat events', state: 'merged', web_url: 'https://gitlab.com/mr/842', merged_at: '2026-10-16T12:00:00Z', merge_commit_sha: 'abc123', head_pipeline: { status: 'success', web_url: 'https://gitlab.com/p/1' } }],
    [/^projects\/acme%2Fsvc\/merge_requests\/842\/diffs/, [{ new_path: 'Api/Controllers/Chat.cs', old_path: 'Api/Controllers/Chat.cs' }, { new_path: 'Shared.Model/Events.cs', old_path: 'Shared.Model/Events.cs' }]],
    [/^projects\/acme%2Fsvc\/repository\/commits\/abc123\/refs\?type=tag/, [{ type: 'tag', name: '2.10.0-dev26' }, { type: 'tag', name: '2.10.0-dev25' }]],
    [/^projects\/acme%2Fsvc\/repository\/tags/, [{ name: '2.10.0-dev26', commit: { created_at: '2026-10-16T16:42:00Z' } }, { name: '2.10.0-dev25', commit: { created_at: '2026-10-15T16:59:00Z' } }]],
    [/^projects\/acme%2Fsvc\/pipelines\?ref=2\.10\.0-dev2[56]/, [{ id: 9, status: 'success', web_url: 'https://gitlab.com/p/9' }]],
    [/^projects\/acme%2Fsvc\/registry\/repositories\?/, [{ id: 1, location: `${REG}/api` }, { id: 2, location: `${REG}/indexer` }]],
    [/^projects\/acme%2Fsvc\/registry\/repositories\/[12]\/tags\/2\.10\.0-dev26$/, { name: '2.10.0-dev26' }],
  ];
  const exec = async (file: string, args: string[]) => {
    if (/kubectl/.test(file)) {
      const kc = args[args.indexOf('--kubeconfig') + 1];
      if (args.includes('config')) return { stdout: `https://${points[kc]}/k8s/clusters/local`, stderr: '' };
      if (args.includes('set')) {
        sets.push(args.slice(args.indexOf('set')));
        // the image changes at once; the rollout takes a read or two
        const [kind, name] = args[args.indexOf('image') + 1].split('/');
        const [, image] = args[args.indexOf('image') + 2].split('=');
        const d = (clusters[kc] as any[]).find((x) => x.kind.toLowerCase() === kind && x.metadata.name === name);
        d.spec.template.spec.containers[0].image = image;
        d.metadata.generation++;
        d.status.updatedReplicas = 1;
        return { stdout: '', stderr: '' };
      }
      if (args.includes('pods')) return { stdout: list(), stderr: '' };
      return { stdout: list(...clusters[kc]), stderr: '' };
    }
    const path = args[3];
    const hit = gitlab.find(([re]) => re.test(path));
    if (!hit) throw Object.assign(new Error('404 Not Found'), { stderr: 'glab: 404 Not Found' });
    return { stdout: JSON.stringify(hit[1]), stderr: '' };
  };
  const envs: EnvState[] = [
    { id: 'dev-host', name: 'orion-dev', label: 'dev', url: '', kubeconfig: 'dev.yaml', on: true, reachable: true },
    { id: 'prod-host', name: 'acmelive', label: 'prod', url: '', kubeconfig: 'prod.yaml', on: true, reachable: true },
  ];
  const sessions: DeploySession[] = [{ id: 's1', ticket: 'ACME-5301', repo: { project: 'acme/svc', branch: 'ACME-5301-chat', defaultBranch: 'main' } }];
  return { clusters, sets, exec, envs, sessions, points };
}

const settle = async (d: Deploys, rounds = 6) => {
  for (let i = 0; i < rounds; i++) {
    await d.tick();
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('deploys: a ticket from MR to dev', () => {
  it('follows the journey, offers the bump, bumps dev only, and follows the rollout', async () => {
    const w = world();
    let now = Date.parse('2026-10-17T12:00:00Z');
    const msgs: DeploysMsg[] = [];
    const lines: string[] = [];
    const file = join(mkdtempSync(join(tmpdir(), 'cora-deploys-')), 'deploys.json');
    const d = new Deploys({ envs: () => w.envs, sessions: () => w.sessions, publish: (m) => msgs.push(m), hasClients: () => true, onBump: (_b, l) => lines.push(l), exec: w.exec as any, kubectl: 'kubectl', file, now: () => now });
    await settle(d);
    let st = d.state();
    expect(st.envs.map((e) => [e.label, !!e.readAt])).toEqual([['dev', true], ['prod', true]]);
    expect(st.workloads.find((x) => x.name === 'indexer')).toMatchObject({ project: 'acme/svc', service: 'indexer', tag: '2.10.0-dev24' });
    const j = st.journeys[0];
    expect(j).toMatchObject({ key: 'ACME-5301', tags: ['2.10.0-dev25', '2.10.0-dev26'], built: { tag: '2.10.0-dev25', status: 'success' }, ready: '2.10.0-dev26' });
    // the other ticket's MR (ACME-53011) isn't this one's
    expect(j.mrs.map((m) => m.iid)).toEqual([842]);
    // its MR changes the api (and shared code): only the api's workloads count, and only they are offered
    expect(j).toMatchObject({ services: ['api'], shared: ['Shared.Model'] });
    expect(j.envs['dev-host']).toMatchObject({ has: 'no', of: 2, with: 0 });
    const s = st.suggestions[0];
    expect(s).toMatchObject({ id: 'ACME-5301@2.10.0-dev26', env: 'dev-host', tag: '2.10.0-dev26' });
    expect(s.targets.map((t) => [t.name, t.on])).toEqual([['acme-api', true], ['pinned', false]]);
    await new Promise((r) => setTimeout(r, 150));
    expect(msgs.length).toBeGreaterThan(0);

    // staging and prod are never changed
    expect(await d.bump({ env: 'prod-host', tag: '2.10.0-dev26', targets: [{ kind: 'deployment', namespace: 'acme-prod', name: 'acme-api', container: 'acme-api' }] })).toEqual({ ok: false, error: 'Cora only bumps dev; acmelive is prod' });
    // nor something dev doesn't run, nor a tag the registry doesn't have
    expect((await d.bump({ env: 'dev-host', tag: '2.10.0-dev26', targets: [{ kind: 'deployment', namespace: 'acme-dev', name: 'nope', container: 'nope' }] })).ok).toBe(false);
    expect(await d.bump({ env: 'dev-host', tag: '2.10.0-dev99', targets: [{ kind: 'deployment', namespace: 'acme-dev', name: 'indexer', container: 'indexer' }] })).toEqual({ ok: false, error: 'indexer:2.10.0-dev99 isn\'t in the registry' });
    expect(w.sets).toEqual([]);

    const r = await d.bump({ env: 'dev-host', tag: '2.10.0-dev26', key: 'ACME-5301', targets: s.targets.filter((t) => t.on) });
    expect(r.ok).toBe(true);
    expect(w.sets).toEqual([
      ['set', 'image', 'deployment/acme-api', `acme-api=${REG}/api:2.10.0-dev26`],
    ]);
    expect(d.state().suggestions).toEqual([]);
    // one read: rolling; then the pods are ready
    now += 5_000;
    await settle(d, 2);
    expect(d.state().bumps[0].state).toBe('rolling');
    for (const x of w.clusters['dev.yaml'] as any[]) (x.status.updatedReplicas = 2), (x.status.observedGeneration = x.metadata.generation);
    now += 5_000;
    await settle(d, 2);
    st = d.state();
    expect(st.bumps[0]).toMatchObject({ state: 'done', tag: '2.10.0-dev26', key: 'ACME-5301' });
    expect(lines).toEqual(['[Deploys] svc 2.10.0-dev26 (ACME-5301) on dev rolled out in 10s: acme-api.']);
    expect(st.events.map((e) => [e.name, e.from, e.to, e.by])).toEqual([
      ['acme-api', '2.10.0-dev24', '2.10.0-dev26', 'cora'],
    ]);
    // the indexer wasn't touched
    expect(st.workloads.find((x) => x.name === 'indexer' && x.env === 'dev-host')?.tag).toBe('2.10.0-dev24');
    // the finished card goes when dismissed, and stays gone after a restart; the last listing is kept
    expect(d.dismiss(st.bumps[0].id)).toBe(true);
    d.stop();
    const again = new Deploys({ envs: () => w.envs.map((e) => ({ ...e, reachable: false })), sessions: () => [], publish: () => {}, hasClients: () => true, exec: w.exec as any, file, now: () => now });
    const st2 = again.state();
    expect(st2.bumps).toEqual([]);
    expect(st2.workloads.find((x) => x.name === 'acme-api' && x.env === 'dev-host')?.tag).toBe('2.10.0-dev26');
    expect(st2.envs[0]).toMatchObject({ reachable: false, readAt: now });
  });

  it('reads nothing while no dashboard is open', async () => {
    const w = world();
    let calls = 0;
    const d = new Deploys({ envs: () => w.envs, sessions: () => w.sessions, publish: () => {}, hasClients: () => false, exec: (async (...a: any[]) => (calls++, (w.exec as any)(...a))) as any, kubectl: 'kubectl' });
    await settle(d);
    expect(calls).toBe(0);
  });

  // docs/audit-2026-10-20.md S14: a dev label isn't enough; the kubeconfig must really reach that cluster
  it("refuses a bump when dev's kubeconfig points at another cluster, and passes each environment's own context", async () => {
    const w = world();
    const calls: string[][] = [];
    w.envs[0] = { ...w.envs[0], context: 'dev-ctx' };
    const d = new Deploys({ envs: () => w.envs, sessions: () => w.sessions, publish: () => {}, hasClients: () => true, exec: (async (f: string, a: string[]) => (calls.push(a), (w.exec as any)(f, a))) as any, kubectl: 'kubectl' });
    await settle(d);
    expect(calls.filter((a) => a.includes('get')).every((a) => a[a.indexOf('--kubeconfig') + 1] !== 'dev.yaml' || a[a.indexOf('--context') + 1] === 'dev-ctx')).toBe(true);
    w.points['dev.yaml'] = 'prod-host';
    const r = await d.bump({ env: 'dev-host', tag: '2.10.0-dev26', targets: [{ kind: 'deployment', namespace: 'acme-dev', name: 'acme-api', container: 'acme-api' }] });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/points at prod-host, not dev-host: nothing was changed/) });
    expect(w.sets).toEqual([]);
  });
});
