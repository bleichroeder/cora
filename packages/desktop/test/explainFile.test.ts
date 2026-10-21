import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainFileName, saveExplain } from '../src/explainFile';

const day = new Date(2026, 9, 20, 15, 4);

describe('saving an explain', () => {
  it('names the file after its title, safe for Windows, with the date', () => {
    expect(explainFileName('Audit group 2: plan and effects', 'md', day)).toBe('Audit group 2 plan and effects 2026-10-20.md');
    expect(explainFileName('a/b\\c?*<>|"  ..', 'html', day)).toBe('a b c 2026-10-20.html');
    expect(explainFileName('   ', 'md', day)).toBe('Explain 2026-10-20.md');
    expect(explainFileName('CON', 'md', day)).toBe('CON explain 2026-10-20.md');
    expect(explainFileName('x'.repeat(300), 'md', day).length).toBeLessThan(100);
  });

  it('writes it into the folder (made if needed), never over another', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cora-explain-')), 'Cora', 'Explains');
    const a = saveExplain(dir, 'Plan', 'md', '# Plan', day);
    const b = saveExplain(dir, 'Plan', 'md', '# Plan again', day);
    expect(basename(a)).toBe('Plan 2026-10-20.md');
    expect(basename(b)).toBe('Plan 2026-10-20 (2).md');
    expect(readFileSync(a, 'utf8')).toBe('# Plan');
    expect(readFileSync(b, 'utf8')).toBe('# Plan again');
  });
});
