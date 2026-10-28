import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { stillQueued } from '../lib/queued';
import { useVirtualizer } from '@tanstack/react-virtual';
import { FAM } from '@cora/shared';
import { agentKey, sessionEvents, useBrain } from '../state/store';
import { buildSteps, isYourCommand, type Item, type Step } from '../lib/steps';
import { runningCommand } from '../lib/composer';
import { shortDur } from '../lib/background';
import { maskSecrets } from '../lib/mask';
import { useComposer } from '../state/composer';
import { agentColor, clock, dur } from '../lib/format';
import { Icon, Tile } from './Icon';
import { RanRow, SaidLine, ToolRow } from './ToolRow';
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
    <button className={`spk${playing ? ' playing' : ''}`} title={playing ? 'Stop reading' : 'Read aloud'} onClick={(e) => (e.stopPropagation(), playing ? stopSpeaking() : void speak(id, text, 4800, false, sessionId, { now: true }))}>
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

/** A stretch of a background agent's work as one row (lib/steps): what it's on now; open it for every step. */
function FoldView({ step, sessionId, hosted }: { step: Step; sessionId: string; hosted: boolean }) {
  const [open, setOpen] = useState(false);
  const a = useBrain((s) => s.agents[agentKey(sessionId, step.agentId)]);
  const setFilter = useBrain((s) => s.setAgentFilter);
  const tools = step.items.filter((i): i is Extract<Item, { kind: 'tool' }> => i.kind === 'tool');
  const last = tools.at(-1);
  const t = (last?.end ?? last?.start)?.tool;
  const working = a ? a.state !== 'done' && a.state !== 'idle' : false;
  return (
    <div className={`step sub fold${step.cont ? ' cont' : ''}`} style={{ ['--c' as any]: agentColor(a) }}>
      <button className="fold-h" onClick={() => setOpen(!open)} title={open ? 'Fold it again' : 'Show every step of this stretch'}>
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} />
        <i />
        <b>{a?.label ?? step.agentId.slice(0, 7)}</b>
        <span className="fold-s">
          background · {working ? 'working' : 'done'} · {tools.length} step{tools.length === 1 ? '' : 's'}
        </span>
        {t ? (
          <span className="fold-last">
            {t.name} {t.summary}
          </span>
        ) : null}
        <span className="ts">{clock((last?.end ?? last?.start)?.ts ?? step.ts)}</span>
      </button>
      {open ? (
        <>
          <StepView step={step} sessionId={sessionId} hosted={hosted} bare />
          <button className="fold-tab" onClick={() => setFilter(step.agentId)}>
            all of its work on its own tab ›
          </button>
        </>
      ) : null}
    </div>
  );
}

/** One step: who, when, what it said, then what it did. `bare`: only what it did (inside a folded row). */
function StepView({ step, sessionId, hosted, bare }: { step: Step; sessionId: string; hosted: boolean; bare?: boolean }) {
  // its own agent only (a change to any other agent, in any session, isn't this row's business)
  const a = useBrain((s) => s.agents[agentKey(sessionId, step.agentId)]);
  // the subagents it spawned (shallow-compared: the same agents, no re-render)
  const spawned = step.items.flatMap((i) => (i.kind === 'spawn' && i.childAgentId ? [i.childAgentId] : []));
  const children = useBrain(useShallow((s) => spawned.map((id) => s.agents[agentKey(sessionId, id)])));
  const setFilter = useBrain((s) => s.setAgentFilter);
  const color = agentColor(a);
  const name = step.agentId === 'main' ? 'main' : a?.label ?? step.agentId.slice(0, 7);

  if (bare) return <div className="fold-body">{body()}</div>;
  // a command you ran yourself: yours, like a prompt (no "main" head: Claude didn't do it)
  if (step.ran) {
    const it = step.items[0];
    return <div className="step ran-step">{it?.kind === 'tool' ? <RanRow item={it} sessionId={sessionId} /> : null}</div>;
  }
  return (
    <div className={`step${step.agentId === 'main' ? '' : ' sub'}${step.cont ? ' cont' : ''}`} style={{ ['--c' as any]: color }}>
      {step.prompt ? (
        <div className={step.agentId === 'main' ? 'prompt' : 'task'}>
          <span className="pl">{step.agentId === 'main' ? (step.mid ? 'you · while it worked' : 'you') : 'its task'}</span>
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
      <div className="body">{body()}</div>
    </div>
  );

  function body() {
    return step.items.map((it) => {
          switch (it.kind) {
            case 'tool':
              return <ToolRow key={it.key} item={it} sessionId={sessionId} />;
            case 'think':
              // a note it wrote on its progress (shown in the terminal too): its words, quieter than a reply
              if (it.e.text)
                return (
                  <div key={it.key} className="think-note">
                    <Say text={it.e.text} clamp={false} />
                  </div>
                );
              if (it.e.durationMs == null && !it.e.tokens?.thinking) return null;
              return (
                <div key={it.key} className="think" title={it.e.tokens?.thinking ? `~${it.e.tokens.thinking} tokens of thinking (its content is hidden)` : 'its thinking is hidden'}>
                  thought{it.e.durationMs != null ? ` ${dur(it.e.durationMs)}` : ''}
                </div>
              );
            case 'spawn': {
              const child = it.childAgentId ? children[spawned.indexOf(it.childAgentId)] : undefined;
              return (
                <div key={it.key} className={`spawn${child?.state === 'done' ? ' done' : ''}`} onClick={() => child && setFilter(child.agentId)}>
                  {child ? <span className="go">open ›</span> : null}
                  <Tile name="GitFork" family="delegate" /> spawned <span className="dot" style={{ background: agentColor(child) }} />
                  <b>{child?.label ?? it.e.text}</b>
                  <span className="ss">{child ? (child.state === 'done' ? `✓ done${child.endedAt ? ` · ${dur(child.endedAt - child.startedAt)}` : ''}` : 'running…') : 'starting…'}</span>
                </div>
              );
            }
            case 'note':
              return it.e.kind === 'prompt' ? (
                <div key={it.key} className="task">
                  <span className="pl">its task</span>
                  <Linkify text={it.e.text ?? ''} jira sessionId={sessionId} />
                </div>
              ) : (
                <Say key={it.key} text={it.e.text ?? ''} clamp={false} />
              );
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
        });
  }
}

/** Messages you sent while Claude was working that it hasn't taken yet: pinned under the transcript until it does. */
function Queued({ sessionId, version }: { sessionId: string; version: number | undefined }) {
  // only while Claude is mid-turn: idle, it takes what you send at once, so nothing can still be waiting
  const midTurn = useBrain((s) => {
    const st = s.sessions[sessionId]?.state;
    return st === 'working' || st === 'thinking' || st === 'needs-you';
  });
  const waiting = useMemo(
    () => stillQueued(sessionEvents(sessionId)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version],
  );
  if (!midTurn || !waiting.length) return null;
  return (
    <div className="queued" title="Claude Code holds these until Claude is ready for them: at its next step, or when its turn ends">
      {waiting.map((e) => (
        <div key={e.id} className="q-row">
          <span className="q-tag">
            <Icon name="Clock" size={11} /> queued
          </span>
          <span className="q-t">{e.text}</span>
        </div>
      ))}
      <div className="q-note">Claude gets {waiting.length === 1 ? 'it' : 'them'} at its next step.</div>
    </div>
  );
}

/**
 * A command you sent from the composer with `!`, while it runs: Claude Code writes it to the transcript only once it's
 * done (then it shows as "you ran" in the feed and this goes).
 */
function Running({ sessionId, version }: { sessionId: string; version: number | undefined }) {
  const sent = useComposer((c) => c.sent[sessionId]);
  const live = useBrain((s) => s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const ran = useMemo(
    () => sessionEvents(sessionId).filter((e) => e.kind === 'tool' && isYourCommand(e)).map((e) => (e.phase === 'end' ? e.ts - (e.durationMs ?? 0) : e.ts)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId, version],
  );
  const r = live && sent ? runningCommand(sent, ran, Date.now()) : null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!r) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [r?.at]);
  if (!r) return null;
  return (
    <div className="ran live ran-now" title="Claude Code writes it to the transcript once it's done">
      <div className="ran-h">
        <span className="pl">you ran</span>
        <span className="out">running · {shortDur(Date.now() - r.at)}</span>
        <span className="spin" />
      </div>
      <pre className="ran-cmd">
        <span className="ps">!</span> {maskSecrets(r.command).text}
      </pre>
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
  // which subagent each spawn started: rebuilt (and the steps with it) only when that changes, not on every agent update
  const spawnSig = sessionAgents.filter((a) => a.parentToolUseId).map((a) => `${a.parentToolUseId}>${a.agentId}`).join('|');
  const childBySpawn = useMemo(() => new Map(spawnSig ? spawnSig.split('|').map((x) => x.split('>') as [string, string]) : []), [spawnSig]);
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
              {steps[vi.index].fold ? <FoldView step={steps[vi.index]} sessionId={sessionId} hosted={hosted} /> : <StepView step={steps[vi.index]} sessionId={sessionId} hosted={hosted} />}
            </div>
          ))}
        </div>
        {!steps.length ? <div className="empty">{q ? 'No matches.' : 'Nothing yet.'}</div> : null}
      </div>
      <Queued sessionId={sessionId} version={version} />
      <Running sessionId={sessionId} version={version} />
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
