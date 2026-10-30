import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import type { Approval, JiraEvent } from '@cora/shared';
import { writeFileAtomic } from '../fsx';

/**
 * What the orchestrator wants to do that needs your OK (start a session, type into one, end one), held as cards in
 * the dashboard. Each carries the action itself: your OK runs it (with your changes to its text) and the agent hears
 * what happened. The agent waits for your answer a while, then carries on knowing it's waiting; the card stays, and an
 * OK given later still runs it.
 */

export type ApprovalOutcome = { ok: true; result: string; edited: boolean } | { ok: false; why: 'denied' | 'waiting' | 'failed'; error?: string };

/**
 * The action: given the (possibly changed) text, do it and say what happened. Throws to say it failed. `late`: the
 * agent stopped waiting. `cwd`: the folder you picked from its `folders` (a start on a Jira ticket).
 */
export type ApprovalRun = (text: string | undefined, late: boolean, cwd?: string) => Promise<string>;

/**
 * What a card does, in words that outlast a restart (its `run` doesn't): rebuilt from this when Cora starts again, so a
 * card from before still works (docs/audit-2026-10-20.md U3). A card without one can't be kept.
 */
export type Redo =
  | { do: 'start'; cwd: string; model?: string; /** the project it goes in (its id) */ project?: string }
  | { do: 'send'; sessionId: string }
  | { do: 'end'; sessionId: string }
  | { do: 'ask'; question: string }
  | { do: 'jira'; event: JiraEvent; cwd: string }
  | { do: 'issue'; project: string; iid: number; title: string; who: string; url: string; cwd: string }
  | { do: 'mail'; sessionId?: string; cwd?: string }
  | { do: 'project'; sessionId: string; projectId: string | null };
export type RedoRun = (r: Redo, text: string | undefined, cwd: string | undefined) => Promise<string>;

type Held = { a: Approval; run: ApprovalRun; answer: (o: ApprovalOutcome) => void; answered: boolean; redo?: Redo };

/** The agent's tool call gives up after a minute, so it waits less than that; a later OK still runs (and it's told). */
export const APPROVAL_WAIT_MS = 45_000;

export class Approvals {
  private held = new Map<string, Held>();
  private redoRun: RedoRun | null = null;

  constructor(private o: { onChange: () => void; waitMs?: number; onLate?: (a: Approval, result: string) => void; /** it asked you (Cora's Inbox) */ onAsk?: (a: Approval) => void; /** you answered */ onAnswer?: (a: Approval, ok: boolean, result?: string) => void; /** where cards are kept across a restart */ file?: string; /** cards from before a restart that couldn't be kept */ onLost?: (a: Approval[]) => void }) {
    if (!o.file || !existsSync(o.file)) return;
    const lost: Approval[] = [];
    try {
      for (const k of JSON.parse(readFileSync(o.file, 'utf8')) as Array<{ a: Approval; redo?: Redo }>) {
        if (!k?.a?.id) continue;
        const redo = k.redo;
        if (!redo) {
          lost.push(k.a);
          continue;
        }
        // nobody waits on it now: an OK does it again from what was kept, and the agent hears (onLate)
        this.held.set(k.a.id, { a: { ...k.a, waiting: false }, redo, answered: true, answer: () => {}, run: (t, _late, cwd) => this.again(redo, t, cwd) });
      }
    } catch {
      /* none kept */
    }
    if (lost.length) queueMicrotask(() => o.onLost?.(lost));
    this.save();
  }

  /** How kept cards do their thing (set once the rest of Cora is up). */
  setRedo(fn: RedoRun): void {
    this.redoRun = fn;
  }
  private again(r: Redo, text: string | undefined, cwd: string | undefined): Promise<string> {
    if (!this.redoRun) return Promise.reject(new Error('Cora is still starting: try again in a moment'));
    return this.redoRun(r, text, cwd);
  }

  private save(): void {
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify([...this.held.values()].map((h) => ({ a: h.a, ...(h.redo ? { redo: h.redo } : {}) }))));
    } catch {
      /* kept for this run */
    }
  }
  private changed(): void {
    this.save();
    this.o.onChange();
  }

  list(): Approval[] {
    return [...this.held.values()].map((h) => h.a).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** `redo`: what it does, in words that outlast a restart (without it, a restart loses the card). */
  request(a: Omit<Approval, 'id' | 'createdAt' | 'waiting'>, run: ApprovalRun, redo?: Redo): Promise<ApprovalOutcome> {
    const approval: Approval = { ...a, id: randomUUID(), createdAt: Date.now(), waiting: true };
    return new Promise((resolve) => {
      const h: Held = { a: approval, run, answered: false, answer: (out) => !h.answered && ((h.answered = true), resolve(out)), ...(redo ? { redo } : {}) };
      this.held.set(approval.id, h);
      this.o.onAsk?.(approval);
      setTimeout(() => {
        if (h.answered || !this.held.has(approval.id)) return;
        h.a = { ...h.a, waiting: false };
        h.answer({ ok: false, why: 'waiting' });
        this.changed();
      }, this.o.waitMs ?? APPROVAL_WAIT_MS);
      this.changed();
    });
  }

  /** Your answer: an OK runs the action (with your text); a failure keeps the card so you can try again or say no. */
  async decide(id: string, d: { ok: boolean; text?: string; cwd?: string }): Promise<{ ok: boolean; error?: string; result?: string }> {
    const h = this.held.get(id);
    if (!h) return { ok: false, error: 'not found (already answered)' };
    if (d.ok && d.cwd !== undefined && !h.a.folders?.some((f) => f.cwd === d.cwd)) return { ok: false, error: 'not one of its folders' };
    if (!d.ok) {
      this.held.delete(id);
      this.o.onAnswer?.(h.a, false);
      h.answer({ ok: false, why: 'denied' });
      this.changed();
      return { ok: true };
    }
    const text = d.text !== undefined ? d.text : h.a.text;
    try {
      const late = h.answered;
      const result = await h.run(text, late, d.cwd);
      this.held.delete(id);
      this.o.onAnswer?.(h.a, true, result);
      h.answer({ ok: true, result, edited: text !== h.a.text });
      if (late) this.o.onLate?.(h.a, result);
      this.changed();
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** The agent went away (turned off, started over): its cards go too. */
  clear(): void {
    for (const h of this.held.values()) h.answer({ ok: false, why: 'denied' });
    this.held.clear();
    this.changed();
  }
}
