import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { protectKey, readSecret, unprotectKey, writeSecret } from '../src/secrets';

// docs/audit-2026-10-20.md S10
describe('secrets at rest', () => {
  it('are written sealed and read back as written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-sec-'));
    const f = join(dir, 'slack.json');
    writeSecret(f, JSON.stringify({ token: 'xoxp-secret' }));
    expect(readFileSync(f, 'utf8')).not.toContain('xoxp-secret');
    expect(readFileSync(f, 'utf8')).toContain('"cora-sealed"');
    expect(JSON.parse(readSecret(f))).toEqual({ token: 'xoxp-secret' });
  });

  it('one written before sealing reads as it was, and is sealed from then on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-sec-'));
    const f = join(dir, 'gmail.json');
    writeFileSync(f, '{"refresh":"1//old"}\n');
    expect(readSecret(f)).toBe('{"refresh":"1//old"}\n');
    expect(readFileSync(f, 'utf8')).not.toContain('1//old');
    expect(readSecret(f)).toBe('{"refresh":"1//old"}\n');
  });

  it("one sealed under a key that's gone (another machine, a new profile) can't be read: it's as if signed out", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-sec-'));
    const f = join(dir, 'voice.json');
    writeSecret(f, '{"key":"sk"}');
    const sealed = readFileSync(f, 'utf8');
    const other = mkdtempSync(join(tmpdir(), 'cora-sec-'));
    writeFileSync(join(other, 'voice.json'), sealed);
    expect(() => readSecret(join(other, 'voice.json'))).toThrow();
    rmSync(join(dir, 'secrets.key'));
  });

  it.runIf(process.platform === 'win32')("Windows protects the key for this user (DPAPI) and gives it back", () => {
    const k = Buffer.from('0123456789abcdef0123456789abcdef');
    const blob = protectKey(k);
    expect(blob).not.toContain(k.toString('base64'));
    expect(unprotectKey(blob).equals(k)).toBe(true);
  });
});
