import { useEffect, useMemo, useState } from 'react';
import { FAM, shortToolName } from '@cora/shared';
import type { Item } from '../lib/steps';
import { maskSecrets } from '../lib/mask';
import { dur } from '../lib/format';
import { fetchToolDetail } from '../state/ws';
import { Tile, Icon } from './Icon';
import { explainFrom } from './Viewer';
import { SPEAK_TOOL, isPresentTool } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { speak, stopSpeaking, useVoice } from '../lib/voice';
import { backgroundTasks, outcome, shortDur } from '../lib/background';
import { openChanges } from '../lib/changes';
import { CopyButton, Linkify, OpenButton, firstUrl } from './Linkify';
import { explainPreview } from '../lib/explainPreview';

/** Next to a row: copy its shell command, open its web address. */
function RowActions({ tool }: { tool: { name?: string; input?: unknown; summary?: string } }) {
  const inp = (tool.input ?? {}) as { command?: unknown; url?: unknown };
  const command = /^(Bash|PowerShell)$/.test(tool.name ?? '') && typeof inp.command === 'string' ? inp.command : null;
  const url = (typeof inp.url === 'string' && /^https?:/i.test(inp.url) ? inp.url : null) ?? firstUrl(command ?? tool.summary ?? '');
  if (!command && !url) return null;
  return (
    <span className="row-acts">
      {command ? <CopyButton text={command} title="Copy the command" /> : null}
      {url ? <OpenButton url={url} /> : null}
    </span>
  );
}

/** A command sent to the background: running with a live timer, then how it ended. */
function BgOut({ sessionId, toolUseId }: { sessionId: string; toolUseId: string }) {
  const version = useBrain((st) => st.versions[sessionId]);
  const t = useMemo(() => backgroundTasks(sessionEvents(sessionId)).find((x) => x.key === toolUseId), [sessionId, toolUseId, version]);
  const [, tick] = useState(0);
  const running = t != null && t.endedAt == null;
  useEffect(() => {
    if (!running) return;
    const h = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(h);
  }, [running]);
  if (!t) return <span className="bgout">  in background</span>;
  if (running) return <span className="bgout running">  ⟳ in background · {shortDur(Date.now() - t.startedAt)}</span>;
  return <span className={`bgout ${t.status}`}>  {t.status === 'completed' ? '✓' : t.status === 'failed' ? '✗' : '■'} {outcome(t)}</span>;
}

/** An explain (a document Claude presented): a card that opens the viewer. */
function ExplainCard({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const e = item.start ?? item.end!;
  const p = explainFrom(e);
  const open = useBrain((s) => s.viewer?.toolUseId === e.toolUseId);
  if (!p) return null;
  const preview = explainPreview(p.content ?? '', p.format === 'html' ? 'html' : 'markdown');
  return (
    <div className={`explain-card${open ? ' on' : ''}`} onClick={() => useBrain.getState().setViewer(open ? null : p)}>
      <div className="pc-h">
        <Tile name="Presentation" family="plan" live={!item.end} />
        <b>{p.title}</b>
        <span className="fmt">{p.format === 'html' ? 'HTML' : 'markdown'}</span>
        <span className="spacer" />
        <span className="go">{open ? 'showing' : <>open <Icon name="ChevronRight" size={11} /></>}</span>
      </div>
      {preview ? <div className="pc-p">{preview}</div> : null}
    </div>
  );
}

function Masked({ text, jira, sessionId }: { text: string; jira?: boolean; sessionId?: string }) {
  const [reveal, setReveal] = useState(false);
  const m = maskSecrets(text);
  return (
    <>
      <Linkify text={reveal ? text : m.text} jira={jira} sessionId={sessionId} />
      {m.masked ? (
        <button className="reveal" onClick={() => setReveal(!reveal)}>
          {reveal ? 'hide secrets' : 'reveal'}
        </button>
      ) : null}
    </>
  );
}

/** A line Claude said out loud (its speak tool): one dim line, with a button to hear it again. */
function SaidRow({ item }: { item: Extract<Item, { kind: 'tool' }> }) {
  const e = item.start ?? item.end!;
  const tool = { ...item.start?.tool, ...item.end?.tool };
  const text = String((tool.input as { text?: unknown } | undefined)?.text ?? tool.summary ?? '');
  // the same id the automation reads it under, so the button shows stop while it's being said
  return <SaidLine id={`said:${e.toolUseId}`} text={text} failed={Boolean(item.end?.tool?.failed)} />;
}

/** A spoken line (a speak call, or a reply's say-line): dim and italic, with a button to hear it again. */
export function SaidLine({ id, text, failed = false }: { id: string; text: string; failed?: boolean }) {
  const on = useVoice((s) => s.settings.enabled && !!s.key?.set);
  const playing = useVoice((s) => s.reading?.id === id);
  return (
    <div className={`said${playing ? ' playing' : ''}${failed ? ' fail' : ''}`} title={failed ? 'Not said: spoken summaries were off' : undefined}>
      <span className="said-t">🔊 said: {text}</span>
      {on && text ? (
        <button className={`spk${playing ? ' playing' : ''}`} title={playing ? 'Stop' : 'Say it again'} onClick={() => (playing ? stopSpeaking() : void speak(id, text, 400, false, undefined, { now: true }))}>
          <Icon name={playing ? 'Square' : 'RotateCcw'} size={10} />
        </button>
      ) : null}
    </div>
  );
}

export function ToolRow({ item, sessionId }: { item: Extract<Item, { kind: 'tool' }>; sessionId: string }) {
  const e = item.start ?? item.end!;
  if (isPresentTool(e.tool?.name)) return <ExplainCard item={item} />;
  if (e.tool?.name === SPEAK_TOOL) return <SaidRow item={item} />;
  return <PlainToolRow item={item} sessionId={sessionId} />;
}

function PlainToolRow({ item, sessionId }: { item: Extract<Item, { kind: 'tool' }>; sessionId: string }) {
  const e = item.start ?? item.end!;
  const tool = { ...item.start?.tool, ...item.end?.tool } as NonNullable<typeof e.tool>;
  const live = !item.end;
  const failed = Boolean(item.end?.tool?.failed);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<{ input: unknown; result: string } | null | 'loading'>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && detail === null && e.toolUseId) {
      setDetail('loading');
      const d = await fetchToolDetail(sessionId, e.toolUseId);
      setDetail(d ?? { input: tool.input, result: tool.preview ?? '' });
    }
  };

  const inputText = (() => {
    const inp = detail && detail !== 'loading' ? detail.input : tool.input;
    if (inp && typeof inp === 'object' && 'command' in (inp as any)) return String((inp as any).command);
    return JSON.stringify(inp, null, 2);
  })();
  const resultText = detail && detail !== 'loading' ? detail.result : tool.preview ?? '';

  return (
    <div className={`tool${live ? ' live' : ''}${failed ? ' fail' : ''}${open ? ' open' : ''}`}>
      <div className="tl" onClick={toggle} title="click to expand">
        <span className="ti" style={{ color: failed ? 'var(--need)' : FAM[e.icon.family].c }}>
          <Icon name={failed ? 'TriangleAlert' : e.icon.name} size={13} />
        </span>
        <b>{shortToolName(tool.name ?? '')}</b> <span className="in"><Masked text={tool.summary ?? ''} jira sessionId={sessionId} /></span>
        <span className="out">
          {tool.background && e.toolUseId ? (
            <BgOut sessionId={sessionId} toolUseId={e.toolUseId} />
          ) : (
            <>
              {tool.resultSummary ? `  ${tool.resultSummary}` : ''}
              {item.end?.durationMs != null ? ` · ${dur(item.end.durationMs)}` : ''}
            </>
          )}
        </span>
        {live ? <span className="spin" /> : null}
        <RowActions tool={tool} />
        {tool.change && !failed && e.toolUseId ? (
          <button
            className="diffbtn"
            title="See exactly what this changed"
            onClick={(ev) => {
              ev.stopPropagation();
              openChanges(sessionId, tool.change!.path, { toolUseId: e.toolUseId });
            }}
          >
            diff
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="pv">
          {detail === 'loading' ? <div className="dim">loading…</div> : null}
          <div className="pv-h">input</div>
          <pre><Masked text={inputText ?? ''} /></pre>
          {resultText ? (
            <>
              <div className="pv-h">{failed ? 'error' : 'result'}</div>
              <pre><Masked text={resultText} /></pre>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
