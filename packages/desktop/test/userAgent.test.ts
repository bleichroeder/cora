import { describe, expect, it } from 'vitest';
import { chromeUserAgent } from '../src/userAgent';

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

describe('chromeUserAgent', () => {
  it("puts Chrome's version back where Electron 44 leaves it out, without the app's name", () => {
    expect(chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Cora/0.1.5 Safari/537.36', '152.0.7977.167')).toBe(CHROME);
  });
  it("takes out the app's and Electron's names from an older Electron's, and reduces Chrome's version as Chrome does", () => {
    expect(chromeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) @cora/desktop/0.1.5 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36', '152.0.7977.167')).toBe(CHROME);
  });
  it('leaves a plain Chrome user agent as it is', () => {
    expect(chromeUserAgent(CHROME, '152.0.7977.167')).toBe(CHROME);
  });
});
