import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rollLog, writeFileAtomic } from '../src/fsx';

// docs/audit-2026-10-20.md B2
describe('writing a file whole', () => {
  it('replaces the file in one step and leaves nothing beside it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-fsx-'));
    const f = join(dir, 'inbox.json');
    writeFileAtomic(f, '[1]');
    expect(readFileSync(f, 'utf8')).toBe('[1]');
    writeFileSync(f, '[1,2,3,4,5,6]');
    writeFileAtomic(f, '[7]');
    expect(readFileSync(f, 'utf8')).toBe('[7]');
    writeFileAtomic(join(dir, 'token'), 'abc\n', { mode: 0o600 });
    expect(readFileSync(join(dir, 'token'), 'utf8')).toBe('abc\n');
    expect(readdirSync(dir).sort()).toEqual(['inbox.json', 'token']);
  });
});

// docs/audit-2026-10-20.md B13
describe('a log that would grow forever', () => {
  it('past its size it becomes .1 (replacing the one before) and a new one starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-log-'));
    const f = join(dir, 'server.log');
    rollLog(f, 10); // none yet: nothing to do
    writeFileSync(f, 'short');
    rollLog(f, 10);
    expect(readFileSync(f, 'utf8')).toBe('short');
    writeFileSync(f, 'a long first log');
    rollLog(f, 10);
    expect([existsSync(f), readFileSync(`${f}.1`, 'utf8')]).toEqual([false, 'a long first log']);
    writeFileSync(f, 'a long second log');
    rollLog(f, 10);
    expect(readFileSync(`${f}.1`, 'utf8')).toBe('a long second log');
  });
});
