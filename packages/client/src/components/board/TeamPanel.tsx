import { useCallback, useEffect, useRef, useState } from 'react';
import { escalationSentence, poolCap, seatsOf, type Endpoint, type Project, type Route, type Seat, type SessionInfo, type Team } from '@cora/shared';
import { approveTeamProposal, bringUpTeam, getTeam, projectOfBoard, rejectTeamProposal, restartTeamSeats, rollbackTeam, standDownTeam, teamHistory, useProject, type TeamChangeDetail, type TeamHealth, type TeamProposal } from '../../state/projects';
import { useBrain } from '../../state/store';
import { draftInProgress, openBuilder, useProjectDraft } from '../../state/builder';
import { ago, sessionColor, sessionName } from '../../lib/format';
import '../projects.css';

/** What `getTeam` says about a project's team beyond the project itself: each seat's health, the seats waiting for a restart, a proposal and what it changes. */
export type TeamLive = { version: number; up: boolean; health: TeamHealth[]; restart: string[]; proposal?: TeamProposal; proposalDetails?: TeamChangeDetail[] };

/**
 * The proposal whose changes are on screen (its `at`), or null while they haven't loaded (or a newer one came): Approve
 * approves only what was shown.
 */
export function shownProposal(live: TeamLive | null, proposal?: TeamProposal): number | null {
  return proposal && live?.proposalDetails && live.proposal?.at === proposal.at ? proposal.at : null;
}

/**
 * What a proposal changes, line by line; a line about a seat's permissions or folder (it starts with ⚠) stands out. A
 * line that was cut (instructions, a startup prompt, a skill) opens to the whole of it.
 */
export function ChangeLines({ live }: { live: TeamLive | null }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const items = live?.proposalDetails;
  if (!items?.length) return live?.proposal && !items ? <div className="tm-line">Loading what it changes…</div> : null;
  const keys = changeKeys(items);
  return (
    <ul className="tm-changes">
      {items.map((x, i) => {
        const k = keys[i];
        return (
          <li key={k} className={x.line.startsWith('⚠') ? 'warn' : undefined}>
            {open[k] && x.full ? <span className="full">{x.full}</span> : x.line}
            {x.full ? (
              <button className="tm-more" aria-expanded={!!open[k]} onClick={() => setOpen((o) => ({ ...o, [k]: !o[k] }))}>
                {open[k] ? 'less' : 'all of it'}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
/** Each change line's key: the line itself (a line opened stays with it, wherever it moves), and which of its twins it is. */
export function changeKeys(items: TeamChangeDetail[]): string[] {
  const seen = new Map<string, number>();
  return items.map((x) => {
    const n = seen.get(x.line) ?? 0;
    seen.set(x.line, n + 1);
    return `${n}:${x.line}`;
  });
}

/**
 * The team's live state (health and restarts come only from the server): fetched on mount, every 10 s while mounted, and
 * again when the project changes. Nothing is fetched when the project has no team.
 */
export function useTeamLive(p?: Project): { live: TeamLive | null; refresh(): void } {
  const [live, setLive] = useState<TeamLive | null>(null);
  const req = useRef(0);
  const id = p?.id;
  const has = !!p?.team || !!p?.teamProposal;
  const refresh = useCallback(() => {
    if (!id || !has) return;
    const n = ++req.current;
    getTeam(id)
      .then((r) => {
        if (n === req.current && r.ok) setLive({ version: r.version ?? 0, up: !!r.up, health: r.health ?? [], restart: r.restart ?? [], proposal: r.proposal, proposalDetails: r.proposalDetails });
      })
      .catch(() => {});
  }, [id, has]);
  // what is worth looking again for: the team's version, its proposal, whether it is up, who is seated
  const seated = p ? p.sessions.filter((sid) => p.members[sid]?.seat).map((sid) => `${sid}:${p.members[sid]?.seat}:${p.members[sid]?.instance ?? ''}`).join(',') : '';
  const key = `${p?.team?.version}|${p?.teamProposal?.at ?? ''}|${p?.teamUp ? 1 : 0}|${seated}`;
  useEffect(() => setLive(null), [id]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10_000);
    return () => {
      clearInterval(t);
      req.current++;
    };
  }, [refresh, key]);
  return { live: has ? live : null, refresh };
}

/** A team action (bring up, stand down, restart, approve…) as the server answers it. */
export type TeamAct = () => Promise<{ ok: boolean; error?: string; problems?: string[] }>;
/** What a team action's row says after it: the team's problems, else what went wrong (a request that threw too). Never throws. */
export async function teamActOutcome(f: TeamAct): Promise<{ problems: string[]; error: string }> {
  try {
    const r = await f();
    const problems = r.problems ?? [];
    return { problems, error: r.ok || problems.length ? '' : (r.error ?? 'That did not work.') };
  } catch (x) {
    return { problems: [], error: x instanceof Error ? x.message : String(x) };
  }
}

/** The sessions live (not ended) under a seat: the one count the whole board uses. */
export function liveOf(p: Project, seatId: string, sessions: Record<string, SessionInfo>): number {
  return seatMembers(p, seatId).filter((sid) => sessions[sid] && sessions[sid].state !== 'ended').length;
}

export const seatName = (t: Team, id: string) => t.seats.find((s) => s.id === id)?.name ?? id;
/** The Team panel's way into the builder: Build a team (none yet), or Edit. */
export function builderEntry(p: Pick<Project, 'team'>): { label: 'Build a team' | 'Edit'; title: string } {
  return p.team ? { label: 'Edit', title: 'Open the team in the builder' } : { label: 'Build a team', title: 'Build this project a team: talk it through with Cora, start from a shape, or draw it' };
}
const names = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : (xs[0] ?? ''));

/**
 * The team's Bring up button: always for a team stood down; for one that is up, only to try the seats failing to start
 * again, to bring back the seats stood down on their own (`down`: their names), or to start again now the standing
 * seats with fewer running than their minimum (`short`: their names; one that died waits out Cora's back-off otherwise).
 */
export function bringUpOffer(o: { up: boolean; failing: boolean; down: string[]; short?: string[]; seated: boolean }): { enabled: boolean; go: boolean; title: string } {
  if (!o.up) return { enabled: true, go: true, title: o.seated ? 'Its stood-down sessions come back as themselves, with their memory' : 'Start its seats' };
  if (o.down.length) return { enabled: true, go: true, title: `Bring back ${names(o.down)} (stood down on ${o.down.length > 1 ? 'their' : 'its'} own)${o.failing ? ', and try the seats that failed to start again' : ''}` };
  if (o.failing) return { enabled: true, go: false, title: 'Try the seats that failed to start again' };
  const short = o.short ?? [];
  if (short.length) return { enabled: true, go: true, title: `Start ${names(short)} again now (fewer running than ${short.length > 1 ? 'their' : 'its'} minimum)` };
  return { enabled: false, go: false, title: 'The team is up' };
}

/**
 * What the project's own settings take from a team that is up (they win over it): coordination off cuts every seat off;
 * a member that may not post, or hears nothing (Crew), can't message or read. Said in the Team panel, a line each.
 */
export function cutOff(p: Project, up: boolean): string[] {
  const team = p.team;
  if (!team || !up) return [];
  if (!p.coordination) return ["Coordination is off (the project's header): its seats can't post, hear the project or hand off work. Turn it on for the team to work."];
  const out: string[] = [];
  for (const s of team.seats) {
    const mem = seatMembers(p, s.id).map((sid) => p.members[sid]);
    if (mem.some((m) => m && !m.canPost)) out.push(`${s.name} may not post (Crew): it can't message anyone or hand off work.`);
    if (mem.some((m) => m?.hears === 'nothing')) out.push(`${s.name} hears nothing of the project (Crew): it can't read its board or items.`);
  }
  return out;
}

/** What else the team says, a line each: who leads, where a refused message should go, its skills. */
export function teamFacts(t: Team): string[] {
  const fb = t.fallback === 'user' ? 'the user' : endpointLabel(t, t.fallback);
  return [
    t.lead ? `${seatName(t, t.lead)} leads (its first member, once the team is up).` : 'No seat leads.',
    `A message no route allows is refused, naming ${fb} to send it to instead when its sender may message ${fb}.`,
    ...(t.skills?.length ? [`Team skills: ${names(t.skills.map((k) => k.name))}.`] : []),
  ];
}
/** A group in a line: its seats, and how it hands out work (a pool grows only to its seat's maximum). */
export function groupLine(t: Team, g: Team['groups'][number]): string {
  const m = seatsOf(t, g.id).map((x) => seatName(t, x));
  const gs = g.grow ? t.seats.find((s) => s.id === g.grow!.seat) : undefined;
  return `${m.join(', ') || 'no seats'} · ${g.dispatch === 'claim' ? `first free claims it${g.grow ? ` (grows to ${gs ? poolCap(g.grow, gs) : g.grow.max})` : ''}` : 'sender picks'}`;
}

/** An endpoint in words: a seat or group's name, You, Cora. */
export function endpointLabel(t: Team, e: Endpoint): string {
  if (e === 'user') return 'You';
  if (e === 'cora') return 'Cora';
  const id = e.slice(e.indexOf(':') + 1);
  return e.startsWith('seat:') ? seatName(t, id) : (t.groups.find((g) => g.id === id)?.name ?? id);
}

const WAKE_WORD = { auto: 'wakes on its own', ask: 'asks you before waking', never: 'never wakes' } as const;
/** A route as a sentence: "Mail, Slack, Infra → Triage · reports · wakes on its own · only issue = encoder". */
export function routeSentence(t: Team, r: Route): string {
  const kinds = r.kinds === 'any' ? 'any message' : r.kinds.map((k) => (k === 'direct' ? 'direct messages' : `${k}s`)).join(', ');
  const parts = [`${r.from.map((f) => endpointLabel(t, f)).join(', ')} → ${endpointLabel(t, r.to)}`, kinds, WAKE_WORD[r.wake]];
  for (const [k, vals] of Object.entries(r.labels ?? {})) parts.push(`only ${k} = ${vals.join(' or ')}`);
  if (r.template?.fields.length) parts.push(`must include ${r.template.fields.join(', ')}`);
  return parts.join(' · ');
}


function limitSentence(s: Seat): string | null {
  const l = s.limits;
  if (!l) return null;
  const parts = [l.turnsPerHour ? `${l.turnsPerHour} turns an hour` : '', l.costPerDay ? `$${l.costPerDay} a day` : '', l.quiet ? `quiet ${l.quiet.from}–${l.quiet.to}` : ''].filter(Boolean);
  return parts.length ? `${s.name}: ${parts.join(', ')}` : null;
}

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const countWord = (s: Seat) => (s.count.min === s.count.max ? `${s.count.max}` : `${s.count.min}–${s.count.max}`);

/** The members live under a seat (by the seat id they carry). */
export function seatMembers(p: Project, seatId: string): string[] {
  return p.sessions.filter((sid) => p.members[sid]?.seat === seatId);
}

const Lab = ({ children, n }: { children: React.ReactNode; n?: number }) => (
  <div className="pc-lab">
    {children} {n != null ? <b>{n}</b> : null}
  </div>
);

/**
 * The team's header row: its version and state; Edit (or Continue draft) in the builder; Restart X to apply when its
 * members run an older definition; Start fresh (stood down, with members); Bring up (bringUpOffer) and Stand down. The
 * Team panel and the team map both show it: one component, two places. `act` runs an action and says what came of it.
 */
export function TeamHead({ p, team, live, draft, act, children }: { p: Project; team: Team; live: TeamLive | null; draft: boolean; act(f: TeamAct): Promise<void>; children?: React.ReactNode }) {
  // what's under way (its button shows it, and none can be pressed twice)
  const [busy, setBusy] = useState<'' | 'up' | 'fresh' | 'down'>('');
  const up = live ? live.up : !!p.teamUp;
  const restart = live?.restart ?? [];
  const failing = !!live?.health.some((h) => h.failing);
  // its members (live or stood down): Bring up brings the stood-down ones back; Start fresh replaces them
  const seated = p.sessions.some((sid) => p.members[sid]?.seat);
  const short = (live?.health ?? []).filter((h) => h.short && !h.failing).map((h) => seatName(team, h.seat));
  const offer = bringUpOffer({ up, failing, down: (p.teamDown ?? []).map((id) => seatName(team, id)), short, seated });
  const run = async (k: 'up' | 'fresh' | 'down', f: TeamAct) => {
    setBusy(k);
    try {
      await act(f);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="tm-head">
      <span className="ver">Version {live?.version ?? team.version}</span>
      <span className={`state${up ? ' up' : ''}`}>{up ? 'up' : 'stood down'}</span>
      {children}
      <span className="sp" />
      <button className="pp-btn" title={builderEntry(p).title} onClick={() => openBuilder(p.id)}>
        {draft ? 'Continue draft' : builderEntry(p).label}
      </button>
      {restart.length ? (
        <button className="pp-btn go" onClick={() => void act(() => restartTeamSeats(p.id, restart))}>
          Restart {names(restart.map((r) => seatName(team, r)))} to apply
        </button>
      ) : null}
      {!up && seated ? (
        <button className="pp-btn" disabled={!!busy} title="Its sessions that were stood down leave the project; every seat starts new, without their memory" onClick={() => void run('fresh', () => bringUpTeam(p.id, { fresh: true }))}>
          {busy === 'fresh' ? 'Starting…' : 'Start fresh'}
        </button>
      ) : null}
      <button className={`pp-btn${offer.go ? ' go' : ''}`} disabled={!!busy || !offer.enabled} title={offer.title} onClick={() => void run('up', () => bringUpTeam(p.id))}>
        {busy === 'up' ? 'Bringing up…' : 'Bring up'}
      </button>
      <button className="pp-btn bad" disabled={!up || !!busy} title="Ends its sessions; Bring up brings them back as themselves" onClick={() => void run('down', () => standDownTeam(p.id))}>
        {busy === 'down' ? 'Standing down…' : 'Stand down'}
      </button>
    </div>
  );
}

/** The project's team, plainly: its seats, groups, routes and rules; bring it up, stand it down, restart, roll back. */
export function TeamPanel({ sessionId }: { sessionId: string }) {
  const p = useProject(projectOfBoard(sessionId));
  const sessions = useBrain((s) => s.sessions);
  const { live, refresh } = useTeamLive(p);
  const [problems, setProblems] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [hist, setHist] = useState<Array<{ version: number; at: number; by: string }> | null>(null);
  const [showHist, setShowHist] = useState(false);
  const team = p?.team;
  // a team draft in progress: Continue it, rather than starting as if there were none
  const draft = draftInProgress(useProjectDraft(p?.id), team);
  const histKey = live?.version;
  useEffect(() => {
    if (!showHist || !p) return;
    void teamHistory(p.id).then((r) => setHist(r.ok ? (r.versions ?? []) : []));
  }, [showHist, p?.id, histKey]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!p) return null;
  const leadName = p.lead && sessions[p.lead] ? sessionName(sessions[p.lead]) : 'The lead';
  const act = async (f: TeamAct) => {
    setErr('');
    const o = await teamActOutcome(f);
    setProblems(o.problems);
    setErr(o.error);
    refresh();
  };
  const proposal = live?.proposal ?? p.teamProposal;
  const propCard = proposal ? (
    <div className="tm-prop">
      <div className="t">
        <b>{leadName}</b> proposes a team change: <q>{proposal.why}</q>
      </div>
      <ChangeLines live={live} />
      <div className="acts">
        <button className="pp-btn go" disabled={shownProposal(live, proposal) === null} onClick={() => void act(() => approveTeamProposal(p.id, shownProposal(live, proposal)!))}>
          Approve
        </button>
        <button className="pp-btn" onClick={() => void act(() => rejectTeamProposal(p.id))}>
          Reject
        </button>
        <button className="pp-btn" title="See it on the canvas, and edit it before you approve" onClick={() => openBuilder(p.id, { proposal: true })}>
          Open in builder
        </button>
      </div>
    </div>
  ) : null;
  // a first proposal comes before there's any team
  if (!team)
    return proposal ? (
      <div className="pc-team">
        {problems.length ? <div className="tm-bad">{problems.join(' ')}</div> : null}
        {err ? <div className="tm-bad">{err}</div> : null}
        {propCard}
      </div>
    ) : (
      <div className="pp-empty">
        {draft ? 'A team draft is in progress.' : 'This project has no team yet.'}{' '}
        <button className="pp-btn go" title={builderEntry(p).title} onClick={() => openBuilder(p.id)}>
          {draft ? 'Continue draft' : builderEntry(p).label}
        </button>
      </div>
    );
  const up = live ? live.up : !!p.teamUp;
  const health = (id: string) => live?.health.find((h) => h.seat === id);
  const byWho = (by: string) => (by === 'you' || by === 'user' ? 'you' : by === 'cora' ? 'Cora' : sessions[by] ? sessionName(sessions[by]) : by);
  return (
    <div className="pc-team">
      <TeamHead p={p} team={team} live={live} draft={!!draft} act={act} />
      {problems.length ? <div className="tm-bad">{problems.join(' ')}</div> : null}
      {err ? <div className="tm-bad">{err}</div> : null}
      {cutOff(p, up).map((x) => (
        <div key={x} className="tm-bad">
          {x}
        </div>
      ))}
      {propCard}

      <Lab n={team.seats.length}>Seats</Lab>
      {team.seats.map((s) => {
        const mem = seatMembers(p, s.id);
        const first = mem.map((m) => sessions[m]).find(Boolean);
        const h = health(s.id);
        return (
          <div key={s.id} className="tm-seat" style={{ ['--sc' as any]: first ? sessionColor(first) : 'var(--ink3)' }}>
            <span className="tile">{s.name[0]?.toUpperCase()}</span>
            <span className="nm">
              <b>{s.name}</b>
              <span className="meta">
                {countWord(s)} · {liveOf(p, s.id, sessions)} of {s.count.max} live · {base(s.folder.path)}
                {s.agent.model ? ` · ${s.agent.model}` : ''}
              </span>
            </span>
            <button className="pp-btn sm" onClick={() => void act(() => standDownTeam(p.id, s.id))} title="Stand this seat down">
              Stand down
            </button>
            {h?.failing ? <span className="fail">failing to start: {h.lastError ?? 'unknown error'}</span> : null}
          </div>
        );
      })}

      {team.groups.length ? <Lab n={team.groups.length}>Groups</Lab> : null}
      {team.groups.map((g) => (
        <div key={g.id} className="tm-line">
          <b>{g.name}</b>: {groupLine(team, g)}
        </div>
      ))}

      {team.routes.length ? <Lab n={team.routes.length}>Routes</Lab> : null}
      {team.routes.map((r) => (
        <div key={r.id} className="tm-line">
          {routeSentence(team, r)}
        </div>
      ))}

      {team.escalation.length ? <Lab n={team.escalation.length}>Escalation</Lab> : null}
      {team.escalation.map((e, i) => (
        <div key={i} className="tm-line">
          {escalationSentence(team, e)}
        </div>
      ))}

      <Lab>The team</Lab>
      {teamFacts(team).map((x) => (
        <div key={x} className="tm-line">
          {x}
        </div>
      ))}

      {team.seats.some((s) => limitSentence(s)) ? <Lab>Limits</Lab> : null}
      {team.seats.map((s) => {
        const l = limitSentence(s);
        return l ? (
          <div key={s.id} className="tm-line">
            {l}
          </div>
        ) : null;
      })}

      <div className="tm-foot">
        <button className="pp-btn" aria-expanded={showHist} onClick={() => setShowHist(!showHist)}>
          History…
        </button>
      </div>
      {showHist ? (
        <div className="tm-hist">
          {(hist ?? []).length ? (
            hist!.map((v) => (
              <div key={v.version} className="row">
                <span className="v">v{v.version}</span>
                <span className="w">
                  {ago(v.at)} · {byWho(v.by)}
                </span>
                {v.version !== (live?.version ?? team.version) ? (
                  <button
                    className="pp-btn sm"
                    onClick={() => window.confirm(`Roll the team back to version ${v.version}? Seats that need it will wait for a restart.`) && void act(() => rollbackTeam(p.id, v.version))}
                  >
                    Roll back
                  </button>
                ) : (
                  <span className="w">current</span>
                )}
              </div>
            ))
          ) : (
            <div className="tm-line">{hist ? 'No earlier versions.' : 'Loading…'}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
