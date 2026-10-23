import { describe, expect, it } from 'vitest';
import { secChUa } from '../src/chromeIdentity';

describe('secChUa', () => {
  it("is Chrome's client-hints header: its brands with their versions", () => {
    expect(secChUa([{ brand: 'Google Chrome', version: '152' }, { brand: 'Chromium', version: '152' }, { brand: 'Not?A_Brand', version: '24' }])).toBe('"Google Chrome";v="152", "Chromium";v="152", "Not?A_Brand";v="24"');
  });
});
