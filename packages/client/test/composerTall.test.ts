import { describe, expect, it } from 'vitest';
import { composerTall } from '../src/lib/composer';

/** The composer's one-line / tall layout, decided without measuring the box on every keystroke (holding Delete was slow). */
describe('composerTall', () => {
  const L = 20;
  it('goes tall past three lines, and stays tall in between (no flip-flop)', () => {
    expect(composerTall(L * 2, L, false, false)).toBe(false);
    expect(composerTall(L * 4, L, false, false)).toBe(true);
    expect(composerTall(L * 2, L, true, false)).toBe(true);
  });
  it('back to one line, or emptied: short again', () => {
    expect(composerTall(L + 4, L, true, false)).toBe(false);
    expect(composerTall(L * 5, L, true, true)).toBe(false);
  });
});
