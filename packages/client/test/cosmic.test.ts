import { describe, expect, it } from 'vitest';
import { BANG_MS, COLLAPSE_MS, comeBack, cosmicNow, cosmicState } from '../src/scene/cosmic';

describe('black hole and big bang', () => {
  it('a collapse opens the hole before anything falls, swallows everything from the inside out, and leaves a remnant', () => {
    const at = (f: number) => cosmicState('collapse', f * COLLAPSE_MS);
    expect(at(0)).toMatchObject({ mass: 0, fallen: 0, matter: true, labels: 1 });
    // the hole is already bending light while nothing has moved yet
    expect(at(0.1).mass).toBeGreaterThan(0.1);
    expect(at(0.1).fallen).toBe(0);
    const fallen = [0.2, 0.4, 0.6, 0.8].map((f) => at(f).fallen);
    for (let i = 1; i < fallen.length; i++) expect(fallen[i]).toBeGreaterThan(fallen[i - 1]);
    // infall accelerates
    expect(fallen[3] - fallen[2]).toBeGreaterThan(fallen[1] - fallen[0]);
    expect(at(0.5).labels).toBe(0);
    expect(at(1)).toMatchObject({ matter: false, done: true });
    expect(at(1).mass).toBeGreaterThan(0.5);
  });

  it('a bang flashes, throws a shock ring, and gives everything back', () => {
    const at = (f: number) => cosmicState('bang', f * BANG_MS);
    expect(at(0.03).flash).toBeGreaterThan(0.8);
    expect(at(0.01).flash).toBeLessThan(at(0.03).flash);
    expect(at(0.5).bang).toBeGreaterThan(at(0.2).bang);
    expect(at(0.05).heat).toBeGreaterThan(0.9);
    expect(at(0.8).heat).toBe(0);
    expect(at(0.2).fallen).toBeGreaterThan(at(0.6).fallen);
    expect(at(1)).toMatchObject({ mass: 0, fallen: 0, labels: 1, done: true });
  });
});

describe('coming back mid-collapse', () => {
  it('unwinds from where the collapse got to instead of snapping to a bang', () => {
    const started = { kind: 'collapse' as const, at: 0 };
    const back = comeBack(started, 2500)!;
    expect(back.kind).toBe('unwind');
    expect(cosmicNow(back, 2500).fallen).toBeCloseTo(cosmicState('collapse', 2500).fallen);
    expect(cosmicNow(back, 2500).matter).toBe(true);
    expect(cosmicNow(back, 2500 + 2500 / 1.6 + 1).done).toBe(true);
    expect(comeBack(started, COLLAPSE_MS + 10)!.kind).toBe('bang');
    expect(comeBack(null, 5)!.kind).toBe('bang');
  });
});
