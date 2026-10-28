import { useLayoutEffect, useRef, useState } from 'react';
import type { DebriefKind, VideoSlide } from '@cora/shared';
import { CoraOrb } from './CoraOrb';
import './videoSlides.css';

/**
 * A debrief video's slides, on a page of their own
 * (`/?slides=1`) that the desktop app opens out of sight at 1920×1080. It puts each slide here with
 * `window.coraSlide(slide)`; the slide is fitted (code that would run off it gets smaller, then cut), and the promise
 * settles once it's drawn, for the app to take its picture. In your Cora's look: its tokens, its fonts, your colour.
 */
const KIND: Record<DebriefKind, { label: string; color: string }> = {
  context: { label: 'Context', color: 'var(--ink2)' },
  change: { label: 'Change', color: 'var(--work)' },
  test: { label: 'Test', color: 'var(--run)' },
  verify: { label: 'Check', color: 'var(--think)' },
  risk: { label: 'Risk', color: 'var(--need)' },
  concept: { label: 'Concept', color: 'var(--cora)' },
};
const CODE_MAX = 30;
const CODE_MIN = 18;

declare global {
  interface Window {
    coraSlide?: (s: VideoSlide) => Promise<void>;
  }
}

export function VideoSlides() {
  const [slide, setSlide] = useState<VideoSlide | null>(null);
  const [cut, setCut] = useState(0);
  const settle = useRef<(() => void) | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const color = new URLSearchParams(location.search).get('color');
  if (color && /^#[0-9a-f]{6}$/i.test(color)) document.documentElement.style.setProperty('--cora', color);

  useLayoutEffect(() => {
    document.documentElement.classList.add('slides-page');
    window.coraSlide = (s) =>
      new Promise<void>((res) => {
        settle.current = res;
        setCut(0);
        setSlide(s);
      });
    // Cora's fonts loaded first (a font loads when text first needs it: the first slide would come out in another)
    void Promise.all([document.fonts.load('750 84px "Figtree Variable"'), document.fonts.load('400 30px "Figtree Variable"'), document.fonts.load('400 30px "JetBrains Mono Variable"')])
      .catch(() => {})
      .then(() => document.fonts.ready)
      .then(() => setTimeout(() => (document.title = 'slides-ready'), 300));
  }, []);

  // fitted: code smaller until it fits, then its last lines cut; then two frames, and it's drawn
  useLayoutEffect(() => {
    if (!slide || !page.current) return;
    const code = page.current.querySelector<HTMLElement>('.vs-code');
    if (code) {
      let size = CODE_MAX;
      code.style.fontSize = `${size}px`;
      while (code.scrollHeight > code.clientHeight + 1 && size > CODE_MIN) code.style.fontSize = `${(size -= 1)}px`;
      if (code.scrollHeight > code.clientHeight + 1 && slide.code && cut < slide.code.lines.length - 3) {
        setCut((c) => c + 2);
        return;
      }
    }
    const done = settle.current;
    settle.current = null;
    if (slide.kind !== 'title') {
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done?.(), 60)));
      return;
    }
    // the title's orb: its canvas made, then time for its first frames (out of sight, compiling it takes a moment)
    const t0 = Date.now();
    const wait = () => (slide.orb === false ? requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => done?.(), 60))) : page.current?.querySelector('.vs-orb canvas') || Date.now() - t0 > 4000 ? setTimeout(() => done?.(), 1600) : setTimeout(wait, 50));
    wait();
  }, [slide, cut]);

  if (!slide) return <div className="vslides" ref={page} />;
  return <SlideView slide={slide} cut={cut} ref={page} />;
}

/** One slide at 1920×1080 (the video's page draws it; the Make a video modal shows it scaled down, as a preview). */
/** `orbSlot`: the title's orb left to whoever shows it (a scaled preview draws its own over the slot). */
export function SlideView({ slide, cut = 0, ref, orbSlot }: { slide: VideoSlide; cut?: number; ref?: React.Ref<HTMLDivElement>; orbSlot?: boolean }) {
  return (
    <div className={`vslides${slide.caption ? ' captioned' : ''}`} ref={ref}>
      <div className="vs-glow" />
      {slide.kind === 'title' ? <Title s={slide} slot={orbSlot} /> : <Step s={slide} cut={cut} />}
      {slide.caption ? <div className="vs-caption">{slide.caption}</div> : null}
    </div>
  );
}

function Title({ s, slot }: { s: VideoSlide; slot?: boolean }) {
  return (
    <div className={`vs-title${s.orb === false ? ' bare' : ''}`}>
      {s.orb === false ? null : (
        <div className="vs-orb">{slot ? null : <CoraOrb state="idle" size={300} ferro always />}</div>
      )}
      <div className="vs-tw">
        <div className="vs-eyebrow">
          <b>CORA</b> · Debrief
        </div>
        <h1>{s.title}</h1>
        {s.sub ? <p>{s.sub}</p> : null}
      </div>
    </div>
  );
}

function Step({ s, cut }: { s: VideoSlide; cut: number }) {
  const k = s.badge ? KIND[s.badge] : null;
  const lines = s.code ? s.code.lines.slice(0, s.code.lines.length - cut) : [];
  const lit = (n: number) => !!s.code?.lit.some(([a, b]) => n >= a && n <= b);
  return (
    <div className="vs-step">
      <div className="vs-head">
        <span className="vs-eyebrow">
          STEP {s.n} <i>of {s.of}</i>
        </span>
        {k ? (
          <span className="vs-kind" style={{ ['--k' as string]: k.color }}>
            {k.label}
          </span>
        ) : null}
        {s.file ? <span className="vs-file">{s.file}</span> : null}
      </div>
      <h2>{s.title}</h2>
      {s.code ? (
        <div className="vs-code">
          {lines.map((l, i) => {
            const n = s.code!.start + i;
            return (
              <div key={n} className={`vs-line${lit(n) ? ' lit' : ''}`}>
                <span className="n">{n}</span>
                <span className="t">{l || ' '}</span>
              </div>
            );
          })}
          {cut ? <div className="vs-line more">⋯</div> : null}
        </div>
      ) : (
        <p className="vs-words">{s.narration}</p>
      )}
      <div className="vs-foot">
        <span className="vs-dots">
          {Array.from({ length: s.of ?? 0 }, (_, i) => (
            <i key={i} className={i + 1 === s.n ? 'on' : i + 1 < (s.n ?? 0) ? 'past' : ''} />
          ))}
        </span>
        <span className="vs-mark">
          <b>CORA</b> · Debrief
        </span>
      </div>
    </div>
  );
}
