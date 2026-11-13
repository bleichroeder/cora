import { useEffect, useState } from 'react';
import { agentKey, useBrain } from '../state/store';
import type { Item, Step } from '../lib/steps';
import { workSummary, type Group, type Turn, type WorkPart } from '../lib/turns';
import { agentColor, clock, dur } from '../lib/format';
import { openChanges, turnsFor } from '../lib/changes';
import { markdownHtml } from '../lib/markdownHtml';
import { Icon, Tile } from './Icon';
import { SaidLine, ToolRow } from './ToolRow';
import { Markdown } from './Markdown';
import { CopyButton } from './Linkify';
import { openInBrowser } from './JiraChip';
import { FoldView, NoticeRow, PromptText, ReadingLine, SpeakBtn, StepView } from './StepView';
import './turns.css';

/**
 * One turn of the transcript: your prompt (pinned at the top while you read its turn), what it did as one line you
 * can open (its steps grouped by kind), what Claude Code's terminal recorded meanwhile, its answer in full, and what
 * it left behind (the files it changed, a merge request).
 */
export function TurnView({ turn, sessionId, hosted }: { turn: Turn; sessionId: string; hosted: boolean }) {
  if (turn.ran) return <StepView step={turn.ran} sessionId={sessionId} hosted={hosted} />;
  const links = turn.notices.filter((n) => n.kind === 'notice' && n.e.notice?.type === 'link');
  const rows = turn.notices.filter((n) => !links.includes(n));
  return (
    <section className={`turn${turn.live ? ' live' : ''}`}>
      {turn.prompt ? (
        <div className="t-prompt">
          <div className="t-pin">
            <span className="t-who">you</span>
            <div className="t-txt">
              <PromptText text={turn.prompt.text} sessionId={sessionId} />
            </div>
            <span className="t-ts">{clock(turn.prompt.ts)}</span>
          </div>
        </div>
      ) : turn.wake ? (
        <div className="t-prompt wake">
          <div className="t-pin">
            <span className="t-who">scheduled</span>
            <div className="t-txt">{turn.wake}</div>
            <span className="t-ts">{clock(turn.ts)}</span>
          </div>
        </div>
      ) : null}
      {turn.work.length || turn.live ? <WorkLine turn={turn} sessionId={sessionId} hosted={hosted} /> : null}
      {rows.map((n) => (n.kind === 'notice' ? <NoticeRow key={n.key} item={n} /> : null))}
      {turn.answer ? <Answer a={turn.answer} sessionId={sessionId} /> : null}
      <Outcome turn={turn} links={links} sessionId={sessionId} />
      {turn.end ? <End item={turn.end} /> : null}
    </section>
  );
}

function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** What the turn did, in one line ("Worked 4m 10s · read 3 files · ran 2"); open it for the steps. Open while it runs. */
function WorkLine({ turn, sessionId, hosted }: { turn: Turn; sessionId: string; hosted: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  useTick(turn.live);
  const shown = open ?? turn.live;
  const ms = turn.live ? Date.now() - turn.ts : turn.stats.ms;
  const sum = workSummary(turn);
  return (
    <div className={`t-work${shown ? ' open' : ''}`}>
      <button className="t-work-h" onClick={() => setOpen(!shown)} title={shown ? 'Fold the steps' : 'Show the steps'}>
        <Icon name="ChevronRight" size={12} className="t-chev" />
        <span className="t-sum">
          {turn.live ? 'Working' : 'Worked'}
          {ms != null ? <b> {dur(ms)}</b> : null}
          {sum ? ` · ${sum}` : turn.stats.thinkMs ? ' · thought' : ''}
        </span>
        {turn.prompt || turn.wake ? null : <span className="t-ts">{clock(turn.ts)}</span>}
      </button>
      {shown ? (
        <div className="t-steps">
          {turn.work.map((p) => (
            <Part key={partKey(p)} p={p} sessionId={sessionId} hosted={hosted} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

const partKey = (p: WorkPart) => (p.kind === 'group' ? p.g.key : p.kind === 'agent' || p.kind === 'fold' ? `${p.step.key}#${p.kind}` : p.kind === 'item' ? p.item.key : p.key);

function Part({ p, sessionId, hosted }: { p: WorkPart; sessionId: string; hosted: boolean }) {
  switch (p.kind) {
    case 'group':
      return <GroupRow g={p.g} sessionId={sessionId} />;
    case 'note':
      return (
        <div className="t-note">
          <Markdown text={p.text} files={sessionId} />
        </div>
      );
    case 'mid':
      return (
        <div className="t-mid">
          <span className="t-who">you · while it worked</span>
          <PromptText text={p.text} sessionId={sessionId} />
        </div>
      );
    case 'agent':
      return <AgentRow step={p.step} sessionId={sessionId} hosted={hosted} />;
    case 'fold':
      return <FoldView step={p.step} sessionId={sessionId} hosted={hosted} />;
    case 'item':
      return <StepView step={one(p.item)} sessionId={sessionId} hosted={hosted} bare />;
  }
}

const one = (item: Item): Step => ({ key: `${item.key}#one`, agentId: 'main', ts: 'e' in item ? item.e.ts : 0, cont: false, items: [item], fingerprint: [] });

/** Consecutive tool calls of one kind as one row; open it for each call. */
function GroupRow({ g, sessionId }: { g: Group; sessionId: string }) {
  const [open, setOpen] = useState(false);
  const icon = (g.items[0].end ?? g.items[0].start)?.icon;
  const running = g.items.some((i) => !i.end);
  return (
    <div className={`t-grp${open ? ' open' : ''}`}>
      <button className="t-grp-h" onClick={() => setOpen(!open)}>
        {icon ? <Tile name={icon.name} family={icon.family} failed={g.failed > 0} live={running} /> : null}
        <span className="t-g-l">
          {g.label}
          {g.detail ? <em> {g.detail}</em> : null}
        </span>
        <span className={`t-g-r${g.failed ? ' bad' : ''}`}>{g.failed ? `${g.failed} failed` : running ? 'running' : g.items.length}</span>
      </button>
      {open ? (
        <div className="t-grp-items">
          {g.items.map((i) => (
            <ToolRow key={i.key} item={i} sessionId={sessionId} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A subagent's stretch of work in the turn: who, how many steps, what it's on; open it for its steps. */
function AgentRow({ step, sessionId, hosted }: { step: Step; sessionId: string; hosted: boolean }) {
  const [open, setOpen] = useState(false);
  const a = useBrain((s) => s.agents[agentKey(sessionId, step.agentId)]);
  const setFilter = useBrain((s) => s.setAgentFilter);
  const tools = step.items.filter((i): i is Extract<Item, { kind: 'tool' }> => i.kind === 'tool');
  const last = (tools.at(-1)?.end ?? tools.at(-1)?.start)?.tool;
  const working = a ? a.state !== 'done' && a.state !== 'idle' : false;
  return (
    <div className="t-agent" style={{ ['--c' as any]: agentColor(a) }}>
      <button className="t-agent-h" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'ChevronDown' : 'ChevronRight'} size={12} />
        <i />
        <b>{a?.label ?? step.agentId.slice(0, 7)}</b>
        <span className="t-g-l">
          <em>
            {working ? 'working' : 'done'} · {tools.length ? `${tools.length} step${tools.length === 1 ? '' : 's'}` : step.items.some((i) => i.kind === 'report') ? 'its report' : step.prompt ? 'its task' : 'a note'}
            {last ? ` · ${last.name} ${last.summary}` : ''}
          </em>
        </span>
      </button>
      {open ? (
        <div className="t-agent-b">
          <StepView step={step} sessionId={sessionId} hosted={hosted} />
          <button className="fold-tab" onClick={() => setFilter(step.agentId)}>
            all of its work on its own tab ›
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** What it said at the end of the turn, in full; a very long one opens in place. */
function Answer({ a, sessionId }: { a: NonNullable<Turn['answer']>; sessionId: string }) {
  const long = a.text.length > 1400 || a.text.split(/\n/).length > 22;
  const [open, setOpen] = useState(false);
  return (
    <div className="t-answer-wrap">
      {a.text ? (
        <div className={`t-answer${long && !open ? ' clamped' : ''}`}>
          <Markdown text={a.text} files={sessionId} />
          <span className="t-a-tools">
            <SpeakBtn id={a.key} text={a.text} sessionId={sessionId} />
            <CopyButton text={a.text} title="Copy the answer (markdown + formatted)" getHtml={() => markdownHtml(a.text)} />
          </span>
        </div>
      ) : null}
      {long ? (
        <button className="t-more" onClick={() => setOpen(!open)}>
          {open ? 'less' : 'show the whole answer'}
        </button>
      ) : null}
      <ReadingLine id={a.key} />
      {a.said ? <SaidLine id={a.said.id} text={a.said.text} sessionId={sessionId} /> : null}
    </div>
  );
}

/** What the turn left behind, each a click from its view: the files it changed, a merge request. */
function Outcome({ turn, links, sessionId }: { turn: Turn; links: Item[]; sessionId: string }) {
  useBrain((s) => s.versions[sessionId]);
  const endTs = turn.end && turn.end.kind === 'turn_end' ? turn.end.e.ts : null;
  const ch = endTs != null ? turnsFor(sessionId).find((x) => x.from <= endTs && (x.to == null || x.to > endTs)) : undefined;
  if (!ch && !links.length) return null;
  return (
    <div className="t-outcome">
      {ch ? (
        <button
          className="t-chip"
          title="Review what this turn changed"
          onClick={() => {
            openChanges(sessionId, ch.files[0].path, { from: ch.from, to: ch.to });
            useBrain.getState().setDiffWide(true);
          }}
        >
          <i style={{ background: 'var(--work)' }} />
          {ch.files.length} file{ch.files.length === 1 ? '' : 's'} <span className="plus">+{ch.add}</span> <span className="minus">−{ch.del}</span> · review
        </button>
      ) : null}
      {links.map((l) =>
        l.kind === 'notice' && l.e.notice?.url ? (
          <button key={l.key} className="t-chip" title={l.e.notice.url} onClick={() => openInBrowser(l.e.notice!.url!, sessionId)}>
            <i style={{ background: 'var(--cora)' }} />
            {l.e.notice.text}
          </button>
        ) : null,
      )}
    </div>
  );
}

function End({ item }: { item: Item }) {
  if (item.kind === 'interrupt')
    return <div className="t-end bad">{'e' in item && item.e.text?.startsWith('Cancelled') ? 'cancelled · back in the composer' : 'interrupted'}</div>;
  const ms = 'e' in item ? item.e.durationMs : undefined;
  return <div className="t-end">finished{ms ? ` · ${dur(ms)}` : ''}</div>;
}
