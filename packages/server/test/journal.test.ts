import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@cora/shared';
import { Journal } from '../src/journal';
import { Prefs } from '../src/prefs';
import { nudgeFor } from '../src/hosted';

const s = { id: 'abcdef12-3456-7890-abcd-ef1234567890', name: 'CORA-118 · Fix: the "retry" loop / backoff?', cwd: 'C:/code/app', startedAt: new Date(2026, 9, 25, 14, 5).getTime(), ticket: 'CORA-118 · Fix the retry loop' };

describe('session journals', () => {
  it('are a markdown file per session, by date and name, with a heading; entries, a wrap-up and recaps added in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cora-journal-'));
    const data = mkdtempSync(join(tmpdir(), 'cora-journal-data-'));
    const j = new Journal({ dir: () => dir, dataDir: data, now: () => new Date(2026, 9, 25, 15, 0).getTime() });
    const file = j.add(s, 'entry', 'Found it: the loop never backed off.');
    j.add(s, 'recap', 'Fixing the backoff; tests next.');
    j.add(s, 'wrapup', 'Done: backoff added, tests green. MR !42.');
    // Documents\Cora\Journal\2026\10\2026-10-25 <name> (<id>).md, the name made safe for a file
    expect(file).toBe(join(dir, '2026', '10', '2026-10-25 CORA-118 · Fix the retry loop backoff (abcdef12).md'));
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^# CORA-118 · Fix: the "retry" loop \/ backoff\?\n\n- \*\*Folder:\*\* `C:\/code\/app`\n- \*\*Started:\*\* Oct 25, 2:05 PM\n- \*\*Ticket:\*\* CORA-118/);
    expect(text.indexOf('Found it')).toBeLessThan(text.indexOf('· Recap'));
    expect(text.indexOf('· Recap')).toBeLessThan(text.indexOf('· Wrap-up'));
    expect(j.read(s.id)).toEqual({ file, text });
    // a rename later: still the same file (kept over a restart)
    const again = new Journal({ dir: () => dir, dataDir: data });
    expect(again.add({ ...s, name: 'Renamed' }, 'entry', 'More.')).toBe(file);
    expect(readdirSync(join(dir, '2026', '10'))).toHaveLength(1);
    expect(new Journal({ dir: () => dir, dataDir: data }).read('nope')).toBeNull();
  });

  it('are on unless you turn them off; sessions are told to keep them only then', () => {
    const p = new Prefs(null);
    expect(p.get().journal).toEqual({ on: true });
    expect(p.update({ journal: { on: false } }).journal).toEqual({ on: false });
    expect(() => p.update({ journal: { on: 'yes' as never } })).toThrow(/journal.on/);
    expect(nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'off', 'off', true)).toMatch(/`journal` tool/);
    expect(nudgeFor(DEFAULT_SETTINGS.explains, undefined, 'off', 'off', false)).not.toMatch(/`journal` tool/);
  });
});
