import { useEffect, useState, type RefObject } from 'react';
import { Icon } from './Icon';

/**
 * What wants you in the rail, when it's scrolled out of sight: a chip on the list's top or bottom edge ("2 need you ·
 * 1 done") that takes you to the nearest one. A row that wants you says so with data-need / data-done (counts: a
 * folded group or project carries its members'); the chips count the ones wholly above or below what's showing.
 */

/** The attributes that mark something in the rail as wanting you (none when nothing does). */
export function attnData(need: number, done: number): Record<string, number> {
  return { ...(need ? { 'data-need': need } : {}), ...(done ? { 'data-done': done } : {}) };
}

type Side = { need: number; done: number };
type Edges = { up: Side; down: Side };
const NONE: Edges = { up: { need: 0, done: 0 }, down: { need: 0, done: 0 } };
const SEL = '[data-need],[data-done]';
/** a row this close to the edge (behind the chip) still counts as showing */
const SLACK = 8;

const same = (a: Edges, b: Edges) => a.up.need === b.up.need && a.up.done === b.up.done && a.down.need === b.down.need && a.down.done === b.down.done;

/** Counts what wants you above and below the list's view, kept current as it scrolls, resizes or changes. */
export function useAttentionEdges(root: RefObject<HTMLElement | null>): Edges {
  const [edges, setEdges] = useState<Edges>(NONE);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      const box = el.getBoundingClientRect();
      const next: Edges = { up: { need: 0, done: 0 }, down: { need: 0, done: 0 } };
      el.querySelectorAll<HTMLElement>(SEL).forEach((t) => {
        const r = t.getBoundingClientRect();
        if (!r.height) return;
        const side = r.bottom <= box.top + SLACK ? next.up : r.top >= box.bottom - SLACK ? next.down : null;
        if (!side) return;
        side.need += Number(t.dataset.need ?? 0);
        side.done += Number(t.dataset.done ?? 0);
      });
      setEdges((prev) => (same(prev, next) ? prev : next));
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    kick();
    el.addEventListener('scroll', kick, { passive: true });
    const ro = new ResizeObserver(kick);
    ro.observe(el);
    // rows come and go, fold and unfold, and change what they want
    const mo = new MutationObserver(kick);
    mo.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-need', 'data-done'] });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener('scroll', kick);
      ro.disconnect();
      mo.disconnect();
    };
  }, [root]);
  return edges;
}

/** Scrolls to the nearest thing beyond that edge that wants you (needing you first), and flashes it. */
function goNearest(root: HTMLElement, dir: 'up' | 'down') {
  const box = root.getBoundingClientRect();
  const beyond = [...root.querySelectorAll<HTMLElement>(SEL)].filter((t) => {
    const r = t.getBoundingClientRect();
    return r.height && (dir === 'up' ? r.bottom <= box.top + SLACK : r.top >= box.bottom - SLACK);
  });
  const pool = beyond.some((t) => t.dataset.need) ? beyond.filter((t) => t.dataset.need) : beyond;
  // nearest the edge: the last of those above, the first of those below
  const t = dir === 'up' ? pool.at(-1) : pool[0];
  if (!t) return;
  t.scrollIntoView({ block: 'center', behavior: 'smooth' });
  t.classList.remove('attn-flash');
  void t.offsetWidth;
  t.classList.add('attn-flash');
  setTimeout(() => t.classList.remove('attn-flash'), 1600);
}

/** One edge's chip: sticky at the top or bottom of the list, only while something beyond it wants you. */
export function AttentionEdge({ root, dir, side }: { root: RefObject<HTMLElement | null>; dir: 'up' | 'down'; side: Side }) {
  const { need, done } = side;
  if (!need && !done) return <div className={`attn-edge ${dir}`} aria-hidden />;
  const where = dir === 'up' ? 'above' : 'below';
  const say = [need ? `${need} need${need === 1 ? 's' : ''} you` : '', done ? `${done} finished since you looked` : ''].filter(Boolean).join(', ');
  return (
    <div className={`attn-edge ${dir}`}>
      <button className={`attn-chip${need ? ' need' : ''}`} title={`${say} ${where}: go to the nearest`} onClick={() => root.current && goNearest(root.current, dir)}>
        <Icon name={dir === 'up' ? 'ArrowUp' : 'ArrowDown'} size={11} />
        {need ? (
          <span className="attn-n need">
            <i />
            {need} need{need === 1 ? 's' : ''} you
          </span>
        ) : null}
        {done ? (
          <span className="attn-n done">
            <i />
            {done} done
          </span>
        ) : null}
      </button>
    </div>
  );
}
