import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cora/shared';
import { switchOrder, touch } from '../src/lib/switcher';

const mk = (id: string, state: SessionInfo['state'], lastTs: number, over: Partial<SessionInfo> = {}): SessionInfo => ({ id, cwd: '', project: '', title: '', state, startedAt: 1, lastTs, cliVersion: '', transcriptPath: '', needsYou: 0, ...over });

describe('the session switcher', () => {
  it('lists live sessions, the ones you were in most recently first, then the rest by activity', () => {
    const list = [mk('a', 'working', 10), mk('b', 'idle', 50), mk('c', 'needs-you', 30), mk('d', 'ended', 99), mk('e', 'idle', 70, { dismissedAt: 80 })];
    expect(switchOrder(list, ['c', 'a']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
    expect(switchOrder(list, []).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });
  it('remembers where you were, newest first, once each', () => {
    expect(touch(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(touch(['a', 'b'], 'z', 2)).toEqual(['z', 'a']);
  });
});
