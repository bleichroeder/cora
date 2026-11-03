import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown } from '../Markdown';
import type { TalkLine } from './talkLines';

/** The tallest the Talk box grows before it scrolls (about eight lines). */
const TALK_MAX_H = 168;

const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Talk: Cora's console, not bubbles. */
export function Talk(p: { lines: TalkLine[]; busy: boolean; /** what she's doing in her turn, at a time (null: nothing yet to show) */ activity?: (now: number) => { step: string; clock: string } | null; /** Talk is off here, and why (a lead's proposal is on screen) */ off?: string; offline: string; /** something you asked for here didn't work (an Undo), in plain words */ note?: string; chips: string[]; onSend(text: string): void; onUndo(ids: string[]): void; onChip(c: string): void; focusKey: number }) {
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // grows with what you write, like the session composer, up to about eight lines, then scrolls
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, TALK_MAX_H)}px`;
  }, [text]);
  // new lines, and a line growing (her words arriving, a change under them), scroll into view; nothing else moves it
  const grown = p.lines.reduce((n, m) => n + m.text.length + (m.turn?.summary.length ?? 0), 0);
  useLayoutEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [p.lines.length, p.busy, grown]);
  useEffect(() => {
    if (p.focusKey) input.current?.focus();
  }, [p.focusKey]);
  // while she works, her step and her turn's clock tick once a second
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!p.busy) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [p.busy]);
  const doing = p.busy ? (p.activity?.(now) ?? null) : null;
  const send = () => {
    const t = text.trim();
    if (!t || p.busy || p.off) return;
    p.onSend(t);
    setText('');
  };
  return (
    <>
      <div className="tk" ref={list}>
        {p.lines.length ? null : <div className="tk-intro">Tell Cora what the team is for. She builds it on the canvas as you talk. Drag, edit or add routes yourself at any point; she works with what you did. Applying stays yours.</div>}
        {p.lines.map((m) => (
          <div key={m.id} className={`msg2 ${m.who}${m.sending ? ' sending' : ''}`}>
            <div className="who">
              {m.who === 'cora' ? 'Cora' : 'You'}
              {m.sending ? <span className="sent">sending…</span> : <time>{hhmm(m.at)}</time>}
            </div>
            {m.who === 'cora' ? <Markdown text={m.text} /> : <p>{m.text}</p>}
            {m.turn ? (
              <div className={`did${m.turn.undone ? ' undone' : ''}`}>
                <span title={m.turn.summary}>
                  {m.turn.summary}
                  {m.turn.struck?.map((x, i) => (
                    <s key={i}> · {x}</s>
                  ))}
                </span>
                {m.turn.undone ? (
                  <em>undone</em>
                ) : m.turn.ids.length && !p.off ? (
                  <button className="undo" title="Take back just this turn" onClick={() => p.onUndo(m.turn!.ids)}>
                    Undo
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        {p.busy ? (
          <div className="msg2 cora">
            <div className="who">
              Cora
              {doing ? <time>{doing.clock}</time> : null}
            </div>
            <div className="doing">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              <span className="step">{doing?.step ?? 'Getting started'}</span>
            </div>
          </div>
        ) : null}
      </div>
      <div className="composer">
        {p.off ? <div className="offline">{p.off}</div> : null}
        {p.offline && !p.off ? (
          <div className="offline">
            <i />
            {p.offline.replace(/[.;\s]+$/, '')}; you can still build by hand or from a shape.
          </div>
        ) : null}
        {p.note ? (
          <div className="offline">
            <i />
            {p.note}
          </div>
        ) : null}
        <div className="line">
          <textarea
            ref={input}
            rows={1}
            value={text}
            placeholder="Tell Cora…  Enter sends · Shift+Enter new line"
            disabled={!!p.off}
            spellCheck
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && (e.preventDefault(), send())}
          />
          <button className="btn go sm" style={{ height: 32 }} disabled={p.busy || !!p.off || !text.trim()} onClick={send}>
            Send
          </button>
        </div>
        <div className="sugg">
          {p.busy || p.off
            ? null
            : p.chips.map((c) => (
                <button key={c} className="tchip ui" onClick={() => p.onChip(c)}>
                  {c}
                </button>
              ))}
        </div>
      </div>
    </>
  );
}
