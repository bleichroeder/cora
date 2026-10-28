import { describe, expect, it } from 'vitest';
import { listenRetry } from '../src/server';

const err = (code: string) => Object.assign(new Error(code), { code });

describe('listening when the port is briefly not ours', () => {
  it('tries again on EACCES / EADDRINUSE until it gets it; anything else (or too long) fails', async () => {
    let n = 0;
    await listenRetry(async () => {
      if (++n < 3) throw err(n === 1 ? 'EACCES' : 'EADDRINUSE');
    }, { waitMs: () => 1 });
    expect(n).toBe(3);
    await expect(listenRetry(async () => { throw err('EPERM'); }, { waitMs: () => 1 })).rejects.toThrow('EPERM');
    let m = 0;
    await expect(listenRetry(async () => { m++; throw err('EACCES'); }, { tries: 4, waitMs: () => 1 })).rejects.toThrow('EACCES');
    expect(m).toBe(4);
  });
});
