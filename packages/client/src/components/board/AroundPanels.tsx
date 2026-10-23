import { useEffect, useMemo, useState } from 'react';
import { isUnread, type InboxItem, type Jot } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { useCi } from '../../state/ci';
import { showInbox, useInbox, whenOf } from '../../state/inbox';
import { NOTES_ID, notesApi, useNotes } from '../../state/notes';
import { useTools } from '../../state/tools';
import { dockNeeds } from '../../state/boardDock';
import { sortedSessions } from '../../lib/sessionOrder';
import { ago, currentAction, isDismissed, sessionColor, sessionName } from '../../lib/format';
import { maskSecrets } from '../../lib/mask';
import { NeedsYou } from '../NeedsYou';
import { CiGlyph } from '../CiStrip';
import { BrandIcon } from '../BrandIcon';
import { Icon } from '../Icon';

const SCRATCH = 'scratch';

/* ------------------------------------------------------------------ Needs you */

/** Approvals and questions waiting on you, with their buttons (the floating cards stand down while this shows them). */
export function NeedsPanel({ sessionId }: { sessionId: string }) {
  const n = useBrain((s) => s.pending.filter((p) => p.sessionId === sessionId).length);
  useEffect(() => dockNeeds(sessionId), [sessionId]);
  return (
    <div className="lb-needs">
      {n ? <NeedsYou sessionId={sessionId} /> : <div className="lb-empty">Nothing waiting on you. Approvals and questions show here, with their buttons.</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Mentions */

/** Inbox items about this session: Cora's notes for it, its ticket's Jira news, its branch's pipeline, mail it watches. */
export function MentionsPanel({ sessionId }: { sessionId: string }) {
  const items = useInbox((s) => s.items);
  const ticket = useBrain((s) => s.sessions[sessionId]?.ticket?.key);
  const repo = useCi((c) => c.links[sessionId]?.repo ?? null);
  const mine = useMemo(() => {
    const ci = repo ? `ci:${repo.project}@${repo.branch}` : null;
    const about = (i: InboxItem) =>
      i.sessionId === sessionId ||
      (!!ticket && (i.key === `jira:${ticket}` || i.title.includes(ticket) || i.entries.some((e) => e.text.includes(ticket)))) ||
      (!!ci && i.key === ci);
    return items.filter(about).sort((a, b) => whenOf(b) - whenOf(a));
  }, [items, sessionId, ticket, repo]);
  if (!mine.length)
    return <div className="lb-empty">Nothing in the Inbox about this session{ticket ? ` or ${ticket}` : ''}. Jira news, its pipeline, mail it watches and Cora's notes about it show here.</div>;
  return (
    <div className="lb-ments">
      {mine.map((i) => {
        const e = i.entries[0];
        return (
          <button key={i.id} className={`lb-ment${isUnread(i) ? ' unread' : ''}`} onClick={() => showInbox(i.key)} title="Open it in the Inbox">
            <BrandIcon source={i.source} size={14} />
            <span className="b">
              <span className="t">{i.title}</span>
              <span className="w">{e ? `${e.who ? `${e.who}: ` : ''}${maskSecrets(e.text).text}` : i.why}</span>
            </span>
            <span className="m">{ago(whenOf(i))}</span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ Notes */

/** Scratch, from this session's side: its jots (or everyone's), newest first, and a line to jot one down. */
export function NotesPanel({ sessionId }: { sessionId: string }) {
  const session = useBrain((s) => s.sessions[sessionId]);
  const name = session ? sessionName(session) : '';
  const changed = useNotes((n) => n.list.find((x) => x.id === SCRATCH)?.updatedAt);
  const [jots, setJots] = useState<Jot[] | null>(null);
  const [all, setAll] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let on = true;
    void notesApi.read(SCRATCH).then((r) => on && r.ok && setJots(r.v.jots ?? []));
    return () => void (on = false);
  }, [changed]);
  const ofThis = (j: Jot) => !!name && (j.src === name || j.by === name);
  const shown = (jots ?? []).filter((j) => all || ofThis(j)).sort((a, b) => b.at - a.at);
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    const r = await notesApi.jot(t, undefined, name || undefined);
    if (!r.ok) return setErr(r.error);
    setErr(null);
    setText('');
    if (r.v.jot) setJots((j) => [r.v.jot!, ...(j ?? [])]);
  };
  return (
    <div className="lb-notes">
      <div className="lb-seg">
        <button className={all ? '' : 'on'} onClick={() => setAll(false)}>
          This session
        </button>
        <button className={all ? 'on' : ''} onClick={() => setAll(true)}>
          All of Scratch
        </button>
        <span className="sp" />
        <button className="lb-pop" onClick={() => useTools.getState().show(NOTES_ID)} title="Open Notes">
          <Icon name="NotebookPen" size={11} /> Notes
        </button>
      </div>
      <div className="lb-jots">
        {jots == null ? (
          <div className="lb-empty">loading…</div>
        ) : !shown.length ? (
          <div className="lb-empty">{all ? 'Scratch is empty.' : 'No jots from this session yet. Jot one below, or ask Claude to note something down.'}</div>
        ) : (
          shown.map((j) => (
            <div key={j.id} className={`lb-jot${ofThis(j) ? ' mine' : ''}`}>
              <div className="t">{j.text}</div>
              <div className="m">
                {j.src || j.by ? `${j.src || j.by} · ` : ''}
                {ago(j.at)}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="lb-jotin">
        <input value={text} placeholder="Jot something down (Enter)" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        {err ? <span className="err">{err}</span> : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ All sessions */

const STATE_WORD: Record<string, string> = { 'needs-you': 'needs you', working: 'working', thinking: 'thinking', idle: 'idle', ended: 'ended' };

/** Every session at a glance (this one marked): what it's doing, its ticket and pipeline; click one to go there. */
export function SessionsPanel({ sessionId }: { sessionId: string }) {
  const sessions = useBrain((s) => s.sessions);
  const versions = useBrain((s) => s.versions);
  const list = useMemo(() => {
    const all = sortedSessions(sessions).filter((s) => !isDismissed(s));
    const live = all.filter((s) => s.state !== 'ended');
    const ended = all.filter((s) => s.state === 'ended').slice(0, 4);
    return [...live, ...ended];
  }, [sessions]);
  const doing = useMemo(() => Object.fromEntries(list.filter((s) => s.state === 'working' || s.state === 'thinking').map((s) => [s.id, currentAction(sessionEvents(s.id))])), [list, versions]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!list.length) return <div className="lb-empty">No sessions.</div>;
  return (
    <div className="lb-sess">
      {list.map((s) => {
        const a = doing[s.id];
        const name = sessionName(s);
        return (
          <button key={s.id} className={`lb-ses st-${s.state}${s.id === sessionId ? ' here' : ''}`} onClick={() => useBrain.getState().setFocus(s.id)} title={s.id === sessionId ? 'This session' : 'Go to this session'}>
            <span className="tile" style={{ ['--sc' as string]: sessionColor(s) }}>
              {name.trim()[0]?.toUpperCase() ?? '?'}
            </span>
            <span className="b">
              <span className="t">{name}</span>
              <span className="w">{a?.text ? maskSecrets(a.text).text : s.ticket ? `${s.ticket.key}${s.ticket.summary ? ` · ${s.ticket.summary}` : ''}` : ago(s.lastTs)}</span>
            </span>
            <CiGlyph sessionId={s.id} />
            <span className="sw">{STATE_WORD[s.state] ?? s.state}</span>
          </button>
        );
      })}
    </div>
  );
}
