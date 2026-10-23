import { describe, expect, it } from 'vitest';
import { fitGrid } from '../src/lib/fitGrid';

const o = { gap: 10, min: 120, max: 300, aspect: 10 / 16, extra: 53 };

describe('fitGrid', () => {
  it('uses the fewest columns (the biggest cards) that fit every card', () => {
    // 4 cards in 800 x 600: 2 columns of ~385 is over max, so 3 (2 rows of ~253 x 211) fit
    expect(fitGrid(4, 800, 600, o)).toBe(3);
  });
  it('never makes a card wider than max, even with one card', () => {
    expect(fitGrid(1, 1200, 900, o)).toBe(4);
  });
  it('adds columns until they fit in a short panel', () => {
    // 6 cards, 900 x 260: one row of 6 (~138 wide, ~139 tall) is what fits
    expect(fitGrid(6, 900, 260, o)).toBe(6);
  });
  it('falls back to the smallest cards (and scrolls) when nothing fits', () => {
    expect(fitGrid(40, 500, 200, o)).toBe(3);
  });
  it('one column in a narrow panel', () => {
    expect(fitGrid(3, 150, 200, o)).toBe(1);
  });
});
