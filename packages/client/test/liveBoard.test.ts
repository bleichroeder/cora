import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { touchedBy } from '../src/components/LiveBoard';

let seq = 0;
const ev = (o: Partial<BrainEvent>): BrainEvent => ({ id: `e${++seq}`, seq, sessionId: 's', agentId: 'main', ts: 1000 + seq, icon: { name: 'X', family: 'look' }, source: 'hook', kind: 'tool', ...o }) as BrainEvent;
const call = (agentId: string, id: string, name: string, input: object, resource: string, summary: string) => ev({ agentId, toolUseId: id, phase: 'start', tool: { name, input, summary, resource } });
const done = (id: string, extra: object = {}) => ev({ toolUseId: id, phase: 'end', durationMs: 1700, tool: { name: 'x', input: {}, summary: '', ...extra } });

describe("the live board's Touching", () => {
  it('files (who touched each, what changed, a diff when it did), the web, the shell; newest first; only lately', () => {
    const events = [
      call('a1', 't1', 'Read', { file_path: 'C:/code/app/src/hooks/registry.ts' }, 'files:src', 'src/hooks/registry.ts'),
      done('t1'),
      call('main', 't2', 'Edit', { file_path: 'C:/code/app/src/hooks/payload.ts' }, 'files:src', 'src/hooks/payload.ts'),
      done('t2', { change: { path: 'C:/code/app/src/hooks/payload.ts', kind: 'edit', add: 2, del: 1 } }),
      call('a3', 't3', 'Edit', { file_path: 'C:/code/app/src/hooks/payload.ts' }, 'files:src', 'src/hooks/payload.ts'),
      call('a2', 't4', 'WebFetch', { url: 'https://code.claude.com/docs/en/hooks' }, 'web:code.claude.com', 'code.claude.com/docs/en/hooks'),
      call('main', 't5', 'Bash', { command: 'npm test -- --run' }, 'shell', 'npm test -- --run'),
      done('t5', { failed: true }),
      call('main', 't6', 'Bash', { command: 'git status' }, 'shell', 'git status'),
      call('main', 't7', 'mcp__gitlab__get_pipeline', {}, 'mcp:gitlab', '#4021'),
    ];
    const t = touchedBy(events, 2000, 'C:/code/app');
    expect(t.Files.map((f) => [f.label, f.agents, f.changed])).toEqual([
      ['src/hooks/payload.ts', ['main', 'a3'], true],
      ['src/hooks/registry.ts', ['a1'], false],
    ]);
    expect(t.Web).toEqual([expect.objectContaining({ label: 'code.claude.com/docs/en/hooks', live: true, note: 'loading' })]);
    expect(t.Shell.map((s) => [s.label, s.note])).toEqual([['git status', 'running'], ['npm test -- --run', 'failed']]);
    expect(t.Tools[0].label).toBe('gitlab · get_pipeline #4021');
    // ten minutes on: nothing
    expect(touchedBy(events, 2000 + 11 * 60_000).Files).toEqual([]);
  });
});
