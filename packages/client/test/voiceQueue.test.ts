import { describe, expect, it } from 'vitest';
import { MERGE_CAP, QUEUE_MAX, enqueueLine, nextUp, type Line } from '../src/lib/voiceQueue';

const line = (id: string, p: Partial<Line> = {}): Line => ({ id, text: `${id} said.`, at: 0, voice: '', short: true, keepMs: 90_000, ...p });

describe('what waits to be said', () => {
  it('waits its turn: not twice, a newer one of its group replaces the older, the oldest go past the cap', () => {
    let q: Line[] = [];
    q = enqueueLine(q, line('a'));
    q = enqueueLine(q, line('a'));
    expect(q.map((x) => x.id)).toEqual(['a']);
    expect(enqueueLine(q, line('b'), 'b')).toBe(q);
    q = enqueueLine(q, line('s1', { group: 'sum:x' }));
    q = enqueueLine(q, line('s2', { group: 'sum:x' }));
    expect(q.map((x) => x.id)).toEqual(['a', 's2']);
    for (let i = 0; i < 20; i++) q = enqueueLine(q, line(`n${i}`));
    expect(q).toHaveLength(QUEUE_MAX);
    expect(q.at(-1)!.id).toBe('n19');
  });

  it('short announcements waiting together are said as one, in the same voice, under the cap; long lines alone', () => {
    const q = [line('a', { text: 'Pipeline passed' }), line('b', { text: 'Tests are done.' }), line('c', { voice: 'cora' }), line('d')];
    const { line: first, rest } = nextUp(q, 0);
    expect(first!.text).toBe('Pipeline passed. Tests are done.');
    expect(rest.map((x) => x.id)).toEqual(['c', 'd']);
    const long = [line('r', { short: false, text: 'A long reply.' }), line('x')];
    expect(nextUp(long, 0).line!.id).toBe('r');
    const big = [line('a', { text: 'x'.repeat(MERGE_CAP - 4) }), line('b')];
    expect(nextUp(big, 0).line!.text).toBe('x'.repeat(MERGE_CAP - 4));
  });

  it('anything left unsaid too long is dropped, not said late', () => {
    const q = [line('old', { at: 0 }), line('new', { at: 80_000 })];
    expect(nextUp(q, 100_000).line!.id).toBe('new');
    expect(nextUp([], 0)).toEqual({ line: null, rest: [] });
  });
});
