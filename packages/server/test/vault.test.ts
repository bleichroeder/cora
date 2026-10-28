import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Vault, runWithSecrets } from '../src/vault';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-vault-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the vault', () => {
  it('keeps secrets: infos without values, a value only when asked; a replaced value asks sessions again', () => {
    const changed: number[] = [];
    const v = new Vault({ file: join(dir, 'secrets.json'), onChange: (l) => changed.push(l.length) });
    v.set({ name: 'GITHUB_PAT', value: 'ghp_abc123', note: 'GitHub sandbox' });
    expect(v.list()).toMatchObject([{ name: 'GITHUB_PAT', note: 'GitHub sandbox', scope: { all: true } }]);
    expect(JSON.stringify(v.list())).not.toContain('pat-na1');
    expect(v.value('GITHUB_PAT')).toBe('ghp_abc123');
    v.grant('s1', 'GITHUB_PAT');
    v.set({ name: 'GITHUB_PAT', note: 'just the note' });
    expect(v.granted('s1', 'GITHUB_PAT')).toBe(true);
    v.set({ name: 'GITHUB_PAT', value: 'ghp_new' });
    expect(v.granted('s1', 'GITHUB_PAT')).toBe(false);
    expect(() => v.set({ name: 'bad name', value: 'x' })).toThrow(/capitals/);
    expect(() => v.set({ name: 'NEW_ONE' })).toThrow(/a value/);
    expect(v.remove('GITHUB_PAT')).toBe(true);
    expect(v.list()).toEqual([]);
    expect(changed).toEqual([1, 1, 1, 0]);
    expect(existsSync(join(dir, 'secrets.json'))).toBe(true);
  });

  it('a JWT says when it expires', () => {
    const v = new Vault({ file: join(dir, 'secrets.json') });
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')}.c2ln`;
    expect(v.set({ name: 'API_JWT', value: jwt }).expiresAt).toBe(2_000_000_000_000);
  });

  it('runs a command with the secret in its environment and masks it in the output, even when printed', async () => {
    const r = await runWithSecrets({ command: 'echo "token is $MY_TOKEN"; echo -n "$MY_TOKEN" | base64; echo done >&2; exit 3', cwd: dir, secrets: { MY_TOKEN: 'super-secret-value' }, timeoutMs: 20_000 });
    expect(r.code).toBe(3);
    expect(r.out).toContain('token is ••••');
    expect(r.out).toContain('done');
    expect(r.out).not.toContain('super-secret-value');
    expect(r.out).not.toContain(Buffer.from('super-secret-value').toString('base64'));
  }, 30_000);

  it('a command that runs too long is ended', async () => {
    const r = await runWithSecrets({ command: 'sleep 20', cwd: dir, secrets: {}, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
  }, 30_000);
});
