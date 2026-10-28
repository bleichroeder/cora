import { useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { MailOutboxMsg, MailSend } from '@cora/shared';
import { useBrain } from '../state/store';
import { useWeb } from '../state/web';
import { mailProfile } from '../state/browser';
import { sessionName } from '../lib/format';
import { Icon } from './Icon';
import './tools.css';
import './popovers.css';

/** Emails sessions asked to send (shared/gmail MailSend), as the server says. */
export const useMailOutbox = create<{ drafts: MailSend[]; apply(m: MailOutboxMsg): void }>((set) => ({ drafts: [], apply: (m) => set({ drafts: m.drafts }) }));

async function decide(id: string, body: { action: 'send' | 'discard' | 'gmail'; edit?: Partial<Pick<MailSend, 'to' | 'cc' | 'subject' | 'body'>> }): Promise<string | null> {
  const r = await fetch(`/api/gmail/outbox/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return "Couldn't reach Cora";
  if (r.ok) return null;
  return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? `failed (${r.status})`;
}

/**
 * Emails sessions want sent, each waiting for you (with Slack's messages): change who it's to, the subject or what it
 * says, then send it, finish it in Gmail, or discard it. Nothing goes without your Send.
 */
export function MailOutbox() {
  const drafts = useMailOutbox((s) => s.drafts);
  if (!drafts.length) return null;
  return (
    <div className="slack-outbox mail-outbox" role="region" aria-label="Emails waiting for you">
      {drafts.map((d) => (
        <MailCard key={d.id} d={d} />
      ))}
    </div>
  );
}

function MailCard({ d }: { d: MailSend }) {
  const [to, setTo] = useState(d.to);
  const [cc, setCc] = useState(d.cc ?? '');
  const [subject, setSubject] = useState(d.subject);
  const [body, setBody] = useState(d.body);
  const [busy, setBusy] = useState<null | 'send' | 'gmail' | 'discard'>(null);
  const [err, setErr] = useState<string | null>(null);
  const session = useBrain((s) => (d.sessionId ? s.sessions[d.sessionId] : undefined));
  const ta = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [body]);
  const act = async (action: 'send' | 'gmail' | 'discard') => {
    if (busy) return;
    setErr(null);
    setBusy(action);
    const e = await decide(d.id, { action, ...(action === 'send' ? { edit: { to, cc, subject, body } } : {}) });
    setBusy(null);
    if (e) return setErr(e);
    // finishing it in Gmail: its draft, in the session's browser (signed in as your Gmail's profile)
    if (action === 'gmail' && d.sessionId) {
      const profile = mailProfile();
      useWeb.getState().open(d.sessionId, d.link, { reload: true, ...(profile ? { profile } : {}) });
      useWeb.getState().setShown(d.sessionId, true);
    }
  };
  return (
    <div className="sd-card">
      <div className="sd-h">
        <Icon name="Mail" size={13} className="sd-logo" />
        <b>Email</b>
        <span className="dim">
          from{' '}
          {session ? (
            <button className="linkish" onClick={() => useBrain.getState().setFocus(d.sessionId!)} title="Go to the session">
              {sessionName(session)}
            </button>
          ) : (
            d.by || 'a session'
          )}
        </span>
        <span className="spacer" />
        {!d.waiting ? <span className="sd-later" title="Claude carried on: it knows this email is waiting for you">waiting for you</span> : null}
      </div>
      <div className="mo-fields">
        <label>
          <span className="k">To</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} />
        </label>
        <label>
          <span className="k">Cc</span>
          <input value={cc} onChange={(e) => setCc(e.target.value)} spellCheck={false} placeholder="—" />
        </label>
        <label>
          <span className="k">Subject</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      <textarea
        ref={ta}
        className="sd-text"
        value={body}
        spellCheck
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) (e.preventDefault(), void act('send'));
        }}
      />
      {err ? (
        <div className="sd-err">
          <Icon name="TriangleAlert" size={12} /> {err}
        </div>
      ) : null}
      <div className="sd-actions">
        <button className="btn ghost" disabled={!!busy} onClick={() => void act('discard')} title="Don't send it (the draft goes too; the session is told)">
          Discard
        </button>
        <span className="spacer" />
        <button className="btn ghost" disabled={!!busy} onClick={() => void act('gmail')} title="Finish it in Gmail yourself (it stays in your Drafts)">
          <Icon name="ExternalLink" size={12} /> Open in Gmail
        </button>
        <button className="btn allow" disabled={!!busy || !to.trim() || !subject.trim() || !body.trim()} onClick={() => void act('send')} title="Send it from your Gmail (Ctrl+Enter)">
          <Icon name={busy === 'send' ? 'LoaderCircle' : 'Send'} size={12} /> {busy === 'send' ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
