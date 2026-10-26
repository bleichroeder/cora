import { existsSync, readFileSync } from 'node:fs';
import type { MailSend } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** What the user did with an email a session asked to send. */
export type MailOutcome = { action: 'sent' | 'discarded' | 'gmail' | 'waiting'; edited?: boolean; to?: string; subject?: string; error?: string };

/** What sending needs: the draft in Gmail, and how to send, change or delete it. */
export type MailDrafts = {
  sendDraft(id: string): Promise<unknown>;
  updateDraft(id: string, d: { to: string; cc?: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string }): Promise<unknown>;
  deleteDraft(id: string): Promise<unknown>;
};

/** Where it is in Gmail (kept with it, never shown): the draft, and its thread when it's a reply. */
type Behind = { draftId: string; threadId?: string; inReplyTo?: string; references?: string };
type Held = { m: MailSend; behind: Behind; answer: (o: MailOutcome) => void; answered: boolean };

/** How long a session waits for your answer before it's told the email waits in Cora (it still does). */
export const MAIL_WAIT_MS = 10 * 60_000;

/**
 * Emails sessions want sent, each a draft in your Gmail until you answer: send it (as written, or as you changed it),
 * finish it in Gmail yourself, or discard it (the draft goes too). Nothing is sent without your click. The session
 * waits a while for the answer, then carries on knowing the email waits for you.
 */
export class MailOutbox {
  private held = new Map<string, Held>();

  constructor(private o: { drafts: MailDrafts; onChange: () => void; waitMs?: number; /** kept across a restart */ file?: string }) {
    try {
      if (o.file && existsSync(o.file))
        for (const h of JSON.parse(readFileSync(o.file, 'utf8')) as Array<{ m: MailSend; behind: Behind }>)
          if (h?.m?.id && h.behind?.draftId) this.held.set(h.m.id, { m: { ...h.m, waiting: false }, behind: h.behind, answered: true, answer: () => {} });
    } catch {
      /* none kept */
    }
  }

  list(): MailSend[] {
    return [...this.held.values()].map((h) => h.m).sort((a, b) => a.at - b.at);
  }

  private changed(): void {
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify([...this.held.values()].map(({ m, behind }) => ({ m, behind }))));
    } catch {
      /* kept for this run */
    }
    this.o.onChange();
  }

  /** A session asks for this email (already a draft in Gmail) to be sent: it waits for you. */
  ask(m: Omit<MailSend, 'id' | 'at' | 'waiting'>, behind: Behind): Promise<MailOutcome> {
    const id = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    return new Promise((resolve) => {
      const h: Held = { m: { ...m, id, at: Date.now(), waiting: true }, behind, answered: false, answer: (o) => (h.answered ? undefined : ((h.answered = true), resolve(o))) };
      this.held.set(id, h);
      this.changed();
      setTimeout(() => {
        if (h.answered) return;
        h.m = { ...h.m, waiting: false };
        h.answer({ action: 'waiting' });
        this.changed();
      }, this.o.waitMs ?? MAIL_WAIT_MS);
    });
  }

  /** Your answer: send (with your changes, if any), you'll finish it in Gmail, or discard it. */
  async decide(id: string, a: { action: 'send' | 'discard' | 'gmail'; edit?: { to?: string; cc?: string; subject?: string; body?: string } }): Promise<{ ok: true } | { error: string }> {
    const h = this.held.get(id);
    if (!h) return { error: 'no such email' };
    try {
      if (a.action === 'send') {
        const e = a.edit ?? {};
        const next = { to: (e.to ?? h.m.to).trim(), cc: (e.cc ?? h.m.cc ?? '').trim(), subject: (e.subject ?? h.m.subject).trim(), body: e.body ?? h.m.body };
        if (!next.to) return { error: 'Who should it go to?' };
        if (!next.subject) return { error: 'It needs a subject.' };
        const edited = next.to !== h.m.to || next.cc !== (h.m.cc ?? '') || next.subject !== h.m.subject || next.body !== h.m.body;
        if (edited) await this.o.drafts.updateDraft(h.behind.draftId, { ...next, ...(next.cc ? {} : { cc: undefined }), threadId: h.behind.threadId, inReplyTo: h.behind.inReplyTo, references: h.behind.references });
        await this.o.drafts.sendDraft(h.behind.draftId);
        this.held.delete(id);
        h.answer({ action: 'sent', edited, to: next.to, subject: next.subject });
      } else if (a.action === 'discard') {
        await this.o.drafts.deleteDraft(h.behind.draftId).catch(() => undefined);
        this.held.delete(id);
        h.answer({ action: 'discarded' });
      } else {
        // you'll finish it in Gmail: it stays a draft there
        this.held.delete(id);
        h.answer({ action: 'gmail' });
      }
      this.changed();
      return { ok: true };
    } catch (err) {
      return { error: (err as Error).message };
    }
  }
}
