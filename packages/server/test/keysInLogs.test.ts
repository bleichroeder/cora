import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { retireLoggedKey } from '../src/config';
import { writeSettings } from '../src/settings';

// docs/audit-2026-10-20.md S11
describe('keys never left lying around', () => {
  it("a sign-in key an older Cora printed into server.log is taken out of it and retired, once", () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-keys-'));
    const old = 'a'.repeat(64);
    writeFileSync(join(dir, 'ui-token'), old + '\n');
    writeFileSync(join(dir, 'server.log'), `  open: http://127.0.0.1:4317/auth?key=${old}\n  started\n`);
    const fresh = retireLoggedKey(dir, old);
    expect(fresh).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh).not.toBe(old);
    expect(readFileSync(join(dir, 'ui-token'), 'utf8').trim()).toBe(fresh);
    expect(readFileSync(join(dir, 'server.log'), 'utf8')).not.toContain(old);
    expect(readFileSync(join(dir, 'server.log'), 'utf8')).toContain('started');
    // the log no longer has the key in force: nothing more to do
    expect(retireLoggedKey(dir, fresh!)).toBeNull();
    // a key that isn't the one in the file (set some other way) is left alone
    writeFileSync(join(dir, 'server.log'), `key=${'b'.repeat(64)}`);
    expect(retireLoggedKey(dir, 'b'.repeat(64))).toBeNull();
    expect(retireLoggedKey(mkdtempSync(join(tmpdir(), 'cora-keys-')), old)).toBeNull();
  });

  it('writing Claude Code settings keeps only the newest backup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-settings-'));
    const file = join(dir, 'settings.json');
    writeFileSync(file, '{"a":1}');
    writeFileSync(join(dir, 'settings.json.cora-backup-2026-01-01T00-00-00-000Z'), '{"old":1}');
    writeFileSync(join(dir, 'other.json'), '{}');
    const b1 = writeSettings({ a: 2 }, file);
    await new Promise((r) => setTimeout(r, 5));
    const b2 = writeSettings({ a: 3 }, file);
    const backups = readdirSync(dir).filter((f) => f.startsWith('settings.json.cora-backup-'));
    expect(backups).toHaveLength(1);
    expect(join(dir, backups[0])).toBe(b2);
    expect(existsSync(b1!)).toBe(b1 === b2);
    expect(readFileSync(b2!, 'utf8')).toBe(JSON.stringify({ a: 2 }, null, 2) + '\n');
    expect(existsSync(join(dir, 'other.json'))).toBe(true);
  });
});
