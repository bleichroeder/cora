import { useEffect, useMemo, useRef, useState } from 'react';
import { isUnread, type InboxItem, type Jot } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { useCi } from '../../state/ci';
import { showInbox, useInbox, whenOf } from '../../state/inbox';
import { NOTES_ID, notesApi, useNotes } from '../../state/notes';
import { useTools } from '../../state/tools';
import { dockNeeds } from '../../state/boardDock';
import { sortedSessions } from '../../lib/sessionOrder';
import { ago, currentAction, isDismissed, sessionColor, sessionName } from '../../lib/format';
import { CORA_BOARD } from '../../lib/boardLayout';
import { maskSecrets } from '../../lib/mask';
import { NeedsYou } from '../NeedsYou';
import { CiGlyph } from '../CiStrip';
import { BrandIcon } from '../BrandIcon';
import { Icon } from '../Icon';

const SCRATCH = 'scratch';

/* ------------------------------------------------------------------ Needs you */

/** Approvals and questions waiting on you, with their buttons (the floating cards stand down while this shows them). */
export function NeedsPanel({ sessionId }: { sessionId: string }) {
  const cora = sessionId === CORA_BOARD;
  // on Cora's board: every session's, each under its name
  const ids = useBrain((s) => [...new Set(s.pending.filter((p) => cora || p.sessionId === sessionId).map((p) => p.sessionId))].join(','));
  const sessions = useBrain((s) => s.sessions);
  useEffect(() => dockNeeds(sessionId), [sessionId]);
  const list = ids ? ids.split(',') : [];
  return (
    <div className="lb-needs">
      {!list.length ? <div className="lb-empty">Nothing waiting on you. Approvals and questions show here, with their buttons.</div> : null}
      {cora
        ? list.map((id) => (
            <div key={id} className="lb-needs-s">
              <div className="lb-needs-h" style={{ ['--k' as string]: sessions[id] ? sessionColor(sessions[id]) : 'var(--ink3)' }}>
                <i />
                {sessions[id] ? sessionName(sessions[id]) : id.slice(0, 8)}
              </div>
              <NeedsYou sessionId={id} />
            </div>
          ))
        : list.length ? <NeedsYou sessionId={sessionId} /> : null}
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

/** Scratch, from this session's side: its jots (or everyone's), newest first, a line to jot one down, and a delete on each (with an undo, as in Notes). */
export function NotesPanel({ sessionId }: { sessionId: string }) {
  const session = useBrain((s) => s.sessions[sessionId]);
  const name = session ? sessionName(session) : '';
  // read again when Scratch changes: a new jot moves its time, a deleted one its count
  const changed = useNotes((n) => {
    const x = n.list.find((y) => y.id === SCRATCH);
    return x ? `${x.updatedAt}|${x.count ?? 0}` : '';
  });
  const [jots, setJots] = useState<Jot[] | null>(null);
  const [all, setAll] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [undo, setUndo] = useState<Jot | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  useEffect(() => {
    let on = true;
    void notesApi.read(SCRATCH).then((r) => on && r.ok && setJots(r.v.jots ?? []));
    return () => void (on = false);
  }, [changed]);
  const remove = async (j: Jot) => {
    const r = await notesApi.deleteJot(j.id);
    if (!r.ok) return setErr(r.error);
    setErr(null);
    setJots((js) => (js ?? []).filter((x) => x.id !== j.id));
    setUndo(j);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 7000);
  };
  const restore = async () => {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    const j = undo;
    setUndo(null);
    const r = await notesApi.restoreJot(j);
    if (r.ok) setJots((js) => [j, ...(js ?? []).filter((x) => x.id !== j.id)]);
  };
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
              <button className="icon-btn lb-jotx" title="Delete this jot" onClick={() => void remove(j)}>
                <Icon name="Trash2" size={12} />
              </button>
            </div>
          ))
        )}
      </div>
      {undo ? (
        <div className="lb-undo">
          Jot deleted
          <button className="btn ghost" onClick={() => void restore()}>
            Undo
          </button>
        </div>
      ) : null}
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
