import { useEffect, useState } from 'react';
import { askProgress } from '../lib/debrief';
import { useBrain, sessionEvents } from '../state/store';
import { currentAction, sessionColor } from '../lib/format';
import { useDebrief, debriefMarkdownOf } from '../state/debrief';
import { ago } from '../lib/format';
import { Icon } from './Icon';
import { VideoButton } from './Videos';

/** A session's debriefs (its walk-throughs of its work), newest first: play one in the IDE panel, or export it. */
export function DebriefList({ sessionId }: { sessionId: string }) {
  const list = useDebrief((s) => s.lists[sessionId]);
  const on = useDebrief((s) => (s.on?.sessionId === sessionId ? s.on : null));
  const needsIde = useDebrief((s) => s.needsIde === sessionId);
  const asking = useDebrief((s) => s.asking[sessionId]);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => void useDebrief.getState().load(sessionId), [sessionId]);
  // on show: they're seen (the dot on Changes goes)
  useEffect(() => useDebrief.getState().markSeen((list ?? []).map((x) => x.id)), [list]);
  if (!list?.length && !asking) return null;
  const db = useDebrief.getState();

  const copy = async (id: string) => {
    const md = await debriefMarkdownOf(sessionId, id);
    if (!md) return;
    await navigator.clipboard?.writeText(md).catch(() => {});
    setDone(id);
    setTimeout(() => setDone((x) => (x === id ? null : x)), 2000);
  };
  const save = async (id: string, title: string) => {
    const md = await debriefMarkdownOf(sessionId, id);
    if (!md) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([md], { type: 'text/markdown' }));
    a.download = `${title.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'debrief'}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <section className="db-list">
      <div className="ex-gh">
        <span>Debriefs</span>
        <span className="ex-n">{list?.length ?? 0}</span>
        <span className="ex-rule" />
      </div>
      {asking ? <Writing sessionId={sessionId} ask={asking} /> : null}
      {(list ?? []).map((x) => {
        const playing = on?.d.id === x.id ? on : null;
        return (
          <div key={x.id} className={`db-row${playing ? ' on' : ''}`}>
            <button className="db-main" onClick={() => (playing ? null : void db.start(sessionId, x.id))} title={playing ? undefined : 'Play it in the IDE panel'}>
              <span className={`ex-tile db-tile ${x.depth}`}>
                <Icon name={x.depth === 'teach' ? 'GraduationCap' : 'Presentation'} size={14} />
              </span>
              <span className="ex-main">
                <span className="ex-t">{x.title}</span>
                <span className="ex-l2">
                  {playing ? (needsIde ? 'waiting for the IDE panel' : `step ${playing.at.step + 1} of ${x.steps + (playing.d.quiz?.length ? 1 : 0)}${playing.playing ? ' · playing' : ''}`) : `${x.depth === 'teach' ? 'teach me' : 'quick'} · ${x.steps} step${x.steps === 1 ? '' : 's'} · ${ago(x.createdAt)} ago`}
                  {!playing && x.changed ? (
                    <span className={`db-cov${x.missed?.length ? ' gap' : ''}`} title={x.missed?.length ? `Not covered: ${x.missed.map((p) => p.split(/[\\/]/).pop()).join(', ')}` : 'Every file changed in that work is covered'}>
                      {x.missed?.length ? `covers ${x.changed - x.missed.length} of ${x.changed} files` : `covers all ${x.changed} file${x.changed === 1 ? '' : 's'}`}
                    </span>
                  ) : null}
                </span>
              </span>
            </button>
            {playing ? (
              <span className="db-ctl">
                <button title="Back (Alt+←)" onClick={() => db.back()}>
                  <Icon name="ChevronLeft" size={14} />
                </button>
                <button title={playing.playing ? 'Pause' : 'Play it through'} onClick={() => (playing.playing ? db.pause() : db.play())}>
                  <Icon name={playing.playing ? 'Pause' : 'Play'} size={13} />
                </button>
                <button title="Next (Alt+→)" onClick={() => db.next()}>
                  <Icon name="ChevronRight" size={14} />
                </button>
                <button className={playing.speak ? 'lit' : ''} title={playing.speak ? 'Stop reading it aloud' : 'Read it aloud as you step'} onClick={() => db.toggleSpeak()}>
                  <Icon name={playing.speak ? 'Volume2' : 'VolumeX'} size={13} />
                </button>
                <button title="End the debrief" onClick={() => db.end()}>
                  <Icon name="X" size={13} />
                </button>
              </span>
            ) : (
              <span className="db-ctl quiet">
                <button title="Copy it as markdown (a PR description, a ticket comment)" onClick={() => void copy(x.id)}>
                  <Icon name={done === x.id ? 'Check' : 'Copy'} size={12} />
                </button>
                <button title="Save it as a markdown file" onClick={() => void save(x.id, x.title)}>
                  <Icon name="Download" size={12} />
                </button>
                <VideoButton sessionId={sessionId} debriefId={x.id} />
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** The ask in flight: what the session is doing as it writes the debrief, how long it's been; or that it ended without one. */
function Writing({ sessionId, ask }: { sessionId: string; ask: { depth: 'quick' | 'teach'; at: number; missed?: boolean } }) {
  const s = useBrain((st) => st.sessions[sessionId]);
  useBrain((st) => st.versions[sessionId]);
  const [, tick] = useState(0);
  useEffect(() => {
    if (ask.missed) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ask.missed]);
  const events = sessionEvents(sessionId);
  const where = askProgress(events, ask.at);
  const act = currentAction(events, 'main');
  const secs = Math.max(0, Math.round((Date.now() - ask.at) / 1000));
  const took = secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, '0')}s`;
  const line = ask.missed
    ? 'Its turn ended without one: it may have answered in words.'
    : s?.state === 'needs-you'
      ? 'Waiting for you: it needs an OK to go on'
      : where === 'queued'
        ? "Waiting its turn: it's finishing what it was doing"
        : act?.live
          ? act.text
          : 'Thinking it through';
  return (
    <div className={`db-row db-writing${ask.missed ? ' missed' : ''}`} style={{ ['--k' as string]: s ? sessionColor(s) : 'var(--cora)' }}>
      <span className="db-main">
        <span className={`ex-tile db-tile ${ask.depth}`}>
          <Icon name={ask.missed ? 'CircleAlert' : ask.depth === 'teach' ? 'GraduationCap' : 'Presentation'} size={14} />
        </span>
        <span className="ex-main">
          <span className="ex-t">{ask.missed ? 'No debrief came' : `Writing a debrief · ${ask.depth === 'teach' ? 'Teach me' : 'Quick'}`}</span>
          <span className="ex-l2">
            <span className="db-now">{line}</span>
            {ask.missed ? null : <span className="db-took">{took}</span>}
          </span>
        </span>
      </span>
      <span className="db-ctl">
        <button title="See it in the transcript" onClick={() => useBrain.getState().setRightTab('transcript')}>
          <Icon name="ScrollText" size={13} />
        </button>
        {ask.missed ? (
          <button title="Dismiss" onClick={() => useDebrief.getState().dismissAsk(sessionId)}>
            <Icon name="X" size={13} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
