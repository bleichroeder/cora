import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { hookTwin } from '../src/pipeline';

const p = (o: Partial<BrainEvent> & { id: string; ts: number }): BrainEvent => ({ seq: o.ts, sessionId: 's', agentId: 'main', kind: 'prompt', source: 'hook', text: 'how are we looking?', ...o }) as BrainEvent;

describe("a queued message's hook prompt (Claude Code fires the hook as you send it)", () => {
  it('is the hook prompt with its words, within seconds of the queueing', () => {
    const events = [p({ id: 'prompt:a', ts: 1000, text: 'merged' }), p({ id: 'prompt:b', ts: 60_000 })];
    expect(hookTwin(events, 'how are we looking?\n', 60_011)?.id).toBe('prompt:b');
  });
  it("isn't an earlier prompt with the same words, the queued message itself, or where Claude got it", () => {
    expect(hookTwin([p({ id: 'prompt:old', ts: 1000, text: 'yes' })], 'yes', 600_000)).toBeUndefined();
    expect(hookTwin([p({ id: 'queued:x:60011', ts: 60_011, source: 'transcript', queue: 'waiting' })], 'how are we looking?', 60_011)).toBeUndefined();
    expect(hookTwin([p({ id: 'prompt:mid:x', ts: 60_500, source: 'transcript', midTurn: true })], 'how are we looking?', 60_011)).toBeUndefined();
  });
});
