import { describe, expect, it } from 'vitest';
import { sentenceAt, sentences, speakable } from '../src/lib/speakable';

describe('speakable', () => {
  it('skips code, mentions tables, shortens paths and strips formatting', () => {
    const md = [
      'Fixed in **`packages/client/src/scene/derive.ts`**, see [the docs](https://example.com/x).',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| a | b |',
      '| - | - |',
      '',
      '- the virtualizer cached heights',
      '- rows grew',
    ].join('\n');
    expect(speakable(md)).toBe("Fixed in derive.ts, see the docs. Code omitted. There's a table in the transcript. The virtualizer cached heights. Rows grew.");
  });

  it('caps at whole paragraphs with a pointer to the rest', () => {
    const md = 'First paragraph here.\n\nSecond paragraph is a bit longer.\n\nThird.';
    expect(speakable(md, 30)).toBe('First paragraph here. More in the transcript.');
    expect(speakable(md, 1000)).toBe('First paragraph here. Second paragraph is a bit longer. Third.');
  });

  it('keeps a lone over-long first paragraph rather than saying nothing', () => {
    expect(speakable('A'.repeat(50) + '.', 10)).toBe('A'.repeat(50) + '.');
  });
});

describe('sentences', () => {
  it('splits on sentence ends, and finds the one at a point in the reading', () => {
    const s = sentences('One two. Three four five! Six?');
    expect(s).toEqual(['One two.', 'Three four five!', 'Six?']);
    expect(sentenceAt(s, 0)).toBe(0);
    expect(sentenceAt(s, 0.5)).toBe(1);
    expect(sentenceAt(s, 1)).toBe(2);
  });
});
