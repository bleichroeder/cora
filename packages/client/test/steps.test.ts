import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { buildSteps, isYourCommand } from '../src/lib/steps';

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

  it("after main's turn ends, a background agent's work folds into one row per stretch, so the reply isn't buried", () => {
    const steps = buildSteps([
      tool('main', 'tA', 'Agent'),
      E({ kind: 'spawn', toolUseId: 'tA', text: 'Retake screenshots' }),
      tool('main', 'tA', 'Agent', 'end'), // returns at once: it runs in the background
      E({ kind: 'prompt', agentId: 'a1', text: 'Retake them' }),
      tool('a1', 'r1'),
      E({ kind: 'say', agentId: 'a1', text: 'Two left' }),
      tool('a1', 'r2', 'Bash'),
      E({ kind: 'say', text: 'Still waiting on the retakes.' }),
      E({ kind: 'turn_end' }),
      tool('a1', 'r3', 'Grep'),
      E({ kind: 'say', agentId: 'a1', text: 'One left' }),
      tool('a1', 'r4', 'Bash'),
      tool('a1', 'r2', 'Bash', 'end'),
      E({ kind: 'report', agentId: 'a1', text: 'All seven retaken' }),
      E({ kind: 'prompt', text: 'thanks' }),
      tool('a1', 'r5'),
    ], 'all', new Map([['tA', 'a1']]));
    const label = (s: (typeof steps)[number]) => (s.fold ? `fold:${s.agentId}:${s.items.map((i) => i.kind).join('+')}` : s.prompt ?? s.text ?? s.items[0]?.kind);
    // while main works: inline, as before; after its turn: one folded row; the report as usual; main busy again: inline
    expect(steps.map(label)).toEqual(['spawn', 'Retake them', 'Two left', 'Still waiting on the retakes.', 'fold:a1:tool+note+tool', 'report', 'thanks', 'tool']);
    const r2 = steps[2].items[0];
    expect(r2.kind === 'tool' && r2.end).toBeTruthy(); // its end still lands on its row
    // on its own tab, everything as usual
    expect(buildSteps([tool('main', 'tA', 'Agent'), tool('main', 'tA', 'Agent', 'end'), E({ kind: 'turn_end' }), tool('a1', 'r1')], 'a1', new Map([['tA', 'a1']]))[0].fold).toBeUndefined();
  });

  it("a foreground agent stays inline; a background agent's helpers fold with it", () => {
    const fg = buildSteps([tool('main', 'tF', 'Agent'), E({ kind: 'turn_end' }), tool('a2', 'x1'), tool('main', 'tF', 'Agent', 'end')], 'all', new Map([['tF', 'a2']]));
    expect(fg.some((s) => s.fold)).toBe(false);
    const bg = buildSteps([
      tool('main', 'tA', 'Agent'), tool('main', 'tA', 'Agent', 'end'),
      E({ kind: 'say', text: 'reply' }), E({ kind: 'turn_end' }),
      tool('a1', 'tH', 'Agent'), E({ kind: 'spawn', agentId: 'a1', toolUseId: 'tH', text: 'helper' }),
      tool('a3', 'h1'), tool('a1', 'z1'), tool('a3', 'h2'),
    ], 'all', new Map([['tA', 'a1'], ['tH', 'a3']]));
    expect(bg.map((s) => (s.fold ? `fold:${s.agentId}:${s.items.length}` : s.text))).toEqual(['reply', 'fold:a1:2', 'fold:a3:2']);
  });

  it('a message sent while Claude works: the queue entry never shows here; taken mid-turn, a prompt marked so', () => {
    const steps = buildSteps([
      E({ kind: 'prompt', text: 'pick more profiles' }),
      tool('main', 't1'),
      E({ kind: 'prompt', id: 'queued:abc', text: 'add a home button', queue: 'delivered' }),
      tool('main', 't2'),
      E({ kind: 'prompt', text: 'add a home button', midTurn: true }),
      tool('main', 't3'),
    ], 'all');
    expect(steps.map((s) => [s.prompt, !!s.mid])).toEqual([['pick more profiles', false], ['add a home button', true]]);
  });
});

describe('a command you ran yourself (!)', () => {
  const yours = (id: string, phase: 'start' | 'end', extra: Partial<BrainEvent> = {}) =>
    E({ kind: 'tool', phase, toolUseId: `bang:${id}`, tool: { name: 'Bash', input: { command: 'ls' }, summary: 'ls', byYou: true }, icon: { name: 'SquareTerminal', family: 'run' }, ...extra });
  it("is a step of its own, not inside Claude's reply; what Claude does next starts another", () => {
    const steps = buildSteps([E({ kind: 'say', text: 'Done.' }), E({ kind: 'turn_end' }), yours('u1', 'start'), yours('u1', 'end'), tool('main', 't9')], 'all');
    expect(steps).toHaveLength(3);
    expect(steps[0].items.map((i) => i.kind)).toEqual(['turn_end']);
    expect(steps[1]).toMatchObject({ ran: true });
    expect(steps[1].items).toHaveLength(1);
    const it0 = steps[1].items[0];
    expect(it0.kind === 'tool' && it0.start && it0.end).toBeTruthy();
    expect(steps[2].ran).toBeUndefined();
    expect(steps[2].items.map((i) => (i.kind === 'tool' ? i.start?.toolUseId : i.kind))).toEqual(['t9']);
  });
  it('one recorded before it was marked yours is known by its id', () => {
    const old = E({ kind: 'tool', phase: 'start', toolUseId: 'bang:u0', tool: { name: 'Bash', input: { command: 'ls', description: 'You ran it (! in the terminal)' }, summary: 'ls' } });
    expect(isYourCommand(old)).toBe(true);
    expect(isYourCommand(tool('main', 't1', 'Bash'))).toBe(false);
    expect(buildSteps([old], 'all')[0]).toMatchObject({ ran: true });
  });
});
