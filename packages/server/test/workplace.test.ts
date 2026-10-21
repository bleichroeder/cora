import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { DEFAULT_SETTINGS, servicesTouched } from '@cora/shared';
import { gitlabHost, isGitlabHost, registryPrefix, setGitlabHost } from '../src/gitlabHost';
import { applyPatch, Prefs } from '../src/prefs';
import { pickProject } from '../src/ciRefs';

const fsOf = (files: Record<string, string>) => ({ exists: () => true, list: () => Object.keys(files), read: (f: string) => files[f.split(/[\\/]/).pop()!] ?? '' });

describe('nothing workplace-specific: plain settings', () => {
  afterEach(() => setGitlabHost(undefined));

  it("service matching finds a project's own prefix; nothing to set", () => {
    expect(servicesTouched(['Billing.Api/Controllers'], ['billing-api', 'web']).services).toEqual(['billing-api']);
    expect(servicesTouched(['Acme.Search.Broadcast/src'], ['broadcast-search', 'acme-indexer', 'acme-web']).services).toEqual(['broadcast-search']);
  });

  it('the GitLab host: gitlab.com unless set; its registry; repos elsewhere are not followed', () => {
    expect(gitlabHost()).toBe('gitlab.com');
    expect(pickProject({ origin: 'git@gitlab.com:acme/app.git' })).toBe('acme/app');
    setGitlabHost('gitlab.acme.io');
    expect(registryPrefix()).toBe('registry.gitlab.acme.io/');
    expect(pickProject({ origin: 'git@gitlab.com:acme/app.git' })).toBeNull();
    expect(pickProject({ origin: 'https://gitlab.acme.io/team/app.git' })).toBe('team/app');
    expect(isGitlabHost('gitlab.acme.io')).toBe(true);
    expect(isGitlabHost('not a host')).toBe(false);
  });

  it('both are settings: checked, and kept across a restart', () => {
    expect(() => applyPatch(DEFAULT_SETTINGS, { gitlab: { host: 'https://x' } })).toThrow(/gitlab.host/);
    const file = join(mkdtempSync(join(tmpdir(), 'cora-preset-')), 'config.json');
    new Prefs(file).update({ gitlab: { host: 'GitLab.Acme.io' } });
    const again = new Prefs(file).get();
    expect(again.gitlab).toEqual({ host: 'gitlab.acme.io' });
    expect(new Prefs(join(mkdtempSync(join(tmpdir(), 'cora-preset-')), 'config.json')).get()).toMatchObject({ gitlab: { host: 'gitlab.com' } });
  });

  it("0.1.0's workplace preset is noticed once (for its labels), then gone from config.json", () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-preset-')), 'config.json');
    writeFileSync(file, JSON.stringify({ preset: 'acme', deploys: { servicePrefix: 'orion' }, retentionDays: 9 }));
    const p = new Prefs(file);
    expect(p.hadPreset).toBe('acme');
    expect(p.problems).toEqual([]);
    p.update({});
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved.preset).toBeUndefined();
    expect(saved.deploys).toBeUndefined();
    expect(saved.retentionDays).toBe(9);
    expect(new Prefs(file).hadPreset).toBeNull();
    writeFileSync(file, JSON.stringify({ preset: 'none' }));
    expect(new Prefs(file).hadPreset).toBeNull();
  });
});
