import { useEffect, useRef, useState } from 'react';
import type { NoteSummary } from '@cora/shared';
import { notesApi } from '../state/notes';
import { desktop } from '../lib/desktop';
import { Icon } from './Icon';
import './notes.css';

/**
 * Quick capture (Ctrl+Alt+N from anywhere): Cora's client in its own small window, just this box. Enter saves to
 * Scratch; Shift+Enter, a new line; Tab picks a named note (or a new one) instead; Esc (or clicking away) hides it, and
 * what you typed stays for next time.
 */
export function Capture() {
  const [text, setText] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [cur, setCur] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pickIn = useRef<HTMLInputElement>(null);

  const reset = () => {
    setDone(null);
    setErr(null);
    setPick(null);
    void notesApi.list().then((r) => r.ok && setNotes(r.v.list.filter((n) => n.kind === 'note')));
    setTimeout(() => ta.current?.focus(), 0);
  };
  useEffect(() => {
    document.documentElement.classList.add('capture');
    reset();
    return desktop?.onCaptureShown?.(reset);
  }, []);
  const hide = () => desktop?.hideCapture?.();

  const matches = pick == null ? [] : notes.filter((n) => n.title.toLowerCase().includes(pick.toLowerCase())).slice(0, 6);
  const options: Array<{ id?: string; title: string; label: string }> = [...matches.map((n) => ({ id: n.id, title: n.title, label: n.title })), ...(pick?.trim() && !matches.some((n) => n.title.toLowerCase() === pick.trim().toLowerCase()) ? [{ title: pick.trim(), label: `+ New note “${pick.trim()}”` }] : [])];

  const save = async (to?: { id?: string; title?: string }, label = 'Scratch') => {
    const t = text.trim();
    if (!t) return hide();
    const r = await notesApi.jot(t, to);
    if (!r.ok) return setErr(r.error);
    setText('');
    setDone(label);
    setTimeout(hide, 700);
  };

  if (done)
    return (
      <div className="qc">
        <div className="qc-done">
          <b>✓</b> Saved to {done}
        </div>
      </div>
    );
  return (
    <div className="qc">
      <div className="qc-i">
        <span className="qc-logo">
          <Icon name="NotebookPen" size={14} />
        </span>
        <textarea
          ref={ta}
          value={text}
          rows={2}
          placeholder="Jot something…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') return (e.preventDefault(), hide());
            if (e.key === 'Tab') return (e.preventDefault(), setPick(''), setCur(0), setTimeout(() => pickIn.current?.focus(), 0));
            if (e.key === 'Enter' && !e.shiftKey) return (e.preventDefault(), void save());
          }}
        />
      </div>
      {err ? <div className="qc-err">{err}</div> : null}
      <div className="qc-f">
        {pick == null ? (
          <>
            <span className="qc-to">→ Scratch</span>
            <span className="spacer" />
            <span>
              <kbd>Enter</kbd> save
            </span>
            <span>
              <kbd>Tab</kbd> to a note
            </span>
            <span>
              <kbd>Esc</kbd> hide
            </span>
          </>
        ) : (
          <>
            <span className="qc-to">
              →{' '}
              <input
                ref={pickIn}
                value={pick}
                placeholder="which note?"
                onChange={(e) => (setPick(e.target.value), setCur(0))}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' || (e.key === 'Tab' && e.shiftKey)) return (e.preventDefault(), setPick(null), ta.current?.focus());
                  if (e.key === 'ArrowDown') return (e.preventDefault(), setCur(Math.min(cur + 1, options.length - 1)));
                  if (e.key === 'ArrowUp') return (e.preventDefault(), setCur(Math.max(cur - 1, 0)));
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const o = options[cur];
                    if (o) void save(o.id ? { id: o.id } : { title: o.title }, o.title);
                  }
                }}
              />
            </span>
            <span className="spacer" />
            <span>
              <kbd>↑↓</kbd> pick
            </span>
            <span>
              <kbd>Enter</kbd> add to it
            </span>
          </>
        )}
      </div>
      {pick != null && options.length ? (
        <div className="qc-pick">
          {options.map((o, i) => (
            <div key={o.label} className={i === cur ? 'on' : ''} onMouseEnter={() => setCur(i)} onMouseDown={(e) => (e.preventDefault(), void save(o.id ? { id: o.id } : { title: o.title }, o.title))}>
              {o.label}
              {o.id && notes.find((n) => n.id === o.id)?.pinned ? <span>pinned</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
