import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export const TOUR_KEY = 'cora.builder.tourSeen';
/** Whether the tour has been seen in this browser (a browser that refuses storage: not seen, and no error). */
export function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_KEY) === '1';
  } catch {
    return false;
  }
}
export function markTourSeen(): void {
  try {
    localStorage.setItem(TOUR_KEY, '1');
  } catch {
    /* storage refused: it shows again next time */
  }
}

/** The four hints, each pointing at its part. */
export const TOUR: Array<{ sel: string; title: string; text: string; at: 'right' | 'handle' | 'above' | 'above-right' }> = [
  { sel: '[data-tour="left"]', title: 'Talk and In words', text: 'Build by talking to Cora, or read what the team does in plain words. Hover a line to see it on the canvas.', at: 'right' },
  { sel: '[data-tour="canvas"]', title: 'The canvas', text: "The same team as a picture. Drag from a seat's edge to let it message another.", at: 'handle' },
  { sel: '[data-tour="try"]', title: 'Try a message', text: 'Send a pretend message through the team. Nothing starts.', at: 'above' },
  { sel: '[data-tour="apply"]', title: 'Apply', text: "Nothing changes until you apply. You'll see what restarts first.", at: 'above-right' },
];

type Place = { ring: null | { left: number; top: number; width: number; height: number }; card: { left: number; top: number }; caret: { left: number; top: number } | null };

const clearHint = () => document.querySelectorAll('.tourhint').forEach((n) => n.classList.remove('tourhint'));

/** Where the card goes when its part is not on screen: the middle, so Skip and Next are always reachable. */
export const centredCard = (vw: number, vh: number, cw = 280, ch = 130) => ({ left: Math.max(8, (vw - cw) / 2), top: Math.max(8, (vh - ch) / 2) });

export function Tour({ step, onNext, onSkip }: { step: number; onNext(): void; onSkip(): void }) {
  const card = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<Place | null>(null);
  const st = TOUR[step];
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick((n) => n + 1);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('resize', on);
      clearHint();
    };
  }, []);
  useLayoutEffect(() => {
    clearHint();
    const el = document.querySelector(st.sel);
    if (!el) {
      setPlace({ ring: null, card: centredCard(window.innerWidth, window.innerHeight, 280, card.current?.offsetHeight ?? 130), caret: null });
      return;
    }
    const r = el.getBoundingClientRect();
    const pad = st.at === 'right' || st.at === 'handle' ? -2 : 4;
    const cw = 280;
    const ch = card.current?.offsetHeight ?? 130;
    const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    let x: number;
    let y: number;
    let caret: Place['caret'] = null;
    if (st.at === 'right') {
      x = r.right + 14;
      y = r.top + 56;
      caret = { left: -5, top: 18 };
    } else if (st.at === 'handle') {
      const node = document.querySelector('.tb g.node.seat');
      const h = node?.querySelector('.handle')?.getBoundingClientRect();
      if (node && h) {
        node.classList.add('tourhint');
        x = h.left + h.width / 2 - 30;
        y = h.bottom + 12;
        caret = { left: 25, top: -5 };
      } else {
        x = r.left + r.width / 2 - cw / 2;
        y = r.top + r.height / 2 - ch / 2;
      }
    } else {
      x = st.at === 'above' ? r.left - 4 : r.right - cw + 4;
      y = r.top - ch - 12;
      caret = { left: clamp(r.left + r.width / 2 - x - 5, 12, cw - 22), top: ch - 5 };
    }
    x = clamp(x, 8, window.innerWidth - cw - 8);
    y = clamp(y, 8, window.innerHeight - ch - 8);
    setPlace({ ring: { left: r.left - pad, top: r.top - pad, width: r.width + pad * 2, height: r.height + pad * 2 }, card: { left: x, top: y }, caret });
  }, [step, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div>
      <div className="tour-block" />
      {place?.ring ? <div className="tour-ring" style={place.ring} /> : null}
      <div ref={card} className="tour-card" style={place?.card ?? { left: -9999, top: 0 }}>
        {place?.caret ? <i className="tour-caret" style={{ position: 'absolute', width: 10, height: 10, background: 'var(--raise)', transform: 'rotate(45deg)', ...place.caret }} /> : null}
        <div className="n">
          {step + 1} of {TOUR.length}
        </div>
        <b>{st.title}</b>
        <p>{st.text}</p>
        <div className="tb-btns">
          <button className="btn sm ghost" onClick={() => (clearHint(), onSkip())}>
            Skip
          </button>
          <button className="btn sm go" onClick={() => (step === TOUR.length - 1 && clearHint(), onNext())}>
            {step === TOUR.length - 1 ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
