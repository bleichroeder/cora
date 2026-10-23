import { useEffect, useState } from 'react';
import type { InboxSource, SetupItem, SetupNeed } from '@cora/shared';
import { finishFirstRun, hooksPreview, loadSetup, runNeed, saveVoiceKey, skipItem, useSetup } from '../state/setup';
import { openSettings } from './SettingsModal';
import { BrandIcon, BRAND_COLOR } from './BrandIcon';
import { CoraMark } from './CoraEye';
import { Icon } from './Icon';
import './setup.css';

/** Each item's tile: a service's own logo, Cora's lens, or an icon. */
const TILE: Record<string, { brand?: InboxSource; icon?: string; c?: string }> = {
  claude: { icon: 'SquareTerminal', c: '#d97757' },
  hooks: { icon: 'Link', c: 'var(--cora)' },
  agent: { brand: 'cora' },
  pipelines: { brand: 'gitlab' },
  environments: { icon: 'Monitor', c: 'var(--run)' },
  jira: { brand: 'jira' },
  voice: { icon: 'Mic', c: '#a78bfa' },
  slack: { brand: 'slack' },
  gmail: { brand: 'mail' },
  screenshots: { icon: 'Camera' },
  basics: { icon: 'NotebookPen' },
};
const HOW: Record<SetupNeed['how'], string> = { itself: 'Cora does it', ok: 'with your OK', you: 'you, with steps' };

function Tile({ id }: { id: string }) {
  const t = TILE[id] ?? { icon: 'Circle' };
  const c = t.brand ? BRAND_COLOR[t.brand] : t.c;
  return (
    <span className="su-tile" style={c ? { ['--c' as any]: c } : undefined}>
      {t.brand ? <BrandIcon source={t.brand} size={16} /> : <Icon name={t.icon!} size={15} />}
    </span>
  );
}

const statusText = (i: SetupItem): string => {
  if (i.status === 'ready') {
    const extras = i.needs.filter((n) => n.optional && !n.done).length;
    return extras ? `Ready · ${extras} extra${extras === 1 ? '' : 's'}` : 'Ready';
  }
  if (i.status === 'skipped') return 'Skipped';
  const must = i.needs.filter((n) => !n.optional);
  if (i.status === 'partial') return `${must.filter((n) => n.done).length} of ${must.length}`;
  return i.id === 'hooks' ? 'Not installed' : 'Needs setup';
};

export function Status({ i }: { i: SetupItem }) {
  const extras = i.status === 'ready' && i.needs.some((n) => n.optional && !n.done);
  return (
    <span className={`su-st ${i.status === 'ready' && !extras ? 'ok' : i.status === 'partial' || extras ? 'part' : i.status}${i.required ? ' req' : ''}`}>
      <i />
      {statusText(i)}
    </span>
  );
}

/** The checklist: required first, then the features (and, on the first run, your workplace). */
export function SetupList() {
  const state = useSetup((s) => s.state);
  useEffect(() => void loadSetup(), []);
  if (!state) return <div className="set-loading">checking…</div>;
  const req = state.items.filter((i) => i.required);
  const feats = state.items.filter((i) => !i.required);
  const done = (l: SetupItem[]) => l.filter((i) => i.status === 'ready').length;
  return (
    <div className="su-list">
      <div className="su-sec" id="su-required">
        Required <span>{done(req)} / {req.length}</span>
      </div>
      <div className="su-rows">
        {req.map((i) => (
          <Row key={i.id} i={i} startOpen={i.status !== 'ready'} />
        ))}
      </div>
      <div className="su-sec" id="su-features">
        Features <span>{done(feats)} / {feats.length}</span>
      </div>
      <div className="su-rows">
        {feats.map((i) => (
          <Row key={i.id} i={i} startOpen={false} />
        ))}
      </div>
    </div>
  );
}

function Row({ i, startOpen }: { i: SetupItem; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const openable = i.needs.some((n) => !n.done || n.how !== 'itself' || n.value) && i.id !== 'basics';
  return (
    <div className={`su-row${open ? ' open' : ''}${i.required ? ' req' : ''}`}>
      <button className="su-rh" onClick={() => openable && setOpen(!open)} aria-expanded={open}>
        <Tile id={i.id} />
        <span className="t">
          <b>{i.title}</b>
          <span>{i.status === 'ready' && i.id === 'claude' ? i.needs.map((n) => n.value).filter(Boolean).join(' · ') : i.blurb}</span>
        </span>
        <Status i={i} />
        {openable ? <Icon name={open ? 'ChevronUp' : 'ChevronDown'} size={14} className="su-chev" /> : <span />}
      </button>
      {open ? (
        <div className="su-rb">
          {i.needs.map((n) => (
            <Need key={n.id} i={i} n={n} />
          ))}
          {!i.required && i.status !== 'ready' ? (
            <div className="su-tail">
              {i.without ? <span>Without it: {i.without.replace(/^./, (c) => c.toLowerCase())}</span> : <span />}
              <span className="sp" />
              {i.page ? (
                <button className="btn ghost" onClick={() => openSettings(i.page)}>
                  Its settings
                </button>
              ) : null}
              <button className="btn ghost" onClick={() => void skipItem(i.id, i.status !== 'skipped')}>
                {i.status === 'skipped' ? 'Set it up after all' : 'Skip'}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Need({ i, n }: { i: SetupItem; n: SetupNeed }) {
  const key = `${i.id}/${n.id}`;
  const busy = useSetup((s) => !!s.busy[key]);
  const err = useSetup((s) => s.err[key]);
  const waiting = n.after ? !i.needs.find((x) => x.id === n.after)?.done : false;
  const [diff, setDiff] = useState<string | null>(null);
  const [keyText, setKeyText] = useState('');
  const verb = i.id === 'hooks' ? 'Install' : /login|signin/.test(n.id) ? 'Sign in' : i.id === 'agent' ? 'Add' : 'Install';
  return (
    <div className="su-need">
      <span className={`mk${n.done ? ' ok' : ''}`}>{n.done ? <Icon name="Check" size={10} strokeWidth={3} /> : null}</span>
      <span className="lb">
        <b>{n.label}</b>
        {n.value ? <code>{n.value}</code> : null}
        {!n.done ? <span className={`how ${n.how}`}>{n.optional ? `extra · ${HOW[n.how]}` : HOW[n.how]}</span> : null}
      </span>
      <span className="act">
        {!n.done && i.id === 'hooks' ? (
          <>
            <button className="btn ghost" onClick={() => (diff == null ? void hooksPreview().then((p) => setDiff(p?.diff ?? '')) : setDiff(null))}>
              {diff == null ? 'Show the change' : 'Hide the change'}
            </button>
            <button className="btn allow" disabled={busy} onClick={() => void runNeed(i.id, n.id)}>
              {busy ? 'Installing…' : 'Install'}
            </button>
          </>
        ) : !n.done && n.command ? (
          <button className="btn su-go" disabled={busy || waiting} title={waiting ? 'After the step above' : `Runs: ${n.command}`} onClick={() => void runNeed(i.id, n.id)}>
            {busy ? 'Opening…' : verb}
          </button>
        ) : !n.done && n.page && i.id !== 'voice' ? (
          <button className="btn" onClick={() => openSettings(n.page)}>
            Open its settings
          </button>
        ) : null}
      </span>
      {n.detail && !n.done ? <p>{n.detail}</p> : null}
      {!n.done && n.command && i.id !== 'hooks' ? (
        <div className="su-cmd">
          <span className="pr">&gt;</span>
          <span className="c">{n.command}</span>
        </div>
      ) : null}
      {diff != null ? <pre className="su-diff">{diff || 'Already there.'}</pre> : null}
      {!n.done && n.steps ? (
        <ol className="su-steps">
          {n.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      ) : null}
      {!n.done && i.id === 'voice' && n.id === 'key' ? (
        <div className="su-key">
          <input className="set-input" type="password" value={keyText} placeholder="sk_…" spellCheck={false} autoComplete="off" onChange={(e) => setKeyText(e.target.value)} />
          <button className="btn su-go" disabled={busy || !keyText.trim()} onClick={() => void saveVoiceKey(keyText).then((e) => !e && setKeyText(''))}>
            {busy ? 'Checking…' : 'Check and save'}
          </button>
        </div>
      ) : null}
      {err ? <span className="ny-err su-err">{err}</span> : null}
    </div>
  );
}

/** The first run: shown instead of the app until Open Cora (which needs the required two). */
export function SetupView() {
  const state = useSetup((s) => s.state);
  if (!state) return null;
  const req = state.items.filter((i) => i.required);
  const feats = state.items.filter((i) => !i.required);
  const ready = state.items.filter((i) => i.status === 'ready').length;
  const reqDone = req.every((i) => i.status === 'ready');
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return (
    <div className="su-view">
      {/* the window has no title bar of its own: this strip moves it (Windows' buttons sit at its right end) */}
      <div className="su-drag" />
      <aside className="su-side">
        <span className="su-orb">
          <CoraMark state="idle" size={96} live />
        </span>
        <h2>Let's set Cora up</h2>
        <p className="lead">Two things are required. The rest are features: set up the ones you want now, or later from Settings › Setup.</p>
        <div className="su-prog">
          <span className="ring" style={{ ['--p' as any]: Math.round((ready / state.items.length) * 100) }} />
          <span>
            <b>
              {ready} of {state.items.length} ready
            </b>
            <small>
              required {req.filter((i) => i.status === 'ready').length} of {req.length} · features {feats.filter((i) => i.status === 'ready').length} of {feats.length}
            </small>
          </span>
        </div>
        <nav className="su-toc">
          <button onClick={() => jump('su-required')}>
            <Icon name="Asterisk" size={14} /> Required
          </button>
          <button onClick={() => jump('su-features')}>
            <Icon name="LayoutGrid" size={14} /> Features
          </button>
        </nav>
        <div className="foot">
          <button className="btn allow su-open" disabled={!reqDone} onClick={() => void finishFirstRun()}>
            Open Cora
          </button>
          {reqDone ? (
            <span className="hint">You can come back to this in Settings › Setup</span>
          ) : (
            <button className="linkish hint" onClick={() => void finishFirstRun()} title="Sessions still show from their transcripts, without live tool and permission events">
              Open Cora without them
            </button>
          )}
        </div>
      </aside>
      <main className="su-main">
        <SetupList />
      </main>
    </div>
  );
}
