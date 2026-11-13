import { describe, expect, it } from 'vitest';
import { journalItems } from '../src/lib/journalDoc';

const FILE = [
  '# Onboard Cora',
  '',
  '- **Started:** Nov 11, 7:38 PM',
  '',
  '## Nov 11, 7:48 PM',
  '',
  'Mapped the architecture. Decided:',
  '- Jira key is a label.',
  '',
  'Refs: decision · explain "How it works" · [artifact](https://example.test/a)',
  '',
  '## Nov 12, 9:00 AM · Recap',
  '',
  'Worked on the composer.',
  '',
  '## Nov 12, 10:47 PM · Wrap-up',
  '',
  'All merged.',
  '',
  'Refs: done · !412',
  '',
  '## Nov 13, 8:00 AM',
  '',
].join('\n');

describe("a session's journal file, as the Journal tab's entries", () => {
  const items = journalItems(FILE);
  it('one per heading that has words: its day, its time, its words without the Refs line', () => {
    expect(items.map((i) => [i.day, i.time])).toEqual([['Nov 11', '7:48 PM'], ['Nov 12', '9:00 AM'], ['Nov 12', '10:47 PM']]);
    expect(items[0].body).toBe(['Mapped the architecture. Decided:', '- Jira key is a label.'].join('\n'));
  });
  it('its kind: from its Refs line, or the wrap-up or recap its heading says; the rest of the Refs are what it points at', () => {
    expect(items.map((i) => i.kind)).toEqual(['decision', 'recap', 'wrapup']);
    expect(items[0].refs).toEqual(['explain "How it works"', '[artifact](https://example.test/a)']);
    expect(items[1].refs).toEqual([]);
    expect(items[2].refs).toEqual(['!412']);
  });
});
