import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { agentKey, useBrain } from '../state/store';
import { type Item, type Step } from '../lib/steps';
import { agentColor, clock, dur } from '../lib/format';
import { Icon, Tile } from './Icon';
import { CommandRow, RanRow, SaidLine, ToolRow } from './ToolRow';
import { Markdown } from './Markdown';
import { PromptImages } from './FilePeek';
import { splitPrompt } from '../lib/filePaths';
import { speak, stopSpeaking, useVoice } from '../lib/voice';
import { openChanges, turnsFor } from '../lib/changes';
import { markdownHtml } from '../lib/markdownHtml';
import { CopyButton, Linkify } from './Linkify';

/** One step of the transcript (an agent's words and what it did), and the pieces the turn view shares with it. */

/** Read a reply aloud (voice is opt-in: nothing shows unless it's on and a key is set). */
export function SpeakBtn({ id, text, sessionId }: { id: string; text: string; sessionId: string }) {
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
export function TurnChanges({ sessionId, ts }: { sessionId: string; ts: number }) {
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
export function ReadingLine({ id }: { id: string }) {
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
export function Say({ text, clamp, sessionId }: { text: string; clamp: boolean; /** its session: file paths in its `code` can be looked at */ sessionId?: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 240 || text.split(/\n/).length > 3;
  const collapsed = clamp && long && !open;
  return (
    <div className={`say${collapsed ? ' clamped' : ''}`}>
      <Markdown text={text} {...(sessionId ? { files: sessionId } : {})} />
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
export function FoldView({ step, sessionId, hosted }: { step: Step; sessionId: string; hosted: boolean }) {
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

/** Your prompt: its words (file paths in them clickable), and the pictures you attached as thumbnails under them. */
export function PromptText({ text, sessionId }: { text: string; sessionId: string }) {
  const p = splitPrompt(text);
  return (
    <>
      {p.text ? <Linkify text={p.text} jira files sessionId={sessionId} /> : null}
      {p.images.length ? <PromptImages sessionId={sessionId} paths={p.images} /> : null}
    </>
  );
}

/** One step: who, when, what it said, then what it did. `bare`: only what it did (inside a folded row). */
export function StepView({ step, sessionId, hosted, bare }: { step: Step; sessionId: string; hosted: boolean; bare?: boolean }) {
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
    return <div className="step ran-step">{it?.kind === 'tool' ? <RanRow item={it} sessionId={sessionId} /> : it?.kind === 'command' ? <CommandRow item={it} /> : null}</div>;
  }
  return (
    <div className={`step${step.agentId === 'main' ? '' : ' sub'}${step.cont ? ' cont' : ''}`} style={{ ['--c' as any]: color }}>
      {step.wake ? (
        <div className="task">
          <span className="pl">scheduled</span>
          {step.wake}
        </div>
      ) : null}
      {step.prompt ? (
        <div className={step.agentId === 'main' ? 'prompt' : 'task'}>
          <span className="pl">{step.agentId === 'main' ? (step.mid ? 'you · while it worked' : 'you') : 'its task'}</span>
          <PromptText text={step.prompt} sessionId={sessionId} />
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
      {step.text ? <Say text={step.text} clamp={hosted && step.agentId === 'main'} sessionId={sessionId} /> : null}
      {step.text ? <ReadingLine id={step.key} /> : null}
      {step.said ? <SaidLine id={step.said.id} text={step.said.text} sessionId={sessionId} /> : null}
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
                    <Say text={it.e.text} clamp={false} sessionId={sessionId} />
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
                <Say key={it.key} text={it.e.text ?? ''} clamp={false} sessionId={sessionId} />
              );
            case 'report':
              return (
                <div key={it.key} className="report">
                  <div className="report-h"><Tile name="Flag" family="delegate" /> <b>Report</b></div>
                  <Markdown text={it.e.text ?? ''} />
                </div>
              );
            case 'notice':
              return <NoticeRow key={it.key} item={it} />;
            case 'compact':
              return (
                <div key={it.key} className="divider">
                  <Icon name="Archive" size={11} /> context compacted
                </div>
              );
            case 'interrupt':
              return (
                <div key={it.key} className="divider interrupted">
                  {/* taken back with Esc just after it went (Cora's marker: Claude Code writes none for it) */}
                  {it.e.text?.startsWith('Cancelled') ? (
                    <>
                      <Icon name="Undo2" size={11} /> cancelled · back in the composer
                    </>
                  ) : (
                    <>
                      <Icon name="OctagonX" size={11} /> interrupted
                    </>
                  )}
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

const NOTICE: Record<string, { cls: string; icon: string; head?: string }> = {
  error: { cls: 'err', icon: 'TriangleAlert' },
  limit: { cls: 'err', icon: 'OctagonPause', head: 'Stopped by a limit.' },
  missed: { cls: 'warn', icon: 'Unplug' },
  info: { cls: 'info', icon: 'Info' },
  mode: { cls: 'info', icon: 'Map' },
  wakeup: { cls: 'info', icon: 'AlarmClock' },
};

/** Something Claude Code's terminal recorded: an error, a limit, a notice. */
export function NoticeRow({ item }: { item: Extract<Item, { kind: 'notice' }> }) {
  const n = item.e.notice;
  if (!n) return null;
  const k = NOTICE[n.type] ?? NOTICE.info;
  return (
    <div className={`t-ev ${k.cls}`}>
      <span className="t-ev-i">
        <Icon name={k.icon} size={12} />
      </span>
      <span className="t-ev-t">
        {k.head ? <b>{k.head} </b> : null}
        {n.text}
      </span>
      <span className="t-ts">{clock(item.e.ts)}</span>
    </div>
  );
}
