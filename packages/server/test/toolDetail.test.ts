import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readToolDetail } from '../src/toolDetail';

describe('readToolDetail', () => {
  it('a command you ran yourself (bang:<uuid>): its line and the output line after it, whole and as printed', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-td-')), 't.jsonl');
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} a&amp;b`).join('\n');
    const lines = [
      { type: 'user', uuid: 'u1', parentUuid: 'p0', message: { role: 'user', content: '<bash-input> npm ls</bash-input>' } },
      { type: 'user', uuid: 'u2', parentUuid: 'u1', message: { role: 'user', content: `<bash-stdout>${long}</bash-stdout><bash-stderr></bash-stderr>` } },
      { type: 'user', uuid: 'u3', parentUuid: 'u2', message: { role: 'user', content: 'next' } },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const d = await readToolDetail(file, 'bang:u1');
    expect(d?.input).toEqual({ command: 'npm ls' });
    expect(d?.result.split('\n')).toHaveLength(400);
    expect(d?.result).toContain('line 399 a&b');
    expect(d?.isError).toBe(false);
    expect(await readToolDetail(file, 'bang:nope')).toBeNull();
  });
});
