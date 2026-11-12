import { choiceOpen, highlightedOption, inputBox, trustQuestion } from '@cora/shared';

/**
 * Is Claude Code ready for a prompt: its input box on screen (shared `inputBox`), and no choice open (a permission
 * prompt, the "trust this folder?" question)?
 */
export function promptReady(lines: string[]): boolean {
  return !choiceOpen(lines) && inputBox(lines) != null;
}

/** Two folders the same, however they're written (slashes, a trailing one, case: Windows paths). */
export const sameFolder = (a: string, b: string) => {
  const n = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) === n(b);
};

/** How long a new terminal is watched for the "trust this folder?" question (it comes in its first seconds, or never). */
export const TRUST_WATCH_MS = 3 * 60_000;

/**
 * A session Cora started in a folder the user chose (a team seat's): its "trust this folder?" question answered yes,
 * and nothing else. Watched from its start until it's past the question (its input box on screen, or `past`: its mod
 * said hello), it ends, or `timeoutMs`. Answered only while its terminal's own folder (`cwd`) is `folder`; any other
 * question or screen is left alone. Never types words: only moves to "Yes" and confirms (six keys at most). Each key
 * is decided from a screen that has caught up with the one before it: after a key, nothing more is sent until the
 * highlighted answer moves (or the question goes), or `settleMs` passes (the key was lost). A screen that lags behind
 * the keys would otherwise send Down again from a "No" already left, and an Enter could land on "No, exit".
 * 'answered': it asked and was told yes; 'none': it never asked; 'elsewhere': it asked in another folder (left for the
 * user); 'stuck': answering didn't take; 'ended': it exited first; 'timeout': still not past it.
 */
export async function answerTrust(
  o: { screen(): string[] | null; alive(): boolean; cwd(): string | null | undefined; key(data: string): void; past?(): boolean },
  folder: string,
  timeoutMs = TRUST_WATCH_MS,
  stepMs = 500,
  settleMs = 3_000,
): Promise<'answered' | 'none' | 'elsewhere' | 'stuck' | 'ended' | 'timeout'> {
  const until = Date.now() + timeoutMs;
  let keys = 0;
  /** the last key: the answer highlighted when it went, and when */
  let sent: { from: string | null; at: number } | null = null;
  while (Date.now() < until) {
    if (!o.alive()) return keys ? 'answered' : 'ended';
    const lines = o.screen();
    if (lines && trustQuestion(lines)) {
      const cwd = o.cwd();
      if (!cwd || !sameFolder(cwd, folder)) return 'elsewhere';
      const on = highlightedOption(lines);
      // the screen hasn't caught up with the last key yet: wait for it
      if (sent && on === sent.from && Date.now() - sent.at < settleMs) {
        await new Promise((r) => setTimeout(r, stepMs));
        continue;
      }
      if (keys >= 6) return 'stuck';
      keys += 1;
      sent = { from: on, at: Date.now() };
      o.key(/^Yes/i.test(on ?? '') ? '\r' : '\x1b[B');
      await new Promise((r) => setTimeout(r, stepMs));
      continue;
    }
    // it asked, and the question has gone: answered
    if (keys) return 'answered';
    if ((lines && promptReady(lines)) || o.past?.()) return 'none';
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return 'timeout';
}

/** Once a session has said it started (its hooks, its mod), how long it gets to draw its box before it's taken as ready. */
export const STARTED_SETTLE_MS = 15_000;
/** How long before a slow start is said (once). */
export const SLOW_AFTER_MS = 60_000;

const inWords = (ms: number) => (ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : ms >= 60_000 ? 'a minute' : `${Math.round(ms / 1000)} seconds`);

/**
 * Wait for a terminal's Claude Code to be ready, then type the text in and send it. Ready: its input box on screen
 * twice in a row, or (`started`) it has said it started and, a moment later, shows no question. Slow (a minute):
 * `onSlow`, once. Gives up after `timeoutMs`, saying why (it's asking something first, or never got going).
 */
export async function deliverWhenReady(
  o: { screen(): string[] | null; type(text: string): void; alive(): boolean; key?(data: string): void; /** it has said it started (a hook, its mod) */ started?(): boolean; /** still not ready after a minute */ onSlow?(): void },
  text: string,
  timeoutMs = 60_000,
  stepMs = 500,
  opts: { trust?: boolean } = {},
): Promise<{ sent: boolean; why?: string }> {
  const t0 = Date.now();
  const until = t0 + timeoutMs;
  let stable = 0;
  let keys = 0;
  let startedAt: number | null = null;
  let toldSlow = false;
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
    // it said it started, a moment ago, and asks nothing: ready, however its screen reads
    if (startedAt === null && o.started?.()) startedAt = Date.now();
    if (startedAt !== null && Date.now() - startedAt >= STARTED_SETTLE_MS && !(lines && choiceOpen(lines))) {
      o.type(text);
      return { sent: true };
    }
    if (!toldSlow && Date.now() - t0 >= SLOW_AFTER_MS) {
      toldSlow = true;
      o.onSlow?.();
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  const lines = o.screen();
  return { sent: false, why: lines && choiceOpen(lines) ? "it's asking a question in its terminal first (maybe whether to trust the folder)" : `it wasn't ready for a prompt within ${inWords(timeoutMs)}` };
}
