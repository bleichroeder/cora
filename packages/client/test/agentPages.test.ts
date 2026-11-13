import { afterEach, describe, expect, it, vi } from 'vitest';
import { aboveOf } from '../src/components/AgentPages';

const pane = (zIndex: string) => ({ zIndex }) as unknown as Element;

describe("a session's Playwright page over its spot", () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sits just above the pane showing it: the usual browser, the widened one (else hidden under it: a white page)', () => {
    vi.stubGlobal('getComputedStyle', (el: { zIndex: string }) => ({ zIndex: el.zIndex }));
    expect(aboveOf(pane('20'))).toBe('21');
    expect(aboveOf(pane('29'))).toBe('30');
    // a pane with no level of its own (a Board panel's browser), or none at all: the usual level
    expect(aboveOf(pane('auto'))).toBe('21');
    expect(aboveOf(null)).toBe('21');
  });
});
