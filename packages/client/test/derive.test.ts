import { describe, expect, it } from 'vitest';
import type { AgentInfo, BrainEvent } from '@cora/shared';
import { contextMax, derive, fileOf } from '../src/scene/derive';

const NOW = 1_000_000;
let n = 0;
const base = { seq: 1, sessionId: 's', agentId: 'main', icon: { name: 'x', family: 'look' as const }, source: 'transcript' as const };
const tool = (name: string, input: unknown, resource: string, ts: number, phase: 'start' | 'end' = 'start', id = `t${n++}`, extra: object = {}): BrainEvent => ({
  ...base, id: `${id}:${phase}`, ts, kind: 'tool', phase, toolUseId: id, tool: { name, input, summary: '', resource, ...extra },
});
const main: AgentInfo = { sessionId: 's', agentId: 'main', parentAgentId: null, parentToolUseId: null, label: 'main', agentType: 'main', colorIdx: -1, startedAt: 0, endedAt: null, state: 'idle' };

describe('fileOf', () => {
  it('names the file for Read / Edit / Write, not for Grep or Bash', () => {
    expect(fileOf(tool('Read', { file_path: 'C:\\code\\x\\src\\tailer.ts' }, 'files:src', 1))).toEqual({ name: 'tailer.ts', op: 'read', path: 'C:\\code\\x\\src\\tailer.ts' });
    expect(fileOf(tool('Edit', { file_path: '/a/b/parse.ts' }, 'files:b', 1))).toEqual({ name: 'parse.ts', op: 'edit', path: '/a/b/parse.ts' });
    expect(fileOf(tool('Write', { file_path: 'new.md' }, 'files:.', 1))).toEqual({ name: 'new.md', op: 'write', path: 'new.md' });
    expect(fileOf(tool('Grep', { path: 'src' }, 'files:src', 1))).toBeNull();
    expect(fileOf(tool('Bash', { command: 'ls' }, 'shell', 1))).toBeNull();
  });
});

describe('contextMax', () => {
  it('1M for [1m] models or when usage passed 200k', () => {
    expect(contextMax('claude-opus-5-5[1m]', 10)).toBe(1_000_000);
    expect(contextMax('claude-opus-5-5', 10)).toBe(200_000);
    expect(contextMax(undefined, 250_000)).toBe(1_000_000);
  });
});

describe('derive', () => {
  it('collects file satellites per resource with counts and the latest op', () => {
    const ev = [
      tool('Read', { file_path: '/p/src/a.ts' }, 'files:src', NOW - 5000),
      tool('Read', { file_path: '/p/src/b.ts' }, 'files:src', NOW - 4000),
      tool('Edit', { file_path: '/p/src/a.ts' }, 'files:src', NOW - 3000),
    ];
    const d = derive(ev, [main], new Map(), NOW);
    const src = d.resources.find((r) => r.id === 'files:src')!;
    expect(src.calls).toBe(3);
    expect(src.files.map((f) => [f.name, f.op, f.count])).toEqual([['a.ts', 'edit', 2], ['b.ts', 'read', 1]]);
  });

  it('context: latest main usage; zero after a later compaction', () => {
    const say = (ts: number, inT: number): BrainEvent => ({ ...base, id: `s${ts}`, ts, kind: 'say', text: 'x', tokens: { in: inT, out: 100 } });
    const d1 = derive([say(NOW - 3000, 50_000), say(NOW - 2000, 90_000)], [main], new Map(), NOW, 'claude-opus-5-5');
    expect(d1.context).toEqual({ used: 90_100, max: 200_000, compactedAt: null });
    const compact: BrainEvent = { ...base, id: 'c', ts: NOW - 1000, kind: 'compact' };
    const d2 = derive([say(NOW - 2000, 90_000), compact], [main], new Map(), NOW);
    expect(d2.context?.used).toBe(0);
    expect(d2.context?.compactedAt).toBe(NOW - 1000);
  });

  it('working with no call in flight reads as thinking (Claude writing out its next call), matching the live row', () => {
    const working = { ...main, state: 'working' as const };
    const [m] = derive([], [working], new Map(), NOW).agents;
    expect(m.thinking).toBe(true);
    expect(m.status.text).toBe('thinking…');
    const running = derive([tool('Read', { file_path: '/p/a.ts' }, 'files:p', NOW - 500)], [working], new Map(), NOW).agents[0];
    expect(running.thinking).toBe(false);
    expect(derive([], [main], new Map(), NOW).agents[0].status.text).toBe('idle');
  });

  it('comets carry file, failure and result size', () => {
    const s = tool('Read', { file_path: '/p/src/a.ts' }, 'files:src', NOW - 2000, 'start', 'k1');
    const e = tool('Read', { file_path: '/p/src/a.ts' }, 'files:src', NOW - 1000, 'end', 'k1', { failed: true, preview: 'abcdef' });
    const [c] = derive([s, e], [main], new Map(), NOW).comets;
    expect(c).toMatchObject({ key: 'k1', resource: 'files:src', file: 'a.ts', failed: true, resultSize: 6, endedAt: NOW - 1000 });
  });

  it('explains are present-tool calls, one per toolUseId, oldest first', () => {
    const p = (id: string, ts: number) => tool('mcp__agent-brain__present', { title: id, format: 'markdown', content: '# x' }, 'mcp:agent-brain', ts, 'start', id);
    const d = derive([p('b', NOW - 1000), p('a', NOW - 2000)], [main], new Map(), NOW);
    expect(d.explains.map((x) => x.toolUseId)).toEqual(['a', 'b']);
  });

  it('shell commands: the last five that ran within a minute or are still running, running and failed flagged; status shows the command', () => {
    const b = (cmd: string, ts: number, id: string) => tool('Bash', { command: cmd }, 'shell', ts, 'start', id, { summary: cmd });
    const ev = [
      b('old', NOW - 120_000, 'c0'),
      b('ls', NOW - 9000, 'c1'),
      tool('Bash', {}, 'shell', NOW - 8000, 'end', 'c1'),
      b('npm test', NOW - 7000, 'c2'),
      tool('Bash', {}, 'shell', NOW - 6000, 'end', 'c2', { failed: true }),
      b('git status', NOW - 5000, 'c3'),
      b('npm run build', NOW - 1000, 'c4'),
    ];
    const d = derive(ev, [{ ...main, state: 'working' }], new Map(), NOW);
    expect(d.commands.map((c) => [c.text, c.live, c.failed])).toEqual([['old', true, false], ['ls', false, false], ['npm test', false, true], ['git status', true, false], ['npm run build', true, false]]);
    expect(d.agents[0].status.text).toBe('$ npm run build');
  });
});

describe('nested subagents', () => {
  it('a subagent started by another sits beside that parent and is linked to it', () => {
    const sub = (id: string, parent: string, startedAt: number): AgentInfo => ({ ...main, agentId: id, parentAgentId: parent, parentToolUseId: `t-${id}`, label: id, agentType: 'Explore', colorIdx: 0, startedAt, state: 'working' });
    const d = derive([], [main, sub('a', 'main', 10), sub('b', 'a', 20), sub('c', 'gone', 30)], new Map(), NOW);
    const at = (id: string) => d.agents.find((x) => x.a.agentId === id)!;
    expect(at('a').parentId).toBe('main');
    expect(at('b').parentId).toBe('a');
    expect(at('c').parentId).toBe('main'); // its parent isn't on show: it hangs off main
    expect(at('b').pos.x).toBeGreaterThan(at('a').pos.x);
    expect(at('b').pos.y).toBeGreaterThan(at('a').pos.y); // just above it
    expect(at('b').pos.y - at('a').pos.y).toBeLessThan(1);
    expect(d.slots.has('b')).toBe(false);
  });
});
