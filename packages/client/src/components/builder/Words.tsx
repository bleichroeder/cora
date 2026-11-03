import type { LintTarget, Seg, WordsLine } from '@cora/shared';
import type { Sel } from './draftOps';

/** A sentence's runs: names in bold, what the checks warn about in its colour, ids in mono. */
export function Segs({ segs }: { segs: Seg[] }) {
  return (
    <>
      {segs.map((s, i) => {
        const inner = s.b ? <b>{s.t}</b> : s.code ? <code className="m">{s.t}</code> : s.t;
        return s.gap ? (
          <span key={i} className="gap">
            {inner}
          </span>
        ) : (
          <span key={i}>{inner}</span>
        );
      })}
    </>
  );
}

/** What a line selects: its route if it has one, else its first seat, else its first target. */
export const pickTarget = (l: WordsLine): LintTarget | undefined => l.targets.find((t) => t.kind === 'route') ?? l.targets.find((t) => t.kind === 'seat') ?? l.targets[0];

const SECTIONS: Array<[WordsLine['section'], string]> = [
  ['flow', 'How work moves'],
  ['sits', 'When work sits'],
  ['also', 'Also'],
];

/** In words: hover a line to see it on the canvas, click to select it. */
export function Words({ lines, sel, onHover, onPick }: { lines: WordsLine[]; sel: Sel; onHover(i: number | null): void; onPick(t?: LintTarget): void }) {
  const on = (l: WordsLine) => {
    const f = pickTarget(l);
    return !!f && f.kind !== 'team' && !!sel && sel.kind === f.kind && sel.ids.includes(f.id);
  };
  return (
    <div className="wsc" onMouseLeave={() => onHover(null)}>
      {SECTIONS.map(([k, label]) => {
        const xs = lines.map((l, i) => ({ l, i })).filter((x) => x.l.section === k);
        if (!xs.length) return null;
        return (
          <div key={k}>
            <div className="wsec">{label}</div>
            {xs.map(({ l, i }) => (
              <p key={i} className={`ws${l.quiet ? ' q' : ''}${on(l) ? ' on' : ''}`} onMouseEnter={() => onHover(l.quiet ? null : i)} onClick={() => !l.quiet && onPick(pickTarget(l))}>
                <Segs segs={l.segs} />
              </p>
            ))}
          </div>
        );
      })}
    </div>
  );
}
