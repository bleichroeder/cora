import { describe, expect, it } from 'vitest';
import type { BrainEvent } from '@cora/shared';
import { stillQueued } from '../src/lib/queued';

const ev = (x: Partial<BrainEvent>): BrainEvent => ({ id: Math.random().toString(36), sessionId: 's', agentId: 'main', source: 'transcript', kind: 'prompt', ts: 0, ...x }) as BrainEvent;

describe('stillQueued', () => {
  it('waiting since the turn last ended; one from before it was taken, whatever its transcript says', () => {
    const old = ev({ queue: 'waiting', text: 'node scripts/package.mjs --publish', ts: 100 });
    const now = ev({ queue: 'waiting', text: 'also add a test', ts: 300 });
    const events = [old, ev({ kind: 'turn_end', ts: 200 }), ev({ queue: 'delivered', ts: 250 }), now];
    expect(stillQueued(events)).toEqual([now]);
    expect(stillQueued([old])).toEqual([old]);
    expect(stillQueued([old, ev({ kind: 'turn_end', agentId: 'a1', ts: 200 })])).toEqual([old]);
  });
});
