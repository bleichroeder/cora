import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { secretEnv, secretVars } from '@cora/shared';
import { Vault, runWithSecrets } from '../src/vault';

let dir: string;
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cora-vault-login-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('a username and password (a login secret)', () => {
  it('keeps both, needs both, and gives a command $NAME_USER and $NAME_PASS', () => {
    const v = new Vault({ file: join(dir, 'secrets.json') });
    expect(() => v.set({ name: 'SITE_LOGIN', kind: 'login', value: 'hunter2' })).toThrow(/username/);
    expect(() => v.set({ name: 'SITE_LOGIN', kind: 'login', user: 'ops' })).toThrow(/password/);
    expect(v.set({ name: 'SITE_LOGIN', kind: 'login', user: 'ops', value: 'hunter2', note: 'the encoder UI' })).toMatchObject({ name: 'SITE_LOGIN', kind: 'login', user: 'ops', expiresAt: null });
    expect(JSON.stringify(v.list())).not.toContain('hunter2');
    expect(v.env('SITE_LOGIN')).toEqual({ SITE_LOGIN_USER: 'ops', SITE_LOGIN_PASS: 'hunter2' });
  });

  it('a new username asks sessions again (as a new password does); the note alone does not', () => {
    const v = new Vault({ file: join(dir, 'secrets.json') });
    v.set({ name: 'SITE_LOGIN', kind: 'login', user: 'ops', value: 'hunter2' });
    v.grant('s1', 'SITE_LOGIN');
    v.set({ name: 'SITE_LOGIN', note: 'changed note' });
    expect(v.granted('s1', 'SITE_LOGIN')).toBe(true);
    v.set({ name: 'SITE_LOGIN', user: 'ops2' });
    expect(v.granted('s1', 'SITE_LOGIN')).toBe(false);
    expect(v.env('SITE_LOGIN')).toEqual({ SITE_LOGIN_USER: 'ops2', SITE_LOGIN_PASS: 'hunter2' });
  });

  it('a value made a login needs its password with it; secrets from before kinds are values', () => {
    const v = new Vault({ file: join(dir, 'secrets.json') });
    v.set({ name: 'OLD_TOKEN', value: 'tok-123' });
    expect(v.list()[0].kind).toBeUndefined();
    expect(v.env('OLD_TOKEN')).toEqual({ OLD_TOKEN: 'tok-123' });
    expect(() => v.set({ name: 'OLD_TOKEN', kind: 'login', user: 'me' })).toThrow(/password/);
  });

  it('how a session is told to use one', () => {
    expect(secretVars('GITHUB_PAT')).toBe('$GITHUB_PAT');
    expect(secretVars('SITE_LOGIN', 'login')).toBe('$SITE_LOGIN_USER and $SITE_LOGIN_PASS');
    expect(secretEnv('X', { value: 'v' })).toEqual({ X: 'v' });
  });

  it('both are hidden in what the command prints', async () => {
    const r = await runWithSecrets({ command: 'echo "user=$SITE_LOGIN_USER pass=$SITE_LOGIN_PASS"', cwd: dir, secrets: { SITE_LOGIN_USER: 'opsuser', SITE_LOGIN_PASS: 'hunter2-long' }, timeoutMs: 20_000 });
    expect(r.out).toContain('user=•••• pass=••••');
    expect(r.out).not.toContain('hunter2');
  });
});
