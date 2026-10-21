import { useEffect, useMemo, useRef, useState } from 'react';
import { EFFORTS, PERMISSION_MODES, coraTicketPrompt, issueUrl, jiraPrompt, type HistoryItem, type LaunchOptions, type LaunchPreset, type PermissionMode, type Settings } from '@cora/shared';
import { useBrain } from '../state/store';
import { fetchDirs, fetchHistory, launchTerminal } from '../state/ws';
import { ago, hashColor, shortCwd } from '../lib/format';
import { Icon } from './Icon';
import { TicketPicker, type PickedTicket } from './TicketPicker';
import { jiraSite, lookupIssue } from '../state/jira';
import './dialogs.css';

/**
 * The shell every dialog shares: a header (its title, and on the right what it switches between), the body, and a
 * footer on a hairline with the quiet Cancel and the one bright action.
 */
export function Dialog({ title, icon, extra, footer, className, onClose, children }: { title: string; icon?: string; extra?: React.ReactNode; footer?: React.ReactNode; className?: string; onClose(): void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-bg" onMouseDown={onClose}>
      <div className={`modal dlg${className ? ` ${className}` : ''}`} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span className="dlg-t">
            {icon ? <Icon name={icon} size={15} /> : null}
            {title}
          </span>
          <span className="spacer" />
          {extra}
          <button className="icon-btn dlg-x" onClick={onClose} title="Close (Esc)">
            <Icon name="X" size={15} />
          </button>
        </div>
        <div className="dlg-b">{children}</div>
        {footer ? <div className="dlg-f">{footer}</div> : null}
      </div>
    </div>
  );
}

/** A folder's tile: its name's first letter, in a colour of its own. */
export function FolderTile({ path, small }: { path: string; small?: boolean }) {
  const name = folderName(path);
  return (
    <span className={`dl-tile${small ? ' sm' : ''}`} style={{ ['--sc' as any]: hashColor(path.toLowerCase()) }}>
      {(name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
    </span>
  );
}
const folderName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
/** A folder that can't be listed, in words. */
const folderError = (path: string, e: string) => (/ENOENT|no such file/i.test(e) ? `There's no folder at ${path}.` : /EACCES|EPERM/i.test(e) ? `Cora can't open ${path}.` : /ENOTDIR/i.test(e) ? `${path} is a file, not a folder.` : e);
const EFFORT_LABEL: Record<string, string> = { '': 'Default', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'xHigh', max: 'Max' };

const MODE_LABEL: Record<PermissionMode, string> = {
  manual: 'Ask each time',
  acceptEdits: 'Accept edits',
  auto: 'Auto',
  plan: 'Plan',
  dontAsk: "Don't ask",
  bypassPermissions: 'Bypass permissions',
};
const MODEL_SUGGESTIONS = ['opus', 'sonnet', 'haiku', 'claude-opus-5-5[1m]'];

const optionsOf = (p: LaunchOptions): LaunchOptions => ({ model: p.model, effort: p.effort, permissionMode: p.permissionMode });
const optionTags = (o: LaunchOptions) => [o.model, o.effort && `${o.effort} effort`, o.permissionMode && MODE_LABEL[o.permissionMode]].filter(Boolean) as string[];

async function savePresets(presets: LaunchPreset[]): Promise<{ ok: boolean; error?: string; presets?: LaunchPreset[] }> {
  const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ presets }) });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, presets: (j as Settings).presets } : { ok: false, error: j.error ?? `HTTP ${r.status}` };
}

/** The folder the next New session dialog starts in (the command palette's "pick options" for a folder), and its tab. */
let startIn: string | null = null;
let startTab: 'blank' | 'jira' = 'blank';
/** a ticket picked already, or a first message (Start a session from the Inbox) */
let startTicket: PickedTicket | null = null;
let startBrief: string | null = null;
export function openNewSession(cwd?: string, tab: 'blank' | 'jira' = 'blank', o: { ticket?: PickedTicket; brief?: string } = {}) {
  startIn = cwd ?? null;
  startTab = tab;
  startTicket = o.ticket ?? null;
  startBrief = o.brief ?? null;
  useBrain.getState().setModal('new-session');
}

export function NewSessionModal() {
  const sessions = useBrain((s) => s.sessions);
  const focus = useBrain((s) => s.focus);
  const close = () => useBrain.getState().setModal(null);
  const recent = useMemo(() => {
    const seen = new Set<string>();
    return Object.values(sessions)
      .sort((a, b) => b.lastTs - a.lastTs)
      .map((s) => s.cwd)
      .filter((c) => c && !seen.has(c.toLowerCase()) && seen.add(c.toLowerCase()))
      .slice(0, 8);
  }, [sessions]);
  const [path, setPath] = useState(() => {
    const p = startIn;
    startIn = null;
    return p || (focus && sessions[focus]?.cwd) || recent[0] || '';
  });
  const [listing, setListing] = useState<{ path: string; parent: string | null; dirs: string[]; error?: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const starting = useRef(false);
  const [opts, setOpts] = useState<LaunchOptions>({});
  const [presets, setPresets] = useState<LaunchPreset[]>([]);
  const [naming, setNaming] = useState<string | null>(null);
  // From a Jira ticket: it starts with your own command (/jira KEY) or Cora's ticket prompt (Settings › Jira)
  const [tab, setTab] = useState(() => startTab);
  const [ticket, setTicket] = useState<PickedTicket | null>(() => {
    const t = startTicket;
    startTicket = null;
    return t;
  });
  // its first message (from the Inbox), yours to change
  const [brief, setBrief] = useState<string | null>(() => {
    const b = startBrief;
    startBrief = null;
    return b;
  });
  const fromTicket = tab === 'jira';

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((s: Settings) => setPresets(s.presets ?? []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void fetchDirs(path).then(setListing), 200);
    return () => clearTimeout(t);
  }, [path]);

  const launch = async (cwd: string, options: LaunchOptions) => {
    if (fromTicket && !ticket) return setErr('Pick a ticket first (or paste its key).');
    // one session per press: Enter held, or a double-click, waits for the first
    if (starting.current) return;
    starting.current = true;
    setBusy(true);
    setErr(null);
    const first = fromTicket && ticket ? await ticketStart(ticket) : brief?.trim() ? { brief: brief.trim() } : {};
    const r = await launchTerminal({ mode: 'new', cwd, options, ...first }).finally(() => (starting.current = false));
    setBusy(false);
    if (!r.ok) setErr(r.error);
    // started from the Inbox: you land in the new session
    else useBrain.getState().setInbox(false);
  };
  const folder = listing?.path ?? path;
  const sep = folder.includes('\\') ? '\\' : '/';
  const setOpt = (k: keyof LaunchOptions, v: string) => setOpts((o) => ({ ...o, [k]: v || undefined }));

  const persist = async (next: LaunchPreset[]) => {
    const r = await savePresets(next);
    if (r.ok) setPresets(r.presets ?? next);
    else setErr(r.error ?? 'could not save presets');
    return r.ok;
  };
  const savePreset = async () => {
    const name = (naming ?? '').trim();
    if (!name) return;
    const id = `p${Date.now().toString(36)}`;
    if (await persist([...presets, { id, name, cwd: folder, ...opts }])) setNaming(null);
  };

  const here = folderName(folder);
  const same = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
  return (
    <Dialog
      title="New session"
      icon="Plus"
      className="ns"
      onClose={close}
      extra={
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={!fromTicket} className={`seg-b${fromTicket ? '' : ' on'}`} onClick={() => setTab('blank')}>
            <Icon name="SquareTerminal" size={13} /> Blank
          </button>
          <button role="tab" aria-selected={fromTicket} className={`seg-b${fromTicket ? ' on' : ''}`} onClick={() => setTab('jira')}>
            <Icon name="Ticket" size={13} /> From a Jira ticket
          </button>
        </div>
      }
      footer={
        <>
          {naming === null ? (
            <button className="btn ghost" disabled={!!listing?.error} onClick={() => setNaming(here)} title="Save this folder and these options as a one-click starter">
              <Icon name="Rocket" size={13} /> Save as a starter
            </button>
          ) : (
            <span className="pr-name">
              <input value={naming} autoFocus maxLength={40} placeholder="Starter name" onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => (e.key === 'Enter' ? void savePreset() : e.key === 'Escape' ? (e.stopPropagation(), setNaming(null)) : null)} />
              <button className="btn allow" disabled={!naming.trim()} onClick={() => void savePreset()}>Save</button>
              <button className="btn ghost" onClick={() => setNaming(null)}>Cancel</button>
            </span>
          )}
          <span className="spacer" />
          <button className="btn ghost" onClick={close}>Cancel</button>
          <button className="btn allow" disabled={busy || !!listing?.error || (fromTicket && !ticket)} onClick={() => void launch(folder, opts)} title={fromTicket && ticket ? `Starts Claude in ${folder} on ${ticket.key}` : `Starts Claude in ${folder}`}>
            <Icon name="Play" size={13} /> {fromTicket ? (ticket ? `Start ${ticket.key} in ${here}` : 'Pick a ticket') : `Start in ${here}`}
          </button>
        </>
      }
    >
      {!fromTicket && brief != null ? (
        <>
          <div className="dlg-gl">First message</div>
          <textarea className="ns-brief" value={brief} rows={6} onChange={(e) => setBrief(e.target.value)} placeholder="What should it do?" autoFocus />
        </>
      ) : null}
      {fromTicket ? (
        <>
          <div className="dlg-gl">Ticket</div>
          <TicketPicker picked={ticket} onPick={setTicket} onStart={() => !busy && !listing?.error && void launch(folder, opts)} />
        </>
      ) : null}
      {presets.length ? (
        <>
          <div className="dlg-gl">
            Starters <span className="n">{presets.length}</span>
          </div>
          <div className="ns-starters">
            {presets.map((p) => (
              <div key={p.id} className="ns-st" role="button" tabIndex={0} title={`Start in ${p.cwd}`} onClick={() => !busy && void launch(p.cwd, optionsOf(p))} onKeyDown={(e) => e.key === 'Enter' && !busy && void launch(p.cwd, optionsOf(p))}>
                <b>
                  <Icon name="Rocket" size={12} /> <span>{p.name}</span>
                  <span
                    className="ns-st-x"
                    role="button"
                    title="Delete this starter"
                    onClick={(e) => {
                      e.stopPropagation();
                      void persist(presets.filter((x) => x.id !== p.id));
                    }}
                  >
                    <Icon name="X" size={11} />
                  </span>
                </b>
                <span className="ns-st-d">{shortCwd(p.cwd)}</span>
                <em>{optionTags(p).join(' · ') || 'default'}</em>
              </div>
            ))}
          </div>
        </>
      ) : null}
      <div className="dlg-gl">Folder</div>
      <label className={`dlg-inp code${listing?.error ? ' bad' : ''}`}>
        <Icon name="Folder" size={14} />
        <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !busy && !listing?.error && void launch(folder, opts)} autoFocus={!fromTicket} spellCheck={false} />
      </label>
      <div className="ns-where">
        <div className="ns-col">
          <div className="ns-h">Recent</div>
          {recent.map((c) => (
            <button key={c} className={`ns-row${same(c, folder) ? ' on' : ''}`} onClick={() => setPath(c)} title={c}>
              <FolderTile path={c} small />
              <span className="ns-row-t">
                <b>{folderName(c)}</b>
                <span>{c}</span>
              </span>
            </button>
          ))}
          {!recent.length ? <div className="ns-none">Folders your sessions work in show here.</div> : null}
        </div>
        <div className="ns-col">
          <div className="ns-h">Browse</div>
          {listing?.error ? (
            <div className="ns-miss">
              {folderError(path, listing.error)}
              <span>Check the path, or pick one on the left.</span>
            </div>
          ) : (
            <>
              {listing?.parent ? (
                <button className="ns-dir" onClick={() => setPath(listing.parent!)}>
                  <Icon name="CornerLeftUp" size={13} /> ..
                </button>
              ) : null}
              {listing?.dirs.map((d) => (
                <button key={d} className="ns-dir" onClick={() => setPath(listing.path.replace(/[\\/]+$/, '') + sep + d)}>
                  <Icon name="Folder" size={13} /> {d}
                </button>
              ))}
              {listing && !listing.dirs.length ? <div className="ns-none">No folders inside.</div> : null}
            </>
          )}
        </div>
      </div>
      <div className="dlg-gl">Options</div>
      <div className="ns-opts">
        <span>Model</span>
        <span>
          <input className="dlg-sel" list="ab-models" placeholder="default" value={opts.model ?? ''} onChange={(e) => setOpt('model', e.target.value.trim())} spellCheck={false} />
          <datalist id="ab-models">{MODEL_SUGGESTIONS.map((m) => <option key={m} value={m} />)}</datalist>
        </span>
        <span>Effort</span>
        <span>
          <div className="seg" role="radiogroup">
            {(['', ...EFFORTS] as string[]).map((x) => (
              <button key={x || 'default'} role="radio" aria-checked={(opts.effort ?? '') === x} className={`seg-b${(opts.effort ?? '') === x ? ' on' : ''}`} onClick={() => setOpt('effort', x)}>
                {EFFORT_LABEL[x] ?? x}
              </button>
            ))}
          </div>
        </span>
        <span>Permissions</span>
        <span>
          <select className="dlg-sel" value={opts.permissionMode ?? ''} onChange={(e) => setOpt('permissionMode', e.target.value)}>
            <option value="">Default</option>
            {PERMISSION_MODES.map((x) => <option key={x} value={x}>{MODE_LABEL[x]}</option>)}
          </select>
        </span>
      </div>
      {err ? <div className="ny-err">{err}</div> : null}
    </Dialog>
  );
}

/** The day an older session belongs to: Today, Yesterday, or Earlier. */
function dayOf(ts: number, now = new Date()): 'Today' | 'Yesterday' | 'Earlier' {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return ts >= start ? 'Today' : ts >= start - 86_400_000 ? 'Yesterday' : 'Earlier';
}

export function HistoryModal() {
  const close = () => useBrain.getState().setModal(null);
  const [items, setItems] = useState<HistoryItem[] | null>(null);
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => void fetchHistory().then(setItems), []);
  // what was said in them: searched on the server (prompts and replies), a moment after you stop typing
  const [said, setSaid] = useState<Array<HistoryItem & { snippet?: string }> | null>(null);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    setSaid(null);
    if (q.trim().length < 3) return;
    let live = true;
    const t = setTimeout(() => {
      setSearching(true);
      void fetch(`/api/history/search?q=${encodeURIComponent(q.trim())}`)
        .then((r) => (r.ok ? r.json() : { sessions: [] }))
        .then((j: { sessions: Array<HistoryItem & { snippet?: string }> }) => live && setSaid(j.sessions))
        .catch(() => {})
        .finally(() => live && setSearching(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  // Claude's picks, from what you remember of it (what's typed)
  const [picks, setPicks] = useState<HistoryItem[] | null>(null);
  // while Claude looks: since when (a counter shows it's at work), and how to stop it
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [, tick] = useState(0);
  const stopAsk = useRef<AbortController | null>(null);
  const asking = askedAt != null;
  useEffect(() => setPicks(null), [q]);
  useEffect(() => {
    if (askedAt == null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [askedAt]);
  useEffect(() => () => stopAsk.current?.abort(), []);
  const ask = async () => {
    if (!q.trim() || asking) return;
    const ctl = new AbortController();
    stopAsk.current = ctl;
    setAskedAt(Date.now());
    setErr(null);
    setPicks(null);
    const r = await fetch('/api/history/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: q.trim() }), signal: ctl.signal }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (ctl.signal.aborted) return;
    setAskedAt(null);
    if (!r?.ok) return setErr(j.error ?? 'Claude couldn’t answer');
    setPicks(j.sessions ?? []);
  };
  const cancelAsk = () => {
    stopAsk.current?.abort();
    setAskedAt(null);
  };
  const named = (items ?? []).filter((h) => !q || `${h.title} ${h.firstPrompt} ${h.cwd}`.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  const pickIds = new Set((picks ?? []).map((h) => h.sessionId));
  const namedIds = new Set(named.map((h) => h.sessionId));
  const deep = (said ?? []).filter((h) => !namedIds.has(h.sessionId) && !pickIds.has(h.sessionId));
  const groups: Array<{ d: string; rows: Array<HistoryItem & { snippet?: string }> }> = [
    ...(picks?.length ? [{ d: 'Claude’s picks', rows: picks }] : []),
    ...(['Today', 'Yesterday', 'Earlier'] as const).map((d) => ({ d, rows: named.filter((h) => !pickIds.has(h.sessionId) && dayOf(h.mtime) === d) })),
    ...(deep.length ? [{ d: 'In what was said', rows: deep }] : []),
  ].filter((g) => g.rows.length);
  const flat = groups.flatMap((g) => g.rows);
  const at = Math.min(sel, Math.max(0, flat.length - 1));
  useEffect(() => setSel(0), [q]);
  // braces, not an arrow's value: scrollIntoView returns a promise in newer Chromium, and an effect may only return its clean-up
  useEffect(() => {
    list.current?.querySelector('.hs-row.on')?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const going = useRef(false);
  const go = async (h: HistoryItem | undefined, mode: 'resume' | 'fork') => {
    if (!h?.cwd || going.current) return;
    going.current = true;
    setErr(null);
    const r = await launchTerminal({ mode, sessionId: h.sessionId, cwd: h.cwd || undefined }).finally(() => (going.current = false));
    if (!r.ok) setErr(r.error);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setSel(Math.max(0, Math.min(flat.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void go(flat[at], e.ctrlKey || e.metaKey ? 'fork' : 'resume');
    }
  };
  let i = 0;
  return (
    <Dialog
      title="Resume a session"
      icon="History"
      className="hs"
      onClose={close}
      footer={
        <>
          <span className="dlg-keys">
            <span><b>↑↓</b> move</span>
            <span><b>Enter</b> resume</span>
            <span><b>Ctrl Enter</b> fork</span>
          </span>
          <span className="spacer" />
          <span className="dlg-keys">{items ? `${items.length} session${items.length === 1 ? '' : 's'}` : ''}</span>
        </>
      }
    >
      <label className="dlg-inp">
        <Icon name="Search" size={14} />
        <input placeholder="Search titles, folders, and what was said, or describe it and Ask Claude" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} autoFocus />
        {searching ? <span className="hs-busy">searching…</span> : null}
        {q.trim().length >= 3 ? (
          <button className="btn ghost hs-ask" disabled={asking} onClick={() => void ask()} title="Claude picks the sessions that fit what you describe, from their titles, folders, first prompts and dates">
            <Icon name="Sparkles" size={12} /> {asking ? 'Asking…' : 'Ask Claude'}
          </button>
        ) : null}
      </label>
      {err ? <div className="ny-err">{err}</div> : null}
      {asking ? (
        <div className="hs-asking" role="status">
          <span className="hs-spin" />
          <span>
            <b>Claude is looking through your sessions</b>
            <span>
              Their titles, folders, first prompts and dates, for “{q.trim().slice(0, 60)}” · {Math.round((Date.now() - askedAt!) / 1000)} s (usually 10 to 20)
            </span>
          </span>
          <button className="btn ghost" onClick={cancelAsk}>
            Cancel
          </button>
        </div>
      ) : picks && !picks.length ? (
        <div className="hs-asking none">
          <Icon name="SearchX" size={14} />
          <span>
            <b>Claude found nothing that fits</b>
            <span>Say a bit more about it (the folder, the ticket, roughly when), and ask again.</span>
          </span>
        </div>
      ) : null}
      <div className="hs-list" ref={list}>
        {!items ? <div className="ns-none">Loading…</div> : null}
        {groups.map((g) => (
          <div key={g.d}>
            <div className="dlg-gl">
              {g.d} <span className="n">{g.rows.length}</span>
            </div>
            {g.rows.map((h) => {
              const me = i++;
              const title = h.title || h.firstPrompt;
              return (
                <div key={h.sessionId} className={`hs-row${me === at ? ' on' : ''}`} onMouseMove={() => me !== at && setSel(me)} onDoubleClick={() => void go(h, 'resume')}>
                  <FolderTile path={h.cwd || h.sessionId} />
                  <span className="hs-t">
                    <b className={title ? '' : 'un'}>{title || <>Untitled <code>{h.sessionId.slice(0, 8)}</code></>}</b>
                    <span>
                      {shortCwd(h.cwd)} · {ago(h.mtime)} ago
                    </span>
                    {h.snippet ? <span className="hs-snip">…{h.snippet}…</span> : null}
                  </span>
                  <span className="hs-a">
                    <button className="btn allow" disabled={!h.cwd} onClick={() => void go(h, 'resume')} title="Make sure it isn't open in another terminal">
                      <Icon name="Play" size={12} /> Resume
                    </button>
                    <button className="btn ghost" disabled={!h.cwd} onClick={() => void go(h, 'fork')} title="A copy that goes its own way">
                      <Icon name="GitBranch" size={12} /> Fork
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}
        {items && !groups.length && !searching && !asking && !picks ? <div className="ns-none">No sessions match.</div> : null}
      </div>
    </Dialog>
  );
}

/**
 * A ticket session's first message: your own command (`/jira KEY`) when that's how you start them, else Cora's ticket
 * prompt from the ticket as Cora reads it (typed in once Claude is ready: it's longer than a launch argument may be).
 */
async function ticketStart(t: PickedTicket): Promise<{ prompt: string } | { brief: string }> {
  const how = (await fetch('/api/ticket-start')
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)) as { use: 'command'; command: string } | { use: 'cora' } | null;
  if (how?.use === 'command') return { prompt: jiraPrompt(t.key, how.command) };
  if (!how) return { prompt: jiraPrompt(t.key) };
  const r = await lookupIssue(t.key, { ...(t.site ? { site: t.site } : {}), force: true });
  const i = r.ok ? r.value : null;
  // its link even when Jira couldn't be read (the session is linked to the ticket by it)
  const site = t.site || jiraSite();
  const url = i?.url ?? (site ? issueUrl(site, t.key) : undefined);
  return { brief: coraTicketPrompt({ key: t.key, ...(url ? { url } : {}), ...(i ? { summary: i.summary, status: i.status.name, ...(i.type ? { type: i.type.name } : {}), ...(i.description ? { description: i.description } : {}) } : {}) }) };
}
