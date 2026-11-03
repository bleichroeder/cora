import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { writeCoraPlugin } from '../src/coraPlugin';

// Claude Code reads the mod with rules of its own ($ spelled $.noun.call(...) at the call site, never read as a value):
// a mod it refuses doesn't load at all, so sessions lose the route gate and Cora's deliveries. Unit tests run the mod
// with a fake $, which can't see those rules; `claude plugin validate` applies them. Skipped where claude isn't installed.
const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
const have = claude.status === 0;

describe('the Cora plugin as Claude Code reads it', () => {
  it.skipIf(!have)('passes claude plugin validate (its mod loads)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-plugin-'));
    try {
      const at = writeCoraPlugin(dir, 'http://127.0.0.1:4317', 'test-token');
      const r = spawnSync('claude', ['plugin', 'validate', at], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000 });
      const out = `${r.stdout}\n${r.stderr}`;
      expect(out, out).toMatch(/Validation passed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
