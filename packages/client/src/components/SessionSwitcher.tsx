import { useEffect, useRef, useState } from 'react';
import type { SessionInfo } from '@cora/shared';
import { recapText } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { switchOrder, touch } from '../lib/switcher';
import { pauseSnaps, snapNow, useSnaps } from '../lib/snaps';
import { ago, sessionColor, shortCwd } from '../lib/format';
import { ticketLabel } from '../lib/ticket';
import './switcher.css';

/** The sessions you were in, newest first (kept across reloads). */
const KEY = 'cora.switch.mru';
let mru: string[] = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];
  } catch {
    return [];
  }
})();
useBrain.subscribe((st, prev) => {
  if (!st.focus || st.focus === prev.focus) return;
  mru = touch(mru, st.focus);
  try {
    localStorage.setItem(KEY, JSON.stringify(mru));
  } catch {
    /* this run only */
  }
});

/** A session's preview: where it stands (its latest recap), else the last thing Claude said, as plain text. */
function preview(s: SessionInfo): string {
  if (s.recap) return recapText(s.recap.text);
  const say = [...sessionEvents(s.id)].reverse().find((e) => e.kind === 'say' && e.agentId === 'main' && e.text);
  const t = say?.text ?? s.title ?? '';
  return t
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_`>|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220);
}

const STATE: Record<string, string> = { working: 'Working', thinking: 'Thinking', 'needs-you': 'Needs you', idle: 'Idle' };
const TILE: Record<string, string> = { working: 'work', thinking: 'think', 'needs-you': 'need' };
/** Shown only if Ctrl is held this long: a quick Ctrl+Tab just goes back to the last session, without a flash. */
const SHOW_AFTER_MS = 140;

/**
 * Switching sessions as Windows' Alt+Tab switches windows: hold Ctrl and press Tab (or hold Alt and press ← or →), and
 * your live sessions line up as little previews (the one you were just in picked); Tab or → steps on, Shift+Tab or ←
 * back; let go of Ctrl (or Alt) to go there; Esc puts it away. Ended and removed sessions aren't in it (the palette, Ctrl+K, has those). In the browser,
 * Ctrl+Tab is the browser's (its tabs).
 */
export function SessionSwitcher() {
  const [list, setList] = useState<SessionInfo[] | null>(null);
  const [at, setAt] = useState(0);
  const [shown, setShown] = useState(false);
  // `hold`: the key it was opened with (letting go of it switches)
  // `snapped`: the picture of the session you're in, taken as it opens (it shows only once that's done)
  const st = useRef<{ list: SessionInfo[] | null; at: number; timer: ReturnType<typeof setTimeout> | null; hold?: 'Control' | 'Alt'; snapped?: Promise<void> }>({ list: null, at: 0, timer: null });
  useEffect(() => {
    // shown once the session you're in has been pictured (never with the switcher in the picture)
    const reveal = () => void (st.current.snapped ?? Promise.resolve()).finally(() => st.current.list && setShown(true));
    const close = () => {
      pauseSnaps(false);
      if (st.current.timer) clearTimeout(st.current.timer);
      st.current = { list: null, at: 0, timer: null };
      setList(null);
      setShown(false);
    };
    const go = () => {
      const s = st.current.list?.[st.current.at];
      close();
      if (s && s.id !== useBrain.getState().focus) useBrain.getState().setFocus(s.id);
      if (s && useBrain.getState().overview) useBrain.getState().toggleOverview(false);
    };
    const down = (e: KeyboardEvent) => {
      if (st.current.list && e.key === 'Escape') return void (e.preventDefault(), close());
      // while it's up: the arrows step too (Ctrl or Alt is held)
      if (st.current.list && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();
        const n = st.current.list.length;
        st.current.at = (st.current.at + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? n - 1 : 1)) % n;
        setAt(st.current.at);
        reveal();
        return;
      }
      // Ctrl+Tab, or Alt+← / Alt+→ (free everywhere: in text, Alt with the arrows does nothing)
      const arrow = e.key === 'ArrowLeft' || e.key === 'ArrowRight';
      const tab = e.key === 'Tab' && e.ctrlKey && !e.altKey;
      const alt = arrow && e.altKey && !e.ctrlKey && !e.shiftKey;
      if ((!tab && !alt) || e.metaKey) return;
      // in the browser, Ctrl+Tab steps through its tabs
      if (tab && (e.target as HTMLElement | null)?.closest?.('.web-pane')) return;
      e.preventDefault();
      e.stopPropagation();
      const back = e.shiftKey || e.key === 'ArrowLeft';
      if (!st.current.list) {
        const l = switchOrder(Object.values(useBrain.getState().sessions), mru);
        if (!l.length) return;
        const cur = useBrain.getState().focus;
        // the session you're in is first (when it's live): Tab goes to the one before it
        const first = l[0]?.id === cur ? 1 : 0;
        const i = back ? l.length - 1 : Math.min(first, l.length - 1);
        // the session you're in, pictured as it is (before the switcher covers it); no other pictures while it's up
        pauseSnaps(true);
        const snapped = snapNow({ opening: true });
        st.current = { list: l, at: i, timer: setTimeout(reveal, SHOW_AFTER_MS), hold: tab ? 'Control' : 'Alt', snapped };
        setList(l);
        setAt(i);
        return;
      }
      const n = st.current.list.length;
      st.current.at = (st.current.at + (back ? n - 1 : 1)) % n;
      setAt(st.current.at);
      reveal();
    };
    const up = (e: KeyboardEvent) => {
      if (!st.current.list || e.key !== st.current.hold) return;
      // (Alt let go: not the window's menu)
      e.preventDefault();
      go();
    };
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', close);
    };
  }, []);

  if (!list || !shown) return null;
  return <SwitcherView list={list} at={at} pick={(i) => ((st.current.at = i), setAt(i))} go={(s) => {
    useBrain.getState().setFocus(s.id);
    pauseSnaps(false);
    if (st.current.timer) clearTimeout(st.current.timer);
    st.current = { list: null, at: 0, timer: null };
    setList(null);
    setShown(false);
  }} />;
}

/** One row of cards (never wrapping: they shrink to fit, and the row scrolls to the picked one when there are many). */
function SwitcherView({ list, at, pick, go }: { list: SessionInfo[]; at: number; pick(i: number): void; go(s: SessionInfo): void }) {
  const snaps = useSnaps((s) => s.by);
  const row = useRef<HTMLDivElement>(null);
  useEffect(() => {
    row.current?.querySelector('.sw-card.on')?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [at]);
  const now = Date.now();
  // as wide as fits (up to 300 px each, never under 170)
  const room = Math.min(1400, window.innerWidth - 80);
  const w = Math.max(170, Math.min(300, Math.floor((room - 12 * (list.length - 1)) / list.length)));
  return (
    <div className="sw-scrim">
      <div className="sw-box" role="listbox" aria-label="Switch session">
        <div className="sw-row" ref={row}>
          {list.map((s, i) => {
            const name = ticketLabel(s).text;
            const snap = snaps[s.id];
            return (
              <button
                key={s.id}
                role="option"
                aria-selected={i === at}
                className={`sw-card st-${s.state}${i === at ? ' on' : ''}`}
                style={{ width: w, ['--sc' as never]: sessionColor(s) }}
                onMouseEnter={() => pick(i)}
                onMouseDown={(e) => (e.preventDefault(), pick(i))}
                onClick={() => go(s)}
              >
                <span className="sw-top">
                  <span className={`dl-tile sw-tile ${TILE[s.state] ?? ''}`}>
                    {(name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
                    <i />
                  </span>
                  <b>{name}</b>
                </span>
                <span className="sw-pic">
                  {snap ? <img src={snap.url} alt="" draggable={false} /> : <span className="sw-prev">{preview(s)}</span>}
                </span>
                <span className="sw-foot">
                  <span className="sw-st">{s.state === 'idle' ? `Idle ${ago(s.lastTs, now)}` : STATE[s.state] ?? s.state}</span>
                  <span className="sw-dir">{snap ? `as of ${ago(snap.at, now)} ago` : shortCwd(s.cwd)}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="sw-name">{list[at] ? ticketLabel(list[at]).text : ''}</div>
        <div className="sw-keys">→ or Tab next · ← or Shift+Tab back · let go to switch · Esc</div>
      </div>
    </div>
  );
}
