import { describe, expect, it } from 'vitest';
import { useBrain } from '../src/state/store';

/** An automatic focus move (a session went away) shows nothing new: what the next session had for you stays unseen. */
describe('setFocus with stay', () => {
  const start = () =>
    useBrain.setState({ focus: 's1', projectOpen: 'p1', overview: false, unseen: { s2: 3 }, toasts: [{ id: 't1', sessionId: 's2', text: 'needs you', ts: 1 }] });

  it('moves the focus behind the project, keeping its unseen mark and toasts', () => {
    start();
    useBrain.getState().setFocus('s2', { stay: true });
    const s = useBrain.getState();
    expect(s.focus).toBe('s2');
    expect(s.projectOpen).toBe('p1');
    expect(s.unseen).toEqual({ s2: 3 });
    expect(s.toasts.map((t) => t.id)).toEqual(['t1']);
  });
  it('a click shows it: the project closes, and its unseen mark and toasts are seen', () => {
    start();
    useBrain.getState().setFocus('s2');
    const s = useBrain.getState();
    expect(s.projectOpen).toBeNull();
    expect(s.unseen).toEqual({});
    expect(s.toasts).toEqual([]);
  });
});
