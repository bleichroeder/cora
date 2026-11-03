import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import type { ApplyLine, ApplyOverview, SessionEffect } from '@cora/shared';

const sc = (c: string): CSSProperties => ({ ['--sc' as string]: c }) as CSSProperties;
const noWarn = (l: string) => l.replace(/^⚠️?\s*/, '');
const listWords = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** A sheet over the builder (a click outside closes it). */
export function Scrim({ onClose, busy, children }: { onClose(): void; busy?: boolean; children: ReactNode }) {
  useEffect(() => {
    if (busy) return;
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [busy, onClose]);
  return (
    <div className="scrim" onPointerDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="sheet" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

/** A change line, opened to its full text on a click when it was cut. */
function Line({ l, warn }: { l: ApplyLine; warn?: boolean }) {
  const [open, setOpen] = useState(false);
  const w = warn ?? /^⚠/.test(l.line);
  return (
    <div className={`cl${w ? ' w' : ''}${l.full ? ' cl-more' : ''}`} onClick={() => l.full && setOpen((o) => !o)}>
      <span className="g">{w ? '⚠' : '·'}</span>
      <span>
        {noWarn(l.line)}
        {l.full ? <span className="lnk"> · in full</span> : null}
        {l.full && open ? <span className="full">{noWarn(l.full)}</span> : null}
      </span>
    </div>
  );
}
const STATUS_WORD: Record<'new' | 'changed' | 'removed', string> = { new: 'new', changed: 'changed', removed: 'removed' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Apply (or Approve): not every change line in one long list, but what you're agreeing to. The team in numbers; the
 * few things worth checking (folders, permissions, risky modes); one row per seat (its model, tools and mode, new or
 * changed, what it does when the team is running), opened to its lines on a click; the routes, groups and rules as one
 * row.
 */
export function ApplySheet(p: { title: string; sub: string; banner?: string; overview: ApplyOverview; effects: { rows: SessionEffect[]; atOnce: string[] } | null; note: string; tag: 'Apply' | 'Approve'; colorOf(id: string): string; busy: boolean; error?: string; onCancel(): void; onApply(bringUp: boolean): void }) {
  const o = p.overview;
  const [openSeat, setOpenSeat] = useState<Record<string, boolean>>({});
  const [restOpen, setRestOpen] = useState(false);
  const effectOf = (id: string) => p.effects?.rows.filter((r) => r.seat === id) ?? [];
  const tiles: Array<{ n: number | string; k: string; tone?: 'add' | 'chg' | 'del' }> = o.first
    ? [
        { n: o.counts.seats, k: o.counts.seats === 1 ? 'seat' : 'seats' },
        { n: o.counts.routes, k: o.counts.routes === 1 ? 'route' : 'routes' },
        { n: o.counts.groups, k: o.counts.groups === 1 ? 'group' : 'groups' },
        { n: o.counts.sessions, k: p.tag === 'Approve' ? 'sessions it runs' : 'sessions to start' },
      ]
    : [
        { n: `+${o.delta.added}`, k: 'new seats', tone: o.delta.added ? 'add' : undefined },
        { n: o.delta.changed, k: 'seats changed', tone: o.delta.changed ? 'chg' : undefined },
        { n: o.delta.removed ? `−${o.delta.removed}` : 0, k: 'seats removed', tone: o.delta.removed ? 'del' : undefined },
        { n: o.delta.other, k: 'routes and rules' },
      ];
  const shown = o.first ? o.seats : o.seats.filter((s) => s.status !== 'same');
  const unchanged = o.seats.length - shown.length;
  return (
    <Scrim onClose={p.onCancel} busy={p.busy}>
      <div className="sh-hd">
        <b>{p.title}</b>
        <span>{p.sub}</span>
        {p.banner ? <div className="banner ok">{p.banner}</div> : null}
      </div>
      <div className="sh-bd">
        <div className="ap-tiles">
          {tiles.map((t) => (
            <div key={t.k} className={`ap-tile${t.tone ? ` ${t.tone}` : ''}`}>
              <b>{t.n}</b>
              <span>{t.k}</span>
            </div>
          ))}
        </div>

        {o.check.length ? (
          <div className="ap-check">
            <div className="lab">
              Check these <b>{o.check.length}</b>
            </div>
            {o.check.map((l, i) => (
              <Line key={i} l={l} warn />
            ))}
          </div>
        ) : null}

        <div className="lab">
          {o.first ? 'Seats' : 'Seats that change'} <b>{shown.length}</b>
          {unchanged ? <span className="ap-quiet">{unchanged} unchanged</span> : null}
        </div>
        {shown.map((s) => {
          const fx = effectOf(s.id);
          const open = !!openSeat[s.id];
          return (
            <div key={s.id} className={`ap-seat${open ? ' open' : ''}${s.status === 'removed' ? ' gone' : ''}`}>
              <button className="ap-row" onClick={() => s.lines.length && setOpenSeat((x) => ({ ...x, [s.id]: !x[s.id] }))} disabled={!s.lines.length} aria-expanded={open}>
                <span className="htile" style={sc(p.colorOf(s.id))}>
                  {s.name[0]?.toUpperCase()}
                </span>
                <span className="ap-who">
                  <b>
                    {s.name}
                    {s.warn ? <i className="ap-warn" title="Something here is worth checking (above)">⚠</i> : null}
                  </b>
                  <span className="ap-facts">{s.status === 'removed' ? 'stands down and leaves the team' : s.facts.join(' · ')}</span>
                  {fx.map((r, i) => (
                    <span key={i} className={`ap-fx ${r.kind}`}>
                      {r.text}
                    </span>
                  ))}
                </span>
                {s.status !== 'same' && !o.first ? <span className={`ap-badge ${s.status}`}>{STATUS_WORD[s.status]}</span> : null}
                {s.lines.length ? <span className="ap-chev" aria-hidden="true">›</span> : null}
              </button>
              {open ? (
                <div className="ap-lines">
                  {s.lines.map((l, i) => (
                    <Line key={i} l={l} />
                  ))}
                </div>
              ) : null}
            </div>
          );
        })}

        {o.rest.length ? (
          <div className={`ap-seat${restOpen ? ' open' : ''}`}>
            <button className="ap-row" onClick={() => setRestOpen((x) => !x)} aria-expanded={restOpen}>
              <span className="htile" style={sc('var(--ink3)')}>
                ↔
              </span>
              <span className="ap-who">
                <b>Routes, groups and rules</b>
                <span className="ap-facts">{o.first ? `${plural(o.counts.routes, 'route')}, ${plural(o.counts.groups, 'group')} and ${plural(o.counts.rules, 'escalation rule')}, as on the canvas` : plural(o.rest.length, 'change')}</span>
              </span>
              <span className="ap-chev" aria-hidden="true">›</span>
            </button>
            {restOpen ? (
              <div className="ap-lines">
                {o.rest.map((l, i) => (
                  <Line key={i} l={l} />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {p.effects?.atOnce.length ? (
          <div className="ap-note">
            The team's {listWords(p.effects.atOnce)} {p.effects.atOnce.length > 1 ? 'take' : 'takes'} effect at once; nobody restarts for {p.effects.atOnce.length > 1 ? 'them' : 'it'}.
          </div>
        ) : p.effects && !p.effects.rows.length ? (
          <div className="ap-note">Nothing for the running seats to act on.</div>
        ) : !p.effects && p.tag !== 'Approve' ? (
          <div className="ap-note">
            The team isn't running, so nothing restarts. Bringing it up starts {plural(o.counts.seats, 'seat')} ({plural(o.counts.sessions, 'session')}).
          </div>
        ) : null}
        {p.error ? <div className="banner">{p.error}</div> : null}
      </div>
      <div className="sh-ft">
        <span className="note">{p.note}</span>
        <button className="btn" disabled={p.busy} onClick={p.onCancel}>
          Cancel
        </button>
        {/* bringing a team up is offered for a team that isn't running; an approval is only an approval */}
        {p.effects || p.tag === 'Approve' ? (
          <button className="btn go" disabled={p.busy} onClick={() => p.onApply(false)}>
            {p.tag}
          </button>
        ) : (
          <>
            <button className="btn" disabled={p.busy} onClick={() => p.onApply(false)}>
              {p.tag}
            </button>
            <button className="btn go" disabled={p.busy} onClick={() => p.onApply(true)}>
              {p.tag} and bring up
            </button>
          </>
        )}
      </div>
    </Scrim>
  );
}

/** A refused Apply: what changed under you, and your draft on top of it (yours kept where you both changed something). */
export function ConflictSheet(p: { from: number; to: number; theirs: string[]; conflicts: string[]; problems?: string[]; busy: boolean; onCancel(): void; onRebase(): void }) {
  return (
    <Scrim onClose={p.onCancel} busy={p.busy}>
      <div className="sh-hd">
        <b>The team changed while you worked</b>
        <span>
          v{p.from} → v{p.to} · your apply was refused; nothing changed
        </span>
        <p>Rebase puts your draft on top of the new version: theirs where you didn't touch it, yours where you both did.</p>
      </div>
      <div className="sh-bd">
        <div className="lab">
          Their changes <b>{p.theirs.length}</b>
        </div>
        {p.theirs.map((l, i) => (
          <div key={i} className="cl">
            <span className="g">·</span>
            <span>{l}</span>
          </div>
        ))}
        <div className="lab">
          Your draft on top <b>{p.conflicts.length ? `${p.conflicts.length} conflict${p.conflicts.length > 1 ? 's' : ''}` : 'clean'}</b>
        </div>
        {p.conflicts.length ? (
          p.conflicts.map((c, i) => (
            <div key={i} className="cl w">
              <span className="g">!</span>
              <span>{c}</span>
            </div>
          ))
        ) : (
          <div className="cl">
            <span className="g">·</span>
            <span>No conflicts: your changes apply cleanly on top of theirs.</span>
          </div>
        )}
        {p.problems?.length ? (
          <>
            <div className="lab">
              New problems <b>{p.problems.length}</b>
            </div>
            {p.problems.map((c, i) => (
              <div key={i} className="cl w">
                <span className="g">!</span>
                <span>{c}</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
      <div className="sh-ft">
        <span className="note">After rebasing you review it again before applying.</span>
        <button className="btn" disabled={p.busy} onClick={p.onCancel}>
          Cancel
        </button>
        <button className="btn go" disabled={p.busy || !!p.problems?.length} title={p.problems?.length ? 'Fix the problems first' : ''} onClick={p.onRebase}>
          Rebase my draft
        </button>
      </div>
    </Scrim>
  );
}
