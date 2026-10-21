import { describe, expect, it } from 'vitest';
import { GL_TRIES, GL_WINDOW_MS, glNext, restartGl, useGl } from '../src/components/GlGuard';

describe('the 3D view recovering', () => {
  it('rebuilds after a failure, but stops after several in a short while (and waits for you)', () => {
    const now = 1_000_000;
    expect(glNext([now], now)).toBe('retry');
    expect(glNext([now - 1000, now], now)).toBe('retry');
    expect(glNext(Array.from({ length: GL_TRIES }, (_, i) => now - i * 1000), now)).toBe('stop');
    // old failures don't count
    expect(glNext([now - GL_WINDOW_MS - 1, now - GL_WINDOW_MS - 2, now], now)).toBe('retry');
  });
  it('a restart by hand rebuilds every 3D view, and is noted', () => {
    const before = useGl.getState().epoch;
    restartGl();
    expect(useGl.getState().epoch).toBe(before + 1);
    expect(useGl.getState().events.at(-1)).toMatchObject({ view: 'all', why: 'you restarted it' });
  });
});
