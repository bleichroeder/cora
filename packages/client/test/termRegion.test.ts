import { describe, expect, it } from 'vitest';
import { activeRegion } from '../src/lib/termRegion';

const RULE = '─'.repeat(60);

describe('activeRegion', () => {
  it('idle prompt: from the input box top rule down to the status line', () => {
    const lines = ['old output', 'more output', '', RULE, '❯ ', RULE, '  ⏵⏵ auto mode on', '', ''];
    expect(activeRegion(lines)).toEqual({ start: 3, end: 6 });
  });

  it('slash menu below the input grows the region', () => {
    const lines = ['output', RULE, '❯ /re', RULE, '  /resume   Resume a conversation', '  /review   Review a PR', '  /release-notes'];
    expect(activeRegion(lines)).toEqual({ start: 1, end: 6 });
  });

  it('fresh session near the top of the screen (blank rows below)', () => {
    const lines = [' ▐▛███▜▌ Claude Code', '', RULE, '❯ ', RULE, '  ? for shortcuts', '', '', '', '', '', ''];
    expect(activeRegion(lines)).toEqual({ start: 2, end: 5 });
  });

  it('no rules (dialog, splash): shows the last 8 non-empty rows worth', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    expect(activeRegion(lines)).toEqual({ start: 12, end: 19 });
  });

  it('blank screen', () => {
    expect(activeRegion(['', '', ''])).toEqual({ start: 0, end: 0 });
  });
});
