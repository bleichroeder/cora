/**
 * Did a prompt Cora typed into a session's terminal reach it? Typing it in isn't enough: a terminal that looks ready
 * (its input box drawn) while Claude Code is still starting, or a key lost on the way, takes the keys and no prompt
 * comes of them. Claude Code says a prompt came with its UserPromptSubmit hook: that's what counts. The log keeps each
 * session's last few, with when they came; `landed` waits a while for one that matches what was typed. Anything Cora
 * types and must know arrived (a seat's first prompt, Cora's agent's first prompt to a session it starts) asks here.
 */

/** A prompt as Claude Code received it, against what was typed: the same words, however they're spaced (and a zero-width mark Cora puts before a leading `/`, `!` or `#` gone). */
export function samePrompt(received: string, typed: string): boolean {
  const n = (s: string) => s.replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  const a = n(received);
  const b = n(typed);
  if (!a || !b) return false;
  // what's typed can carry more than what's heard (a hook's context added), or be cut: the start of the shorter one
  const k = Math.min(a.length, b.length, 120);
  return a.slice(0, k) === b.slice(0, k);
}

const KEEP = 8;

export class PromptLog {
  private seen = new Map<string, Array<{ at: number; text: string }>>();
  private waiters = new Set<() => void>();
  /** a prompt has come by its hook (any session's): prompts come back, so a missing one means something */
  private any = false;
  private untrackedSaid = false;
  /**
   * `hooksSet`: Cora's hooks are in Claude Code's settings (the setup check). Without them, and none heard yet, no prompt
   * ever comes back: what's typed in counts as in (`landed` says so at once), or nothing would ever be.
   */
  constructor(
    private now: () => number = Date.now,
    private o: { hooksSet?: () => boolean; log?: (m: string) => void } = {},
  ) {}

  /** Can a prompt be seen to land (hooks heard from, or set up)? */
  tracks(): boolean {
    return this.any || !!this.o.hooksSet?.();
  }

  /** A session's prompt came (its UserPromptSubmit hook). */
  heard(sid: string, text: string, at = this.now()): void {
    this.any = true;
    const list = [...(this.seen.get(sid) ?? []), { at, text }].slice(-KEEP);
    this.seen.set(sid, list);
    for (const w of [...this.waiters]) w();
  }

  /** Has a prompt matching `text` come for this session since `since`? */
  since(sid: string, since: number, text: string): boolean {
    return (this.seen.get(sid) ?? []).some((x) => x.at >= since && samePrompt(x.text, text));
  }

  /** Waits up to `timeoutMs` for a prompt matching `text` since `since`: whether it came. */
  landed(sid: string, since: number, text: string, timeoutMs: number): Promise<boolean> {
    if (this.since(sid, since, text)) return Promise.resolve(true);
    if (!this.tracks()) {
      if (!this.untrackedSaid) this.o.log?.("prompts: none has come back (Cora's hooks aren't in Claude Code?), so a typed prompt can't be seen to land: typed in counts as in");
      this.untrackedSaid = true;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(t);
        this.waiters.delete(check);
        resolve(ok);
      };
      const check = () => this.since(sid, since, text) && done(true);
      const t = setTimeout(() => done(this.since(sid, since, text)), timeoutMs);
      (t as { unref?: () => void }).unref?.();
      this.waiters.add(check);
    });
  }

  /** A session gone: its prompts forgotten. */
  forget(sid: string): void {
    this.seen.delete(sid);
  }
}
