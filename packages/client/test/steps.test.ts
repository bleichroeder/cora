import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { buildSteps } from '../src/lib/steps';

let seq = 0;
const E = (o: Partial<BrainEvent> & Pick<BrainEvent, 'kind'>): BrainEvent => ({
  id: `e${++seq}`, seq, sessionId: 's', agentId: 'main', ts: seq * 10, icon: { name: 'X', family: 'look' }, source: 'transcript', ...o,
});
const tool = (agentId: string, id: string, name = 'Read', phase: 'start' | 'end' = 'start', extra: Partial<BrainEvent> = {}) =>
  E({ kind: 'tool', phase, agentId, toolUseId: id, tool: { name, input: {}, summary: id }, icon: { name: 'FileText', family: 'look' }, ...extra });

describe('buildSteps', () => {
  it('narration opens a step; tool start/end pair into one item', () => {
    const steps = buildSteps([E({ kind: 'say', text: 'Let me look' }), tool('main', 't1'), tool('main', 't1', 'Read', 'end'), E({ kind: 'think', durationMs: 900 })], 'all');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ agentId: 'main', text: 'Let me look', cont: false });
    expect(steps[0].items.map((i) => i.kind)).toEqual(['tool', 'think']);
    const t = steps[0].items[0];
    expect(t.kind === 'tool' && t.start && t.end).toBeTruthy();
    expect(steps[0].fingerprint).toEqual([{ name: 'FileText', family: 'look' }]);
  });

  it('prompts open a step of their own', () => {
    const steps = buildSteps([E({ kind: 'prompt', text: 'Fix the build' }), tool('main', 't1')], 'all');
    expect(steps[0]).toMatchObject({ prompt: 'Fix the build' });
    expect(steps[0].items).toHaveLength(1);
  });

  it('Agent tool calls render as spawn cards, not tool rows', () => {
    const steps = buildSteps([
      E({ kind: 'say', text: 'Fanning out' }),
      tool('main', 'tA', 'Agent'),
      E({ kind: 'spawn', toolUseId: 'tA', text: 'Verify hooks' }),
      tool('main', 'tA', 'Agent', 'end'),
    ], 'all', new Map([['tA', 'a1']]));
    expect(steps[0].items).toEqual([expect.objectContaining({ kind: 'spawn', childAgentId: 'a1' })]);
  });

  it('interleaved agents produce continuation steps in "all" view', () => {
    const steps = buildSteps([
      E({ kind: 'say', text: 'main says' }),
      E({ kind: 'say', agentId: 'a1', text: 'sub says' }),
      tool('main', 't1'),
      tool('a1', 't2'),
    ], 'all');
    expect(steps.map((s) => [s.agentId, s.cont])).toEqual([['main', false], ['a1', false], ['main', true], ['a1', true]]);
  });

  it('tool end updates its item in place even if the step is no longer last', () => {
    const steps = buildSteps([tool('main', 't1'), E({ kind: 'say', agentId: 'a1', text: 'hi' }), tool('main', 't1', 'Read', 'end')], 'all');
    expect(steps).toHaveLength(2);
    const it0 = steps[0].items[0];
    expect(it0.kind === 'tool' && it0.end).toBeTruthy();
  });

  it('agent filter keeps only that agent, without continuations', () => {
    const evs = [E({ kind: 'say', text: 'm' }), E({ kind: 'say', agentId: 'a1', text: 's' }), tool('main', 't1'), tool('a1', 't2'), tool('a1', 't3')];
    const steps = buildSteps(evs, 'a1');
    expect(steps.map((s) => [s.agentId, s.cont, s.items.length])).toEqual([['a1', false, 2]]);
  });

  it('reports attach to the child agent; turn ends are dividers', () => {
    const steps = buildSteps([E({ kind: 'report', agentId: 'a1', text: 'found it' }), E({ kind: 'turn_end' })], 'all');
    expect(steps[0].items[0]).toMatchObject({ kind: 'report' });
    expect(steps[1].items[0]).toMatchObject({ kind: 'turn_end' });
  });

  it('interrupts are markers in the current step, not prompts', () => {
    const steps = buildSteps([E({ kind: 'say', text: 'Working on it' }), tool('main', 't9'), E({ kind: 'interrupt', text: '[Request interrupted by user]' })], 'all');
    expect(steps).toHaveLength(1);
    expect(steps[0].items.map((i) => i.kind)).toEqual(['tool', 'interrupt']);
    expect(steps[0].prompt).toBeUndefined();
  });

  it('hook and transcript duplicates are already merged upstream; order is by ts then seq', () => {
    const a = E({ kind: 'say', text: 'second', ts: 50 });
    const b = E({ kind: 'say', text: 'first', ts: 40 });
    expect(buildSteps([a, b], 'all').map((s) => s.text)).toEqual(['first', 'second']);
  });
});
