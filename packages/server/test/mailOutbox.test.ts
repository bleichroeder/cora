import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MailOutbox } from '../src/mailOutbox';

const fakeDrafts = () => ({ sendDraft: vi.fn(async () => ({})), updateDraft: vi.fn(async () => {}), deleteDraft: vi.fn(async () => {}) });
const email = { sessionId: 's1', by: 'cora-dev', to: 'qa@example.com', subject: 'Build 2.4', body: 'It passed.', link: 'https://mail.google.com/mail/u/0/#drafts' };

describe('emails sessions ask to send', () => {
  it('waits for your Send; your changes go into the draft before it goes', async () => {
    const drafts = fakeDrafts();
    const changed = vi.fn();
    const box = new MailOutbox({ drafts, onChange: changed });
    const asked = box.ask(email, { draftId: 'd1', threadId: 't1', inReplyTo: '<m@x>' });
    const [m] = box.list();
    expect(m).toMatchObject({ to: 'qa@example.com', waiting: true });
    expect(drafts.sendDraft).not.toHaveBeenCalled();
    expect(await box.decide(m.id, { action: 'send', edit: { subject: 'Build 2.4 passed' } })).toEqual({ ok: true });
    expect(drafts.updateDraft).toHaveBeenCalledWith('d1', expect.objectContaining({ to: 'qa@example.com', subject: 'Build 2.4 passed', body: 'It passed.', threadId: 't1', inReplyTo: '<m@x>' }));
    expect(drafts.sendDraft).toHaveBeenCalledWith('d1');
    expect(await asked).toEqual({ action: 'sent', edited: true, to: 'qa@example.com', subject: 'Build 2.4 passed' });
    expect(box.list()).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });

  it('as written: sent without touching the draft; discarded: the draft goes; in Gmail: it stays', async () => {
    const drafts = fakeDrafts();
    const box = new MailOutbox({ drafts, onChange: () => {} });
    const a = box.ask(email, { draftId: 'd1' });
    expect(await box.decide(box.list()[0].id, { action: 'send', edit: {} })).toEqual({ ok: true });
    expect(drafts.updateDraft).not.toHaveBeenCalled();
    expect(await a).toMatchObject({ action: 'sent', edited: false });
    const b = box.ask(email, { draftId: 'd2' });
    await box.decide(box.list()[0].id, { action: 'discard' });
    expect(drafts.deleteDraft).toHaveBeenCalledWith('d2');
    expect(await b).toEqual({ action: 'discarded' });
    const c = box.ask(email, { draftId: 'd3' });
    await box.decide(box.list()[0].id, { action: 'gmail' });
    expect(await c).toEqual({ action: 'gmail' });
    expect(drafts.deleteDraft).toHaveBeenCalledTimes(1);
    // no one to send it to: not sent
    box.ask(email, { draftId: 'd4' });
    expect(await box.decide(box.list()[0].id, { action: 'send', edit: { to: ' ' } })).toEqual({ error: 'Who should it go to?' });
    expect(drafts.sendDraft).toHaveBeenCalledTimes(1);
  });

  it('the session stops waiting after a while (the email still waits for you), and it survives a restart', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cora-mail-')), 'mail-outbox.json');
    const box = new MailOutbox({ drafts: fakeDrafts(), onChange: () => {}, waitMs: 20, file });
    expect(await box.ask(email, { draftId: 'd1' })).toEqual({ action: 'waiting' });
    expect(box.list()[0]).toMatchObject({ waiting: false });
    const again = new MailOutbox({ drafts: fakeDrafts(), onChange: () => {}, file });
    expect(again.list()).toHaveLength(1);
  });
});
