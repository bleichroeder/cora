import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { MSG_KINDS, RISKY_MODES, SEAT_PERMISSION_MODES, dispatchText, endpointName, endpointOptions, endpointsOf, groupById, memberName, routeName, seatById, seatsOf, type Endpoint, type Escalation, type Group, type Route, type Seat, type Team, type TeamLayout, type Watch } from '@cora/shared';
import { toggleIn, toggleKind, type Sel } from './draftOps';
import type { SeatState } from './Canvas';

export type InspectorProps = {
  team: Team;
  /** the team as applied (ids that have been applied stay) */
  base?: Team;
  sel: Sel;
  look: TeamLayout;
  projectName: string;
  version: number;
  stateOf(id: string): SeatState;
  /** bumped when a seat is added: its name field takes focus */
  focusName: number;
  onEdit(path: string, value: unknown): void;
  onTeam(t: Team): void;
  onRename(name: string): void;
  onDelete(): void;
  onGroupThem(): void;
};

const MODELS: Array<[string, string]> = [['', 'default'], ['opus', 'opus'], ['sonnet', 'sonnet'], ['haiku', 'haiku']];
const EFFORTS: Array<[string, string]> = [['', 'default'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'xhigh'], ['max', 'max']];
const WHENS: Array<Escalation['when']> = ['unclaimed', 'critical', 'stale', 'blocked'];
const THEN: Array<Escalation['then'][number]> = ['reoffer', 'nudge-owner', 'tell-lead', 'tell-user', 'dm-user'];
const THEN_LABEL: Record<Escalation['then'][number], string> = { reoffer: 'reoffer', 'nudge-owner': 'nudge owner', 'tell-lead': 'tell lead', 'tell-user': 'tell you', 'dm-user': 'DM you' };
const MODE_LINE: Record<string, string> = {
  default: 'Starts in yours (the mode your sessions start in).',
  acceptEdits: '⚠ Edits files without asking.',
  auto: '⚠ Claude Code decides when to ask.',
  dontAsk: '⚠ Never asks: anything not allowed is refused, the rest goes ahead.',
  plan: 'Reads and plans; changes nothing.',
  manual: 'Asks before every action.',
  bypassPermissions: '⚠ Skips every permission prompt.',
};
const WAKE_LINE: Record<Route['wake'], string> = { auto: 'An idle member is woken on its own.', ask: 'An idle member is woken only with your OK (a card in Needs you).', never: 'An idle member reads it at its next prompt.' };
const TOOL_NAMES = ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit', 'TodoWrite', 'mcp__cora__project_post', 'mcp__cora__project_read', 'mcp__cora__project_item', 'mcp__cora__project_claim', 'mcp__cora__project_annotate', 'mcp__cora__project_close'];
const RULES = ['Read(//logs/**)', 'Bash(curl:*)', 'Bash(git push:*)', 'Bash(rm:*)', 'Edit(**)', 'WebFetch'];
const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
const sc = (c: string): CSSProperties => ({ ['--sc' as string]: c }) as CSSProperties;
/** This PC's folders under a path (the server's listing, as the New session picker uses; state/ws.ts isn't imported here: it brings the whole app). */
const fetchDirs = async (path: string): Promise<{ path: string; parent: string | null; dirs: string[]; error?: string }> => {
  try {
    const r = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
    return (await r.json()) as { path: string; parent: string | null; dirs: string[]; error?: string };
  } catch (e) {
    return { path, parent: null, dirs: [], error: (e as Error).message };
  }
};
const joinPath = (dir: string, name: string) => `${dir}${/[\\/]$/.test(dir) ? '' : dir.includes('\\') ? '\\' : '/'}${name}`;

const F = ({ label, hint, warn, children }: { label?: string; hint?: ReactNode; warn?: boolean; children: ReactNode }) => (
  <div className="f">
    {label ? <label className="fl">{label}</label> : null}
    {children}
    {hint !== undefined ? <div className={`fh${warn ? ' warn' : ''}`}>{hint}</div> : null}
  </div>
);
const Lab = ({ children, n }: { children: ReactNode; n?: number }) => (
  <div className="lab">
    {children}
    {n !== undefined ? <b>{n}</b> : null}
  </div>
);
const Head = ({ tile, title, sub }: { tile: ReactNode; title: string; sub: string }) => (
  <div className="ih">
    {tile}
    <div className="t">
      <b>{title}</b>
      <span>{sub}</span>
    </div>
  </div>
);
function Txt({ value, onChange, mono, ph, w }: { value: string; onChange(v: string): void; mono?: boolean; ph?: string; w?: number }) {
  return <input className={`in${mono ? ' mono' : ''}`} value={value} placeholder={ph} spellCheck={false} style={w ? { width: w, flex: 'none' } : undefined} onChange={(e) => onChange(e.target.value)} />;
}
/** A number typed as text: partial input ("0.", "2.50", empty) stays as typed; the number is committed whenever it parses. */
function Num({ value, onCommit, ph, w }: { value?: number; onCommit(v: number | undefined): void; ph?: string; w?: number }) {
  const [text, setText] = useState(value != null ? String(value) : '');
  const sent = useRef(value);
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value != null ? String(value) : '');
    }
  }, [value]);
  return (
    <Txt
      mono
      value={text}
      ph={ph}
      w={w}
      onChange={(v) => {
        setText(v);
        const n = v.trim() === '' ? undefined : num(v);
        if (v.trim() !== '' && n === undefined) return;
        sent.current = n;
        onCommit(n);
      }}
    />
  );
}
/** Each seat's and group's own form token (the id follows the name until applied, so the id can't key its form). */
export type FormTokens = { team: Team; sel: Sel; tokens: Record<string, string> };
/**
 * The tokens after a change: each seat and group keeps its own while others come, go or move, and the selected one keeps
 * its own when it's renamed (its old id gone and its new one new, in the same change); a new seat or group gets a fresh one.
 */
export function formTokens(prev: FormTokens | null, team: Team, sel: Sel, fresh: () => string): FormTokens {
  const keys = [...team.seats.map((x) => `seat:${x.id}`), ...team.groups.map((x) => `group:${x.id}`)];
  const ps = prev?.sel;
  const k = sel?.kind;
  let renamed: { from: string; to: string } | null = null;
  if (prev && ps && sel && (k === 'seat' || k === 'group') && ps.kind === k && ps.ids.length === 1 && sel.ids.length === 1 && ps.ids[0] !== sel.ids[0]) {
    const from = `${k}:${ps.ids[0]}`;
    const to = `${k}:${sel.ids[0]}`;
    if (prev.tokens[from] && !prev.tokens[to] && !keys.includes(from)) renamed = { from, to };
  }
  const tokens: Record<string, string> = {};
  for (const key of keys) tokens[key] = (renamed?.to === key ? prev!.tokens[renamed.from] : prev?.tokens[key]) ?? fresh();
  return { team, sel, tokens };
}
/** The key the selected seat's or group's form keeps: its token. */
export const formKey = (f: FormTokens, sel: Sel): string => {
  const id = sel?.ids[0] ?? '';
  return sel?.kind === 'seat' || sel?.kind === 'group' ? `${sel.kind}-${f.tokens[`${sel.kind}:${id}`] ?? id}` : `${sel?.kind ?? 'team'}-${id}`;
};
const Area = ({ value, rows, ph, onChange }: { value: string; rows: number; ph?: string; onChange(v: string): void }) => <textarea className="in" rows={rows} value={value} placeholder={ph} onChange={(e) => onChange(e.target.value)} />;
const Pick = ({ value, options, onChange }: { value: string; options: Array<[string, string]>; onChange(v: string): void }) => (
  <select className="in" value={value} onChange={(e) => onChange(e.target.value)}>
    {options.map(([v, l]) => (
      <option key={v} value={v}>
        {l}
      </option>
    ))}
  </select>
);
/** A list as chips: × removes one; type and Enter (or pick) adds; Backspace in the empty box takes the last. */
function Chips({ values, onChange, list, ph, ui, names, options }: { values: string[]; onChange(v: string[]): void; list?: string; ph?: string; ui?: boolean; names?: (v: string) => string; options?: Array<[string, string]> }) {
  const [draft, setDraft] = useState('');
  const add = (v: string) => {
    const x = v.trim();
    if (x && !values.includes(x)) onChange([...values, x]);
    setDraft('');
  };
  return (
    <div className="chips">
      {values.map((c, i) => (
        <span key={c} className={`chip${ui ? ' ui' : ''}`}>
          {names ? names(c) : c}
          <button className="x" title="Remove" onClick={() => onChange(values.filter((_, j) => j !== i))}>
            ×
          </button>
        </span>
      ))}
      {options ? (
        <select className="add" value="" onChange={(e) => add(e.target.value)}>
          <option value="">+ add</option>
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="add"
          list={list}
          value={draft}
          placeholder={ph ?? '+ add'}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.preventDefault(), add(draft));
            if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
          }}
          onBlur={() => draft && add(draft)}
        />
      )}
    </div>
  );
}
const Toggles = ({ opts, on, onToggle, ui }: { opts: Array<[string, string]>; on(v: string): boolean; onToggle(v: string): void; ui?: boolean }) => (
  <div className="tg-row">
    {opts.map(([v, l]) => (
      <button key={v} className={`tchip${ui ? ' ui' : ''}${on(v) ? ' on' : ''}`} onClick={() => onToggle(v)}>
        {l}
      </button>
    ))}
  </div>
);
const Seg = ({ value, opts, onSet }: { value: string; opts: Array<[string, string]>; onSet(v: string): void }) => (
  <div className="seg wide">
    {opts.map(([v, l]) => (
      <button key={v} className={v === value ? 'on' : ''} onClick={() => onSet(v)}>
        {l}
      </button>
    ))}
  </div>
);
const Stepper = ({ value, min, onSet }: { value: number; min: number; onSet(v: number): void }) => (
  <div className="step">
    <button disabled={value <= min} onClick={() => onSet(Math.max(min, value - 1))}>
      −
    </button>
    <b>{value}</b>
    <button onClick={() => onSet(value + 1)}>+</button>
  </div>
);
const IconGroup = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.3}>
    <rect x={1.5} y={2.5} width={11} height={9} rx={2.5} strokeDasharray="2 1.6" />
    <circle cx={5} cy={7} r={1.3} />
    <circle cx={9} cy={7} r={1.3} />
  </svg>
);
const IconRoute = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 10c3 0 4-6 8-6" />
    <path d="M8.5 2.5 10.5 4 9 6" />
  </svg>
);
const IconTeam = () => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.3}>
    <circle cx={3.5} cy={4} r={1.6} />
    <circle cx={3.5} cy={10} r={1.6} />
    <circle cx={10.5} cy={7} r={1.6} />
    <path d="M5 4.6 9 6.4M5 9.4 9 7.6" />
  </svg>
);

/** A folder: typed, or picked by walking this PC's folders. */
function FolderField({ value, onChange }: { value: string; onChange(v: string): void }) {
  const [list, setList] = useState<{ path: string; parent: string | null; dirs: string[] } | null>(null);
  const browse = async (path: string) => {
    const r = await fetchDirs(path);
    setList(r.error ? null : r);
  };
  return (
    <>
      <div className="frow">
        <Txt mono value={value} ph="C:\path\to\folder" onChange={onChange} />
        <button className="btn sm" onClick={() => (list ? setList(null) : void browse(value))}>
          Browse…
        </button>
      </div>
      {list ? (
        <div className="dirs">
          <button onClick={() => (onChange(list.path), setList(null))}>Use {list.path}</button>
          {list.parent ? <button onClick={() => void browse(list.parent!)}>..</button> : null}
          {list.dirs.map((d) => (
            <button key={d} onClick={() => void browse(joinPath(list.path, d))}>
              {d}
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

/**
 * A seat's standing email watches (Cora sets them when it starts). Slack isn't offered until Cora can keep one: a Slack
 * watch a seat has already (Cora's JSON, an older team) is shown as it is, and said not to be set.
 */
function Watches({ s, onEdit }: { s: Seat; onEdit(path: string, v: unknown): void }) {
  const ws = s.startup.watches ?? [];
  const set = (next: Watch[]) => onEdit('startup.watches', next.length ? next : undefined);
  const at = (i: number, f: (w: Watch) => Watch) => set(ws.map((w, j) => (j === i ? f(w) : w)));
  return (
    <div className="f">
      <label className="fl">Watches</label>
      {ws.map((w, i) =>
        w.kind === 'slack' ? (
          <div key={i} className="watch">
            <div className="frow">
              <span className="wro">
                Slack {w.channel}: {w.about || 'no description'}
              </span>
              <button className="btn sm ghost" title="Remove watch" onClick={() => set(ws.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
            <div className="fh">Slack watches aren't supported yet: Cora doesn't set this one.</div>
          </div>
        ) : (
          <div key={i} className="watch">
            <div className="frow">
              <span className="unit">Email from</span>
              <Txt mono value={w.from} ph="an address" onChange={(v) => at(i, (x) => (x.kind === 'gmail' ? { ...x, from: v } : x))} />
              <button className="btn sm ghost" title="Remove watch" onClick={() => set(ws.filter((_, j) => j !== i))}>
                ×
              </button>
            </div>
            <div className="frow">
              <Txt value={w.about} ph="what it waits for" onChange={(v) => at(i, (x) => ({ ...x, about: v }))} />
            </div>
            <Area value={w.then} rows={2} ph="what to do when it comes" onChange={(v) => at(i, (x) => ({ ...x, then: v }))} />
          </div>
        ),
      )}
      <button className="btn sm" onClick={() => set([...ws, { kind: 'gmail', from: '', about: '', then: '' }])}>
        + Watch
      </button>
      <div className="fh">Cora sets these when the seat starts.</div>
    </div>
  );
}

const countLine = (s: Seat): ReactNode =>
  s.count.min > s.count.max ? <span style={{ color: 'var(--need)' }}>The minimum is above the maximum.</span> : s.count.max > 1 ? `A pool: ${s.count.min} to ${s.count.max} sessions. It grows when its group has work and nobody free.` : s.count.min === 0 ? 'Starts when work arrives.' : 'One session, always up.';
const idHint = (id: string, applied: boolean): ReactNode =>
  applied ? (
    <>
      Its id stays <code>{id}</code> (it has been applied).
    </>
  ) : (
    <>
      Its id follows the name until it's applied: <code>{id}</code>.
    </>
  );

function SeatForm({ s, p, handled }: { s: Seat; p: InspectorProps; handled: { current: number } }) {
  const a = s.agent;
  const risky = !!a.permissionMode && RISKY_MODES.has(a.permissionMode);
  const applied = !!p.base && !!seatById(p.base, s.id);
  const stWords = { work: 'working', idle: 'idle', down: 'stood down', none: 'not started yet' }[p.stateOf(s.id)];
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (p.focusName !== handled.current) {
      handled.current = p.focusName;
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [p.focusName, handled]);
  return (
    <>
      <Head tile={<span className="htile" style={sc(p.look.color?.[s.id] ?? '#94a3b8')}>{(s.name || '?').trim()[0]?.toUpperCase() || '?'}</span>} title={s.name || 'Unnamed seat'} sub={`seat · ${s.id} · ${stWords}`} />
      <div className="isc">
        <Lab>Role</Lab>
        <F label="Name" hint={idHint(s.id, applied)}>
          <input ref={nameRef} className="in" value={s.name} placeholder="Triage, Monitor…" spellCheck={false} onChange={(e) => p.onRename(e.target.value)} />
        </F>
        <F label="Instructions">
          <Area value={s.instructions} rows={7} ph="The role, in plain words" onChange={(v) => p.onEdit('instructions', v)} />
        </F>
        <Lab>Agent</Lab>
        <div className="row2">
          <F label="Model">
            <Pick value={a.model ?? ''} options={MODELS} onChange={(v) => p.onEdit('agent.model', v)} />
          </F>
          <F label="Effort">
            <Pick value={a.effort ?? ''} options={EFFORTS} onChange={(v) => p.onEdit('agent.effort', v)} />
          </F>
        </div>
        <F label="Tools" hint={a.tools?.length ? "Its team messaging (SendMessage and the project tools) is kept, unless May not use takes it away." : 'Empty: every tool.'}>
          <Chips values={a.tools ?? []} list="tb-tools" onChange={(v) => p.onEdit('agent.tools', v)} />
        </F>
        <F label="May not use">
          <Chips values={a.disallowedTools ?? []} list="tb-tools" onChange={(v) => p.onEdit('agent.disallowedTools', v)} />
        </F>
        <F label="Permission mode" hint={MODE_LINE[a.permissionMode ?? 'default']} warn={risky}>
          <Pick value={a.permissionMode ?? 'default'} options={SEAT_PERMISSION_MODES.map((m): [string, string] => [m, m])} onChange={(v) => p.onEdit('agent.permissionMode', v === 'default' ? '' : v)} />
        </F>
        <div className="f">
          <label className="fl">Permissions</label>
          {(['allow', 'ask', 'deny'] as const).map((k) => (
            <div key={k} className="perm">
              <span className="pk">{cap(k)}</span>
              <Chips values={a.permissions?.[k] ?? []} list="tb-rules" ph="+ rule" onChange={(v) => p.onEdit(`agent.permissions.${k}`, v)} />
            </div>
          ))}
          <div className="fh">Claude Code's own rules. An ask lands as a card in Needs you.</div>
        </div>
        <F label="Skills">
          <Chips values={s.skills} list="tb-skills" onChange={(v) => p.onEdit('skills', v)} />
        </F>
        <Lab>Where</Lab>
        <F label="Folder">
          <FolderField value={s.folder.path} onChange={(v) => p.onEdit('folder.path', v)} />
          <button className="swr" onClick={() => p.onEdit('folder.worktree', s.folder.worktree ? undefined : true)}>
            <span className="t">
              A fresh worktree<small>Each session works in its own worktree of the folder</small>
            </span>
            <i className={`tg${s.folder.worktree ? ' on' : ''}`} />
          </button>
        </F>
        <Lab>Size</Lab>
        <div className="row2">
          <F label="Min">
            <Stepper value={s.count.min} min={0} onSet={(v) => p.onEdit('count.min', v)} />
          </F>
          <F label="Max">
            <Stepper value={s.count.max} min={1} onSet={(v) => p.onEdit('count.max', v)} />
          </F>
        </div>
        <div className="fh" style={{ margin: '-4px 0 12px' }}>
          {countLine(s)}
        </div>
        <F label="Idle close" hint={s.count.max > s.count.min ? 'Members above the minimum, idle this long, are closed.' : 'Only for a pool: nothing above the minimum to close.'}>
          <div className="frow">
            <Num value={s.idleCloseMin || undefined} ph="never" w={80} onCommit={(v) => p.onEdit('idleCloseMin', v || undefined)} />
            <span className="unit">min</span>
          </div>
        </F>
        <Lab>Startup</Lab>
        <F label="First prompt">
          <Area value={s.startup.prompt ?? ''} rows={3} ph="What it does first" onChange={(v) => p.onEdit('startup.prompt', v)} />
        </F>
        <F label="Monitor">
          <Txt mono value={s.startup.monitor ?? ''} ph="a command whose output it watches" onChange={(v) => p.onEdit('startup.monitor', v)} />
        </F>
        <Watches s={s} onEdit={p.onEdit} />
        <Lab>Limits</Lab>
        <div className="row2">
          <F label="Turns an hour">
            <Num value={s.limits?.turnsPerHour} ph="no limit" onCommit={(v) => p.onEdit('limits.turnsPerHour', v)} />
          </F>
          <F label="Cost a day ($)">
            <Num value={s.limits?.costPerDay} ph="no limit" onCommit={(v) => p.onEdit('limits.costPerDay', v)} />
          </F>
        </div>
        <F label="Quiet hours" hint="Its messages wait in quiet hours, and you're told.">
          <div className="frow">
            <Txt mono value={s.limits?.quiet?.from ?? ''} ph="22:00" onChange={(v) => p.onEdit('limits.quiet.from', v)} />
            <span className="unit">to</span>
            <Txt mono value={s.limits?.quiet?.to ?? ''} ph="07:00" onChange={(v) => p.onEdit('limits.quiet.to', v)} />
          </div>
        </F>
        <button className="btn bad wide" onClick={p.onDelete}>
          Delete seat
        </button>
      </div>
    </>
  );
}

function GroupForm({ g, p }: { g: Group; p: InspectorProps }) {
  const t = p.team;
  const label = g.split ? t.labels.find((l) => l.id === g.split!.label) : undefined;
  const inside = endpointsOf(t, `group:${g.id}`);
  const memberOpts: Array<[string, string]> = [...t.seats.map((s): [string, string] => [s.id, s.name]), ...t.groups.filter((x) => x.id !== g.id && !inside.includes(`group:${x.id}`)).map((x): [string, string] => [x.id, `${x.name} (group)`])].filter(([v]) => !g.members.includes(v));
  const mOpts: Array<[string, string]> = [['', '—'], ...g.members.map((m): [string, string] => [m, memberName(t, m)])];
  const splitVals = label && g.split ? [...new Set([...label.values, ...Object.keys(g.split.to)])] : [];
  const seats: Array<[string, string]> = seatsOf(t, g.id).map((id) => [id, seatById(t, id)?.name ?? id]);
  return (
    <>
      <Head tile={<span className="htile" style={sc('var(--ink3)')}><IconGroup /></span>} title={g.name || 'Unnamed group'} sub={`group · ${g.id} · ${dispatchText(g)}`} />
      <div className="isc">
        <Lab>Group</Lab>
        <F label="Name" hint={idHint(g.id, !!p.base && !!groupById(p.base, g.id))}>
          <input className="in" value={g.name} placeholder="Analysts…" spellCheck={false} onChange={(e) => p.onRename(e.target.value)} />
        </F>
        <F label="Members" hint="Seats and groups; groups nest. Or drag a seat into its region.">
          <Chips ui values={g.members} names={(m) => memberName(t, m)} options={memberOpts} onChange={(v) => p.onEdit('members', v)} />
        </F>
        <F label="Dispatch" hint={g.dispatch === 'claim' ? 'An incident is offered to its free members; the first to claim it owns it.' : 'The sender names the member.'}>
          <Seg value={g.dispatch} opts={[['claim', 'Claim'], ['direct', 'Direct']]} onSet={(v) => p.onEdit('dispatch', v)} />
        </F>
        <Lab>Split by label</Lab>
        <F>
          <Pick value={g.split?.label ?? ''} options={[['', 'No split'], ...t.labels.map((l): [string, string] => [l.id, `${l.id} (${l.name})`])]} onChange={(v) => p.onEdit('split.label', v)} />
        </F>
        {label && g.split ? (
          <>
            {splitVals.map((v) => (
              <div key={v} className="split-row">
                <span className={`v${label.values.includes(v) ? '' : ' bad'}`} title={v}>
                  {v}
                </span>
                <span className="arr">→</span>
                <Pick value={g.split!.to[v] ?? ''} options={mOpts} onChange={(m) => p.onEdit(`split.to.${v}`, m || undefined)} />
              </div>
            ))}
            <div className="split-row">
              <span className="v" style={{ color: 'var(--ink3)' }}>
                else
              </span>
              <span className="arr">→</span>
              <Pick value={g.split.else ?? ''} options={[['', 'nowhere (it goes to everyone in the group)'], ...mOpts.slice(1)]} onChange={(m) => p.onEdit('split.else', m || undefined)} />
            </div>
            <div className="fh" style={{ marginBottom: 12 }}>
              A message carrying that value goes to that member, down the nesting.
            </div>
          </>
        ) : null}
        <Lab>Grow</Lab>
        <div className="row2">
          <F label="Start another">
            <Pick value={g.grow?.seat ?? ''} options={[['', 'Never'], ...seats]} onChange={(v) => p.onEdit('grow.seat', v)} />
          </F>
          {g.grow ? (
            <F label="Up to">
              <Stepper value={g.grow.max} min={1} onSet={(v) => p.onEdit('grow.max', v)} />
            </F>
          ) : null}
        </div>
        <div className="fh">{g.grow ? `When nobody is free, Cora starts another ${seatById(t, g.grow.seat)?.name ?? ''}, up to ${g.grow.max}.` : 'When nobody is free, the work waits for one.'}</div>
        <button className="btn bad wide" onClick={p.onDelete}>
          Delete group (its members stay)
        </button>
      </div>
    </>
  );
}

function RouteForm({ r, p }: { r: Route; p: InspectorProps }) {
  const t = p.team;
  const fromOpts = endpointOptions(t).filter(([v]) => v !== 'user' && v !== 'cora' && !r.from.includes(v));
  return (
    <>
      <Head tile={<span className="htile" style={sc('var(--ink3)')}><IconRoute /></span>} title={routeName(t, r)} sub={`route · ${r.id}`} />
      <div className="isc">
        <Lab>Who to whom</Lab>
        <F label="From" hint="Several senders merge into one arrow.">
          <Chips ui values={r.from} names={(e) => endpointName(t, e as Endpoint)} options={fromOpts} onChange={(v) => p.onEdit('from', v)} />
        </F>
        <F label="To">
          <Pick value={r.to} options={endpointOptions(t).filter(([v]) => v !== 'cora')} onChange={(v) => p.onEdit('to', v)} />
        </F>
        <Lab>What</Lab>
        <F label="Kinds">
          <Toggles opts={[['any', 'any'], ...MSG_KINDS.map((k): [string, string] => [k, k])]} on={(v) => (r.kinds === 'any' ? v === 'any' : (r.kinds as string[]).includes(v))} onToggle={(v) => p.onEdit('kinds', toggleKind(r.kinds, v as never))} />
        </F>
        {t.labels.map((L) => (
          <F key={L.id} label={`Labels · ${L.id}`}>
            <Toggles opts={L.values.map((v): [string, string] => [v, v])} on={(v) => (r.labels?.[L.id] ?? []).includes(v)} onToggle={(v) => p.onEdit(`labels.${L.id}`, toggleIn(r.labels?.[L.id], v))} />
          </F>
        ))}
        {t.labels.length ? (
          <div className="fh" style={{ margin: '-6px 0 12px' }}>
            None picked: any value, or none.
          </div>
        ) : null}
        <Lab>Wake</Lab>
        <F hint={WAKE_LINE[r.wake]}>
          <Seg value={r.wake} opts={[['auto', 'Auto'], ['ask', 'Ask'], ['never', 'Never']]} onSet={(v) => p.onEdit('wake', v)} />
        </F>
        <Lab>Template</Lab>
        <F label="Must include" hint="A message on it missing one of these bounces, naming it.">
          <Chips values={r.template?.fields ?? []} ph="+ field" onChange={(v) => p.onEdit('template.fields', v)} />
        </F>
        <button className="btn bad wide" onClick={p.onDelete}>
          Delete route
        </button>
      </div>
    </>
  );
}

function TeamForm({ p }: { p: InspectorProps }) {
  const t = p.team;
  const addLabel = () => {
    let id = 'label';
    for (let n = 1; t.labels.some((l) => l.id === id); n++) id = `label-${String.fromCharCode(97 + n)}`;
    p.onTeam({ ...t, labels: [...t.labels, { id, name: 'New label', values: [] }] });
  };
  return (
    <>
      <Head tile={<span className="htile" style={sc('var(--pc)')}><IconTeam /></span>} title={p.projectName} sub={`team · v${p.version} · ${t.seats.length} seats · ${t.groups.length} groups · ${t.routes.length} routes`} />
      <div className="isc">
        <Lab n={t.labels.length}>Labels</Lab>
        {t.labels.map((L, i) => (
          <div key={L.id} className="lset">
            <div className="frow" style={{ marginBottom: 6 }}>
              <Txt value={L.name} ph="Issue type" onChange={(v) => p.onEdit(`labels.${i}.name`, v)} />
              <code className="m" style={{ flex: 'none' }}>
                {L.id}
              </code>
              <button className="btn sm ghost" title="Remove label" onClick={() => p.onTeam({ ...t, labels: t.labels.filter((_, j) => j !== i) })}>
                ×
              </button>
            </div>
            <Chips values={L.values} ph="+ value" onChange={(v) => p.onEdit(`labels.${i}.values`, v)} />
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 6 }} onClick={addLabel}>
          + Label
        </button>
        <Lab>Lead</Lab>
        <F hint="Once the team is up, its first member leads: it proposes changes to the team, and opens and assigns incidents.">
          <Pick value={t.lead ?? ''} options={[['', 'No lead'], ...t.seats.map((s): [string, string] => [s.id, s.name])]} onChange={(v) => p.onEdit('lead', v)} />
        </F>
        <Lab>Fallback</Lab>
        <F hint="Where a message no route allows would go, when its sender is told to send it there.">
          <Pick value={t.fallback} options={endpointOptions(t)} onChange={(v) => p.onEdit('fallback', v)} />
        </F>
        <Lab n={t.escalation.length}>Escalation</Lab>
        {t.escalation.map((e, i) => (
          <div key={i} className="esc-rule">
            <div className="frow">
              <Pick value={e.when} options={WHENS.map((w): [string, string] => [w, w])} onChange={(v) => p.onEdit(`escalation.${i}.when`, v)} />
              {e.when !== 'critical' ? (
                <>
                  <span className="unit">after</span>
                  <Num value={e.after} onCommit={(v) => p.onEdit(`escalation.${i}.after`, v)} />
                  <span className="unit">min</span>
                </>
              ) : null}
              <button className="btn sm ghost" title="Remove rule" onClick={() => p.onTeam({ ...t, escalation: t.escalation.filter((_, j) => j !== i) })}>
                ×
              </button>
            </div>
            <div className="frow">
              <Pick value={e.scope?.group ?? ''} options={[['', 'Any group'], ...t.groups.map((g): [string, string] => [g.id, `In ${g.name}`])]} onChange={(v) => p.onEdit(`escalation.${i}.scope.group`, v)} />
            </div>
            <Toggles ui opts={THEN.map((x): [string, string] => [x, THEN_LABEL[x]])} on={(v) => e.then.includes(v as never)} onToggle={(v) => p.onEdit(`escalation.${i}.then`, toggleIn(e.then, v))} />
          </div>
        ))}
        <button className="btn sm" style={{ marginTop: 6 }} onClick={() => p.onTeam({ ...t, escalation: [...t.escalation, { when: 'unclaimed', after: 15, then: ['tell-user'] }] })}>
          + Rule
        </button>
        <div className="hintbox">
          <b>On the canvas.</b> Double-click empty space for a seat. Drag from a seat's right-edge dot onto another for a route. Shift-click seats, then Group them. Drag a seat into a region to add it to that group. Space-drag or drag empty space to pan; ctrl-wheel to zoom.
        </div>
      </div>
    </>
  );
}

function MultiForm({ p }: { p: InspectorProps }) {
  const ss = (p.sel?.ids ?? []).map((i) => seatById(p.team, i)).filter((s): s is Seat => !!s);
  return (
    <>
      <Head tile={<span className="htile" style={sc('var(--ink3)')}><IconGroup /></span>} title={`${ss.length} seats`} sub="shift-click to add or remove" />
      <div className="isc">
        <ul className="multi">
          {ss.map((s) => (
            <li key={s.id}>
              <span className="htile" style={sc(p.look.color?.[s.id] ?? '#94a3b8')}>
                {(s.name || '?').trim()[0]?.toUpperCase() || '?'}
              </span>
              {s.name}
            </li>
          ))}
        </ul>
        <button className="btn go wide" onClick={p.onGroupThem}>
          Group them
        </button>
        <button className="btn bad wide" style={{ marginTop: 8 }} onClick={p.onDelete}>
          Delete {ss.length} seats
        </button>
      </div>
    </>
  );
}

/** Everything about what's selected, as a form (nothing selected: the team's labels, lead, fallback and escalation). */
export function Inspector(p: InspectorProps) {
  // (from 0: a bump made before the inspector was there, the first seat of an empty team, still focuses its name)
  const handled = useRef(0);
  // each seat's and group's form token, kept across renames and others coming and going
  const tok = useRef<FormTokens | null>(null);
  const made = useRef(0);
  if (!tok.current || tok.current.team !== p.team || tok.current.sel !== p.sel) tok.current = formTokens(tok.current, p.team, p.sel, () => `f${++made.current}`);
  const s = p.sel;
  const id = s?.ids[0] ?? '';
  const seat = s?.kind === 'seat' ? seatById(p.team, id) : undefined;
  const group = s?.kind === 'group' ? groupById(p.team, id) : undefined;
  const route = s?.kind === 'route' ? p.team.routes.find((r) => r.id === id) : undefined;
  const body = s?.kind === 'seat' && s.ids.length > 1 ? <MultiForm p={p} /> : seat ? <SeatForm key={formKey(tok.current, s)} s={seat} p={p} handled={handled} /> : group ? <GroupForm key={formKey(tok.current, s)} g={group} p={p} /> : route ? <RouteForm key={route.id} r={route} p={p} /> : <TeamForm p={p} />;
  return (
    <aside className="insp" data-tour="inspector">
      {body}
      <datalist id="tb-tools">
        {TOOL_NAMES.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
      <datalist id="tb-skills">
        {(p.team.skills ?? []).map((k) => (
          <option key={k.name} value={k.name} />
        ))}
      </datalist>
      <datalist id="tb-rules">
        {RULES.map((x) => (
          <option key={x} value={x} />
        ))}
      </datalist>
    </aside>
  );
}
