import { describe, expect, it } from 'vitest';
import { compareTags, deploysText, servicesTouched, sharedPrefixes, journeySteps, journeyWhere, serviceRows, sortTags, EMPTY_DEPLOYS, type DeployEnv, type Journey, type Workload } from '../src/deploys';

const W = (env: string, service: string, tag: string, more: Partial<Workload> = {}): Workload => ({ env, kind: 'deployment', namespace: `ns-${env}`, name: service, container: service, image: `registry.gitlab.com/g/svc/${service}`, tag, project: 'g/svc', service, desired: 2, ready: 2, updated: 2, rolling: false, ...more });
const ENVS: DeployEnv[] = [
  { id: 'p', name: 'acmelive', label: 'prod', reachable: true, readAt: 1 },
  { id: 'd', name: 'orion-dev', label: 'dev', reachable: true, readAt: 1 },
  { id: 's', name: 'acme-staging', label: 'staging', reachable: false, readAt: 1 },
];

describe('deploys: versions', () => {
  it('orders tags as versions: dev builds, release candidates, releases', () => {
    expect(compareTags('2.10.0-dev26', '2.10.0-dev25')).toBeGreaterThan(0);
    expect(compareTags('2.10.0-dev3', '2.10.0-dev25')).toBeLessThan(0);
    expect(compareTags('2.10.0-dev1', '2.9.1')).toBeGreaterThan(0);
    expect(compareTags('2.10.0', '2.10.0-rc3')).toBeGreaterThan(0);
    expect(compareTags('v1.2.3', '1.2.3')).toBe(0);
    expect(compareTags('latest', '1.2.3')).toBeNull();
    expect(sortTags(['2.9.1', '2.10.0-dev26', '2.10.0', '2.10.0-dev9'])).toEqual(['2.10.0', '2.10.0-dev26', '2.10.0-dev9', '2.9.1']);
  });
});

describe('deploys: which services a change is in', () => {
  const IMAGES = ['orionwebapiproject', 'orionwebapiproject-private', 'orion-indexer', 'orion-report-scheduler', 'orion-weekly-report-scheduler', 'morning-report-scheduler', 'media-catalog-searcher', 'orionimportbulkweb', 'help-proxy', 'media-event-emitter'];
  it('matches folders to images by name, and keeps shared code apart (tests and docs left out)', () => {
    // the project's prefix is found from its own names, never set (and a name without it is matched as it is)
    expect(sharedPrefixes(IMAGES, ['Orion.Indexer/Jobs'])).toEqual(['orion']);
    expect(sharedPrefixes(['billing-api', 'web', 'search-api'], ['Billing.Api/Controllers'])).toEqual(['billing']);
    expect(sharedPrefixes(['api', 'web'], ['src/x'])).toEqual([]);
    expect(servicesTouched(['OrionWebAPIProject/Controllers', 'Orion.DataAccess', 'Orion.ProductEvents.Model/Events', 'Orion.Tests/Api', 'docs'], IMAGES)).toEqual({ services: ['orionwebapiproject'], shared: ['Orion.DataAccess', 'Orion.ProductEvents.Model'] });
    expect(servicesTouched(['Orion.Indexer/Jobs', 'Orion.ReportScheduler', 'Orion.Import.Bulk.Web/Pages', 'OrionWeb.HelpProxy', 'Orion.MediaEventEmitter'], IMAGES).services).toEqual(['help-proxy', 'media-event-emitter', 'orion-indexer', 'orion-report-scheduler', 'orionimportbulkweb']);
    expect(servicesTouched(['Orion.Searcher.Media/Search', 'Orion.Searcher.Media.Library'], IMAGES)).toEqual({ services: ['media-catalog-searcher'], shared: ['Orion.Searcher.Media.Library'] });
    expect(servicesTouched(['OrionWebAPIProject.Private.Tests', '.gitlab'], IMAGES)).toEqual({ services: [], shared: [] });
  });
});

describe('deploys: the grid', () => {
  it('a row per service, environments in order, amber when behind the one before, dev behind a newer passed build', () => {
    const rows = serviceRows({
      envs: ENVS,
      workloads: [W('d', 'api', '2.10.0-dev26', { rolling: true, ready: 1 }), W('s', 'api', '2.10.0-dev20'), W('p', 'api', '2.9.1'), W('p', 'api', '2.7.0-rc2', { name: 'api-test' }), W('d', 'indexer', '2.10.0-dev25')],
      builds: [{ project: 'g/svc', tag: '2.10.0-dev27', at: 3, status: 'running' }, { project: 'g/svc', tag: '2.10.0-dev26', at: 2, status: 'success' }],
    });
    const api = rows.find((r) => r.service === 'api')!;
    expect(api.cells.d).toMatchObject({ tag: '2.10.0-dev26', rolling: true, ready: 1, desired: 2, behind: false });
    expect(api.cells.s.behind).toBe(true);
    expect(api.cells.p).toMatchObject({ tag: '2.9.1', behind: true });
    expect(api.cells.p.tags.sort()).toEqual(['2.7.0-rc2', '2.9.1']);
    expect(api.newest?.tag).toBe('2.10.0-dev27');
    expect(api.newestOk?.tag).toBe('2.10.0-dev26');
    expect(api.devBehind).toBe(false);
    expect(rows.find((r) => r.service === 'indexer')!.devBehind).toBe(true);
  });
});

describe('deploys: a journey', () => {
  const j: Journey = {
    sessionId: 's1',
    key: 'ACME-5301',
    project: 'g/svc',
    mrs: [{ iid: 842, title: 'ACME-5301: events', state: 'merged', url: 'u', mergedAt: 1, sha: 'abc', pipeline: { status: 'success', url: 'p' } }],
    tags: ['2.10.0-dev25', '2.10.0-dev26'],
    built: { tag: '2.10.0-dev25', status: 'success' },
    ready: '2.10.0-dev26',
    services: ['api'],
    shared: [],
    envs: { d: { has: 'yes', runs: '2.10.0-dev26', of: 3, with: 3 }, s: { has: 'no', runs: '2.10.0-dev20', of: 3, with: 0 }, p: { has: 'no', runs: '2.9.1', of: 4, with: 0 } },
    readAt: 0,
  };
  it('MR → Pipeline → Tag → dev → staging → prod, and the chip says how far it got', () => {
    const steps = journeySteps(j, ENVS, 3_600_001);
    expect(steps.map((s) => [s.label, s.state])).toEqual([['MR', 'ok'], ['Pipeline', 'ok'], ['Tag', 'ok'], ['Dev', 'ok'], ['Staging', 'none'], ['Prod', 'none']]);
    expect(steps[0].detail).toBe('!842 merged 1h');
    expect(steps[4].detail).toBe('runs 2.10.0-dev20');
    expect(journeyWhere(j, ENVS)).toBe('dev');
    expect(journeyWhere({ ...j, mrs: [{ ...j.mrs[0], state: 'opened', sha: null }], tags: [], built: null, ready: null, envs: {} }, ENVS)).toBe('mr');
  });

  it('the tool says what runs where and how far the ticket got', () => {
    const text = deploysText({ ...EMPTY_DEPLOYS, envs: ENVS, workloads: [W('d', 'api', '2.10.0-dev26'), W('p', 'api', '2.9.1')], journeys: [j] }, { project: 'svc', sessionId: 's1' }, 10);
    expect(text).toMatch(/dev \(orion-dev\) reachable now; staging \(acme-staging\) not reachable, last read/);
    expect(text).toMatch(/- api: dev 2\.10\.0-dev26 2\/2 ready \[ns-d\/api\] · prod 2\.9\.1/);
    expect(text).toMatch(/ACME-5301 \(changes api\): MR !842 merged.*Dev 2\.10\.0-dev26 ✓ → Staging runs 2\.10\.0-dev20/);
  });
});
