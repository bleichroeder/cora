import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compareVersions, electronStatus, nodeStatus, parseAudit, securityLevel, type SecurityReport } from '@cora/shared';
import { SecurityWatch, readUpdates } from '../src/security';

const TAGS = { latest: '44.7.3', '44-x-y': '44.7.3', '43-x-y': '43.7.11', '42-x-y': '42.11.14', '41-x-y': '41.10.7', '38-x-y': '38.8.6' };
const RELEASES = [
  { version: 'v26.12.0', security: false },
  { version: 'v22.22.1', security: false },
  { version: 'v22.22.0', security: true },
  { version: 'v22.16.0', security: false },
  { version: 'v20.19.9', security: true },
];
const SCHEDULE = { v20: { end: '2026-04-30' }, v22: { end: '2027-04-30' }, v26: { end: '2029-04-30' } };
const NOW = Date.parse('2026-10-15T12:00:00Z');

describe('the security check: what counts', () => {
  it('compares versions', () => {
    expect(compareVersions('44.7.3', '44.7.2')).toBeGreaterThan(0);
    expect(compareVersions('v22.16.0', 'v22.22.0')).toBeLessThan(0);
    expect(compareVersions('44.10.0', '44.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', 'v1.0.0')).toBe(0);
  });

  it("Electron: supported if it's one of the newest three majors; the newest patch of its own", () => {
    expect(electronStatus('44.7.2', TAGS)).toEqual({ installed: '44.7.2', latest: '44.7.3', supportedMajors: [44, 43, 42], supported: true, latestPatch: '44.7.3' });
    expect(electronStatus('38.8.6', TAGS)).toMatchObject({ supported: false, latestPatch: '38.8.6' });
  });

  it('Node: behind on a security release of its line, or past its end of life', () => {
    expect(nodeStatus('v22.16.0', RELEASES, SCHEDULE, NOW)).toEqual({ version: 'v22.16.0', latestInLine: 'v22.22.1', securityBehind: true, endOfLife: '2027-04-30', ended: false });
    expect(nodeStatus('v22.22.0', RELEASES, SCHEDULE, NOW).securityBehind).toBe(false);
    expect(nodeStatus('v20.19.9', RELEASES, SCHEDULE, NOW)).toMatchObject({ securityBehind: false, ended: true });
  });

  it('npm audit: findings worst first, direct ones before the rest', () => {
    const r = parseAudit({
      vulnerabilities: {
        glob: { severity: 'high', isDirect: false, via: [{ title: 'Command injection in glob CLI', url: 'https://github.com/advisories/GHSA-1' }], fixAvailable: true },
        vite: { severity: 'moderate', isDirect: true, via: ['esbuild'], fixAvailable: { name: 'vite', version: '7.0.0', isSemVerMajor: true } },
        esbuild: { severity: 'moderate', isDirect: false, via: [{ title: 'dev server reads any file' }], fixAvailable: false },
        fastify: { severity: 'critical', isDirect: true, via: [{ title: 'bad thing' }], fixAvailable: { name: 'fastify', version: '5.1.1', isSemVerMajor: false } },
      },
    });
    expect(r.counts).toEqual({ critical: 1, high: 1, moderate: 2, low: 0, info: 0 });
    expect(r.findings.map((f) => `${f.severity} ${f.name} ${f.fix}`)).toEqual(['critical fastify auto', 'high glob auto', 'moderate vite breaking', 'moderate esbuild none']);
    expect(r.findings[1]).toMatchObject({ title: 'Command injection in glob CLI', url: 'https://github.com/advisories/GHSA-1' });
    expect(r.findings[2].title).toBe('through esbuild');
    expect(parseAudit({}).findings).toEqual([]);
    // with the production-only audit: what's only in dev tools is marked, and sorted after the rest
    const both = parseAudit({ vulnerabilities: { vitest: { severity: 'critical', isDirect: true, via: [{ title: 'x' }] }, '@fastify/static': { severity: 'high', isDirect: true, via: [{ title: 'y' }] } } }, { vulnerabilities: { '@fastify/static': {} } });
    expect(both.findings.map((f) => `${f.name}${f.dev ? ' dev' : ''}`)).toEqual(['@fastify/static', 'vitest dev']);
  });

  it('how worrying a report is', () => {
    const base: SecurityReport = { checkedAt: 0, repo: 'r', electron: electronStatus('44.7.3', TAGS), node: nodeStatus('v22.22.1', RELEASES, SCHEDULE, NOW), npm: parseAudit({}) };
    expect(securityLevel(base)).toBeNull();
    expect(securityLevel({ ...base, electron: electronStatus('44.7.2', TAGS) })).toBe('some');
    expect(securityLevel({ ...base, electron: electronStatus('38.8.6', TAGS) })).toBe('high');
    expect(securityLevel({ ...base, node: nodeStatus('v22.16.0', RELEASES, SCHEDULE, NOW) })).toBe('high');
    expect(securityLevel({ ...base, npm: parseAudit({ vulnerabilities: { a: { severity: 'low', via: [] } } }) })).toBe('some');
    // a critical finding only in dev tools isn't urgent
    expect(securityLevel({ ...base, npm: parseAudit({ vulnerabilities: { vitest: { severity: 'critical', via: [] } } }, { vulnerabilities: {} }) })).toBe('some');
    expect(securityLevel({ ...base, npm: parseAudit({ vulnerabilities: { fastify: { severity: 'critical', via: [] } } }, { vulnerabilities: { fastify: {} } }) })).toBe('high');
    expect(securityLevel(null)).toBeNull();
  });
});

describe('the security watch', () => {
  const fetchFn = (async (url: string) => {
    const body = url.includes('dist-tags') ? TAGS : url.includes('index.json') ? RELEASES : SCHEDULE;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  it('checks everything, downloads a newer Electron patch ahead, and notes it for the next start', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-sec-'));
    const published: SecurityReport[] = [];
    const downloads: string[] = [];
    const w = new SecurityWatch({
      repo: 'C:/repo',
      dataDir,
      publish: (r) => published.push(r),
      fetchFn,
      audit: async () => ({ vulnerabilities: { glob: { severity: 'high', via: [{ title: 'x' }], fixAvailable: true } } }),
      electronVersion: () => '44.7.2',
      download: async (v) => void downloads.push(v),
      nodeVersion: 'v22.16.0',
      now: () => NOW,
    });
    const r = await w.check();
    expect(downloads).toEqual(['44.7.3']);
    expect(r.electron).toMatchObject({ installed: '44.7.2', pending: '44.7.3', supported: true });
    expect(r.node).toMatchObject({ securityBehind: true, latestInLine: 'v22.22.1' });
    expect(r.npm?.counts.high).toBe(1);
    expect(readUpdates(dataDir).electron).toMatchObject({ version: '44.7.3', ready: true });
    expect(published.at(-1)).toEqual(r);
    // checked again: not downloaded twice
    await w.check();
    expect(downloads).toEqual(['44.7.3']);
  });

  it("doesn't retry a patch that failed to install, and clears the note once it's installed", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'cora-sec-'));
    const downloads: string[] = [];
    let installed = '44.7.2';
    const w = new SecurityWatch({ repo: 'r', dataDir, publish: () => {}, fetchFn, audit: async () => ({}), electronVersion: () => installed, download: async (v) => void downloads.push(v), now: () => NOW });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(dataDir, 'updates.json'), JSON.stringify({ electron: { version: '44.7.3', ready: false, failed: '44.7.3', at: NOW - 3600_000 } }));
    const r = await w.check();
    expect(r.electron?.pending).toBeUndefined();
    // the Security page says it wouldn't install (not "downloading" forever)
    expect(r.electron?.failed).toBe('44.7.3');
    expect(downloads).toEqual([]);
    // a day on, it's tried again (what held it may be gone)
    writeFileSync(join(dataDir, 'updates.json'), JSON.stringify({ electron: { version: '44.7.3', ready: false, failed: '44.7.3', at: NOW - 90_000_000 } }));
    expect((await w.check()).electron?.pending).toBe('44.7.3');
    expect(downloads).toEqual(['44.7.3']);
    installed = '44.7.3';
    await w.check();
    expect(JSON.parse(readFileSync(join(dataDir, 'updates.json'), 'utf8')).electron).toBeUndefined();
  });

  it('a source that fails says so without failing the rest', async () => {
    const w = new SecurityWatch({
      repo: 'r',
      dataDir: mkdtempSync(join(tmpdir(), 'cora-sec-')),
      publish: () => {},
      fetchFn: (async () => new Response('', { status: 503 })) as typeof fetch,
      audit: async () => {
        throw new Error('npm audit gave no answer');
      },
      electronVersion: () => '44.7.2',
      now: () => NOW,
    });
    const r = await w.check();
    expect(r.electron?.error).toMatch(/503/);
    expect(r.node?.error).toMatch(/503/);
    expect(r.npm?.error).toBe('npm audit gave no answer');
  });
});
