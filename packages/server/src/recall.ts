import { inputBoxText } from '@cora/shared';
import { samePrompt } from './promptLanded';

/** How long after a prompt is sent from the composer Esc may take it back (Claude Code may not be "working" yet). */
export const RECALL_WINDOW_MS = 10_000;
/** How long Claude Code gets to put a cancelled prompt back in its input box. */
export const RECALL_WAIT_MS = 1_500;

const CTRL_U = '\x15';
const BACKSPACE = '\x7f';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is what's in the box the prompt that was sent (or a long one Claude Code folded into "[Pasted text #1 +40 lines]")? */
export const isSentPrompt = (box: string, sent: string) => samePrompt(box, sent) || /^\[Pasted text #\d+[^\]]*\]$/.test(box.trim());

/**
 * Esc right after a prompt went from the composer: Claude Code cancels the turn and puts the prompt back in its input
 * box, which the composer hides (and the next prompt would be typed after it, the two sent as one). Waits for it there,
 * clears it (Ctrl+U clears the line the cursor is on, Backspace joins it to the line before: one Ctrl+U per line), and
 * says whether it did, so the composer can put it back in its own box. Null: it didn't come back (the turn was too far
 * along, or the box shows something else), and nothing was typed.
 */
export async function recallPrompt(
  o: { screen(): string[] | null; key(data: string): void },
  sent: string,
  waitMs = RECALL_WAIT_MS,
  stepMs = 100,
): Promise<'recalled' | null> {
  const until = Date.now() + waitMs;
  let box: string | null = null;
  while (Date.now() < until) {
    box = inputBoxText(o.screen() ?? []);
    if (box && isSentPrompt(box, sent)) break;
    box = null;
    await sleep(stepMs);
  }
  if (box == null) return null;
  const lines = /^\[Pasted text #/.test(box.trim()) ? 1 : sent.split('\n').length;
  for (let i = 0; i < lines; i++) {
    if (i) {
      o.key(BACKSPACE);
      await sleep(stepMs / 2);
    }
    o.key(CTRL_U);
    await sleep(stepMs / 2);
  }
  return 'recalled';
}
