import { describe, expect, it } from 'vitest';
import { textChange } from '../src/index';

const long = (mid: string) => `Read the queue first. ${'Pick the oldest item and work it to the end. '.repeat(3)}${mid} Report to the lead when done.`;

describe('textChange: what changed in a long text', () => {
  it('without context words: the part that differs, as before', () => {
    expect(textChange(long('Hand it to Review.'), long('Hand it to Test.'), 40)).toBe('… "Review." → "Test." …');
  });

  it('with context words: a few on each side, so the same words twice can be told apart', () => {
    // "the lead" appears twice; only the second changes
    const a = `Tell the lead you started. ${'Work through the list in order. '.repeat(3)}Tell the lead when you finish.`;
    const b = a.replace('Tell the lead when', 'Tell the user when');
    expect(textChange(a, b, 40)).toBe('… "lead" → "user" …');
    expect(textChange(a, b, 40, 3)).toBe('… "order. Tell the lead when you finish." → "order. Tell the user when you finish."');
    // in the middle: "…" on both sides
    expect(textChange(long('Hand it to Review.'), long('Hand it to Test.'), 40, 2)).toBe('… "it to Review. Report to" → "it to Test. Report to" …');
  });

  it('with context words: an addition or a removal says where', () => {
    const a = long('');
    const b = `${a} Then close it.`;
    expect(textChange(a, b, 40, 3)).toBe('added "Then close it." after "lead when done."');
    expect(textChange(b, a, 40, 3)).toBe('removed "Then close it." after "lead when done."');
    expect(textChange(a, `First, coffee. ${a}`, 40, 3)).toBe('added "First, coffee." before "Read the queue"');
  });

  it('short texts, or the full view: both whole, context or not', () => {
    expect(textChange('Be enc.', 'Fix the encoders.', 80, 4)).toBe('"Be enc." → "Fix the encoders."');
    expect(textChange(long('a'), long('b'), Infinity, 4)).toBe(`"${long('a')}" → "${long('b')}"`);
  });
});
