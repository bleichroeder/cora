import { useEffect, useRef, useState } from 'react';
import { useBrain } from '../../state/store';
import { desktop } from '../../lib/desktop';
import { Markdown } from '../Markdown';
import { Icon } from '../Icon';
import { openSettings } from '../SettingsModal';

/**
 * The Board's Journal panel: this session's journal (Documents\Cora\Journal), read as it's written: its milestones, its
 * wrap-up, Claude Code's recaps. Newest at the bottom, where it opens; Open shows the file itself.
 */
export function JournalPanel({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const [j, setJ] = useState<{ file: string | null; text: string } | null>(null);
  const [on, setOn] = useState(true);
  const box = useRef<HTMLDivElement>(null);
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
  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: { journal?: { on?: boolean } }) => setOn(s.journal?.on !== false))
      .catch(() => {});
  }, []);
  // the newest entry in view
  useEffect(() => {
    const b = box.current;
    if (b) b.scrollTop = b.scrollHeight;
  }, [j?.text]);
  if (!j) return <div className="lb-empty">…</div>;
  if (!j.file)
    return (
      <div className="lb-jempty">
        <Icon name="BookOpen" size={20} />
        {on ? (
          <>
            <b>Nothing in the journal yet</b>
            <span>The session adds an entry at each milestone and a wrap-up when the work is done; recaps come in too.</span>
          </>
        ) : (
          <>
            <b>Journals are off</b>
            <button className="lb-pop" onClick={() => openSettings('sessions')}>
              Turn them on
            </button>
          </>
        )}
      </div>
    );
  return (
    <div className="lb-journal">
      <div className="lb-jbar">
        <span className="f" title={j.file}>
          {j.file.split(/[\\/]/).pop()}
        </span>
        {desktop?.openJournal ? (
          <button className="lb-pop" title="Open the file" onClick={() => desktop?.openJournal?.(j.file!)}>
            <Icon name="ExternalLink" size={11} /> Open
          </button>
        ) : null}
      </div>
      <div className="lb-jbody" ref={box}>
        <div className="lb-doc">
          <Markdown text={j.text} />
        </div>
      </div>
    </div>
  );
}
