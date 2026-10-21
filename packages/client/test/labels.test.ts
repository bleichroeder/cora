import { describe, expect, it } from 'vitest';

describe('tapeRows (the shell tape keeps to a few rows)', () => {
  it('shows running commands first, then the newest finished, and counts what it hides', async () => {
    const { tapeRows } = await import('../src/scene/tape');
    const c = (id: number, live = false) => ({ id, live });
    const few = [c(1), c(2, true)];
    expect(tapeRows(few, false)).toEqual({ shown: few, hidden: 0, hiddenRunning: 0 });
    const many = [c(1), c(2), c(3, true), c(4), c(5), c(6), c(7), c(8, true)];
    const t = tapeRows(many, false);
    expect(t.shown.map((x) => x.id)).toEqual([3, 5, 6, 7, 8]);
    expect(t).toMatchObject({ hidden: 3, hiddenRunning: 0 });
    const busy = Array.from({ length: 8 }, (_, i) => c(i, true));
    expect(tapeRows(busy, false)).toMatchObject({ hidden: 3, hiddenRunning: 3 });
    expect(tapeRows(busy, false).shown.map((x) => x.id)).toEqual([3, 4, 5, 6, 7]);
    expect(tapeRows(many, true).shown).toHaveLength(8);
  });
});
