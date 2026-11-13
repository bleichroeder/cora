import { describe, expect, it } from 'vitest';
import { claudeMode, headlessScreen, suggestionFrom } from '../src/screen';
import { takeBackQueued } from '../src/recall';
import { inputBoxText } from '@cora/shared';

const RULE = '─'.repeat(60);

describe("Claude Code's suggested next prompt (the dimmed text in its input box)", () => {
  const screenWith = async (box: string) => {
    const s = headlessScreen(60, 6);
    s.write(`done\r\n${RULE}\r\n${box}\r\n${RULE}\r\n  ⏵⏵ auto mode on (shift+tab to cycle)`);
    await new Promise((r) => setTimeout(r, 50));
    const dim = s.dimInput!();
    s.dispose();
    return dim;
  };
  it('is read when the box holds only dimmed text', async () => {
    expect(suggestionFrom(await screenWith('❯ \x1b[2mrun the tests again\x1b[22m'))).toBe('run the tests again');
  });
  it("isn't a draft (normal text), an empty box, or the placeholder's examples", async () => {
    expect(await screenWith('❯ my own draft')).toBeNull();
    expect(suggestionFrom(await screenWith('❯ '))).toBeNull();
    expect(suggestionFrom(await screenWith('❯ \x1b[2mTry "fix lint errors"\x1b[22m'))).toBeNull();
  });
  it('loses the key hint it may end with', () => {
    expect(suggestionFrom('commit this (tab to accept)')).toBe('commit this');
  });
});

describe("Claude Code's permission mode, from the bar under its input box", () => {
  const screen = (bar: string) => ['some output', RULE, '❯ ', RULE, bar];
  it('says the mode on the bar, the default when the bar names none, nothing when no box is on screen', () => {
    expect(claudeMode(screen('  ⏵⏵ auto mode on (shift+tab to cycle)'))).toBe('auto');
    expect(claudeMode(screen('  ⏸ plan mode on (shift+tab to cycle)'))).toBe('plan');
    expect(claudeMode(screen('  ⏵⏵ accept edits on (shift+tab to cycle)'))).toBe('acceptEdits');
    expect(claudeMode(screen('  ? for shortcuts'))).toBe('default');
    expect(claudeMode(['Do you want to proceed?', '❯ 1. Yes', '  2. No'])).toBeNull();
  });
});

describe('taking back messages you queued', () => {
  /** A fake input box: Up fills it with `onUp`; Ctrl+U empties the last line, Backspace joins it to the one before. */
  const fake = (onUp: string[]) => {
    let rows = [''];
    const keys: string[] = [];
    return {
      keys,
      rows: () => rows,
      o: {
        screen: () => ['❯ before', RULE, ...rows.map((r, i) => (i ? `  ${r}` : `❯ ${r}`)), RULE, '  ⏵⏵ auto mode on'],
        key: (d: string) => {
          keys.push(d === '\x1b[A' ? 'up' : d === '\x15' ? 'ctrl-u' : d === '\x7f' ? 'backspace' : d);
          if (d === '\x1b[A') rows = [...onUp];
          else if (d === '\x15') rows[rows.length - 1] = '';
          else if (d === '\x7f' && rows.length > 1 && rows[rows.length - 1] === '') rows = rows.slice(0, -1);
        },
      },
    };
  };
  it('Up brings them into the box; they are cleared from it and given back', async () => {
    const f = fake(['also check staging', 'and the logs']);
    expect(await takeBackQueued(f.o, ['also check staging', 'and the logs'], 500, 10)).toBe('also check staging\n\nand the logs');
    expect(f.keys).toEqual(['up', 'ctrl-u', 'backspace', 'ctrl-u']);
    expect(f.rows()).toEqual(['']);
  });
  it('an older prompt that came instead (nothing was queued any more) is cleared, and nothing is given back', async () => {
    const f = fake(['an old prompt from history']);
    expect(await takeBackQueued(f.o, ['also check staging'], 500, 10)).toBeNull();
    expect(f.rows()).toEqual(['']);
  });
  it("Claude Code's own dimmed hint in the box doesn't count as something written there", async () => {
    const f = fake(['also check staging']);
    let hint = true;
    const o = {
      screen: () => (hint ? ['x', RULE, '❯ Press up to edit queued messages', RULE, ''] : f.o.screen()),
      key: (d: string) => ((hint = false), f.o.key(d)),
      dim: () => (hint ? 'Press up to edit queued messages' : null),
    };
    expect(await takeBackQueued(o, ['also check staging'], 500, 10)).toBe('also check staging');
  });
  it('nothing is pressed when the box already holds something', async () => {
    const f = fake(['x']);
    f.o.key('\x1b[A');
    f.keys.length = 0;
    expect(await takeBackQueued(f.o, ['also check staging'], 100, 10)).toBeNull();
    expect(f.keys).toEqual([]);
  });
});

describe("the input box under a rule that carries the session's name", () => {
  it('is still the input box', () => {
    const top = `${'─'.repeat(50)} cora-99c0 ─`;
    const lines = ['✽ Skedaddling… (46s)', '', top, '> Press up to edit queued messages', RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'];
    expect(inputBoxText(lines)).toBe('Press up to edit queued messages');
    expect(claudeMode(lines)).toBe('auto');
  });
});
