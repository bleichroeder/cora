import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SHAPES, SHAPE_DEFAULTS, previewShape, type ShapeAnswers, type ShapeKind } from '@cora/shared';
import { Scrim } from './Sheets';
import { Segs } from './Words';

const PICS: Record<string, ReactNode> = {
  cora: (
    <svg className="pic" viewBox="0 0 84 52">
      <rect x={12} y={11} width={14} height={14} rx={4} fill="color-mix(in srgb, var(--cora) 16%, transparent)" stroke="color-mix(in srgb, var(--cora) 45%, transparent)" />
      <path d="M32 15h34M32 21h22" stroke="var(--ink3)" strokeWidth={1.4} strokeLinecap="round" />
      <path d="M32 33h26" stroke="var(--ink4)" strokeWidth={1.4} strokeLinecap="round" />
      <path d="M18 42h18" stroke="var(--ink3)" fill="none" />
      <circle cx={16} cy={42} r={3} fill="var(--run)" />
      <circle cx={40} cy={42} r={3} fill="var(--work)" />
    </svg>
  ),
  hub: (
    <svg className="pic" viewBox="0 0 84 52">
      <g stroke="var(--ink3)" fill="none" strokeWidth={1}>
        <path d="M20 17C30 17 30 26 40 26M20 35C30 35 30 26 40 26" />
        <path d="M46 26h10" />
      </g>
      <rect x={56} y={12} width={22} height={28} rx={6} fill="rgba(148,163,184,.07)" />
      <circle cx={16} cy={17} r={4} fill="var(--run)" />
      <circle cx={16} cy={35} r={4} fill="var(--run)" />
      <circle cx={43} cy={26} r={4} fill="var(--cora)" />
      <circle cx={67} cy={21} r={3.5} fill="var(--work)" />
      <circle cx={67} cy={31} r={3.5} fill="var(--work)" />
    </svg>
  ),
  pipeline: (
    <svg className="pic" viewBox="0 0 84 52">
      <path d="M20 26h18M46 26h18" stroke="var(--ink3)" fill="none" strokeWidth={1} />
      <circle cx={16} cy={26} r={4} fill="var(--run)" />
      <circle cx={42} cy={26} r={4} fill="var(--cora)" />
      <circle cx={68} cy={26} r={4} fill="var(--work)" />
    </svg>
  ),
  squad: (
    <svg className="pic" viewBox="0 0 84 52">
      <rect x={18} y={8} width={48} height={36} rx={9} fill="rgba(148,163,184,.07)" />
      <path d="M42 19 32 32M42 19 52 32M32 33h20" stroke="var(--ink3)" fill="none" strokeWidth={1} />
      <circle cx={42} cy={18} r={4} fill="var(--think)" />
      <circle cx={31} cy={33} r={4} fill="var(--run)" />
      <circle cx={53} cy={33} r={4} fill="var(--work)" />
    </svg>
  ),
  blank: (
    <svg className="pic" viewBox="0 0 84 52">
      <circle cx={16} cy={19} r={4} fill="var(--ink2)" />
      <circle cx={16} cy={33} r={4} fill="var(--cora)" />
      <rect x={30} y={10} width={44} height={32} rx={8} fill="none" stroke="rgba(148,163,184,.18)" strokeDasharray="3 3" />
    </svg>
  ),
};

/**
 * The start sheet: Build with Cora, or a shape that asks a few
 * questions first. With a draft (`onDiscard`): Discard draft throws it away, once you say so, and ends Cora's session for it.
 */
export function StartSheet(p: { name: string; version: number; coraDown: boolean; onCora(): void; onBuild(kind: ShapeKind | 'blank', a: ShapeAnswers): void; onClose(): void; onDiscard?(): void; busy?: boolean }) {
  const [view, setView] = useState<ShapeKind | null>(null);
  const [sure, setSure] = useState(false);
  const [answers, setAnswers] = useState<Record<ShapeKind, ShapeAnswers>>(() => ({ hub: { ...SHAPE_DEFAULTS.hub }, pipeline: { ...SHAPE_DEFAULTS.pipeline }, squad: { ...SHAPE_DEFAULTS.squad } }));
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (view) (first.current?.focus(), first.current?.select());
  }, [view]);
  const replaces = `replaces your draft (v${p.version} stays as it is until you apply)`;
  if (view) {
    const shape = SHAPES.find((s) => s.kind === view)!;
    const a = answers[view];
    const set = (k: string, v: string | boolean) => setAnswers((x) => ({ ...x, [view]: { ...x[view], [k]: v } }));
    let firstUsed = false;
    const field = (key: string, kind: string) => {
      if (kind === 'perKind')
        return (
          <div key={key} className="seg" style={{ flex: 'none' }}>
            {([[true, 'A pool per kind'], [false, 'One pool']] as const).map(([v, l]) => (
              <button key={String(v)} className={a.perKind === v ? 'on' : ''} onClick={() => set('perKind', v)}>
                {l}
              </button>
            ))}
          </div>
        );
      const ref = firstUsed ? undefined : ((firstUsed = true), first);
      return (
        <input
          key={key}
          ref={ref}
          className={`in${kind === 'mono' || kind === 'count' ? ' mono' : ''}`}
          value={String(a[key] ?? '')}
          spellCheck={false}
          inputMode={kind === 'count' ? 'numeric' : undefined}
          style={kind === 'count' ? { width: 64, flex: 'none' } : undefined}
          onChange={(e) => set(key, e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), p.onBuild(view, a))}
        />
      );
    };
    return (
      <Scrim onClose={p.onClose}>
        <div className="sh-hd">
          <button className="backlink" onClick={() => setView(null)}>
            ‹ All the ways to start
          </button>
          <b>{shape.title}</b>
          <span>a few questions · Enter builds it with what's filled in</span>
        </div>
        <div className="sh-bd">
          {shape.rows.map((r) => (
            <div key={r.label} className="q">
              <label>{r.label}</label>
              {r.fields.length > 1 ? <div className="frow">{r.fields.map((f) => field(f.key, f.kind))}</div> : field(r.fields[0].key, r.fields[0].kind)}
              {r.hint ? <div className="fh">{r.hint}</div> : null}
            </div>
          ))}
          <div className="qprev">
            <Segs segs={previewShape(view, a).segs} />
          </div>
        </div>
        <div className="sh-ft">
          <span className="note">It {replaces}.</span>
          <button className="btn" onClick={() => setView(null)}>
            Back
          </button>
          <button className="btn go" onClick={() => p.onBuild(view, a)}>
            Build it
          </button>
        </div>
      </Scrim>
    );
  }
  return (
    <Scrim onClose={p.onClose} busy={p.busy}>
      <div className="sh-hd">
        <b>Start the team</b>
        <span>
          {p.name} · {replaces}
        </span>
      </div>
      <div className="sh-bd" style={{ paddingTop: 8 }}>
        <button className="shape" disabled={p.coraDown} onClick={p.onCora}>
          {PICS.cora}
          <span>
            <b>Build with Cora</b>
            <span>{p.coraDown ? "Cora isn't available; you can still build by hand or from a shape." : 'Tell her what the team is for. She builds it on the canvas as you talk, and you can take over any time.'}</span>
          </span>
          <em>{p.coraDown ? 'unavailable' : 'talk'}</em>
        </button>
        <div className="lab">Or start from a shape</div>
        {SHAPES.map((s) => (
          <button key={s.kind} className="shape" onClick={() => (s.kind === 'blank' ? p.onBuild('blank', {}) : setView(s.kind))}>
            {PICS[s.kind]}
            <span>
              <b>{s.title}</b>
              <span>{s.blurb}</span>
            </span>
            <em>{s.asks}</em>
          </button>
        ))}
      </div>
      <div className="sh-ft">
        {sure ? (
          <>
            <span className="note">{`Throw the draft away and end Cora's session for it? ${p.version ? `The team stays at v${p.version}.` : 'There is no team yet.'}`}</span>
            <button className="btn" disabled={p.busy} onClick={() => setSure(false)}>
              Keep it
            </button>
            <button className="btn bad" disabled={p.busy} onClick={p.onDiscard}>
              Discard it
            </button>
          </>
        ) : (
          <>
            <span className="note">Teams you save as presets will appear here too.</span>
            {p.onDiscard ? (
              <button className="btn bad" title="Throw the draft away (the team stays as it is)" onClick={() => setSure(true)}>
                Discard draft
              </button>
            ) : null}
            <button className="btn" onClick={p.onClose}>
              Cancel
            </button>
          </>
        )}
      </div>
    </Scrim>
  );
}
