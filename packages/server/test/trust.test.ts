import { describe, expect, it } from 'vitest';
import { choiceOpen, highlightedOption, trustQuestion } from '@cora/shared';
import { deliverWhenReady } from '../src/orchestrator/deliver';

const RULE = '─'.repeat(100);
// Claude Code 2.1.281 in a new git repo, as the terminal host renders it: no option numbers, "No, exit" highlighted
const trust = (yes = false) => [
  '',
  RULE,
  ' Accessing workspace:',
  '',
  ' C:\code\cora-trial',
  '',
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  yes ? '   No, exit' : ' ❯ No, exit',
  yes ? ' ❯ Yes, I trust this folder' : '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
  '',
];
const ready = ['', ' ▐▛███▜▌ Claude Code', RULE, '❯ ', RULE, '  ? for shortcuts'];

describe('the "trust this folder?" question', () => {
  it('is a choice (nothing may be typed into it), even with no option numbers', () => {
    expect(choiceOpen(trust())).toBe(true);
    expect(trustQuestion(trust())).toBe(true);
    expect(highlightedOption(trust())).toBe('No, exit');
    expect(highlightedOption(trust(true))).toBe('Yes, I trust this folder');
    // the input box isn't a choice, even with a ❯ and a hint below
    expect(choiceOpen(ready)).toBe(false);
    expect(choiceOpen([RULE, '❯ Try "fix lint errors"', RULE, '  ⏵⏵ auto mode on · Esc to cancel'])).toBe(false);
  });

  it('allowed: Cora moves to "Yes" and confirms, then types the prompt; not allowed: it stops and says why', async () => {
    let screen = trust();
    const keys: string[] = [];
    const typed: string[] = [];
    const io = {
      screen: () => screen,
      alive: () => true,
      type: (t: string) => typed.push(t),
      key: (k: string) => {
        keys.push(k);
        if (k === '\x1b[B') screen = trust(true);
        if (k === '\r') screen = ready;
      },
    };
    expect(await deliverWhenReady(io, 'build standup', 5000, 5, { trust: true })).toEqual({ sent: true });
    expect(keys).toEqual(['\x1b[B', '\r']);
    expect(typed).toEqual(['build standup']);
    screen = trust();
    expect(await deliverWhenReady({ ...io, key: () => {} }, 'x', 1000, 5)).toEqual({ sent: false, why: expect.stringMatching(/trust the folder: the user has to answer/) });
  });
});
