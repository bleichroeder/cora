import { describe, expect, it } from 'vitest';
import type { SessionInfo } from '@cora/shared';
import { heavyContext, nudgeNotice } from '../src/lib/contextNudge';

const S = (o: Partial<SessionInfo> = {}) => ({ id: 's1', cwd: 'C:/code/x', project: 'x', title: 'Old lead', state: 'idle', startedAt: 1, lastTs: 10, cliVersion: '', transcriptPath: '', needsYou: 0, ...o }) as SessionInfo;
const nudged = { at: 1_000_000, tokens: 461_000, over: 300_000 };

describe('a session nudged about its context', () => {
  it("its header chip: amber, what each turn rereads, while it's still past the threshold (a compact or handover brings it back)", () => {
    expect(heavyContext(S({ contextNudge: nudged }), 470_000, false)).toBe('each turn rereads ~470k');
    expect(heavyContext(S({ contextNudge: nudged }), 120_000, false)).toBeNull();
    expect(heavyContext(S({ contextNudge: nudged }), 470_000, true)).toBeNull();
    expect(heavyContext(S(), 470_000, false)).toBeNull();
  });

  it('its notice, once: the first time it is seen nudged (and lately), suggesting a handover or /compact', () => {
    const n = nudgeNotice(S({ contextNudge: nudged }), new Set(), 1_000_000 + 60_000);
    expect(n).toEqual({ title: 'Old lead: each turn rereads ~461k', detail: expect.stringMatching(/^Its context is past 300k\. A handover \(a fresh session given a summary of where it stands\) or \/compact would make each turn cheaper\.$/) });
    // told already, or long ago: nothing
    expect(nudgeNotice(S({ contextNudge: nudged }), new Set(['s1']), 1_000_000 + 60_000)).toBeNull();
    expect(nudgeNotice(S({ contextNudge: nudged }), new Set(), 1_000_000 + 11 * 60_000)).toBeNull();
    expect(nudgeNotice(S(), new Set(), 1_000_000)).toBeNull();
  });
});
