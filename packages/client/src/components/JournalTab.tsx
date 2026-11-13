import { useEffect, useMemo, useState } from 'react';
import { useBrain } from '../state/store';
import { desktop } from '../lib/desktop';
import { journalItems, type JournalItem } from '../lib/journalDoc';
import { Markdown } from './Markdown';
import { Icon } from './Icon';
import { openSettings } from './SettingsModal';
import './journalTab.css';

const KIND: Record<JournalItem['kind'], string> = { done: 'done', decision: 'decision', finding: 'finding', blocker: 'blocker', wrapup: 'wrap-up', recap: 'recap', entry: '' };

/**
 * The session's Journal tab: its journal (Documents\Cora\Journal) as entries, the newest first, a day at a time: when,
 * what kind it is (a decision, a finding, something done, a blocker, the wrap-up, a recap), its words, and what it
 * points at. The short history of the session: what was done and decided, without scrolling the transcript for it.
 */
export function JournalTab({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const [j, setJ] = useState<{ file: string | null; text: string } | null>(null);
  const [on, setOn] = useState(true);
  // read again as the session goes (an entry lands with its tool call), at most every couple of seconds
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void fetch(`/api/journal/${encodeURIComponent(sessionId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((x: { file: string | null; text: string } | null) => live && x && setJ(x))
        .catch(() => {});
    }, j ? 1500 : 0);
    return () => ((live = false), clearTimeout(t));
  }, [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => setJ(null), [sessionId]);
  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { journal?: { on?: boolean } }) => setOn(s.journal?.on !== false))
      .catch(() => {});
  }, []);
  const count = useMemo(() => journalItems(j?.text ?? '').length, [j?.text]);
  if (!j) return <div className="jt-empty">…</div>;
  if (!j.file || !count)
    return (
      <div className="jt-empty">
        <Icon name="BookOpen" size={20} />
        {on ? (
          <>
            <b>Nothing in the journal yet</b>
            <span>The session adds an entry at each milestone and a wrap-up when the work is done; recaps come in too.</span>
          </>
        ) : (
          <>
            <b>Journals are off</b>
            <button className="jt-btn" onClick={() => openSettings('sessions')}>
              Turn them on
            </button>
          </>
        )}
      </div>
    );
  return (
    <div className="jtab">
      <JournalList text={j.text} sessionId={sessionId} />
      <div className="jt-foot">
        <span className="f" title={j.file}>
          {count} {count === 1 ? 'entry' : 'entries'} · {j.file.split(/[\\/]/).pop()}
        </span>
        {desktop?.openJournal ? (
          <button className="jt-btn" title="Open the file" onClick={() => desktop?.openJournal?.(j.file!)}>
            <Icon name="ExternalLink" size={11} /> Open
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The entries themselves: newest first, under their day. */
export function JournalList({ text, sessionId }: { text: string; sessionId: string }) {
  const days = useMemo(() => {
    const out: { day: string; items: JournalItem[] }[] = [];
    for (const it of journalItems(text).reverse()) {
      const last = out[out.length - 1];
      if (last?.day === it.day) last.items.push(it);
      else out.push({ day: it.day, items: [it] });
    }
    return out;
  }, [text]);
  return (
    <div className="jt-list">
      {days.map((d) => (
        <section className="jt-day" key={d.day}>
          <h4>
            <span>{d.day}</span>
          </h4>
          {d.items.map((it, i) => (
            <article className={`jt-entry k-${it.kind}`} key={`${it.time}:${i}`}>
              <header>
                {KIND[it.kind] ? <span className="jt-kind">{KIND[it.kind]}</span> : null}
                <time>{it.time}</time>
              </header>
              <div className="jt-body">
                <Markdown text={it.body} files={sessionId} />
              </div>
              {it.refs.length ? (
                <footer>
                  {it.refs.map((r, k) => (
                    <span className="jt-ref" key={k}>
                      <Markdown text={r} files={sessionId} />
                    </span>
                  ))}
                </footer>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </div>
  );
}
