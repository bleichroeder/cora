import { describe, expect, it } from 'vitest';
import { choiceOpen, highlightedOption, trustQuestion } from '@cora/shared';
import { answerTrust, deliverWhenReady } from '../src/orchestrator/deliver';

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

describe("a team seat's folder: its trust question answered yes (answerTrust)", () => {
  const io = (first: string[], cwd = 'C:\\work\\eng-1') => {
    let screen = first;
    const keys: string[] = [];
    return {
      keys,
      o: {
        screen: () => screen,
        alive: () => true,
        cwd: () => cwd,
        key: (k: string) => {
          keys.push(k);
          if (k === '\x1b[B') screen = trust(true);
          if (k === '\r') screen = ready;
        },
      },
    };
  };

  it('in its own folder (however the path is written): moved to "Yes" and confirmed, nothing typed', async () => {
    const x = io(trust());
    expect(await answerTrust(x.o, 'c:/work/eng-1/', 2000, 5)).toBe('answered');
    expect(x.keys).toEqual(['\x1b[B', '\r']);
  });

  it('in any other folder: never answered', async () => {
    const x = io(trust(), 'C:\\elsewhere');
    expect(await answerTrust(x.o, 'C:/work/eng-1', 2000, 5)).toBe('elsewhere');
    expect(x.keys).toEqual([]);
  });

  it('any other question is left alone; past its start (its box, or its mod said hello) it stops watching', async () => {
    const perm = ['', RULE, ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel', ''];
    const x = io(perm);
    expect(await answerTrust(x.o, 'C:/work/eng-1', 200, 5)).toBe('timeout');
    expect(x.keys).toEqual([]);
    const y = io(ready);
    expect(await answerTrust(y.o, 'C:/work/eng-1', 2000, 5)).toBe('none');
    const z = io([]);
    expect(await answerTrust({ ...z.o, past: () => true }, 'C:/work/eng-1', 2000, 5)).toBe('none');
    expect([...y.keys, ...z.keys]).toEqual([]);
  });

  it("an answer that doesn't take: six keys at most (each after the screen had its while to catch up), then it gives up", async () => {
    const x = io(trust());
    const t0 = Date.now();
    expect(await answerTrust({ ...x.o, key: (k) => void x.keys.push(k) }, 'C:/work/eng-1', 10_000, 5, 40)).toBe('stuck');
    expect(x.keys.length).toBe(6);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5 * 40);
  });

  it('a screen that lags behind the keys: one Down, then Enter once "Yes" shows; never Down again from a "No" already left', async () => {
    // the terminal moves at once (Down toggles between the two answers, wrapping); its mirror shows it a while later
    type At = 'no' | 'yes' | 'done';
    let real = 'no' as At;
    let shown = 'no' as At;
    let lagUntil = 0;
    const keys: string[] = [];
    const o = {
      screen: () => {
        if (Date.now() >= lagUntil) shown = real;
        return shown === 'done' ? ready : trust(shown === 'yes');
      },
      alive: () => true,
      cwd: () => 'C:/work/eng-1',
      key: (k: string) => {
        keys.push(k);
        if (k === '\x1b[B') real = real === 'no' ? 'yes' : 'no';
        // Enter picks what the terminal has highlighted (not what its mirror shows)
        if (k === '\r') real = real === 'yes' ? 'done' : real;
        // (longer than a fixed pause after a key: as under load)
        lagUntil = Date.now() + 400;
      },
    };
    expect(await answerTrust(o, 'C:/work/eng-1', 5_000, 10, 1_000)).toBe('answered');
    expect(keys).toEqual(['\x1b[B', '\r']);
    expect(real).toBe('done');
  });
});
