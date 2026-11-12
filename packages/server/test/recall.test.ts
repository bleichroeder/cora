import { describe, expect, it } from 'vitest';
import { isSentPrompt, recallPrompt } from '../src/recall';

const RULE = '─'.repeat(100);
const boxWith = (...rows: string[]) => ['❯ the prompt before', RULE, ...rows.map((r, i) => (i ? `  ${r}` : `❯ ${r}`)), RULE, '  ⏵⏵ auto mode on'];

/** A fake Claude Code input box: Ctrl+U empties the line the cursor is on (the last), Backspace joins it to the one before. */
function fakeBox(lines: string[]) {
  const keys: string[] = [];
  let rows = [...lines];
  return {
    keys,
    rows: () => rows,
    o: {
      screen: () => boxWith(...(rows.length ? rows : [''])),
      key: (d: string) => {
        keys.push(d === '\x15' ? 'ctrl-u' : d === '\x7f' ? 'backspace' : d);
        if (d === '\x15') rows[rows.length - 1] = '';
        else if (d === '\x7f' && rows.length > 1 && rows[rows.length - 1] === '') rows = rows.slice(0, -1);
      },
    },
  };
}

describe('recallPrompt (Esc just after a prompt went from the composer)', () => {
  it('a one-line prompt Claude Code put back is cleared from its box', async () => {
    const f = fakeBox(['reply with the single word pear']);
    expect(await recallPrompt(f.o, 'reply with the single word pear', 500, 10)).toBe('recalled');
    expect(f.keys).toEqual(['ctrl-u']);
    expect(f.rows()).toEqual(['']);
  });
  it('several lines: a Ctrl+U a line, a Backspace between', async () => {
    const f = fakeBox(['first line', 'second line', 'third line']);
    expect(await recallPrompt(f.o, 'first line\nsecond line\nthird line', 500, 10)).toBe('recalled');
    expect(f.keys).toEqual(['ctrl-u', 'backspace', 'ctrl-u', 'backspace', 'ctrl-u']);
    expect(f.rows()).toEqual(['']);
  });
  it("nothing typed when it didn't come back (the box is empty, or holds something else)", async () => {
    const empty = fakeBox(['']);
    expect(await recallPrompt(empty.o, 'fix the bug', 100, 10)).toBeNull();
    const other = fakeBox(['a draft of my own']);
    expect(await recallPrompt(other.o, 'fix the bug', 100, 10)).toBeNull();
    expect([...empty.keys, ...other.keys]).toEqual([]);
  });
  it('a long prompt Claude Code folded into a pasted-text token counts as the one sent', () => {
    expect(isSentPrompt('[Pasted text #1 +40 lines]', 'a very long log…')).toBe(true);
    expect(isSentPrompt('something else', 'a very long log…')).toBe(false);
  });
});
