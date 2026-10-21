import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FAM } from '@cora/shared';
import { agentKey, sessionEvents, useBrain } from '../state/store';
import { buildSteps, type Step } from '../lib/steps';
import { agentColor, clock, dur } from '../lib/format';
import { Icon, Tile } from './Icon';
import { SaidLine, ToolRow } from './ToolRow';
import { Markdown } from './Markdown';
import { LiveActivity } from './LiveActivity';
import { TaskPanel } from './TaskPanel';
import { speak, stopSpeaking, useVoice } from '../lib/voice';
import { openChanges, turnsFor } from '../lib/changes';
import { useCursorStep } from '../lib/replay';
import { Follow } from '../lib/follow';
import { markdownHtml } from '../lib/markdownHtml';
import { CopyButton, Linkify } from './Linkify';

/** Read a reply aloud (voice is opt-in: nothing shows unless it's on and a key is set). */
function SpeakBtn({ id, text, sessionId }: { id: string; text: string; sessionId: string }) {
  const on = useVoice((s) => s.settings.enabled && !!s.key?.set);
  const playing = useVoice((s) => s.reading?.id === id);
  if (!on) return null;
  return (
    <button className={`spk${playing ? ' playing' : ''}`} title={playing ? 'Stop reading' : 'Read aloud'} onClick={(e) => (e.stopPropagation(), playing ? stopSpeaking() : void speak(id, text, 4800, false, sessionId))}>
      <Icon name={playing ? 'Square' : 'Volume2'} size={11} />
    </button>
  );
}

/** At a turn's end: what it changed, one click from the review. */
function TurnChanges({ sessionId, ts }: { sessionId: string; ts: number }) {
  useBrain((s) => s.versions[sessionId]);
  const t = turnsFor(sessionId).find((x) => x.from <= ts && (x.to == null || x.to > ts));
  if (!t) return null;
  return (
    <button className="turn-ch" title="Review what this turn changed" onClick={() => {
      openChanges(sessionId, t.files[0].path, { from: t.from, to: t.to });
      useBrain.getState().setDiffWide(true);
    }}>
      · {t.files.length} file{t.files.length === 1 ? '' : 's'} <span className="plus">+{t.add}</span> <span className="minus">−{t.del}</span> · review
    </button>
  );
}

/** The sentence being read, under the reply, with how far through it is. */
function ReadingLine({ id }: { id: string }) {
  const r = useVoice((s) => (s.reading?.id === id ? s.reading : null));
  if (!r) return null;
  return (
    <div className="reading">
      <Icon name="AudioLines" size={11} /> {r.sentence}
      <div className="bar"><i style={{ width: `${Math.round(r.progress * 100)}%` }} /></div>
    </div>
  );
}

/** Narration as markdown. In hosted sessions main's text is also in the terminal below, so it starts collapsed. */
function Say({ text, clamp }: { text: string; clamp: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split(/\n/).length > 3;
  const collapsed = clamp && long && !open;
  return (
    <div className={`say${collapsed ? ' clamped' : ''}`}>
      <Markdown text={text} />
      {/* the whole reply as its markdown and as rich text (the HTML is rendered only when copied) */}
      <span className="say-copy">
        <CopyButton text={text} title="Copy the reply (markdown + formatted)" getHtml={() => markdownHtml(text)} />
      </span>
      {clamp && long ? (
        <button className="say-more" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'more · full reply is in the terminal'}
        </button>
      ) : null}
    </div>
  );
}

function StepView({ step, sessionId, hosted }: { step: Step; sessionId: string; hosted: boolean }) {
  const agents = useBrain((s) => s.agents);
  const setFilter = useBrain((s) => s.setAgentFilter);
  const a = agents[agentKey(sessionId, step.agentId)];
  const color = agentColor(a);
  const name = step.agentId === 'main' ? 'main' : a?.label ?? step.agentId.slice(0, 7);

  return (
    <div className={`step${step.agentId === 'main' ? '' : ' sub'}${step.cont ? ' cont' : ''}`} style={{ ['--c' as any]: color }}>
      {step.prompt ? (
        <div className={step.agentId === 'main' ? 'prompt' : 'task'}>
          <span className="pl">{step.agentId === 'main' ? 'you' : 'its task'}</span>
          <Linkify text={step.prompt} jira sessionId={sessionId} />
        </div>
      ) : null}
      <div className="sh">
        <i />
        <span className="sh-who">
          {name}
          {step.cont ? <span className="contd"> · continued</span> : null}
        </span>
        <span className="sh-rule" />
        <span className="ts">{clock(step.ts)}</span>
        {step.text ? <SpeakBtn id={step.key} text={step.text} sessionId={sessionId} /> : null}
      </div>
      {step.text ? <Say text={step.text} clamp={hosted && step.agentId === 'main'} /> : null}
      {step.text ? <ReadingLine id={step.key} /> : null}
      {step.said ? <SaidLine id={step.said.id} text={step.said.text} /> : null}
      <div className="body">
        {step.items.map((it) => {
          switch (it.kind) {
            case 'tool':
              return <ToolRow key={it.key} item={it} sessionId={sessionId} />;
            case 'think':
              if (it.e.durationMs == null && !it.e.tokens?.thinking) return null;
              return (
                <div key={it.key} className="think" title={it.e.tokens?.thinking ? `~${it.e.tokens.thinking} tokens of thinking (its content is hidden)` : 'its thinking is hidden'}>
                  thought{it.e.durationMs != null ? ` ${dur(it.e.durationMs)}` : ''}
                </div>
              );
            case 'spawn': {
              const child = it.childAgentId ? agents[agentKey(sessionId, it.childAgentId)] : undefined;
              return (
                <div key={it.key} className={`spawn${child?.state === 'done' ? ' done' : ''}`} onClick={() => child && setFilter(child.agentId)}>
                  {child ? <span className="go">open ›</span> : null}
                  <Tile name="GitFork" family="delegate" /> spawned <span className="dot" style={{ background: agentColor(child) }} />
                  <b>{child?.label ?? it.e.text}</b>
                  <span className="ss">{child ? (child.state === 'done' ? `✓ done${child.endedAt ? ` · ${dur(child.endedAt - child.startedAt)}` : ''}` : 'running…') : 'starting…'}</span>
                </div>
              );
            }
            case 'report':
              return (
                <div key={it.key} className="report">
                  <div className="report-h"><Tile name="Flag" family="delegate" /> <b>Report</b></div>
                  <Markdown text={it.e.text ?? ''} />
                </div>
              );
            case 'compact':
              return (
                <div key={it.key} className="divider">
                  <Icon name="Archive" size={11} /> context compacted
                </div>
              );
            case 'interrupt':
              return (
                <div key={it.key} className="divider interrupted">
                  <Icon name="OctagonX" size={11} /> interrupted
                </div>
              );
            case 'turn_end':
              return (
                <div key={it.key} className="divider">
                  <Icon name="CircleCheck" size={11} /> turn finished{it.e.durationMs ? ` · ${dur(it.e.durationMs)}` : ''}
                  <TurnChanges sessionId={sessionId} ts={it.e.ts} />
                </div>
              );
          }
        })}
      </div>
    </div>
  );
}

export function Transcript({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const agents = useBrain((s) => s.agents);
  const filter = useBrain((s) => s.agentFilter);
  const setFilter = useBrain((s) => s.setAgentFilter);
  const hosted = useBrain((s) => s.prefs.collapseHosted && s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  useBrain((s) => s.sessions[sessionId]?.color); // re-render when main's colour changes
  const [q, setQ] = useState('');
  // the scene asks for a search when you click a file satellite
  useEffect(() => {
    const on = (e: Event) => setQ(String((e as CustomEvent).detail ?? ''));
    window.addEventListener('cora:search', on);
    return () => window.removeEventListener('cora:search', on);
  }, []);
  const events = sessionEvents(sessionId);

  const sessionAgents = useMemo(
    () => Object.values(agents).filter((a) => a.sessionId === sessionId).sort((a, b) => (a.agentId === 'main' ? -1 : b.agentId === 'main' ? 1 : a.startedAt - b.startedAt)),
    [agents, sessionId],
  );
  const childBySpawn = useMemo(() => new Map(sessionAgents.filter((a) => a.parentToolUseId).map((a) => [a.parentToolUseId!, a.agentId])), [sessionAgents]);
  const steps = useMemo(() => {
    const all = buildSteps(events, filter, childBySpawn);
    if (!q.trim()) return all;
    const needle = q.toLowerCase();
    return all.filter((s) =>
      [s.text, s.prompt, ...s.items.map((i) => (i.kind === 'tool' ? `${(i.start ?? i.end)?.tool?.name} ${(i.start ?? i.end)?.tool?.summary}` : 'e' in i ? i.e.text : ''))]
        .filter(Boolean)
        .some((t) => t!.toLowerCase().includes(needle)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, filter, childBySpawn, q]);

  const [searching, setSearching] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  // whether we keep the newest activity in view (lib/follow); `follow` mirrors it for rendering the button
  const [fol] = useState(() => new Follow());
  const [follow, setFollow] = useState(true);
  const [unseen, setUnseen] = useState(false);
  // Row heights are cached per step, not per index: steps shift when events land mid-list or the filter changes.
  // No virt.measure() on expand: it clears every cached height, and only rows that resize get measured again (the
  // rest fall back to the estimate and overlap). The ResizeObserver behind measureElement re-measures changed rows.
  const virt = useVirtualizer({ count: steps.length, getScrollElement: () => scroller.current, estimateSize: () => 90, overscan: 8, getItemKey: (i) => steps[i]?.key ?? i });
  // the timeline's playhead: scroll to the step at it and mark it
  const atCursor = useCursorStep(sessionId, steps, (i) => virt.scrollToIndex(i, { align: 'center' }));

  // New activity, or another session / agent: a new view starts following here, in the same effect that scrolls,
  // so it lands at its end even when the last view was scrolled up.
  const view = `${sessionId}\n${filter}`;
  useEffect(() => {
    if (fol.setView(view)) {
      setFollow(true);
      setUnseen(false);
    }
    if (!steps.length) return;
    if (fol.following) virt.scrollToIndex(steps.length - 1, { align: 'end' });
    else setUnseen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steps.length, version, view]);
  // The feed getting shorter (the terminal opening a dialog, live-activity rows) or rows growing after they were
  // measured fire no scroll event and bring no new event: keep the end in view while following.
  useEffect(() => {
    const el = scroller.current;
    const inner = sizer.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => fol.resized(el));
    ro.observe(el);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [fol]);

  const onScroll = () => {
    const atBottom = fol.scrolled(scroller.current!);
    setFollow(atBottom);
    if (atBottom) setUnseen(false);
  };

  return (
    <aside className="journal">
      <div className="jhead">
        {searching || q ? (
          <div className="jsearch">
            <Icon name="Search" size={13} />
            <input autoFocus placeholder="Search the transcript…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (setQ(''), setSearching(false))} />
            <button className="jx" title="Close the search (Esc)" onClick={() => (setQ(''), setSearching(false))}>
              <Icon name="X" size={12} />
            </button>
          </div>
        ) : (
          <div className="chips">
            <div className="chips-scroll" onWheel={(e) => e.deltaY && (e.currentTarget.scrollLeft += e.deltaY)}>
            <button className={`chip${filter === 'all' ? ' on' : ''}`} onClick={() => setFilter('all')}>
              All
            </button>
            {sessionAgents.map((a) => (
              <button key={a.agentId} className={`chip${filter === a.agentId ? ' on' : ''}${a.state === 'done' ? ' done' : ''}`} title={a.state === 'done' ? 'done' : a.state === 'idle' ? 'idle' : 'live'} onClick={() => setFilter(a.agentId)}>
                <i style={{ background: agentColor(a) }} />
                {a.agentId === 'main' ? 'main' : a.label}
                {a.state !== 'done' && a.state !== 'idle' ? <span className="cl" /> : null}
              </button>
            ))}
            </div>
            <button className="jfind" title="Search the transcript" onClick={() => setSearching(true)}>
              <Icon name="Search" size={13} />
            </button>
          </div>
        )}
      </div>
      <TaskPanel sessionId={sessionId} />
      <div className={`feed${filter !== 'all' ? ' single' : ''}`} ref={scroller} onScroll={onScroll}>
        <div ref={sizer} style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {virt.getVirtualItems().map((vi) => (
            <div key={steps[vi.index].key} data-index={vi.index} ref={virt.measureElement} className={steps[vi.index].key === atCursor ? 'at-cursor' : undefined} style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}>
              <StepView step={steps[vi.index]} sessionId={sessionId} hosted={hosted} />
            </div>
          ))}
        </div>
        {!steps.length ? <div className="empty">{q ? 'No matches.' : 'Nothing yet.'}</div> : null}
      </div>
      <LiveActivity sessionId={sessionId} />
      {unseen && !follow ? (
        <button
          className="more"
          onClick={() => {
            fol.resume(scroller.current!);
            setFollow(true);
            setUnseen(false);
            virt.scrollToIndex(steps.length - 1, { align: 'end' });
          }}
        >
          ↓ new activity
        </button>
      ) : null}
    </aside>
  );
}
