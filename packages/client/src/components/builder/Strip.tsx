import type { ReactNode } from 'react';
import { MSG_KINDS, endpointName, endpointOptions, type LintItem, type LintTarget, type Team, type TraceMsg, type TraceStep } from '@cora/shared';
import { Segs } from './Words';

export type Notice = { text: string; level: 'warn' | 'info' };
export type StripProps = {
  tab: 'checks' | 'try';
  onTab(t: 'checks' | 'try'): void;
  checks: LintItem[];
  /** said in the checks: what the last delete or move did (info), and trouble (warn: a clash with Cora's change, an edit not saved, a bring-up that failed) */
  notices: Notice[];
  isSelected(t?: LintTarget): boolean;
  onPickCheck(t?: LintTarget): void;
  sum: { text: string; tone: '' | 'ok' | 'bad' };
  applyLabel: 'Apply' | 'Approve';
  applyDisabled: boolean;
  applyTitle: string;
  onApply(): void;
  /** a lead's proposal: Reject */
  onReject?: () => void;
  tryPanel: ReactNode;
};

/** The strip: the checks, Try a message, and Apply. */
export function Strip(p: StripProps) {
  const errs = p.checks.filter((c) => c.level === 'error').length;
  const warns = p.checks.length - errs + p.notices.filter((n) => n.level === 'warn').length;
  return (
    <footer className="tb-strip">
      <div className="sh">
        <button className={`tab${p.tab === 'checks' ? ' on' : ''}`} onClick={() => p.onTab('checks')}>
          Checks{' '}
          <span className="cnt">
            {errs ? <i className="e">{errs}</i> : null}
            {warns ? <i className="w">{warns}</i> : null}
            {!errs && !warns ? <i className="ok">0</i> : null}
          </span>
        </button>
        <button className={`tab${p.tab === 'try' ? ' on' : ''}`} data-tour="try" onClick={() => p.onTab('try')}>
          Try a message
        </button>
        <span className="sp" />
        <span className={`sum${p.sum.tone ? ` ${p.sum.tone}` : ''}`}>{p.sum.text}</span>
        {p.onReject ? (
          <button className="btn" onClick={p.onReject}>
            Reject
          </button>
        ) : null}
        <button className="btn go" data-tour="apply" disabled={p.applyDisabled} title={p.applyTitle} onClick={p.onApply}>
          {p.applyLabel}
        </button>
      </div>
      <div className="sb">
        {p.tab === 'checks' ? (
          <div className="pane">
            {p.checks.length || p.notices.length ? (
              <>
                {p.checks.map((c, i) => (
                  <div key={i} className={`ck ${c.level}${p.isSelected(c.target) ? ' on' : ''}`} title={c.target ? 'Select it' : ''} onClick={() => p.onPickCheck(c.target)}>
                    <span className="g" />
                    <span className="t">{c.text}</span>
                    <span className="lv">{c.level === 'error' ? 'error · Apply is off' : 'warning'}</span>
                  </div>
                ))}
                {p.notices.map((n, i) => (
                  <div key={`n${i}`} className={`ck ${n.level}`}>
                    <span className="g" />
                    <span className="t">{n.text}</span>
                    <span className="lv">{n.level === 'warn' ? 'warning' : 'done'}</span>
                  </div>
                ))}
              </>
            ) : (
              <div className="empty">Nothing to fix. Try a message to see how it moves through the team.</div>
            )}
          </div>
        ) : (
          p.tryPanel
        )}
      </div>
    </footer>
  );
}

export type TryProps = {
  team: Team;
  form: TraceMsg;
  onForm(f: TraceMsg): void;
  /** the steps shown so far (they appear one by one) */
  shown: TraceStep[];
  /** where each "Then what?" began, in `shown` */
  continuedAt: number[];
  done: boolean;
  canThen: boolean;
  /** the pickers just changed for "Then what?" */
  flash: boolean;
  onRun(): void;
  onThen(): void;
  onClear(): void;
  examples: Array<[string, TraceMsg]>;
  /** an example picked: run it as it is */
  onExample(m: TraceMsg): void;
};

function Pick({ label, value, flash, onChange, options }: { label: string; value: string; flash: boolean; onChange(v: string): void; options: Array<[string, string]> }) {
  return (
    <label className={`pick${flash ? ' flash' : ''}`}>
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Try a message: who sends it, what kind, its labels, who it's for; then the steps, as the rules say. */
export function TryPanel(p: TryProps) {
  const t = p.team;
  const f = p.form;
  const from = endpointOptions(t, { groups: false });
  const to = endpointOptions(t);
  let n = 0;
  return (
    <div className="try">
      <div className="tf">
        <Pick label="From" value={f.from} flash={p.flash} onChange={(v) => p.onForm({ ...f, from: v as TraceMsg['from'] })} options={from} />
        <Pick label="To" value={f.to} flash={p.flash} onChange={(v) => p.onForm({ ...f, to: v as TraceMsg['to'] })} options={to} />
        <Pick label="Kind" value={f.kind} flash={p.flash} onChange={(v) => p.onForm({ ...f, kind: v as TraceMsg['kind'] })} options={MSG_KINDS.map((k) => [k, k])} />
        {t.labels.map((L) => (
          <label key={L.id} className="pick">
            <span>{L.id}</span>
            <select
              value={f.labels?.[L.id] ?? ''}
              onChange={(e) => {
                const labels = { ...(f.labels ?? {}) };
                if (e.target.value) labels[L.id] = e.target.value;
                else delete labels[L.id];
                p.onForm({ ...f, labels });
              }}
            >
              <option value="">none</option>
              {L.values.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}
        <div className="tbtns">
          <button className="btn go sm" onClick={p.onRun}>
            {p.continuedAt.length && !p.done ? 'Run on' : 'Run'}
          </button>
          <button className="btn sm" disabled={!p.canThen} title="Continue from the seat it reached" onClick={p.onThen}>
            Then what?
          </button>
          <button className={`tchip ui${f.critical ? ' on' : ''}`} title="Mark it critical" onClick={() => p.onForm({ ...f, critical: !f.critical })}>
            critical
          </button>
          <span className="sp" />
          <button className="btn sm ghost" onClick={p.onClear}>
            Clear
          </button>
        </div>
      </div>
      <div className="tl">
        {p.shown.length ? (
          p.shown.map((s, i) => {
            const caveat = s.kind === 'caveat';
            const numbered = s.kind !== 'blocked' && s.kind !== 'reach' && !caveat;
            if (numbered) n++;
            return (
              <div key={i}>
                {p.continuedAt.includes(i) ? <div className="thn">Then, from {endpointName(t, f.from)}</div> : null}
                {caveat ? (
                  <div className="tnote">{s.text}</div>
                ) : (
                  <div className={`ts k-${s.kind}`}>
                    <i>{numbered ? n : s.kind === 'blocked' ? '×' : '✓'}</i>
                    <span>
                      <Segs segs={s.segs} />
                    </span>
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="tempty">
            Pick who sends it, its kind, its labels and who it's for, then Run. Nothing starts: it traces the rules.
            {p.examples.length ? (
              <div className="tg-row">
                {p.examples.map(([label, m]) => (
                  <button key={label} className="tchip ui" onClick={() => p.onExample(m)}>
                    {label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
