import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Environments, clustersIn, detect, envLine, guessLabel, signature } from '../src/environments';

const kc = (server: string, ctx = 'local') => `apiVersion: v1\nclusters:\n- cluster:\n    server: "${server}"\n  name: c\ncontexts:\n- context:\n    cluster: c\n  name: ${ctx}\ncurrent-context: "${ctx}"\n`;

function kubeDir() {
  const d = join(mkdtempSync(join(tmpdir(), 'cora-env-')), '.kube');
  mkdirSync(d);
  writeFileSync(join(d, 'config'), kc('https://rancher.acme-dev.aws.example.com/k8s/clusters/local'));
  writeFileSync(join(d, 'acme-dev.yaml'), kc('https://rancher.acme-dev.aws.example.com/k8s/clusters/local'));
  writeFileSync(join(d, 'acme-live.yaml'), kc('https://rancher.acme-live.aws.example.com/k8s/clusters/local'));
  writeFileSync(join(d, 'acme-staging.yaml'), kc('https://rancher.acme-staging.aws.example.com/k8s/clusters/local'));
  writeFileSync(join(d, 'acme-staging.yaml.bak-2026'), kc('https://old.example.com'));
  writeFileSync(join(d, 'rancher-desktop.yaml'), kc('https://127.0.0.1:6443'));
  return d;
}

describe('environments', () => {
  it('finds one environment per cluster from the kubeconfigs (no backups, no local clusters), labelled sensibly', () => {
    const envs = detect(kubeDir());
    expect(envs.map((e) => [e.name, e.label]).sort()).toEqual([['acme-dev', 'dev'], ['acme-live', 'prod'], ['acme-staging', 'staging']]);
    expect(envs.find((e) => e.label === 'dev')?.url).toBe('https://rancher.acme-dev.aws.example.com/ping');
    expect(envs.find((e) => e.label === 'staging')?.kubeconfig).toMatch(/acme-staging\.yaml$/);
  });

  it('labels from names', () => {
    expect(guessLabel('acme-staging')).toBe('staging');
    expect(guessLabel('orion-dev')).toBe('dev');
    expect(guessLabel('prod-config')).toBe('prod');
    expect(guessLabel('mystery')).toBe('other');
    // prod before dev, and dev only as a word: a wrong "dev" is what lets a bump through (audit S14)
    expect(guessLabel('prod-devices')).toBe('prod');
    expect(guessLabel('devices-live')).toBe('prod');
    expect(guessLabel('devtools')).toBe('other');
  });

  it("gives each cluster in a kubeconfig its own context, not the file's current one", () => {
    const two = [
      'apiVersion: v1',
      'clusters:',
      '- cluster:',
      '    certificate-authority-data: abc',
      '    server: https://dev.example.com:6443',
      '  name: dev-cluster',
      '- name: prod-cluster',
      '  cluster:',
      '    server: "https://prod.example.com:6443"',
      'contexts:',
      '- context:',
      '    cluster: prod-cluster',
      '    user: me',
      '  name: prod',
      '- context:',
      '    cluster: dev-cluster',
      '    user: me',
      '  name: dev',
      'current-context: prod',
      'users:',
      '- name: me',
    ].join('\n');
    expect(clustersIn(two)).toEqual([
      { server: 'https://dev.example.com:6443', context: 'dev' },
      { server: 'https://prod.example.com:6443', context: 'prod' },
    ]);
    // the simple shape still works
    expect(clustersIn(kc('https://one.example.com'))).toEqual([{ server: 'https://one.example.com', context: 'local' }]);
  });

  it("an older Cora's labels are kept as the user's own, never over theirs", () => {
    const dir = kubeDir();
    writeFileSync(join(dir, 'orion.yaml'), kc('https://rancher.orion.example.com/k8s/clusters/local'));
    const file = join(dir, '..', 'environments.json');
    const env = new Environments({ kubeDir: dir, file, probe: async () => true });
    expect(env.list().find((e) => e.name === 'orion')?.label).toBe('other');
    env.update('rancher.acme-live.aws.example.com', { label: 'staging' });
    env.keepLabels((e) => (e.name === 'orion' ? 'dev' : 'prod'));
    const again = new Environments({ kubeDir: dir, file, probe: async () => true });
    expect(again.list().find((e) => e.name === 'orion')?.label).toBe('dev');
    expect(again.list().find((e) => e.name === 'acme-live')?.label).toBe('staging');
  });

  it('checks what is reachable, says it in a line, and tells when it changes', async () => {
    let up = new Set(['rancher.acme-dev.aws.example.com']);
    const changes: string[] = [];
    const env = new Environments({ kubeDir: kubeDir(), probe: async (u) => up.has(new URL(u).hostname), onChange: (s) => changes.push(signature(s)) });
    await env.check();
    expect(envLine(env.list())).toBe('Reachable now: dev (acme-dev). Not reachable: staging (acme-staging), prod (acme-live).');
    up = new Set(['rancher.acme-staging.aws.example.com']);
    await env.check();
    await env.check();
    expect(changes).toEqual(['rancher.acme-dev.aws.example.com', 'rancher.acme-staging.aws.example.com']);
    up = new Set();
    await env.check();
    expect(envLine(env.list())).toMatch(/^No environment is reachable right now/);
  });

  it("keeps the user's label and name changes, and leaves out ones they turn off", async () => {
    const dir = kubeDir();
    const file = join(dir, '..', 'environments.json');
    const env = new Environments({ kubeDir: dir, file, probe: async () => true });
    const id = 'rancher.acme-live.aws.example.com';
    expect(env.update(id, { name: 'Acme live' })).toBe(true);
    expect(env.update(id, { label: 'nonsense' as any })).toBe(false);
    expect(env.update('nope', { on: false })).toBe(false);
    env.update('rancher.acme-staging.aws.example.com', { on: false });
    const again = new Environments({ kubeDir: dir, file, probe: async () => true });
    await again.check();
    expect(again.list().find((e) => e.id === id)?.name).toBe('Acme live');
    expect(envLine(again.list())).toBe('Reachable now: dev (acme-dev), prod (Acme live).');
  });
});

describe('sessions hear about the network', () => {
  it('with their first prompt, then only when it changes; the dashboard can see and relabel them', { timeout: 30_000 }, async () => {
    const { startServer } = await import('../src/server');
    const { loadConfig } = await import('../src/config');
    let up = new Set(['rancher.acme-dev.aws.example.com']);
    const srv = await startServer(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'cora-envsrv-')), dbPath: ':memory:', hookToken: 'hooktok', uiToken: 'uitok', clientDir: join(tmpdir(), 'nope-client') }), { tail: false, listen: false, kubeDir: kubeDir(), envProbe: async (u) => up.has(new URL(u).hostname) });
    try {
      const UI = { cookie: 'ab_session=uitok', origin: 'http://127.0.0.1:4317' };
      const prompt = (sid: string, n: number) => srv.app.inject({ method: 'POST', url: '/hook/UserPromptSubmit', headers: { 'x-cora-token': 'hooktok' }, payload: { session_id: sid, cwd: 'C:/work/x', prompt: 'hi', prompt_id: `${sid}-p${n}` } });
      await srv.app.inject({ method: 'POST', url: '/api/environments/check', headers: UI });
      const first = await prompt('sess-env-1', 1);
      expect(first.json().hookSpecificOutput.additionalContext).toMatch(/^From Cora: network: Reachable now: dev \(acme-dev\)\..*KUBECONFIG=.*acme-dev\.yaml/);
      expect((await prompt('sess-env-1', 2)).statusCode).toBe(204);
      up = new Set(['rancher.acme-staging.aws.example.com']);
      await srv.app.inject({ method: 'POST', url: '/api/environments/check', headers: UI });
      expect((await prompt('sess-env-1', 3)).json().hookSpecificOutput.additionalContext).toMatch(/the network changed: Reachable now: staging/);
      const list = (await srv.app.inject({ method: 'GET', url: '/api/environments', headers: UI })).json().environments;
      expect(list.find((e: any) => e.label === 'staging').reachable).toBe(true);
      const r = await srv.app.inject({ method: 'POST', url: '/api/environments/rancher.acme-live.aws.example.com', headers: UI, payload: { name: 'Acme live' } });
      expect(r.json().environments.find((e: any) => e.id === 'rancher.acme-live.aws.example.com').name).toBe('Acme live');
    } finally {
      await srv.close();
    }
  });
});
