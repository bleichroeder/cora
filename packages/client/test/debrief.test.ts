import { describe, expect, it } from 'vitest';
import type { Debrief } from '@cora/shared';
import { askProgress, debriefPlace, nav, replyOf } from '../src/lib/debrief';

const d: Debrief = {
  id: 'd1',
  sessionId: 's1',
  createdAt: 1,
  title: 'Port retry',
  task: 'Make it start.',
  depth: 'teach',
  steps: [
    { title: 'What was asked', kind: 'context', beats: [{ text: 'It stayed down.' }] },
    { title: 'The fix', kind: 'change', path: 'C:\\code\\cora\\server.ts', range: [615, 616], beats: [{ text: 'Retries.' }] },
  ],
  quiz: [{ q: 'Why retry?', options: ['speed', 'a held port'], answer: 1, why: 'Windows.' }],
  snaps: {},
};

describe('the debrief player', () => {
  it('steps through the steps, then the quiz', () => {
    expect(nav(d).steps).toHaveLength(3);
    expect(nav({ ...d, quiz: undefined }).steps).toHaveLength(2);
  });

  it('a question says where you are: the step, its file and lines', () => {
    expect(debriefPlace(d, { step: 1, beat: 0 })).toBe('2/3 · server.ts:615-616');
    expect(debriefPlace(d, { step: 0, beat: 0 })).toBe('1/3');
    expect(debriefPlace(d, { step: 2, beat: 0 })).toBe('quiz');
  });

  it("the answer: the session's words in the turn after the question, once it ends", () => {
    const asked = '[Debrief 2/3 · server.ts:615-616] why not a fixed delay?';
    const ev = (kind: string, ts: number, text?: string, agentId = 'main') => ({ kind, ts, text, agentId });
    const before = [ev('say', 90, 'old words'), ev('turn_end', 95)];
    expect(replyOf([...before, ev('prompt', 100, asked), ev('say', 110, 'Because')], asked, 100)).toBeNull();
    const done = [...before, ev('turn_end', 99), ev('prompt', 100, asked), ev('say', 110, 'A fixed delay <!-- say: x --> waits too long.'), ev('say', 115, 'sub', 'a1'), ev('say', 120, 'Retries stop early.'), ev('turn_end', 130), ev('say', 140, 'later')];
    expect(replyOf(done, asked, 100)).toBe('A fixed delay  waits too long.\n\nRetries stop early.');
  });

  it("an ask's progress: waiting its turn, being written, its turn over", () => {
    const ev = (kind: string, ts: number, text?: string) => ({ kind, ts, text, agentId: 'main' });
    const busy = [ev('prompt', 50, 'fix it'), ev('tool', 120)];
    expect(askProgress(busy, 100)).toBe('queued');
    const taken = [...busy, ev('turn_end', 130), ev('prompt', 140, 'Debrief me (quick) on your last piece of work'), ev('tool', 150)];
    expect(askProgress(taken, 100)).toBe('writing');
    expect(askProgress([...taken, ev('turn_end', 200)], 100)).toBe('ended');
  });
});
