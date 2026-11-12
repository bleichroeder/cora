import { describe, expect, it } from 'vitest';
import type { SecretInfo } from '@cora/shared';
import { DEFAULT_VIEW, health, kindCounts, matches, needsYou, stale, viewSecrets } from '../src/lib/secretsView';

const NOW = Date.UTC(2026, 10, 11, 12);
const H = 3600_000;
const D = 24 * H;
const s = (name: string, o: Partial<SecretInfo> = {}): SecretInfo => ({ name, note: '', scope: { all: true }, createdAt: NOW - 10 * D, updatedAt: NOW - 10 * D, ...o });

const SVC = String.raw`C:\gitlab\orion-services`;
const CORA = String.raw`C:\code\cora`;
const list = [
  s('GITHUB_PAT', { note: 'CI bot token', lastUsed: { at: NOW - 2 * H, sessionId: 'a', session: 'cora-dev' } }),
  s('ENCODER_LOGIN', { kind: 'login', user: 'ops-admin', note: 'encoder web UI', scope: { folders: [SVC] }, lastUsed: { at: NOW - 41 * D, sessionId: 'b', session: 'svc' } }),
  s('GITLAB_JWT', { expiresAt: NOW - H, scope: { folders: [SVC, CORA] }, createdAt: NOW - D }),
  s('GRAFANA_TOKEN', { expiresAt: NOW + 3 * H }),
  s('OLD_KEY', { expiresAt: NOW + 30 * D }),
];

describe('Settings › Secrets: finding one', () => {
  it('what needs you: expired first, then expiring within a day (not a month off)', () => {
    expect(needsYou(list, NOW).map((x) => x.name)).toEqual(['GITLAB_JWT', 'GRAFANA_TOKEN']);
    expect(health(list[4], NOW)).toBeNull();
    expect(stale(list[1], NOW)).toBe(true);
    expect(stale(list[0], NOW)).toBe(false);
    expect(stale(list[3], NOW)).toBe(false); // never used: "not used yet", not stale
  });

  it('search covers names, notes, usernames and folders, every word in any order', () => {
    expect(matches(list[1], 'ops-admin')).toBe(true);
    expect(matches(list[1], 'orion encoder')).toBe(true);
    expect(matches(list[0], 'ci TOKEN')).toBe(true);
    expect(matches(list[0], 'grafana')).toBe(false);
    expect(viewSecrets(list, { ...DEFAULT_VIEW, q: 'cora', group: 'none' }, NOW)[0].items.map((x) => x.name)).toEqual(['GITLAB_JWT']);
  });

  it('grouped by who may use it: all sessions first, then each folder (a secret for two folders is in both)', () => {
    const g = viewSecrets(list, DEFAULT_VIEW, NOW);
    expect(g.map((x) => [x.label, x.items.map((i) => i.name)])).toEqual([
      ['All sessions', ['GITHUB_PAT', 'GRAFANA_TOKEN', 'OLD_KEY']],
      ['cora', ['GITLAB_JWT']],
      ['orion-services', ['ENCODER_LOGIN', 'GITLAB_JWT']],
    ]);
    expect(g[2].title).toBe(SVC);
  });

  it('two folders with the same last part keep their full paths apart', () => {
    const [one, two] = [String.raw`C:\one\app`, String.raw`D:\two\app`];
    const both = [s('A', { scope: { folders: [one] } }), s('B', { scope: { folders: [two] } })];
    expect(viewSecrets(both, DEFAULT_VIEW, NOW).map((g) => g.label)).toEqual([one, two]);
  });

  it('by kind, filtered by kind, only what needs you, and sorted', () => {
    expect(viewSecrets(list, { ...DEFAULT_VIEW, group: 'kind' }, NOW).map((g) => [g.label, g.items.length])).toEqual([
      ['Secrets', 4],
      ['Usernames + passwords', 1],
    ]);
    expect(viewSecrets(list, { ...DEFAULT_VIEW, group: 'none', kind: 'login' }, NOW)[0].items.map((x) => x.name)).toEqual(['ENCODER_LOGIN']);
    expect(viewSecrets(list, { ...DEFAULT_VIEW, group: 'none', attention: true }, NOW)[0].items.map((x) => x.name)).toEqual(['GITLAB_JWT', 'GRAFANA_TOKEN']);
    expect(viewSecrets(list, { ...DEFAULT_VIEW, group: 'none', sort: 'used' }, NOW)[0].items.map((x) => x.name)).toEqual(['GITHUB_PAT', 'ENCODER_LOGIN', 'GITLAB_JWT', 'GRAFANA_TOKEN', 'OLD_KEY']);
    expect(viewSecrets(list, { ...DEFAULT_VIEW, group: 'none', sort: 'newest' }, NOW)[0].items[0].name).toBe('GITLAB_JWT');
    expect(viewSecrets(list, { ...DEFAULT_VIEW, q: 'nothing like it' }, NOW)).toEqual([]);
    expect(kindCounts(list)).toEqual({ all: 5, value: 4, login: 1 });
  });
});
