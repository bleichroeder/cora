import { describe, expect, it } from 'vitest';
import { classify, lowMemory } from '../src/ci';

describe('the PC low on memory (glab or kubectl failing to start)', () => {
  it('is told apart from GitLab or the cluster failing, and said plainly', () => {
    expect(lowMemory({ stderr: 'fatal error: out of memory allocating heap arena map' })).toBe(true);
    expect(lowMemory({ message: 'spawn UNKNOWN' })).toBe(true);
    expect(lowMemory({ stderr: 'runtime: cannot allocate memory' })).toBe(true);
    expect(lowMemory({ stderr: 'dial tcp: i/o timeout' })).toBe(false);
    expect(classify({ stderr: 'fatal error: runtime: cannot allocate memory' }).message).toMatch(/low on memory/);
    expect(classify({ stderr: 'dial tcp: no such host' }).kind).toBe('offline');
  });
});
