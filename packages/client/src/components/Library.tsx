import { useEffect, useRef, useState } from 'react';
import { LIBRARY_KINDS, type LibraryEntry, type LibraryKind, type LibraryWhen } from '@cora/shared';
import { KIND_WORDS, LIBRARY_ID, groupLibrary, useLibrary, type LibraryGroups } from '../state/library';
import { useTools } from '../state/tools';
import { goToSession, knownSession, openEntry } from '../lib/libraryOpen';
import { Icon } from './Icon';
import './library.css';

/**
 * The Library (Tools › Cora): everything sessions made, ended sessions' too, in one place: explains and live explains,
 * debriefs and their videos, artifacts, recaps and Cora's briefs. Grouped by project, then session, newest first;
 * starred ones pinned on top. Search, kind chips (counted) and a time filter; a click opens it where Cora shows it.
 */

/** When, as a row says it: the time today, else the day. */
export function libraryWhen(at: number, now = Date.now()): string {
  const d = new Date(at);
  if (d.toDateString() === new Date(now).toDateString()) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const part = (o: Intl.DateTimeFormatOptions) => d.toLocaleDateString('en-GB', o);
  return `${part({ weekday: 'short' })} ${d.getDate()} ${part({ month: 'short' })}${d.getFullYear() !== new Date(now).getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

const WHENS: Array<{ id: LibraryWhen | null; label: string }> = [
  { id: null, label: 'All' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This week' },
  { id: 'older', label: 'Older' },
];

/**
 * A row's Enter opens it only when it's the row itself that has the keyboard: on its star, Enter stars it (the
 * button's own), and goes no further.
 */
export function rowKey(x: { key: string; target: unknown; currentTarget: unknown }, open: () => void): void {
  if (x.key === 'Enter' && x.target === x.currentTarget) open();
}

/** The list is capped (the newest 500): how many there are, so a search or filter can narrow it. Null: all are shown. */
export function cappedLine(a: { entries: unknown[]; total: number } | null): string | null {
  return a && a.total > a.entries.length ? `Showing ${a.entries.length} of ${a.total}: search or filter to narrow it.` : null;
}

/** One entry: its kind's tile, its title and when, its kind and a line of it; a star on hover (kept on when starred). */
function Row({ e, onOpen, onStar, withSession, now }: { e: LibraryEntry; onOpen(e: LibraryEntry): void; onStar(e: LibraryEntry): void; withSession?: boolean; now: number }) {
  const k = KIND_WORDS[e.kind];
  return (
    <div className={`lib-r k-${e.kind}${e.starred ? ' starred' : ''}`} role="button" tabIndex={0} title={e.snippet || e.title} onClick={() => onOpen(e)} onKeyDown={(x) => rowKey(x, () => onOpen(e))}>
      <span className="lib-tile">
        <Icon name={k.icon} size={14} />
      </span>
      <span className="lib-nm">{e.title}</span>
      <span className="lib-at">{libraryWhen(e.at, now)}</span>
      <span className="lib-l2">
        <span className="lib-k">{k.one}{e.versions ? ` · ${e.versions} versions` : ''}</span>
        {withSession ? <span className="lib-ses">{e.session}</span> : null}
        <span className="lib-sn">{e.snippet}</span>
      </span>
      <button
        className="lib-star"
        aria-label={e.starred ? 'Unstar' : 'Star: pin it to the top'}
        aria-pressed={!!e.starred}
        title={e.starred ? 'Starred (pinned to the top): click to unstar' : 'Star it: pinned to the top'}
        onClick={(x) => (x.stopPropagation(), onStar(e))}
        onKeyDown={(x) => x.stopPropagation()}
      >
        <Icon name="Star" size={12} fill={e.starred ? 'currentColor' : 'none'} />
      </button>
    </div>
  );
}

/** The list itself (its groups as given): starred, then each project's sessions' entries. */
export function LibraryList({ groups, onOpen, onStar, onSession, now = Date.now() }: { groups: LibraryGroups; onOpen(e: LibraryEntry): void; onStar(e: LibraryEntry): void; onSession(sessionId: string): void; now?: number }) {
  return (
    <div className="lib-list">
      {groups.starred.length ? (
        <section className="lib-g">
          <div className="lib-h">
            <span>Starred</span>
            <span className="lib-n">{groups.starred.length}</span>
            <span className="lib-rule" />
          </div>
          {groups.starred.map((e) => (
            <Row key={e.id} e={e} onOpen={onOpen} onStar={onStar} withSession now={now} />
          ))}
        </section>
      ) : null}
      {groups.projects.map((p) => (
        <section key={p.key || 'none'} className="lib-g">
          <div className="lib-h">
            <span>{p.name ?? 'No project'}</span>
            <span className="lib-n">{p.sessions.reduce((n, s) => n + s.entries.length, 0)}</span>
            <span className="lib-rule" />
          </div>
          {p.sessions.map((s) => (
            <div key={s.sessionId} className="lib-s">
              <button className="lib-sh" disabled={!knownSession(s.sessionId)} title={knownSession(s.sessionId) ? 'Go to its session' : 'Its session is older than the list: Resume has it'} onClick={() => onSession(s.sessionId)}>
                <span>{s.name}</span>
                <Icon name="ArrowUpRight" size={11} />
              </button>
              {s.entries.map((e) => (
                <Row key={e.id} e={e} onOpen={onOpen} onStar={onStar} now={now} />
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** The Library's pane in the tool drawer. */
export function LibraryPane({ visible }: { visible: boolean }) {
  const { filter, answer, error, setFilter, load, star } = useLibrary();
  const [q, setQ] = useState(filter.q);
  const [said, setSaid] = useState<string | null>(null);
  const typing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // shown: read again (what sessions made meanwhile)
  useEffect(() => {
    if (visible) void load();
  }, [visible, load]);
  useEffect(() => () => void (typing.current && clearTimeout(typing.current)), []);
  const search = (v: string) => {
    setQ(v);
    if (typing.current) clearTimeout(typing.current);
    typing.current = setTimeout(() => setFilter({ q: v }), 200);
  };
  const open = (e: LibraryEntry) => void openEntry(e).then(setSaid);
  const kinds = answer?.kinds ?? {};
  const shown = LIBRARY_KINDS.filter((k) => (kinds[k] ?? 0) > 0 || filter.kind === k);
  const groups = groupLibrary(answer?.entries ?? []);
  const filtered = !!(filter.q || filter.kind || filter.when || filter.starred);
  return (
    <div className="lib" style={visible ? undefined : { display: 'none' }}>
      <div className="lib-top">
        <label className="lib-q">
          <Icon name="Search" size={13} />
          <input value={q} placeholder="Search titles and what they say" onChange={(e) => search(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && q && (e.stopPropagation(), search(''))} />
        </label>
        <div className="lib-chips">
          {shown.map((k: LibraryKind) => (
            <button key={k} className={`lib-chip${filter.kind === k ? ' on' : ''}`} onClick={() => setFilter({ kind: filter.kind === k ? null : k })}>
              {KIND_WORDS[k].label}
              <i>{kinds[k] ?? 0}</i>
            </button>
          ))}
        </div>
        <div className="lib-when">
          {WHENS.map((w) => (
            <button key={w.label} className={filter.when === w.id ? 'on' : ''} onClick={() => setFilter({ when: w.id })}>
              {w.label}
            </button>
          ))}
          <span className="spacer" />
          <button className={`lib-starred${filter.starred ? ' on' : ''}`} title="Only the starred ones" onClick={() => setFilter({ starred: !filter.starred })}>
            <Icon name="Star" size={11} fill={filter.starred ? 'currentColor' : 'none'} /> Starred
          </button>
        </div>
      </div>
      {said ? (
        <div className="lib-said" role="status">
          <span>{said}</span>
          <button className="mini" onClick={() => setSaid(null)}>
            ok
          </button>
        </div>
      ) : null}
      {error ? <div className="lib-empty">{error}</div> : null}
      {cappedLine(answer) ? <div className="lib-building">{cappedLine(answer)}</div> : null}
      {answer?.building ? <div className="lib-building">Still gathering everything sessions made (its first look)…</div> : null}
      {answer && !answer.entries.length && !answer.building ? (
        <div className="lib-empty">{filtered ? 'Nothing matches.' : 'Nothing yet. What your sessions make (explains, debriefs, artifacts, recaps, briefs) gathers here.'}</div>
      ) : null}
      <div className="lib-scroll">
        <LibraryList groups={groups} onOpen={open} onStar={(e) => void star(e.id, !e.starred)} onSession={(sid) => goToSession(sid)} />
      </div>
    </div>
  );
}

const openLibrary = () => useTools.getState().toggle(LIBRARY_ID);
/** The Library in Tools' icon row. */
export function LibraryButton({ on }: { on: boolean }) {
  const total = useLibrary((s) => s.answer?.total);
  return (
    <button className={`rt-b rt-cora cc-library${on ? ' on' : ''}`} title={`Library: everything your sessions made, in one place${total != null ? ` · ${total}` : ''}`} onClick={openLibrary}>
      <Icon name="LibraryBig" size={18} />
    </button>
  );
}
