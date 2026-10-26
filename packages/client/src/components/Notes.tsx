import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MAX_DRAFT_ASKS, SCRATCH_ID, toggleTask, type Jot, type NoteDoc, type NoteSummary } from '@cora/shared';
import { Markdown } from './Markdown';
import { draftNote, notesApi, useNotes, type DraftPreview } from '../state/notes';
import { desktop } from '../lib/desktop';
import { Icon } from './Icon';
import { openSettings } from './SettingsModal';
import './notes.css';

/**
 * Cora's Notes tool, in the Tools drawer: the list beside the open
 * note (narrower than 480 px: the list, then the note). Scratch takes jots; named notes are plain text that saves itself.
 */

const SEL = 'cora.notes.open';
const readSel = () => {
  try {
    return localStorage.getItem(SEL) || SCRATCH_ID;
  } catch {
    return SCRATCH_ID;
  }
};

const day = (t: number) => {
  const d = new Date(t);
  const today = new Date();
  const y = new Date(Date.now() - 86400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  return same(d, today) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
};
const time = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
const when = (t: number) => (!t ? '' : day(t) === 'Today' ? `today ${time(t)}` : day(t) === 'Yesterday' ? 'yesterday' : day(t));
const copy = (s: string) => (desktop?.writeClipboard ? desktop.writeClipboard(s) : void navigator.clipboard?.writeText(s).catch(() => {}));

export function NotesPane({ visible }: { visible: boolean }) {
  const list = useNotes((s) => s.list);
  const [sel, setSel] = useState(readSel);
  const [opened, setOpened] = useState(false);
  const [q, setQ] = useState('');
  const [narrow, setNarrow] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 480));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // the list on first show (the socket also sends it)
  useEffect(() => {
    if (visible && !list.length) void notesApi.list().then((r) => r.ok && useNotes.setState({ list: r.v.list }));
  }, [visible]);
  const pick = (id: string) => {
    setSel(id);
    setOpened(true);
    try {
      localStorage.setItem(SEL, id);
    } catch {
      /* not kept */
    }
  };
  // "Jot a note" (the palette): Scratch, its box
  const focusJot = useNotes((s) => s.focusJot);
  useEffect(() => {
    if (focusJot) pick(SCRATCH_ID);
  }, [focusJot]);
  // a note that's gone: back to Scratch
  useEffect(() => {
    if (list.length && !list.some((n) => n.id === sel && n.kind !== 'template')) setSel(SCRATCH_ID);
  }, [list, sel]);
  const newNote = async () => {
    setMenu(false);
    const r = await notesApi.create('Untitled');
    if (r.ok) pick(r.v.id);
  };
  // templates (kept in Settings › Tools): the New note menu, the fill sheet for the ones Cora drafts
  const [menu, setMenu] = useState(false);
  const [fill, setFill] = useState<{ template: string; note?: string; asks?: string } | null>(null);
  const templates = list.filter((n) => n.kind === 'template');
  const startTemplate = async (t: NoteSummary) => {
    setMenu(false);
    if (t.fill) return setFill({ template: t.id });
    const r = await notesApi.fromTemplate(t.id, false);
    if (r.ok) pick(r.v.id);
  };
  // the palette: open a note, or start one from a template
  const askOpen = useNotes((s) => s.open);
  const askStart = useNotes((s) => s.start);
  useEffect(() => {
    if (askOpen) pick(askOpen.id);
  }, [askOpen?.n]);
  useEffect(() => {
    const t = askStart && useNotes.getState().list.find((n) => n.id === askStart.id);
    if (t) void startTemplate(t);
  }, [askStart?.n]);
  // search: every word, in titles, notes and jots (the server reads them all); each hit with its first matching line
  const [hits, setHits] = useState<Record<string, string> | null>(null);
  useEffect(() => {
    const w = q.trim();
    if (!w) return setHits(null);
    let live = true;
    const t = setTimeout(() => void notesApi.search(w).then((r) => live && r.ok && setHits(Object.fromEntries(r.v.hits.map((h) => [h.id, (h.lines[0] ?? '').replace(/^\[[^\]]*\]\s*/, '')])))), 180);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, list]);
  const shown = useMemo(() => (hits ? list.filter((n) => n.id in hits) : list), [list, hits]);
  const scratch = shown.find((n) => n.kind === 'scratch');
  const pinned = shown.filter((n) => n.kind === 'note' && n.pinned);
  const rest = shown.filter((n) => n.kind === 'note' && !n.pinned);
  const row = (n: NoteSummary) => (
    <button key={n.id} className={`nt-r${n.id === sel ? ' on' : ''}`} onClick={() => pick(n.id)}>
      <b>
        {n.title}
        {n.unseen ? <i className="nt-by" title="A session added to it" /> : null}
      </b>
      <span>{hits?.[n.id] ? hits[n.id] : n.kind === 'scratch' ? `${n.count ?? 0} jot${n.count === 1 ? '' : 's'}${n.updatedAt ? ` · ${when(n.updatedAt)}` : ''}` : when(n.updatedAt) || 'empty'}</span>
    </button>
  );
  const drill = narrow;
  return (
    <div ref={box} className={`notes${drill ? ' drill' : ''}${drill && opened ? ' opened' : ''}${visible ? '' : ' off'}`}>
      <div className="nt-list">
        <label className="nt-search">
          <Icon name="Search" size={12} />
          <input value={q} placeholder="Search notes" onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="nt-rows">
          {scratch ? row(scratch) : null}
          {pinned.length ? <div className="nt-sl">Pinned</div> : null}
          {pinned.map(row)}
          {rest.length ? <div className="nt-sl">Notes</div> : null}
          {rest.map(row)}
          {q && hits && !shown.length ? <div className="nt-none">No note mentions “{q}”.</div> : null}
        </div>
        <div className="nt-newbox">
          <button className="nt-new" onClick={() => void newNote()}>
            <Icon name="Plus" size={12} /> New note
          </button>
          <button className="nt-new nt-more" title="From a template" aria-expanded={menu} onClick={() => setMenu(!menu)}>
            <Icon name="ChevronUp" size={12} />
          </button>
          {menu ? (
            <div className="nt-menu nt-newmenu" onMouseLeave={() => setMenu(false)}>
              <button onClick={() => void newNote()}>
                <Icon name="Plus" size={12} /> Blank note
              </button>
              {templates.length ? <div className="nt-mh">From a template</div> : null}
              {templates.map((t) => (
                <button key={t.id} onClick={() => void startTemplate(t)}>
                  <Icon name={t.fill ? 'Sparkles' : 'FileText'} size={12} /> {t.title}
                  {t.fill ? <em>Cora fills</em> : null}
                </button>
              ))}
              <button onClick={() => (setMenu(false), openSettings('tools'))}>
                <Icon name="PencilLine" size={12} /> Edit templates…
              </button>
            </div>
          ) : null}
        </div>
      </div>
      <div className="nt-note">
        {drill ? (
          <button className="nt-back" onClick={() => setOpened(false)}>
            <Icon name="ChevronLeft" size={13} /> All notes
          </button>
        ) : null}
        {sel === SCRATCH_ID ? <Scratch visible={visible} /> : <NoteEditor key={sel} id={sel} onGone={() => setSel(SCRATCH_ID)} onRedraft={(template, asks) => setFill({ template, note: sel, asks })} onOpen={pick} />}
        {fill ? <FillSheet template={fill.template} note={fill.note} asks={fill.asks} onPicked={pick} onClose={() => setFill(null)} /> : null}
      </div>
    </div>
  );
}

const WINDOWS: Array<[string, string]> = [
  ['since-last', 'Since last'],
  ['today', 'Today'],
  ['24h', 'Last 24 h'],
  ['week', 'This week'],
];
const stamp = (t: number) => new Date(t).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/**
 * Cora drafts a note from a template: the window (the template's default first), the repos worked in during it (all
 * ticked), what it will read; then the draft (a new note, or `note` again: Redraft).
 */
function FillSheet({ template, note, asks: asked, onPicked, onClose }: { template: string; note?: string; asks?: string; onPicked: (id: string) => void; onClose: () => void }) {
  const t = useNotes((s) => s.list.find((n) => n.id === template));
  const [win, setWin] = useState<string | null>(null);
  const [p, setP] = useState<DraftPreview | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // what you add for this draft ("leave out project X"); Redraft starts from what you added last time
  const [asks, setAsks] = useState(asked ?? '');
  useEffect(() => {
    let live = true;
    setP(null);
    void notesApi.draftPreview(template, win ?? '', note).then((r) => {
      if (!live) return;
      if (r.ok) (setP(r.v), win == null && setWin(r.v.window));
      else setErr(r.error);
    });
    return () => {
      live = false;
    };
  }, [template, win]);
  const repos = (p?.repos ?? []).filter((r) => !off.has(r.repo)).map((r) => r.repo);
  const go = async () => {
    if (!p) return;
    setBusy(true);
    let id = note;
    if (!id) {
      const r = await notesApi.fromTemplate(template, true);
      if (!r.ok) return (setBusy(false), setErr(r.error));
      id = r.v.id;
    }
    onPicked(id);
    onClose();
    void draftNote(id, template, p.since, p.until, repos, asks);
  };
  const plain = async () => {
    const r = await notesApi.fromTemplate(template, false);
    if (r.ok) (onPicked(r.v.id), onClose());
  };
  const c = p?.counts;
  return (
    <div className="nt-sheet">
      <h4>Cora drafts {note ? 'it again' : `your ${(t?.title ?? 'note').toLowerCase()}`}</h4>
      <div className="sub">From what it saw you do. You can edit everything after.</div>
      <div className="lab">From</div>
      <div className="nt-seg">
        {WINDOWS.map(([k, label]) => (
          <button key={k} className={win === k ? 'on' : ''} onClick={() => setWin(k)}>
            {k === 'since-last' ? (p?.last && win === k ? `Since last · ${stamp(p.last)}` : p && !p.last && win === k ? 'Since last (24 h)' : label) : label}
          </button>
        ))}
      </div>
      <div className="lab">Repos</div>
      {!p ? (
        <div className="nt-reads">Looking at that window…</div>
      ) : !p.repos.length ? (
        <div className="nt-reads">No sessions in that window.</div>
      ) : (
        <div className="nt-picks">
          {p.repos.map((r) => (
            <button key={r.repo} className={off.has(r.repo) ? '' : 'on'} onClick={() => setOff((o) => (o.has(r.repo) ? new Set([...o].filter((x) => x !== r.repo)) : new Set([...o, r.repo])))}>
              {r.repo} · {r.sessions}
            </button>
          ))}
        </div>
      )}
      {c ? (
        <div className="nt-reads">
          Reads <b>{c.sessions} sessions</b>
          {c.tickets.length ? ` · ${c.tickets.join(' ')}` : ''}
          {c.mrs.length ? ` · ${c.mrs.join(' ')}` : ''}
          {c.deploys ? ` · ${c.deploys} deploys` : ''}
          {c.jira ? ` · ${c.jira} Jira events` : ''}
          {c.jots ? ` · ${c.jots} jots` : ''}. Claude writes it from these facts only.
        </div>
      ) : null}
      <div className="lab">Anything to add?</div>
      <textarea
        className="nt-asks"
        rows={2}
        maxLength={MAX_DRAFT_ASKS}
        value={asks}
        placeholder="Optional, e.g. leave out the canvas work and anything personal"
        onChange={(e) => setAsks(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && (e.preventDefault(), void go())}
      />
      {err ? <div className="cc-inerr">{err}</div> : null}
      <div className="nt-acts">
        <button className="btn allow" disabled={!p || busy || (!repos.length && !c?.jots && !c?.jira)} onClick={() => void go()}>
          <Icon name="Sparkles" size={12} /> {note ? 'Redraft' : 'Draft it'}
        </button>
        {note ? null : (
          <button className="btn ghost" onClick={() => void plain()}>
            Just the template
          </button>
        )}
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Read a note, and again when the list says it changed (a session added to it). */
function useDoc(id: string, skip: () => boolean) {
  const stamp = useNotes((s) => {
    const n = s.list.find((x) => x.id === id);
    return n ? `${n.updatedAt}|${n.count ?? ''}|${n.unseen}` : '';
  });
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (skip()) return;
    let live = true;
    void notesApi.read(id).then((r) => {
      if (!live) return;
      if (r.ok) (setDoc(r.v), setErr(null));
      else setErr(r.error);
    });
    return () => {
      live = false;
    };
  }, [id, stamp]);
  return { doc, setDoc, err };
}

// ---------------------------------------------------------------------------------------------------------------

function Scratch({ visible }: { visible: boolean }) {
  const { doc } = useDoc(SCRATCH_ID, () => false);
  const focusJot = useNotes((s) => s.focusJot);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<Jot | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(undoTimer.current), []);
  const remove = async (j: Jot) => {
    const r = await notesApi.deleteJot(j.id);
    if (!r.ok) return;
    setUndo(j);
    clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(() => setUndo(null), 7000);
  };
  const restore = async () => {
    if (!undo) return;
    clearTimeout(undoTimer.current);
    const j = undo;
    setUndo(null);
    await notesApi.restoreJot(j);
  };
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (visible) ta.current?.focus();
  }, [visible, focusJot]);
  const add = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const r = await notesApi.jot(t);
    setBusy(false);
    if (r.ok) setText('');
  };
  const jots = doc?.jots ?? [];
  const days: Array<[string, Jot[]]> = [];
  for (const j of jots) {
    const d = day(j.at);
    if (days.at(-1)?.[0] === d) days.at(-1)![1].push(j);
    else days.push([d, [j]]);
  }
  return (
    <div className="nt-doc">
      <div className="nt-h">
        <h3>Scratch</h3>
        <span className="spacer" />
        <span className="nt-saved">{jots.length} jot{jots.length === 1 ? '' : 's'}</span>
      </div>
      <div className="nt-jotbox">
        <textarea
          ref={ta}
          value={text}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
          placeholder="Jot something…  (Ctrl+Alt+N from anywhere)"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) (e.preventDefault(), void add());
          }}
        />
      </div>
      {undo ? (
        <div className="nt-undo">
          Jot deleted
          <button className="btn ghost" onClick={() => void restore()}>
            Undo
          </button>
        </div>
      ) : null}
      <div className="nt-body">
        {!jots.length ? <div className="nt-none">Nothing jotted yet. Enter adds a jot; Ctrl+Alt+N jots from anywhere in Windows.</div> : null}
        {days.map(([d, js]) => (
          <div key={d}>
            <div className="nt-day">{d}</div>
            {js.map((j) => (
              <JotRow key={j.id} j={j} onDelete={() => void remove(j)} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function JotRow({ j, onDelete }: { j: Jot; onDelete: () => void }) {
  const [menu, setMenu] = useState(false);
  const all = useNotes((s) => s.list);
  const list = useMemo(() => all.filter((n) => n.kind === 'note'), [all]);
  const move = (to: { id?: string; title?: string }) => (setMenu(false), void notesApi.moveJot(j.id, to));
  return (
    <div className={`nt-jot${j.by ? ' by' : ''}`}>
      <span className="t">{time(j.at)}</span>
      <span className="w">
        {j.by ? <span className="src">from {j.by}</span> : j.src ? <span className="src">taken from {j.src}</span> : null}
        {j.text}
      </span>
      <span className="nt-ja">
        <button className="icon-btn" title="Copy" onClick={() => copy(j.text)}>
          <Icon name="Copy" size={12} />
        </button>
        <button className="icon-btn" title="Move to a note" onClick={() => setMenu(!menu)}>
          <Icon name="FileInput" size={12} />
        </button>
        <button className="icon-btn" title="Delete" onClick={onDelete}>
          <Icon name="Trash2" size={12} />
        </button>
      </span>
      {menu ? (
        <div className="nt-menu" onMouseLeave={() => setMenu(false)}>
          <div className="nt-mh">Move to</div>
          <button onClick={() => move({ title: j.text.split('\n')[0].slice(0, 60) })}>
            <Icon name="Plus" size={12} /> A new note
          </button>
          {list.slice(0, 12).map((n) => (
            <button key={n.id} onClick={() => move({ id: n.id })}>
              <Icon name="FileText" size={12} /> {n.title}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/** A named note: its title and its text, saved as you type. */
/** A note by its title (any case), for `[[links]]`: its id, or none. */
const noteByTitle = (title: string) => useNotes.getState().list.find((n) => n.kind !== 'template' && n.title.toLowerCase() === title.trim().toLowerCase())?.id ?? null;

function NoteEditor({ id, onGone, onRedraft, onOpen }: { id: string; onGone: () => void; onRedraft: (template: string, asks?: string) => void; /** open another note (a link to it) */ onOpen: (id: string) => void }) {
  const dirty = useRef(false);
  const drafting = useNotes((s) => !!s.drafting[id]);
  const draftError = useNotes((s) => s.draftError[id]);
  const [redraftAsk, setRedraftAsk] = useState(false);
  const { doc, setDoc, err } = useDoc(id, () => dirty.current);
  const [text, setText] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [state, setState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [confirm, setConfirm] = useState(false);
  const [reading, setReading] = useState(false);
  const base = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef('');
  const ta = useRef<HTMLTextAreaElement>(null);
  // the note as read (first, and again when a session added while you weren't typing)
  useEffect(() => {
    if (!doc || dirty.current) return;
    setText(doc.text);
    setTitle(doc.title);
    base.current = doc.version;
  }, [doc]);
  useEffect(() => () => clearTimeout(timer.current), []);
  // a draft just landed: show it formatted (ticket chips, links); double-click to edit
  const wasDrafting = useRef(drafting);
  useEffect(() => {
    if (wasDrafting.current && !drafting && !draftError) setReading(true);
    wasDrafting.current = drafting;
  }, [drafting, draftError]);
  const save = async () => {
    const sent = latest.current;
    setState('saving');
    const r = await notesApi.save(id, sent, base.current);
    if (!r.ok) return setState('error');
    base.current = r.v.version;
    // typed more meanwhile: that's saved next
    if (latest.current !== sent) return void (timer.current = setTimeout(() => void save(), 400));
    dirty.current = false;
    setState('saved');
    // a session's addition kept at the end
    if (r.v.text !== sent) {
      latest.current = r.v.text;
      setText(r.v.text);
    }
  };
  const change = (v: string) => {
    setText(v);
    latest.current = v;
    dirty.current = true;
    setState('saving');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), 600);
  };
  // a task's box ticked (reading) or Ctrl+Enter on its line (writing)
  const tick = (line: number) => text != null && change(toggleTask(text, line));
  const tickHere = (el: HTMLTextAreaElement) => {
    const at = el.selectionStart;
    const line = el.value.slice(0, at).split('\n').length;
    const next = toggleTask(el.value, line);
    if (next === el.value) return;
    change(next);
    requestAnimationFrame(() => el.setSelectionRange(at, at));
  };
  const rename = async () => {
    const t = title.trim();
    if (doc && t && t !== doc.title) {
      await notesApi.meta(id, { title: t });
      setDoc({ ...doc, title: t });
    } else if (doc) setTitle(doc.title);
  };
  const titles = useNotes((s) => s.list);
  const links = useMemo(
    () => ({
      has: (t: string) => !!noteByTitle(t),
      open: (t: string) => {
        const found = noteByTitle(t);
        if (found) return onOpen(found);
        void notesApi.create(t.trim()).then((r) => r.ok && onOpen(r.v.id));
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [titles, onOpen],
  );
  // typing `[[`: the notes it could link to, under the caret
  const [ac, setAc] = useState<{ q: string; at: number; x: number; y: number; i: number } | null>(null);
  const acList = useMemo(() => {
    if (!ac) return [];
    const q = ac.q.trim().toLowerCase();
    const all = titles.filter((n) => n.kind === 'note' && n.id !== id).map((n) => n.title);
    return [...all.filter((t) => t.toLowerCase().startsWith(q)), ...all.filter((t) => !t.toLowerCase().startsWith(q) && t.toLowerCase().includes(q))].slice(0, 8);
  }, [ac, titles, id]);
  const lookForLink = (el: HTMLTextAreaElement) => {
    const at = el.selectionStart;
    const m = /\[\[([^[\]|\n]{0,60})$/.exec(el.value.slice(0, at));
    if (!m || el.selectionEnd !== at) return setAc(null);
    const c = caretXY(el, at);
    setAc((cur) => ({ q: m[1], at: at - m[1].length, x: c.x, y: c.y, i: cur && cur.at === at - m[1].length ? cur.i : 0 }));
  };
  const takeLink = (title: string) => {
    const el = ta.current;
    if (!el || !ac) return;
    const end = el.selectionStart;
    const closes = el.value.slice(end, end + 2) === ']]';
    const next = `${el.value.slice(0, ac.at)}${title}]]${el.value.slice(closes ? end + 2 : end)}`;
    const caret = ac.at + title.length + 2;
    change(next);
    setAc(null);
    requestAnimationFrame(() => (el.focus(), el.setSelectionRange(caret, caret)));
  };
  if (err) return <div className="nt-none">{err === 'no such note' ? 'This note is gone.' : err}</div>;
  if (!doc || text == null) return <div className="nt-none">Opening…</div>;
  return (
    <div className="nt-doc">
      <div className="nt-h">
        <input className="nt-title" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), ta.current?.focus())} />
        <span className="nt-saved">{state === 'saving' ? 'saving…' : state === 'error' ? "couldn't save" : 'saved'}</span>
        <button className={`icon-btn${reading ? ' on' : ''}`} title={reading ? 'Write (edit the text)' : 'Read (tick boxes, see it formatted)'} onClick={() => setReading(!reading)}>
          <Icon name={reading ? 'PencilLine' : 'BookOpen'} size={13} />
        </button>
        {(doc.draft || doc.from) && doc.kind === 'note' && useNotes.getState().list.find((n) => n.id === (doc.draft?.template ?? doc.from))?.fill ? (
          <button className="icon-btn" title="Cora drafts it again" disabled={drafting} onClick={() => (doc.updatedAt > (doc.draft?.at ?? 0) + 3000 && doc.text.trim() ? setRedraftAsk(true) : onRedraft(doc.draft?.template ?? doc.from!, doc.draft?.asks))}>
            <Icon name="Sparkles" size={13} />
          </button>
        ) : null}
        {doc.kind === 'template' ? null : (
        <button className={`icon-btn${doc.pinned ? ' on' : ''}`} title={doc.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => void notesApi.meta(id, { pinned: !doc.pinned }).then(() => setDoc({ ...doc, pinned: !doc.pinned }))}>
          <Icon name={doc.pinned ? 'PinOff' : 'Pin'} size={13} />
        </button>
        )}
        <button className="icon-btn" title={doc.kind === 'template' ? 'Delete this template' : 'Delete this note'} onClick={() => setConfirm(true)}>
          <Icon name="Trash2" size={13} />
        </button>
      </div>
      {confirm ? (
        <div className="nt-confirm">
          {doc.kind === 'template' ? `Delete the ${doc.title} template? It won't be offered under New note any more; notes made from it stay. (Restore default templates brings the starters back.)` : `Delete “${doc.title}”? It can't be undone.`}
          <button className="btn danger" onClick={() => void notesApi.remove(id).then(onGone)}>
            Delete
          </button>
          <button className="btn ghost" onClick={() => setConfirm(false)}>
            Keep
          </button>
        </div>
      ) : null}
      {redraftAsk ? (
        <div className="nt-confirm">
          Redraft replaces what's here, your edits too.
          <button className="btn allow" onClick={() => (setRedraftAsk(false), onRedraft(doc.draft?.template ?? doc.from!, doc.draft?.asks))}>
            Redraft
          </button>
          <button className="btn ghost" onClick={() => setRedraftAsk(false)}>
            Keep
          </button>
        </div>
      ) : null}
      <div className="nt-meta">
        {doc.kind === 'template'
          ? `template${doc.fill ? ' · Cora fills it' : ''} · the lines between --- set fill: cora, window (since-last, today, 24h, week) and title; <!-- cora: … --> says what Cora writes`
          : doc.draft
            ? `drafted by Cora · ${stamp(doc.draft.since)} → ${stamp(doc.draft.until)} · ${doc.draft.repos.join(', ')}`
            : `${doc.pinned ? 'pinned · ' : ''}~/.cora/notes/${id}.md`}
      </div>
      {drafting ? (
        <div className="nt-drafting">
          <span className="dl-glyph run" /> Cora is drafting this from what it saw you do… (up to a minute)
        </div>
      ) : draftError ? (
        <div className="nt-confirm">
          Cora couldn't draft it: {draftError}
          <button className="btn ghost" onClick={() => onRedraft(doc.draft?.template ?? doc.from!, doc.draft?.asks)}>
            Try again
          </button>
        </div>
      ) : null}
      {reading ? (
        <div className="nt-read" onDoubleClick={() => setReading(false)}>
          {text.trim() ? <Markdown text={text} onTask={tick} notes={links} /> : <div className="nt-none">Empty. Double-click to write.</div>}
        </div>
      ) : (
        <textarea
          ref={ta}
          className="nt-text"
          value={text}
          readOnly={drafting}
          spellCheck
          placeholder="Write anything. Markdown is fine: - [ ] makes a task (Ctrl+Enter ticks it), [[a note's title]] links to it. It saves as you type."
          onChange={(e) => (change(e.target.value), lookForLink(e.currentTarget))}
          onClick={(e) => lookForLink(e.currentTarget)}
          onBlur={() => setTimeout(() => setAc(null), 150)}
          onKeyDown={(e) => {
            if (ac && acList.length) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return (e.preventDefault(), setAc({ ...ac, i: (ac.i + (e.key === 'ArrowDown' ? 1 : acList.length - 1)) % acList.length }));
              if (e.key === 'Enter' || e.key === 'Tab') return (e.preventDefault(), takeLink(acList[ac.i] ?? acList[0]));
              if (e.key === 'Escape') return (e.preventDefault(), setAc(null));
            }
            if (e.key === 'Enter' && e.ctrlKey) (e.preventDefault(), tickHere(e.currentTarget));
          }}
        />
      )}
      {ac && acList.length && !reading ? (
        <div className="nt-ac" style={{ left: ac.x, top: ac.y }}>
          {acList.map((t, i) => (
            <button key={t} className={i === ac.i ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), takeLink(t))}>
              <Icon name="FileText" size={12} /> {t}
            </button>
          ))}
        </div>
      ) : null}
      {doc.backlinks?.length ? (
        <div className="nt-linked">
          <span className="nt-linked-h">Linked from</span>
          {doc.backlinks.map((b) => (
            <button key={b.id} className="nt-linked-r" onClick={() => onOpen(b.id)} title={`Open “${b.title}”`}>
              <b>{b.title}</b>
              <span>{b.line}</span>
            </button>
          ))}
        </div>
      ) : null}
      {doc.draft && !drafting ? <div className="nt-src">read {doc.draft.read}</div> : null}
    </div>
  );
}

/** Where the caret at `pos` is drawn in a textarea, relative to its box (a hidden copy with the same text measures it). */
function caretXY(el: HTMLTextAreaElement, pos: number): { x: number; y: number } {
  const cs = getComputedStyle(el);
  const div = document.createElement('div');
  for (const k of ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize'] as const) div.style[k] = cs[k];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', overflow: 'hidden', top: '0', left: '-9999px' });
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  div.appendChild(mark);
  document.body.appendChild(div);
  const x = mark.offsetLeft + el.offsetLeft;
  const y = mark.offsetTop + el.offsetTop - el.scrollTop + parseFloat(cs.lineHeight || '18');
  div.remove();
  return { x: Math.min(x, el.offsetLeft + el.clientWidth - 220), y };
}
