import { useEffect, useState } from 'react';
import type { JiraIssue, JiraResult } from '@cora/shared';
import { parseTicketInput } from '../lib/ticket';
import { jiraSite, myOpenIssues, useJira, useJiraIssue } from '../state/jira';
import { useBrain } from '../state/store';
import { MISS, openInBrowser, priorityColor, typeIcon } from './JiraChip';
import { Icon } from './Icon';

export type PickedTicket = { key: string; site?: string };

/**
 * The New session dialog's ticket: one of your open issues, or a key or Jira link pasted in (looked up as you type).
 * Signed out of Jira, the list can't be had; it says so and offers the sign-in, and a pasted key still starts the
 * session (its card fills in once you're signed in). Enter (or a double-click) starts.
 */
export function TicketPicker({ picked, onPick, onStart }: { picked: PickedTicket | null; onPick(t: PickedTicket | null): void; onStart(): void }) {
  const auth = useJira((st) => st.auth);
  const site = useJira((st) => jiraSite(st));
  const [list, setList] = useState<JiraResult<JiraIssue[]> | null>(null);
  const [text, setText] = useState('');
  const pasted = parseTicketInput(text, site);

  // the list, and again once a sign-in lands
  const signedIn = auth === 'ok';
  useEffect(() => {
    if (list?.ok) return;
    let live = true;
    void myOpenIssues(30).then((r) => live && setList(r));
    return () => void (live = false);
  }, [signedIn, site]);
  const type = (v: string) => {
    setText(v);
    onPick(parseTicketInput(v, site));
  };

  const signIn = () => {
    if (!site) return;
    useBrain.getState().setModal(null);
    openInBrowser(`https://${site}/`, useBrain.getState().focus ?? undefined);
  };
  const issues = list?.ok ? list.value : [];
  const err = list && !list.ok ? list.error : null;

  return (
    <div className="tpick">
      <label className="field">
        <span>Ticket</span>
        <input
          value={text}
          autoFocus
          spellCheck={false}
          placeholder="paste a key (PROJ-123) or a Jira link, or pick one below"
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && picked && onStart()}
        />
      </label>
      {text.trim() ? pasted ? <Pasted t={pasted} /> : <div className="tp-msg">Not a ticket: paste a key like PROJ-123, or a link to one.</div> : null}
      {err === 'signed-out' ? (
        <div className="tp-msg warn">
          <Icon name="LogIn" size={12} /> Signed out of Jira, so your open issues can&apos;t be listed. A pasted key still works.
          {site ? <button className="btn jc-btn" onClick={signIn}>Sign in at {site}</button> : null}
        </div>
      ) : err === 'unavailable' ? (
        <div className="tp-msg">Your open issues are listed in the desktop app. Paste a key here to start from it.</div>
      ) : err === 'no-site' ? (
        <div className="tp-msg">Which Jira? Set the site in Settings › Jira to list your open issues. A pasted key still works.</div>
      ) : err ? (
        <div className="tp-msg">Couldn&apos;t list your open issues ({err === 'offline' ? 'Jira is out of reach' : err}). A pasted key still works.</div>
      ) : null}
      {!list ? <div className="tp-msg">Looking up your open issues…</div> : null}
      {list?.ok && !issues.length ? <div className="tp-msg">Nothing assigned to you is open.</div> : null}
      {issues.length ? (
        <div className="tp-list" role="listbox" aria-label="Your open issues">
          {issues.map((i) => (
            <button
              key={i.key}
              role="option"
              aria-selected={picked?.key === i.key}
              className={`tp-row${picked?.key === i.key ? ' on' : ''}`}
              onClick={() => {
                setText('');
                onPick({ key: i.key });
              }}
              onDoubleClick={onStart}
              title={`${i.key} · ${i.summary}`}
            >
              <Icon name={typeIcon(i.type)} size={12} />
              <span className="tk">{i.key}</span>
              <span className="tsum">{i.summary}</span>
              {i.priority ? <i className="jc-pri" title={`${i.priority.name} priority`} style={{ background: priorityColor(i.priority.name) }} /> : null}
              <span className={`jc-st j-${i.status.category}`}>{i.status.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A pasted ticket, looked up: its summary and status, or why there's none (it can still be started). */
function Pasted({ t }: { t: PickedTicket }) {
  const r = useJiraIssue(t.key, t.site);
  if (r?.ok)
    return (
      <div className="tp-row on static">
        <Icon name={typeIcon(r.value.type)} size={12} />
        <span className="tk">{t.key}</span>
        <span className="tsum">{r.value.summary}</span>
        <span className={`jc-st j-${r.value.status.category}`}>{r.value.status.name}</span>
      </div>
    );
  const why = !r ? 'looking it up…' : r.error === 'not-found' ? "Jira doesn't know it, or you can't see it" : r.error === 'unavailable' || r.error === 'no-site' ? 'not looked up' : MISS[r.error] === 'sign in' ? 'signed out of Jira: it fills in once you sign in' : MISS[r.error] ?? r.error;
  return (
    <div className={`tp-msg${r && !r.ok && r.error === 'not-found' ? ' warn' : ''}`}>
      <span className="tk">{t.key}</span> · {why}
    </div>
  );
}
