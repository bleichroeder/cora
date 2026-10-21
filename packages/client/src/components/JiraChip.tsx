import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { issueUrl, type JiraIssue, type JiraResult } from '@cora/shared';
import { splitKeys, type JiraRef } from '../lib/jira';
import { desktop } from '../lib/desktop';
import { jiraSite, noteLink, useJira, useJiraIssue, useKnownKey } from '../state/jira';
import { useBrain } from '../state/store';
import { useWeb } from '../state/web';
import { Icon } from './Icon';
import './popovers.css';

/**
 * A page in the session's browser (Ctrl/Shift+click: your own browser). With no session, as any link clicked in
 * the app goes: the focused session's browser.
 */
export function openInBrowser(url: string, sessionId?: string, external = false) {
  if (external && desktop?.openExternal) return desktop.openExternal(url);
  if (sessionId && desktop?.browser) {
    if (useBrain.getState().focus !== sessionId) useBrain.getState().setFocus(sessionId);
    return useWeb.getState().open(sessionId, url);
  }
  window.open(url, '_blank', 'noopener');
}

const TYPE_ICON: Record<string, string> = { bug: 'Bug', story: 'Bookmark', epic: 'Zap', task: 'SquareCheck', subtask: 'ListTree', 'sub-task': 'ListTree', improvement: 'TrendingUp', spike: 'FlaskConical' };
export const typeIcon = (t?: JiraIssue['type']) => (t ? (TYPE_ICON[t.name.toLowerCase()] ?? (t.subtask ? 'ListTree' : 'SquareCheck')) : 'Ticket');
const PRIORITY: Array<[RegExp, string]> = [[/highest|blocker|critical|urgent/i, '#f87171'], [/high|major/i, '#fb923c'], [/medium|normal/i, '#fbbf24'], [/lowest|trivial/i, '#64748b'], [/low|minor/i, '#38bdf8']];
export const priorityColor = (n: string) => PRIORITY.find(([re]) => re.test(n))?.[1] ?? '#64748b';
const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

/** What the chip's pill says when there's no status to show. */
export const MISS: Record<string, string> = { 'signed-out': 'sign in', 'not-found': 'not found', offline: 'offline', error: '?' };

/**
 * A Jira ticket in text: its key and status, coloured by how far along it is; hover for a card (summary, type,
 * priority, assignee), click to open it in the session's browser. Signed out of Jira, it says so and the card offers
 * the sign-in.
 */
export function JiraChip({ jref, sessionId, compact = false, bare = false }: { jref: JiraRef; sessionId?: string; /** a dot for the status (a narrow list) */ compact?: boolean; /** the key alone, tinted by its status (the session list) */ bare?: boolean }) {
  const r = useJiraIssue(jref.key, jref.site);
  const fallbackSite = useJira((st) => jiraSite(st));
  const site = jref.site ?? fallbackSite;
  const url = r?.ok ? r.value.url : jref.url ?? (site ? issueUrl(site, jref.key) : '');
  const [card, setCard] = useState(false);
  const el = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (jref.url && jref.site) noteLink(jref.site, jref.key);
  }, [jref.url, jref.site, jref.key]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const hover = (on: boolean) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCard(on), on ? 280 : 160);
  };
  const state = !r ? 'loading' : r.ok ? r.value.status.category : r.error;
  const pill = !r ? '…' : r.ok ? r.value.status.name : MISS[r.error];
  const open = (e: React.MouseEvent | React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (url) openInBrowser(url, sessionId, e.ctrlKey || e.metaKey || e.shiftKey);
  };

  return (
    <span
      ref={el}
      className={`jchip j-${state}${compact ? ' compact' : ''}${bare ? ' bare' : ''}`}
      role="link"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => e.key === 'Enter' && open(e)}
      onMouseEnter={() => hover(true)}
      onMouseLeave={() => hover(false)}
    >
      <span className="jk">{jref.key}</span>
      {bare ? null : compact ? <span className="jdot" /> : pill ? <span className="jst">{pill}</span> : null}
      {card && el.current ? createPortal(<JiraCard anchor={el.current} jkey={jref.key} r={r} site={site} sessionId={sessionId} onHover={hover} />, document.body) : null}
    </span>
  );
}

/**
 * The hover card, fixed to the screen next to its chip (the transcript scrolls and clips; the card shouldn't). It's
 * the chip's child in React, so a click on it opens the ticket like the chip does.
 */
function JiraCard({ anchor, jkey, r, site, sessionId, onHover }: { anchor: HTMLElement; jkey: string; r: JiraResult<JiraIssue> | undefined; site: string | null; sessionId?: string; onHover: (on: boolean) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const a = anchor.getBoundingClientRect();
    const b = box.current!.getBoundingClientRect();
    const below = a.bottom + 6 + b.height < window.innerHeight - 8;
    setPos({ left: Math.max(8, Math.min(a.left, window.innerWidth - b.width - 8)), top: below ? a.bottom + 6 : Math.max(8, a.top - 6 - b.height) });
  }, [anchor, r]);
  const signIn = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (site) openInBrowser(`https://${site}/`, sessionId ?? useBrain.getState().focus ?? undefined);
  };

  let body: React.ReactNode;
  if (!r) body = <div className="jc-dim">Looking up {jkey}…</div>;
  else if (r.ok) {
    const i = r.value;
    body = (
      <>
        <div className="jc-sum">{i.summary || <span className="jc-dim">(no summary)</span>}</div>
        <div className="jc-meta">
          <span className={`jc-st j-${i.status.category}`}>{i.status.name}</span>
          {i.type ? <span><Icon name={typeIcon(i.type)} size={11} /> {i.type.name}</span> : null}
          {i.priority ? <span><i className="jc-pri" style={{ background: priorityColor(i.priority.name) }} /> {i.priority.name}</span> : null}
        </div>
        <div className="jc-who">
          {i.assignee ? <Avatar name={i.assignee.name} url={i.assignee.avatarUrl} /> : <span className="jc-av none"><Icon name="User" size={11} /></span>}
          <span>{i.assignee?.name ?? 'Unassigned'}</span>
        </div>
      </>
    );
  } else if (r.error === 'signed-out')
    body = (
      <>
        <div className="jc-dim">Sign in to Jira in Cora&apos;s browser to see {jkey} here.</div>
        {site ? <button className="btn jc-btn" onClick={signIn}><Icon name="LogIn" size={12} /> Open {site}</button> : null}
      </>
    );
  else if (r.error === 'not-found') body = <div className="jc-dim">No issue {jkey}, or you can&apos;t see it.</div>;
  else if (r.error === 'offline') body = <div className="jc-dim">Couldn&apos;t reach Jira. It&apos;ll look again in a moment.</div>;
  else if (r.error === 'no-site') body = <div className="jc-dim">Which Jira? Set the site in Settings › Jira.</div>;
  else body = <div className="jc-dim">Jira didn&apos;t answer for {jkey}{r.status ? ` (${r.status})` : ''}.</div>;

  return (
    <div
      ref={box}
      className="jcard"
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
    >
      <div className="jc-h">
        <b>{jkey}</b>
        <span className="spacer" />
        <span className="jc-dim">{r?.ok || r?.error === 'not-found' ? 'click to open' : site ?? ''}</span>
      </div>
      {body}
    </div>
  );
}

export function Avatar({ name, url }: { name: string; url?: string }) {
  const [bad, setBad] = useState(false);
  if (!url || bad) return <span className="jc-av">{initials(name)}</span>;
  return <img className="jc-av" src={url} alt="" referrerPolicy="no-referrer" onError={() => setBad(true)} />;
}

/** Plain text (a session's name, a title) with its ticket keys as chips; no links, so it can sit inside a button. */
export function JiraText({ text, sessionId, compact }: { text: string; sessionId?: string; compact?: boolean }) {
  const known = useKnownKey();
  if (!known || !text) return <>{text}</>;
  const parts = splitKeys(text, known);
  if (parts.length === 1 && typeof parts[0] === 'string') return <>{text}</>;
  return <>{parts.map((p, i) => (typeof p === 'string' ? p : <JiraChip key={i} jref={p} sessionId={sessionId} compact={compact} />))}</>;
}
