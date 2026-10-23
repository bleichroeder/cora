import { useState } from 'react';
import type { Approval, JiraStarted } from '@cora/shared';
import { alertTitle, didWhat, dismissAlert, dismissStarted, openJiraEvent, startedToShow, useJiraWatch, type JiraAlert } from '../state/jiraWatch';
import { decideApproval, useOrch } from '../state/orchestrator';
import { useBrain } from '../state/store';
import { Icon } from './Icon';
import { BrandIcon } from './BrandIcon';
import { showInbox } from '../state/inbox';

const baseOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
const NONE: JiraStarted[] = [];

/** The one-line detail of an event: what was said (a comment or a mention), else the ticket's summary. */
const detailOf = (what: string, summary: string) => (what.includes(':') ? what.slice(what.indexOf(':') + 1).trim() : summary);

/**
 * A Jira alert beside Cora (or, inline, in its conversation): who did what on which ticket, several at once, or a
 * catch-up summary. The Slack sent card's shape, in Jira's colour. Open takes you to the ticket.
 */
export function JiraCard({ a, inline = false }: { a: JiraAlert; inline?: boolean }) {
  const [open, setOpen] = useState(false);
  const one = a.events.length === 1 ? a.events[0] : null;
  return (
    <div className={`sd-sent jw-card${inline ? ' inline' : ''}`} role="status">
      <span className="sd-logo-tile jw-tile">
        <BrandIcon source="jira" size={14} />
      </span>
      <span className="sd-sent-t">
        <b>{a.summary ?? alertTitle(a.events)}</b>
        {!inline && one ? <span>{detailOf(one.what, one.summary)}</span> : null}
        {!one && open ? (
          <span className="jw-list">
            {a.events.map((e) => (
              <button key={e.id} className="linkish" onClick={() => openJiraEvent(e)}>
                {e.who} {didWhat(e)}
              </button>
            ))}
          </span>
        ) : null}
      </span>
      {one ? (
        <button className="btn ghost" onClick={() => (openJiraEvent(one), dismissAlert(a.id))}>
          Open
        </button>
      ) : a.events.length ? (
        <button className="btn ghost" onClick={() => setOpen(!open)}>
          {open ? 'Hide' : 'Show'}
        </button>
      ) : null}
      <button className="btn ghost jw-x" title="See in Inbox" onClick={() => (showInbox(one ? `jira:${one.key}` : undefined), dismissAlert(a.id))}>
        <Icon name="Inbox" size={12} />
      </button>
      <button className="btn ghost jw-x" title="Dismiss" onClick={() => dismissAlert(a.id)}>
        <Icon name="X" size={12} />
      </button>
    </div>
  );
}

/** Jira alerts in Cora's conversation (console or command mode), and what Cora started on its own. */
export function JiraAlertsInline() {
  const alerts = useJiraWatch((s) => s.alerts);
  const started = useStartedCards();
  if (!alerts.length && !started.length) return null;
  return (
    <div className="cora-sent-inline">
      {started.map((r) => (
        <JiraStartedCard key={r.sessionId} r={r} inline />
      ))}
      {alerts.map((a) => (
        <JiraCard key={a.id} a={a} inline />
      ))}
    </div>
  );
}

/**
 * A ticket assigned to you, and Cora offers to start it: who assigned what, Cora's folder and why, Start in it (▾:
 * another of its candidates) or Not now. It starts with the ticket prompt (Settings › Jira), so there's no prompt to change.
 */
export function JiraStartCard({ a, inline = false }: { a: Approval; inline?: boolean }) {
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const t = a.ticket!;
  const folders = a.folders ?? [];
  const cwd = a.cwd ?? folders[0]?.cwd ?? '';
  const decide = async (ok: boolean, where?: string) => {
    setBusy(true);
    setErr(null);
    const e = await decideApproval(a.id, ok, undefined, ok && folders.length ? (where ?? cwd) : undefined);
    setBusy(false);
    if (e) setErr(e);
  };
  return (
    <div className={`sd-sent jw-card jw-start${inline ? ' inline' : ''}`} role="alert">
      <span className="sd-logo-tile jw-tile">
        <BrandIcon source={t.source ?? 'jira'} size={14} />
      </span>
      <span className="sd-sent-t">
        <b>
          {/* a GitLab issue reads as its project's name and number (its whole path in the tooltip) */}
          {t.who} assigned you{' '}
          <span className="k" title={t.key}>
            {t.source === 'gitlab' ? t.key.replace(/^.*\/([^/]+)#(\d+)$/, '$1 #$2') : t.key}
          </span>
        </b>
        <span>{t.summary}</span>
        <span className="jw-pick" title={cwd}>
          Cora: <em>{baseOf(cwd)}</em> · {a.detail}
        </span>
        <span className="jw-acts">
          <span className="jw-split">
            <button className="btn allow" disabled={busy} title={`Start ${t.key} in ${cwd}`} onClick={() => void decide(true)}>
              <Icon name="Play" size={11} /> Start in {baseOf(cwd)}
            </button>
            {folders.length > 1 ? (
              <button className="btn allow jw-more" disabled={busy} title="Another folder" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <Icon name="ChevronDown" size={12} />
              </button>
            ) : null}
          </span>
          <button className="btn ghost" disabled={busy} onClick={() => void decide(false)}>
            Not now
          </button>
        </span>
        {menu ? (
          <span className="jw-menu">
            <span className="jw-mh">Start it in</span>
            {folders.map((f) => (
              <button key={f.cwd} className={f.cwd === cwd ? 'on' : undefined} title={f.cwd} disabled={busy} onClick={() => void decide(true, f.cwd)}>
                <Icon name={f.cwd === cwd ? 'Check' : 'Folder'} size={12} />
                <span>{baseOf(f.cwd)}</span>
                <i>{f.why}</i>
              </button>
            ))}
          </span>
        ) : null}
        {err ? <span className="cc-inerr">{err}</span> : null}
      </span>
      <button className="btn ghost jw-x" title="Not now" disabled={busy} onClick={() => void decide(false)}>
        <Icon name="X" size={12} />
      </button>
    </div>
  );
}

/** What Cora started on its own lately (dismissed ones aside). */
export function useStartedCards(): JiraStarted[] {
  const list = useOrch((s) => (s.status?.enabled ? (s.status.jiraStarted ?? NONE) : NONE));
  const seen = useJiraWatch((s) => s.startedSeen);
  return startedToShow(list, seen, Date.now());
}

/** Cora started a ticket on its own: which, where, and a way to it. It stops at a plan. */
export function JiraStartedCard({ r, inline = false }: { r: JiraStarted; inline?: boolean }) {
  const close = () => dismissStarted(r.sessionId);
  return (
    <div className={`sd-sent jw-card jw-start jw-started${inline ? ' inline' : ''}`} role="status">
      <span className="sd-logo-tile jw-tile">
        <BrandIcon source="jira" size={14} />
      </span>
      <span className="sd-sent-t">
        <b>
          Cora started <span className="k">{r.key}</span> in {baseOf(r.cwd)}
        </b>
        <span>{r.summary}</span>
        <span className="jw-pick">getting it ready: it reads the ticket, then stops at a plan</span>
      </span>
      <button className="btn ghost" onClick={() => (useBrain.getState().setFocus(r.sessionId), close())}>
        Open
      </button>
      <button className="btn ghost jw-x" title="Dismiss" onClick={close}>
        <Icon name="X" size={12} />
      </button>
    </div>
  );
}
