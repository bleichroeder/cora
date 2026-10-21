import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { changeTurns, relPath } from '../src/lib/changes';
import { proposedChange } from '../src/lib/proposed';

let seq = 0;
const base = { sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'look' as const }, source: 'hook' as const };
const prompt = (ts: number, text: string): BrainEvent => ({ ...base, seq: seq++, id: `p${ts}`, ts, kind: 'prompt', text });
const edit = (ts: number, path: string, add: number, del: number, kind: 'edit' | 'create' = 'edit', failed = false): BrainEvent => ({
  ...base, seq: seq++, id: `tool:t${ts}:end`, ts, kind: 'tool', phase: 'end', toolUseId: `t${ts}`,
  tool: { name: kind === 'create' ? 'Write' : 'Edit', input: {}, summary: '', ...(failed ? { failed: true } : {}), change: { path, kind, add, del, hunks: [] } },
});

describe('changeTurns', () => {
  it('groups edits into the turn of the prompt before them, one entry per file', () => {
    const turns = changeTurns(
      [
        prompt(100, 'fix the overlap'),
        edit(110, 'C:\\p\\src\\a.ts', 3, 1),
        edit(120, 'C:\\p\\src\\a.ts', 1, 0),
        edit(130, 'C:\\p\\src\\new.ts', 9, 0, 'create'),
        edit(135, 'C:\\p\\src\\b.ts', 1, 1, 'edit', true),
        prompt(200, 'now the tests'),
        edit(210, 'C:\\p\\test\\a.test.ts', 4, 0),
      ],
      'C:\\p',
    );
    expect(turns.map((t) => [t.prompt, t.from, t.to, t.add, t.del])).toEqual([
      ['fix the overlap', 100, 200, 13, 1],
      ['now the tests', 200, null, 4, 0],
    ]);
    expect(turns[0].files.map((f) => [f.rel, f.edits.length, f.isNew])).toEqual([
      ['src/a.ts', 2, false],
      ['src/new.ts', 1, true],
    ]);
  });

  it('edits before any prompt we know of land in an "earlier" turn', () => {
    const turns = changeTurns([edit(50, '/p/x.ts', 1, 0), prompt(100, 'go'), edit(110, '/p/x.ts', 2, 0)], '/p');
    expect(turns.map((t) => [t.key, t.files[0].add])).toEqual([['start', 1], ['p100', 2]]);
  });

  it('relPath is relative to the session folder when inside it', () => {
    expect(relPath('C:\\code\\x\\src\\a.ts', 'C:\\code\\x')).toBe('src/a.ts');
    expect(relPath('D:\\other\\a.ts', 'C:\\code\\x')).toBe('D:/other/a.ts');
  });
});

describe('proposedChange', () => {
  it('turns an Edit permission request into a diff of old → new', () => {
    const c = proposedChange('Edit', { file_path: 'C:\\p\\a.ts', old_string: 'const a = 1;\nconst b = 2;', new_string: 'const a = 1;\nconst b = 3;' });
    expect(c?.hunks[0].lines).toEqual([' const a = 1;', '-const b = 2;', '+const b = 3;']);
  });
  it('a Write is the whole file, added; other tools have none', () => {
    expect(proposedChange('Write', { file_path: '/p/n.md', content: '# hi\n' })).toMatchObject({ note: 'writes the whole file', hunks: [{ lines: ['+# hi'] }] });
    expect(proposedChange('Bash', { command: 'ls' })).toBeNull();
  });
});
