import { describe, expect, it } from 'vitest';
import type { AgentInfo, BrainEvent } from '@cora/shared';
import { agentsAt, replayAt, stepAt, statesAt } from '../src/lib/replay';
import { buildSteps } from '../src/lib/steps';
import { derive } from '../src/scene/derive';

const T = 2_000_000;
const base = { seq: 1, sessionId: 's', icon: { name: 'x', family: 'look' as const }, source: 'transcript' as const };
const ev = (id: string, agentId: string, ts: number, extra: Partial<BrainEvent>): BrainEvent => ({ ...base, id, agentId, ts, kind: 'say', ...extra });
const call = (id: string, agentId: string, ts: number, phase: 'start' | 'end'): BrainEvent =>
  ev(`${id}:${phase}`, agentId, ts, { kind: 'tool', phase, toolUseId: id, tool: { name: 'Read', input: { file_path: '/a/x.ts' }, summary: 'x.ts', resource: 'files:a' } });
const agent = (agentId: string, startedAt: number, endedAt: number | null, state: AgentInfo['state']): AgentInfo => ({
  sessionId: 's', agentId, parentAgentId: agentId === 'main' ? null : 'main', parentToolUseId: null, label: agentId, agentType: 'x', colorIdx: 0, startedAt, endedAt, state,
});

// main gets a prompt, reads a file, spawns sub1 which works and reports; main's turn ends; later sub2 is born
const events: BrainEvent[] = [
  ev('p', 'main', T, { kind: 'prompt', text: 'go' }),
  call('m1', 'main', T + 1000, 'start'),
  call('m1', 'main', T + 2000, 'end'),
  ev('s1p', 'sub1', T + 3000, { kind: 'prompt', text: 'task' }),
  call('s1', 'sub1', T + 4000, 'start'),
  call('s1', 'sub1', T + 5000, 'end'),
  ev('s1r', 'sub1', T + 6000, { kind: 'report', text: 'done' }),
  ev('say', 'main', T + 7000, { kind: 'say', text: 'all done' }),
  ev('te', 'main', T + 8000, { kind: 'turn_end' }),
  ev('s2p', 'sub2', T + 20_000, { kind: 'prompt', text: 'later' }),
];
const agents = [agent('main', T, null, 'idle'), agent('sub1', T + 3000, T + 6000, 'done'), agent('sub2', T + 20_000, null, 'thinking')];

describe('statesAt', () => {
  it('replays working / thinking / idle / done as the server decides them', () => {
    const at = (t: number) => Object.fromEntries([...statesAt(events, T + t)].map(([k, v]) => [k, v.state]));
    expect(at(500)).toEqual({ main: 'thinking' });
    expect(at(1500)).toEqual({ main: 'working' });
    expect(at(4500)).toEqual({ main: 'thinking', sub1: 'working' });
    expect(at(6500)).toEqual({ main: 'thinking', sub1: 'done' });
    expect(at(9000)).toEqual({ main: 'idle', sub1: 'done' });
  });
  it('a done subagent stays done; an interrupt stops everyone else', () => {
    const more = [...events.slice(0, 7), call('late', 'sub1', T + 6500, 'start'), call('m2', 'main', T + 6600, 'start'), ev('int', 'main', T + 6700, { kind: 'interrupt' })];
    const s = statesAt(more, T + 6800);
    expect(s.get('sub1')).toEqual({ state: 'done', endedAt: T + 6000 });
    expect(s.get('main')?.state).toBe('idle');
  });
  it('a long silence is idle, not thinking', () => {
    expect(statesAt(events.slice(0, 1), T + 11 * 60_000).get('main')?.state).toBe('idle');
  });
});

describe('agentsAt', () => {
  it('leaves out agents not yet started, shows ended ones as done, the rest from the events', () => {
    const at = (t: number) => agentsAt(agents, events, T + t).map((a) => [a.agentId, a.state, a.endedAt]);
    expect(at(1500)).toEqual([['main', 'working', null]]);
    expect(at(4500)).toEqual([['main', 'thinking', null], ['sub1', 'working', null]]);
    expect(at(7000)).toEqual([['main', 'thinking', null], ['sub1', 'done', T + 6000]]);
    expect(at(30_000)).toEqual([['main', 'idle', null], ['sub1', 'done', T + 6000], ['sub2', 'thinking', null]]);
  });
  it('a turn ended by the Stop hook alone (no event): idle before your next prompt, and as it is now after the last event', () => {
    const noEnd = events.filter((e) => e.kind !== 'turn_end');
    const later = [...noEnd.slice(0, 8), ev('p2', 'main', T + 15_000, { kind: 'prompt', text: 'again' }), call('m3', 'main', T + 16_000, 'start')];
    const main = (evs: BrainEvent[], t: number, live: AgentInfo['state']) => agentsAt([agent('main', T, null, live)], evs, T + t)[0].state;
    expect(main(later, 10_000, 'working')).toBe('idle');
    expect(main(later, 15_500, 'working')).toBe('thinking');
    expect(main(noEnd.slice(0, 8), 10_000, 'idle')).toBe('idle');
  });
  it('moves its times by the shift', () => {
    const [, sub1] = agentsAt(agents, events, T + 7000, 100);
    expect([sub1.startedAt, sub1.endedAt]).toEqual([T + 3100, T + 6100]);
  });
});

describe('replayAt', () => {
  it('keeps the events up to the moment, shifted, and remembers its answer', () => {
    const r = replayAt(events, agents, T + 4500, 1000);
    expect(r.events.map((e) => e.id)).toEqual(['p', 'm1:start', 'm1:end', 's1p', 's1:start']);
    expect(r.events[0].ts).toBe(T + 1000);
    expect(events[0].ts).toBe(T); // the originals are untouched
    expect(replayAt(events, agents, T + 4500, 1000)).toBe(r);
    expect(replayAt(events, agents, T + 4600, 1000)).not.toBe(r);
  });
  it('fed to derive, the scene shows that moment: who was there and what was in flight', () => {
    // played back as if the moment were now: the shift brings it to the wall clock
    const now = T + 100_000;
    const at = T + 4500;
    const r = replayAt(events, agents, at, now - at);
    const d = derive(r.events, r.agents, new Map(), now);
    expect(d.agents.map((a) => [a.a.agentId, a.status.text])).toEqual([['main', 'waiting on subagents'], ['sub1', 'Read → a/']]);
    expect(d.comets.map((c) => [c.key, c.endedAt])).toEqual([['s1', null], ['m1', T + 2000 + (now - at)]]);
    // live, sub1 is long gone and sub2 is thinking
    const live = derive(events, agents, new Map(), now);
    expect(live.agents.map((a) => a.a.agentId)).toEqual(['main', 'sub2']);
  });
});

describe('stepAt', () => {
  const steps = buildSteps(events, 'all');
  const keyOf = (i: number) => steps[i]?.key;
  it('finds the step holding the event or call it was put on', () => {
    expect(keyOf(stepAt(steps, { ts: 0, toolUseId: 's1' }))).toBe('s1p#step');
    expect(keyOf(stepAt(steps, { ts: 0, eventId: 'say' }))).toBe('say#step');
    expect(keyOf(stepAt(steps, { ts: 0, eventId: 'te' }))).toBe('say#step');
  });
  it('else the last step begun by then', () => {
    expect(keyOf(stepAt(steps, { ts: T + 2500 }))).toBe('p#step');
    expect(keyOf(stepAt(steps, { ts: T + 7500 }))).toBe('say#step');
    expect(keyOf(stepAt(steps, { ts: T - 5 }))).toBe('p#step');
    expect(stepAt([], { ts: T })).toBe(-1);
  });
});
