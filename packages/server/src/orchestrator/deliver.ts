import { choiceOpen, highlightedOption, trustQuestion } from '@cora/shared';

const RULE = /^[─━]{8,}$/;

/**
 * Is Claude Code ready for a prompt: its input box (the line under the second-to-last full-width rule, starting
 * with ❯ or >) on screen, and no choice open (a permission prompt, the "trust this folder?" question)?
 */
export function promptReady(lines: string[]): boolean {
  if (choiceOpen(lines)) return false;
  const rules: number[] = [];
  lines.forEach((l, i) => RULE.test(l.trim()) && rules.push(i));
  if (rules.length < 2) return false;
  const input = lines[rules[rules.length - 2] + 1] ?? '';
  return /^\s*[❯>]/u.test(input);
}

/**
 * Wait for a terminal's Claude Code to be ready, then type the text in and send it. Gives up after `timeoutMs`,
 * saying why (it's asking something first, or never got going).
 */
export async function deliverWhenReady(
  o: { screen(): string[] | null; type(text: string): void; alive(): boolean; key?(data: string): void },
  text: string,
  timeoutMs = 60_000,
  stepMs = 500,
  opts: { trust?: boolean } = {},
): Promise<{ sent: boolean; why?: string }> {
  const until = Date.now() + timeoutMs;
  let stable = 0;
  let keys = 0;
  while (Date.now() < until) {
    if (!o.alive()) return { sent: false, why: 'it exited before it was ready' };
    const lines = o.screen();
    // a new folder: "do you trust it?" (its highlighted answer is "No, exit"). Yes, when the user allowed it
    if (lines && trustQuestion(lines)) {
      stable = 0;
      if (!opts.trust || !o.key) return { sent: false, why: "it's asking whether to trust the folder: the user has to answer that in its terminal" };
      if (keys >= 6) return { sent: false, why: "it's asking whether to trust the folder, and answering it didn't work" };
      keys += 1;
      o.key(/^Yes/i.test(highlightedOption(lines) ?? '') ? '\r' : '\x1b[B');
      await new Promise((r) => setTimeout(r, Math.max(stepMs, 300)));
      continue;
    }
    // ready twice in a row: its first screen settles in a moment
    stable = lines && promptReady(lines) ? stable + 1 : 0;
    if (stable >= 2) {
      o.type(text);
      return { sent: true };
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  const lines = o.screen();
  return { sent: false, why: lines && choiceOpen(lines) ? "it's asking a question in its terminal first (maybe whether to trust the folder)" : "it wasn't ready for a prompt within a minute" };
}
