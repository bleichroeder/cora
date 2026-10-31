import { useState } from 'react';
import { bySeverity, itemOpen, SEVERITIES, type ItemSeverity, type Project, type ProjectItem } from '@cora/shared';
import { useBrain } from '../../state/store';
import { itemOp, projectOfBoard, useProject } from '../../state/projects';
import { ago, sessionColor, sessionName } from '../../lib/format';
import { Icon } from '../Icon';
import '../projects.css';

/**
 * A project's items on its board: its
 * incidents (one per outage, most urgent first, with the log of closed ones) and its known issues. You act as the
 * user: you may change anything; the sessions change theirs through their tools.
 */
type Props = { sessionId: string };

export const SEV_COLOR: Record<ItemSeverity, string> = { critical: 'var(--need)', high: '#fb923c', medium: '#fbbf24', low: 'var(--ink3)' };
/** An open incident nobody has touched in this long reads as quiet (dimmed): someone should look. */
const QUIET = 2 * 3_600_000;

function useWho() {
  const sessions = useBrain((s) => s.sessions);
  return (by?: string) => (!by ? { name: 'nobody', color: 'var(--ink4)' } : by === 'you' ? { name: 'You', color: 'var(--cora)' } : by === 'cora' ? { name: 'Cora', color: 'var(--cora)' } : sessions[by] ? { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) } : { name: 'a session', color: 'var(--ink3)' });
}

/** Incidents: open ones by severity (owner, state, next step, the latest note), or the log; open, assign, claim, close, merge. */
export function IncidentsPanel({ sessionId }: Props) {
  const p = useProject(projectOfBoard(sessionId));
  const [log, setLog] = useState(false);
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  if (!p) return null;
  const all = (p.items ?? []).filter((i) => i.kind === 'incident');
  const live = all.filter(itemOpen).sort(bySeverity);
  const closed = all.filter((i) => !itemOpen(i)).sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
  const counts = SEVERITIES.map((s) => [s, live.filter((i) => (i.severity ?? 'medium') === s).length] as const).filter(([, n]) => n);
  return (
    <div className="pi">
      <div className="pi-head">
        <span className="pp-seg">
          <button className={!log ? 'on' : ''} onClick={() => setLog(false)}>
            Open {live.length ? <b>{live.length}</b> : null}
          </button>
          <button className={log ? 'on' : ''} onClick={() => setLog(true)} title="Closed incidents: their cause and fix">
            Log
          </button>
        </span>
        {!log && counts.length ? (
          <span className="pi-sevs">
            {counts.map(([s, n]) => (
              <span key={s} style={{ ['--kc' as any]: SEV_COLOR[s] }}>
                <i />
                {n} {s}
              </span>
            ))}
          </span>
        ) : null}
        <span className="sp" />
        {!log ? (
          <button className={`pp-tg${adding ? ' on' : ''}`} onClick={() => setAdding(!adding)} title="Open an incident">
            <Icon name="Plus" size={11} /> Incident
          </button>
        ) : null}
      </div>
      {adding && !log ? <NewIncident p={p} done={() => setAdding(false)} /> : null}
      <div className="pi-rows">
        {log ? (
          closed.length ? closed.map((i) => <Closed key={i.id} i={i} />) : <div className="pp-empty">Nothing closed yet. A closed incident lands here with its cause and fix.</div>
        ) : live.length ? (
          live.map((i) => <Incident key={i.id} p={p} i={i} open={open === i.id} toggle={() => setOpen(open === i.id ? null : i.id)} />)
        ) : (
          <div className="pp-empty">No open incidents. The sessions open one per outage (project_item), or you can, above.</div>
        )}
      </div>
    </div>
  );
}

function NewIncident({ p, done }: { p: Project; done: () => void }) {
  const sessions = useBrain((s) => s.sessions);
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState<ItemSeverity>('medium');
  const [owner, setOwner] = useState('');
  const [err, setErr] = useState('');
  const go = async () => {
    if (!title.trim()) return;
    const r = await itemOp(p.id, 'open', { kind: 'incident', title: title.trim(), severity, ...(owner ? { owner } : {}) });
    if (r.ok) done();
    else setErr(r.error ?? "Couldn't open it.");
  };
  return (
    <div className="pi-new">
      <input autoFocus value={title} placeholder="What and where: a site, a station, a service…" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} />
      <div className="row">
        <SevPick v={severity} set={setSeverity} />
        <select value={owner} onChange={(e) => setOwner(e.target.value)} title="Who owns it">
          <option value="">Nobody yet</option>
          {p.sessions
            .filter((sid) => sessions[sid])
            .map((sid) => (
              <option key={sid} value={sid}>
                {sessionName(sessions[sid])}
              </option>
            ))}
        </select>
        <span className="sp" />
        <button className="pp-btn go" disabled={!title.trim()} onClick={() => void go()}>
          Open
        </button>
      </div>
      {err ? <div className="pi-err">{err}</div> : null}
    </div>
  );
}

const SevPick = ({ v, set }: { v: ItemSeverity; set: (s: ItemSeverity) => void }) => (
  <span className="pp-seg pi-sev">
    {SEVERITIES.map((s) => (
      <button key={s} className={v === s ? 'on' : ''} style={{ ['--kc' as any]: SEV_COLOR[s] }} onClick={() => set(s)}>
        {s}
      </button>
    ))}
  </span>
);

function Incident({ p, i, open, toggle }: { p: Project; i: ProjectItem; open: boolean; toggle: () => void }) {
  const who = useWho();
  const sessions = useBrain((s) => s.sessions);
  const [next, setNext] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [closing, setClosing] = useState<{ cause: string; fix: string } | null>(null);
  const [err, setErr] = useState('');
  const sev = i.severity ?? 'medium';
  const o = who(i.owner);
  const quiet = i.state !== 'waiting' && Date.now() - i.updatedAt > QUIET;
  const last = i.notes.at(-1);
  const act = async (op: Parameters<typeof itemOp>[1], f: Record<string, unknown>) => {
    const r = await itemOp(p.id, op, { item: i.id, ...f });
    setErr(r.ok ? '' : (r.error ?? 'Not done.'));
    return r.ok;
  };
  const others = (p.items ?? []).filter((x) => x.kind === 'incident' && x.id !== i.id && itemOpen(x));
  return (
    <div className={`pi-row${open ? ' open' : ''}${quiet ? ' quiet' : ''}`} style={{ ['--kc' as any]: SEV_COLOR[sev] }}>
      <button className="pi-main" onClick={toggle} title={open ? 'Fold it' : 'Its details and what you can do'}>
        <span className="pp-kind">{sev === 'critical' ? 'crit' : sev === 'medium' ? 'med' : sev}</span>
        <b className="t">{i.title}</b>
        <span className={`st ${i.state}`}>{i.state}</span>
        <span className="who">
          <span className="dot" style={{ ['--sc' as any]: o.color }} />
          {i.owner ? o.name : <em>unowned</em>}
        </span>
        <span className="age" title={`Opened ${new Date(i.openedAt).toLocaleString()}; last changed ${new Date(i.updatedAt).toLocaleString()}`}>
          {quiet ? `quiet ${ago(i.updatedAt)}` : ago(i.openedAt)}
        </span>
        {i.next ? (
          <span className="next">
            <Icon name="ArrowRight" size={10} /> {i.next}
          </span>
        ) : null}
        {last && !open ? (
          <span className="note">
            {who(last.by).name}: {last.text}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="pi-more">
          <div className="row">
            <span className="lab">Owner</span>
            <select value={i.owner ?? ''} onChange={(e) => void act('change', { owner: e.target.value })}>
              <option value="">Nobody</option>
              {p.sessions
                .filter((sid) => sessions[sid])
                .map((sid) => (
                  <option key={sid} value={sid}>
                    {sessionName(sessions[sid])}
                  </option>
                ))}
            </select>
            <span className="lab">State</span>
            <span className="pp-seg">
              {(['open', 'working', 'waiting'] as const).map((s) => (
                <button key={s} className={i.state === s ? 'on' : ''} onClick={() => void act('change', { state: s })}>
                  {s}
                </button>
              ))}
            </span>
          </div>
          <div className="row">
            <span className="lab">Severity</span>
            <SevPick v={sev} set={(s) => void act('change', { severity: s })} />
            {i.link ? (
              <a className="pi-link" href={i.link} target="_blank" rel="noreferrer">
                <Icon name="ExternalLink" size={11} /> {i.link.replace(/^https?:\/\//, '').slice(0, 40)}
              </a>
            ) : null}
          </div>
          <input className="pi-in" value={next ?? i.next ?? ''} placeholder="The next step…" onChange={(e) => setNext(e.target.value)} onBlur={() => (next != null && next !== (i.next ?? '') ? void act('change', { next }) : null, setNext(null))} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          {i.notes.length ? (
            <div className="pi-notes">
              {i.notes.slice(-6).map((n, k) => (
                <div key={k}>
                  <b style={{ color: who(n.by).color }}>{who(n.by).name}</b> <time>{ago(n.at)}</time> {n.text}
                </div>
              ))}
            </div>
          ) : null}
          <input className="pi-in" value={note} placeholder="Add a note (its owner is told)…" onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && void act('annotate', { text: note.trim() }).then((ok) => ok && setNote(''))} />
          {closing ? (
            <div className="pi-close">
              <input autoFocus className="pi-in" value={closing.cause} placeholder="Cause…" onChange={(e) => setClosing({ ...closing, cause: e.target.value })} />
              <input className="pi-in" value={closing.fix} placeholder="Fix…" onChange={(e) => setClosing({ ...closing, fix: e.target.value })} />
              <div className="row">
                <span className="sp" />
                <button className="pp-btn" onClick={() => setClosing(null)}>
                  Not yet
                </button>
                <button className="pp-btn go" disabled={!closing.cause.trim() || !closing.fix.trim()} onClick={() => void act('close', { cause: closing.cause.trim(), fix: closing.fix.trim() })}>
                  Close it
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              {others.length ? (
                <select value="" onChange={(e) => e.target.value && void act('merge', { into: e.target.value })} title="It's the same outage as another: its notes go there">
                  <option value="">Merge into…</option>
                  {others.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title.slice(0, 60)}
                    </option>
                  ))}
                </select>
              ) : null}
              <span className="sp" />
              <button className="pp-btn" onClick={() => setClosing({ cause: '', fix: '' })}>
                Close…
              </button>
            </div>
          )}
          {err ? <div className="pi-err">{err}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function Closed({ i }: { i: ProjectItem }) {
  const who = useWho();
  const merged = !!i.mergedInto;
  return (
    <div className="pi-row done" style={{ ['--kc' as any]: SEV_COLOR[i.severity ?? 'medium'] }}>
      <div className="pi-main">
        <span className="pp-kind">{merged ? 'dup' : 'done'}</span>
        <b className="t">{i.title}</b>
        <span className="who">
          <span className="dot" style={{ ['--sc' as any]: who(i.owner).color }} />
          {i.owner ? who(i.owner).name : <em>unowned</em>}
        </span>
        <span className="age">{i.closedAt ? ago(i.closedAt) : ''}</span>
        {merged ? (
          <span className="next">merged into another incident</span>
        ) : (
          <span className="next">
            <b>Cause</b> {i.cause || '—'} · <b>Fix</b> {i.fix || '—'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Known issues: proposed ones for you to approve (they join every member's card), the approved ones with their rule, retired ones folded away. */
export function KnownPanel({ sessionId }: Props) {
  const p = useProject(projectOfBoard(sessionId));
  const who = useWho();
  const [retired, setRetired] = useState(false);
  const [title, setTitle] = useState('');
  const [rule, setRule] = useState('');
  const [err, setErr] = useState('');
  if (!p) return null;
  const known = (p.items ?? []).filter((i) => i.kind === 'known');
  const proposed = known.filter((i) => i.state === 'proposed');
  const approved = known.filter((i) => i.state === 'approved');
  const gone = known.filter((i) => i.state === 'retired');
  const set = async (i: ProjectItem, state: string) => {
    const r = await itemOp(p.id, 'change', { item: i.id, state });
    setErr(r.ok ? '' : (r.error ?? 'Not done.'));
  };
  const add = async () => {
    if (!title.trim()) return;
    const r = await itemOp(p.id, 'open', { kind: 'known', title: title.trim(), ...(rule.trim() ? { rule: rule.trim() } : {}) });
    if (r.ok) (setTitle(''), setRule(''), setErr(''));
    else setErr(r.error ?? 'Not added.');
  };
  const row = (i: ProjectItem) => (
    <div key={i.id} className={`pk-row ${i.state}`}>
      <div className="t">
        <b>{i.title}</b>
        {i.rule ? (
          <span className="rule">
            <Icon name="CornerDownRight" size={10} /> {i.rule}
          </span>
        ) : null}
        {i.body ? <span className="body">{i.body}</span> : null}
        <em>
          {i.state === 'proposed' ? 'proposed by' : 'from'} {who(i.openedBy).name} · {ago(i.openedAt)}
        </em>
      </div>
      <div className="acts">
        {i.state === 'proposed' ? (
          <>
            <button className="pp-btn go" onClick={() => void set(i, 'approved')} title="It joins every member's project card">
              Approve
            </button>
            <button className="pp-btn" onClick={() => void set(i, 'retired')} title="Not a known issue">
              Reject
            </button>
          </>
        ) : i.state === 'approved' ? (
          <button className="pp-btn" onClick={() => void set(i, 'retired')} title="It's fixed, or no longer applies: it leaves the cards">
            Retire
          </button>
        ) : (
          <button className="pp-btn" onClick={() => void set(i, 'approved')}>
            Bring back
          </button>
        )}
      </div>
    </div>
  );
  return (
    <div className="pk">
      <div className="pk-rows">
        {proposed.length ? <div className="pk-lab">Proposed · for you to approve</div> : null}
        {proposed.map(row)}
        {approved.length ? <div className="pk-lab">On every card</div> : null}
        {approved.map(row)}
        {!proposed.length && !approved.length ? <div className="pp-empty">No known issues. A session proposes one when it finds something that keeps coming back (a flapping check, a site that's always down at night); you approve it.</div> : null}
        {gone.length ? (
          <button className="pk-lab more" onClick={() => setRetired(!retired)}>
            <Icon name={retired ? 'ChevronDown' : 'ChevronRight'} size={10} /> Retired ({gone.length})
          </button>
        ) : null}
        {retired ? gone.map(row) : null}
      </div>
      <div className="pk-add">
        <input value={title} placeholder="A known issue…" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        <input value={rule} placeholder="Its rule (what to do about it)…" onChange={(e) => setRule(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} />
        {err ? <div className="pi-err">{err}</div> : null}
      </div>
    </div>
  );
}

