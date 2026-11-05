import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { bySeverity, isOpenQuestion, itemOpen, type Post, type PostKind, type Project, type ProjectHears, type ProjectWake, type SessionInfo } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { answerWake, approveTeamProposal, bringUpTeam, closeQuestion, editDecision, editPost, itemOp, leaveProject, pinPost, postToProject, projectOfBoard, rejectTeamProposal, restartTeamSeats, setMember, updateProject, useProject, useProjectOfSession, useProjects } from '../../state/projects';
import type { CoraState } from '../../state/orchestrator';
import { ago, sessionColor, sessionName } from '../../lib/format';
import { CoraOrb } from '../CoraOrb';
import { useVoice } from '../../lib/voice';
import { CiGlyph } from '../CiStrip';
import { Icon } from '../Icon';
import { SEV_COLOR } from './ItemPanels';
import { NeedsYou } from '../NeedsYou';
import { ChangeLines, liveOf, seatName, shownProposal, teamActOutcome, useTeamLive, type TeamAct } from './TeamPanel';
import { draftInProgress, openBuilder, useProjectDraft } from '../../state/builder';
import { liveTerminal, sendToSession } from '../../state/composer';
import '../projects.css';

/**
 * A project's board panels: the Constellation, Members,
 * Thread, Brief & decisions, Across repos, Activity; and the Project panel on a member's own board.
 */
type Props = { sessionId: string };

function useBoardProject(owner: string): Project | undefined {
  return useProject(projectOfBoard(owner));
}
function useMembers(p?: Project): SessionInfo[] {
  const sessions = useBrain((s) => s.sessions);
  return useMemo(() => (p ? p.sessions.map((id) => sessions[id]).filter((s): s is SessionInfo => !!s) : []), [p, sessions]);
}
const orbState = (s: SessionInfo): CoraState => (s.state === 'needs-you' ? 'needs-you' : s.state === 'working' || s.state === 'thinking' ? 'thinking' : s.state === 'ended' ? 'off' : 'idle');
const STATE_WORD: Record<string, string> = { 'needs-you': 'needs you', working: 'working', thinking: 'thinking', idle: 'idle', ended: 'ended' };
const KIND_COLOR: Record<PostKind, string> = { note: 'var(--ink3)', change: '#60a5fa', question: '#fbbf24', handoff: '#3ddc97', decision: '#a78bfa', report: '#2dd4bf', direct: 'var(--ink3)' };
/** A direct message: one a session sent itself (Claude Code delivered it), or a post of the kind direct. */
export const isDirect = (x: Pick<Post, 'native' | 'kind'>) => !!x.native || x.kind === 'direct';
/** No sessions yet. On the Crew panel of a project with no team (nor one proposed): `team`, its id, adds a way into the builder. */
export const NoMembers = ({ team, drafting }: { team?: string; /** a team draft is in progress: Continue it */ drafting?: boolean }) => (
  <div className="pp-empty">
    No sessions in this project yet. Drag a session onto it in the nav, or start one from the project's header.
    {team ? (
      <div className="pp-noteam">
        {drafting ? 'A team draft is in progress · ' : 'No team yet · '}
        <button className="pp-link" title={drafting ? 'Back to the builder, where you left it' : 'Talk it through with Cora, start from a shape, or draw it'} onClick={() => openBuilder(team)}>
          {drafting ? 'Continue' : 'Build a team'}
        </button>
      </div>
    ) : null}
  </div>
);
const open = (sid: string) => useBrain.getState().setFocus(sid);

/** What's waiting for each member (handoffs and questions not delivered yet, and wakes asking you). */
function useWaiting(p?: Project): Map<string, number> {
  const wakes = useProjects((s) => s.wakes);
  return useMemo(() => {
    const n = new Map<string, number>();
    if (!p) return n;
    const seen = new Set<string>();
    for (const w of p.waiting ?? []) (seen.add(`${w.post}|${w.to}`), n.set(w.to, (n.get(w.to) ?? 0) + 1));
    for (const w of wakes) if (w.project === p.id && !seen.has(`${w.post}|${w.to}`)) n.set(w.to, (n.get(w.to) ?? 0) + 1);
    return n;
  }, [p, wakes]);
}

/**
 * The members' orbs together: a post streaks from its writer to who it's for (by its kind's colour); a handoff or
 * question still waiting stays as a marching dashed line until it's delivered; a badge counts what waits for each.
 */
export function ConstellationPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  const doing = useProjects((s) => s.doing);
  const waiting = useWaiting(p);
  // the one session being read aloud (each orb speaks only for itself; none given, an orb would take Cora's voice)
  const speakingSid = useVoice((v) => (v.reading && !v.reading.id.startsWith('cora') ? v.reading.sessionId : null));
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(400);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.min(el.clientWidth, el.clientHeight * 1.6)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // where each sits: a ring (one in the middle; two side by side)
  const at = useMemo(() => {
    const n = members.length;
    return members.map((s, i) => {
      if (n === 1) return { s, x: 50, y: 50 };
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2 + (n === 2 ? Math.PI / 2 : 0);
      return { s, x: 50 + Math.cos(a) * (n === 2 ? 24 : 30), y: 50 + Math.sin(a) * (n === 2 ? 0 : 26) };
    });
  }, [members]);
  // the thread's newest post, as light: from its writer to who it's for (or all who hear it); a refused one was never sent
  const last = p?.thread.filter((x) => !x.blocked).at(-1);
  const [streak, setStreak] = useState<Post | null>(null);
  const seen = useRef(last?.id);
  useEffect(() => {
    if (!last || last.id === seen.current) return;
    seen.current = last.id;
    setStreak(last);
    const t = setTimeout(() => setStreak(null), 2200);
    return () => clearTimeout(t);
  }, [last]);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  const size = Math.max(40, Math.min(84, Math.round(w / Math.max(3, members.length + 1))));
  const pos = (sid: string) => at.find((a) => a.s.id === sid);
  const from = streak ? pos(streak.by) : undefined;
  const to = streak ? at.filter((a) => a.s.id !== streak.by && (streak.to?.length ? streak.to.includes(a.s.id) : p.coordination && p.members[a.s.id]?.hears === 'everything')) : [];
  // waiting: from the post's writer to its member
  const lines = (p.waiting ?? []).flatMap((x) => {
    const post = p.thread.find((y) => y.id === x.post);
    const a = post ? pos(post.by) : undefined;
    const b = pos(x.to);
    return a && b ? [{ key: `${x.post}|${x.to}`, a, b, kind: post!.kind }] : [];
  });
  return (
    <div className="pp-sky" ref={box} style={{ ['--pc' as any]: p.color }}>
      <svg className="links" viewBox="0 0 100 100" preserveAspectRatio="none">
        {lines.map((l) => (
          <path key={l.key} className="wait" d={`M${l.a.x},${l.a.y} L${l.b.x},${l.b.y}`} stroke={KIND_COLOR[l.kind]} vectorEffect="non-scaling-stroke" />
        ))}
        {from && to.length
          ? to.map((t) => <path key={t.s.id + streak!.id} className="streak" d={`M${from.x},${from.y} L${t.x},${t.y}`} stroke={KIND_COLOR[streak!.kind]} vectorEffect="non-scaling-stroke" />)
          : null}
      </svg>
      {at.map(({ s, x, y }) => {
        const n = waiting.get(s.id) ?? 0;
        return (
          <button key={s.id} className={`pp-star${s.state === 'needs-you' ? ' need' : ''}${s.state === 'ended' ? ' ended' : ''}`} style={{ left: `${x}%`, top: `${y}%` }} onClick={() => open(s.id)} title={`${sessionName(s)}${doing[s.id] ? `: ${doing[s.id]}` : ''}`}>
            <span className="orbw">
              <CoraOrb state={orbState(s)} size={size} agent={s.id} color={sessionColor(s)} speaking={speakingSid === s.id} />
              {n ? <span className="pp-badge" title={`${n} waiting for it`}>{n}</span> : null}
            </span>
            <b>{sessionName(s)}</b>
            <small>{STATE_WORD[s.state] ?? s.state}</small>
          </button>
        );
      })}
      {lines.length ? (
        <div className="pp-legend">
          <span style={{ ['--lc' as any]: KIND_COLOR.handoff }}>waiting to be delivered</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Crew: who's doing what, and what each last said. Every row is the same height
 * whatever you point at; each has two quiet actions, Reply (picks who the one reply line at the bottom goes to) and
 * Settings (a menu over the list: lead, what it hears, may post, may be woken, its seat name, take it out). The lead is
 * said at the top, with a way to change it.
 */
export function MembersPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  const waiting = useWaiting(p);
  const sessions = useBrain((s) => s.sessions);
  const versions = useBrain((s) => s.versions);
  const pending = useBrain((s) => s.pending);
  const [pin, setPin] = useState<ReplyPin>(NO_PIN);
  const [menu, setMenu] = useState<{ sid: string; button: HTMLElement } | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const draft = draftInProgress(useProjectDraft(p?.id), p?.team);
  if (!p) return null;
  if (!members.length) return <NoMembers team={(p.team || p.teamProposal) && !draft ? undefined : p.id} drafting={!!draft} />;
  const asks = (sid: string) => pending.some((x) => x.sessionId === sid);
  const target = replyTarget(members, pin, asks);
  const pick = (sid: string) => (setPin((x) => replyPin(x, { kind: 'pick', sid })), field.current?.focus());
  // typing keeps it on the one it's going to: one starting to ask mid-sentence never changes the To (until it's sent)
  const typed = (text: string) => setPin((x) => replyPin(x, { kind: 'type', text, target: target.id }));
  const sent = () => setPin((x) => replyPin(x, { kind: 'sent' }));
  const row = (s: SessionInfo, extra = false) => (
    <CrewRow
      key={s.id}
      p={p}
      s={s}
      extra={extra}
      waiting={waiting.get(s.id) ?? 0}
      asks={asks(s.id)}
      version={versions[s.id]}
      target={target.id === s.id}
      menuOpen={menu?.sid === s.id}
      onReply={() => pick(s.id)}
      onSettings={(button) => setMenu(menu?.sid === s.id ? null : { sid: s.id, button })}
    />
  );
  let list: React.ReactNode;
  // with a team, the rows sit under their seat (in team order); the rest under Others
  if (p.team) {
    const seatIds = new Set(p.team.seats.map((x) => x.id));
    const others = members.filter((s) => !seatIds.has(p.members[s.id]?.seat ?? ''));
    list = (
      <>
        {p.team.seats.map((seat) => {
          const mine = members.filter((s) => p.members[s.id]?.seat === seat.id);
          const live = liveOf(p, seat.id, sessions);
          return mine.length ? (
            <div key={seat.id} className="pc-group">
              <div className="pc-lab">
                {seat.name} <b>{seat.count.max > 1 ? `${live} of ${seat.count.max}` : live}</b>
              </div>
              {mine.map((s) => row(s, (p.members[s.id]?.instance ?? 0) > seat.count.min))}
            </div>
          ) : null;
        })}
        {others.length ? (
          <div className="pc-group">
            <div className="pc-lab">
              Others <b>{others.length}</b>
            </div>
            {others.map((s) => row(s))}
          </div>
        ) : null}
      </>
    );
  } else list = members.map((s) => row(s));
  const lead = p.lead ? sessions[p.lead] : undefined;
  const menuFor = menu ? members.find((s) => s.id === menu.sid) : undefined;
  return (
    <div className="pc-crew">
      {p.coordination ? (
        <div className="pc-leadline">
          <span className="k">Lead</span>
          <span className={`who${lead ? '' : ' none'}`}>{lead ? sessionName(lead) : 'No lead: an incident’s opener decides'}</span>
          <select
            value={p.lead ?? ''}
            onChange={(e) => void updateProject(p.id, { lead: e.target.value || null })}
            title={`Who leads: opens incidents, sets severity and owner, merges duplicates${p.team?.lead ? `. The team's lead seat is ${p.team.seats.find((x) => x.id === p.team!.lead)?.name ?? p.team.lead}: its first member leads when the team comes up, unless you pick another (No lead stays until you pick one)` : ''}`}
          >
            <option value="">No lead</option>
            {members.map((s) => (
              <option key={s.id} value={s.id}>
                {sessionName(s)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="pc-crew-list">{list}</div>
      <CrewCompose s={target} asks={asks(target.id)} members={members} field={field} onPick={pick} onType={typed} onSent={sent} />
      {menu && menuFor ? <CrewMenu key={menu.sid} p={p} s={menuFor} button={menu.button} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}

/**
 * The Crew's reply line's To: `picked`, the one you picked (row Reply, the To list), kept until you pick another;
 * `typing`, the one it was going to when you started typing, kept until it's sent or the line is emptied.
 */
export type ReplyPin = { picked: string | null; typing: string | null };
export const NO_PIN: ReplyPin = { picked: null, typing: null };
export type ReplyEvent = { kind: 'pick'; sid: string } | { kind: 'type'; text: string; target: string } | { kind: 'sent' };
export function replyPin(pin: ReplyPin, e: ReplyEvent): ReplyPin {
  if (e.kind === 'pick') return { picked: e.sid, typing: null };
  if (e.kind === 'sent' || !e.text) return pin.typing === null ? pin : { ...pin, typing: null };
  return pin.typing === null ? { ...pin, typing: e.target } : pin;
}
/** Who the Crew's reply line goes to: the one it was going to as you typed, else the one you picked (still here), else the first waiting on you, else the first. */
export function replyTarget(members: SessionInfo[], pin: ReplyPin, asks: (sid: string) => boolean): SessionInfo {
  return members.find((s) => s.id === pin.typing) ?? members.find((s) => s.id === pin.picked) ?? members.find((s) => asks(s.id) || s.state === 'needs-you') ?? members[0];
}

/** Its last reply's words, as plain text (no markdown marks). */
const plain = (t: string) =>
  t
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const hhmm = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function CrewRow(props: { p: Project; s: SessionInfo; extra?: boolean; waiting: number; asks: boolean; version?: number; target: boolean; menuOpen: boolean; onReply(): void; onSettings(button: HTMLElement): void }) {
  const { p, s, extra, waiting, asks, version, target, menuOpen, onReply, onSettings } = props;
  const m = p.members[s.id];
  const said = useMemo(
    () => sessionEvents(s.id).filter((e) => e.agentId === 'main' && e.kind === 'say' && (e.said || e.text)).at(-1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.id, version],
  );
  const busy = s.state === 'working' || s.state === 'thinking';
  const need = asks || s.state === 'needs-you';
  const st = need ? 'need' : busy ? 'work' : s.state === 'ended' ? 'end' : 'idle';
  const where = [(s.wd || s.cwd).split(/[\\/]/).filter(Boolean).pop(), s.ticket?.key].filter(Boolean).join(' · ');
  const words = said ? plain(said.said || said.text || '') : '';
  return (
    <div className={`pc-mem s-${st}${target ? ' target' : ''}`} style={{ ['--sc' as any]: sessionColor(s) }}>
      <button className="tile" onClick={() => open(s.id)} title="Open it">
        {sessionName(s)[0]?.toUpperCase()}
      </button>
      <div className="body">
        <div className="nm">
          <button className="n" onClick={() => open(s.id)} title={where ? `Open it (${where})` : 'Open it'}>
            {sessionName(s)}
          </button>
          {m?.role && !p.team ? <span className="chip">{m.role}</span> : null}
          {p.lead === s.id ? (
            <span className="chip lead" title="The project's lead: opens incidents, sets severity and owner, merges duplicates">
              lead
            </span>
          ) : null}
          {extra ? (
            <span className="chip extra" title="Started above the seat's minimum, for the load">
              extra
            </span>
          ) : null}
          <span className="word">
            {need ? 'needs you' : (STATE_WORD[s.state] ?? s.state)}
            {waiting ? ` · ${waiting} waiting` : ''}
          </span>
        </div>
        <div className={`said${said ? '' : ' none'}`} title={words || undefined}>
          {said ? (
            <>
              <time>{hhmm(said.ts)}</time>
              {words}
            </>
          ) : (
            'Nothing said yet.'
          )}
        </div>
      </div>
      <div className="acts">
        <button className={`act${target ? ' on' : ''}`} onClick={onReply} title={`Reply to ${sessionName(s)} (the line at the bottom)`}>
          <Icon name="Reply" size={11} /> Reply
        </button>
        <button className={`act${menuOpen ? ' on' : ''}`} aria-haspopup="dialog" aria-expanded={menuOpen} onMouseDown={(e) => e.stopPropagation()} onClick={(e) => onSettings(e.currentTarget)} title="Its settings in this project">
          <Icon name="Settings" size={11} /> Settings
        </button>
      </div>
    </div>
  );
}

/** The one reply line, at the bottom: to whom, and what happens when it's sent (a question it's asking, answered here). */
export function CrewCompose({ s, asks, members, field, onPick, onType, onSent }: { s: SessionInfo; asks: boolean; members: SessionInfo[]; field: React.RefObject<HTMLInputElement | null>; onPick(sid: string): void; onType(text: string): void; onSent(): void }) {
  const [text, setText] = useState('');
  const [note, setNote] = useState<{ ok: boolean; t: string } | null>(null);
  // a new target: what was said about the last one goes (what you're typing stays)
  useEffect(() => setNote(null), [s.id]);
  const busy = s.state === 'working' || s.state === 'thinking';
  const live = !!liveTerminal(s.id);
  const name = sessionName(s);
  const hint = !live ? `${name} isn't running here: resume it to reply.` : asks || s.state === 'needs-you' ? `${name} is waiting on you: this answers it.` : busy ? `${name} is working: it reads this when its turn ends.` : `${name} is idle: this starts a turn right away.`;
  const send = async () => {
    const t = text.trim();
    if (!t || !live) return;
    const r = await sendToSession(s.id, t);
    if (r.ok) {
      setText('');
      onSent();
    }
    setNote(r.ok ? { ok: true, t: `✓ Sent to ${name} as you${busy ? ': it reads it when its turn ends' : ''}.` } : { ok: false, t: r.choice ? 'It is showing a choice: answer that first.' : r.error });
  };
  return (
    <div className="pc-compose">
      {asks ? (
        <div className="asks">
          <NeedsYou sessionId={s.id} />
        </div>
      ) : null}
      <div className="line">
        <label className="to">
          <span>To</span>
          <select value={s.id} onChange={(e) => onPick(e.target.value)}>
            {members.map((x) => (
              <option key={x.id} value={x.id}>
                {sessionName(x)}
              </option>
            ))}
          </select>
        </label>
        <input ref={field} value={text} disabled={!live} placeholder={live ? `Reply to ${name}…` : 'Not running here'} onChange={(e) => (setText(e.target.value), setNote(null), onType(e.target.value))} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && void send()} />
        <button className="send" disabled={!live || !text.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
      <div className={`hint${note ? (note.ok ? ' ok' : ' bad') : ''}`}>{note ? note.t : hint}</div>
    </div>
  );
}

/**
 * A member's settings: a menu over the list (the list never moves), under its button, kept on screen. To a screen
 * reader it is a dialog (it holds a text field and a choice of three, which a menu can't). It takes the focus when it
 * opens, on its first setting (never "Take out"), and gives it back to its button when it closes from the keyboard; a
 * click away, a scroll or a resize closes it. One per row (keyed): another row's opens fresh.
 */
function CrewMenu({ p, s, button, onClose }: { p: Project; s: SessionInfo; button: HTMLElement; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const at = useMemo(() => button.getBoundingClientRect(), [button]);
  const [top, setTop] = useState(at.bottom + 6);
  // the latest onClose, so the listeners below are set once
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  // placed before it's painted (no flash where it doesn't fit)
  useLayoutEffect(() => {
    const h = box.current?.offsetHeight ?? 0;
    setTop(at.bottom + 6 + h > innerHeight - 8 ? Math.max(8, at.top - h - 6) : at.bottom + 6);
  }, [at]);
  // open: the focus on its first setting (never on "Take out"; with none, on the menu itself)
  useEffect(() => {
    (box.current?.querySelector<HTMLElement>(FIRST_SETTING) ?? box.current)?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const close = (back: boolean) => {
      if (back && button.isConnected) button.focus({ preventScroll: true });
      closeRef.current();
    };
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && close(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && close(true);
    // what holds its row scrolled (the crew list, the board, the page): it would float away from the row (other panels
    // scrolling, a terminal say, leave it open)
    const scrolled = (e: Event) => e.target instanceof Node && e.target.contains(button) && close(false);
    const resized = () => close(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    document.addEventListener('scroll', scrolled, true);
    window.addEventListener('resize', resized);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
      document.removeEventListener('scroll', scrolled, true);
      window.removeEventListener('resize', resized);
    };
  }, [button]);
  return createPortal(<CrewMenuPanel p={p} s={s} ref={box} style={{ top, left: Math.max(8, Math.min(at.right - 268, innerWidth - 276)) }} onClose={onClose} />, document.body);
}

/** The settings that take the focus when the menu opens: the first of them (never "Take out", the one marked bad). */
export const FIRST_SETTING = 'button:not(.bad), input';

/** The menu itself (CrewMenu places it and wires its keys and focus): a dialog to a screen reader, named for its member. */
export function CrewMenuPanel({ p, s, ref, style, onClose }: { p: Project; s: SessionInfo; ref?: React.Ref<HTMLDivElement>; style?: React.CSSProperties; onClose(): void }) {
  const m = p.members[s.id];
  const seat = p.team?.seats.find((x) => x.id === m?.seat);
  return (
    <div className="pc-menu" ref={ref} role="dialog" tabIndex={-1} aria-label={`${sessionName(s)}: its settings in this project`} style={style} onMouseDown={(e) => e.stopPropagation()}>
      <div className="hd">
        <b>{sessionName(s)}</b>
        <span>{seat ? `${seat.name} seat` : m?.role ? `${m.role} seat` : 'no seat'} · in this project</span>
      </div>
      {p.coordination && m ? (
        <>
          <button className="mi" role="switch" aria-checked={p.lead === s.id} onClick={() => void updateProject(p.id, { lead: p.lead === s.id ? null : s.id })}>
            <span className="t">
              Lead of the project<small>Opens incidents, sets severity and owner, merges duplicates</small>
            </span>
            <i className={`tg cora${p.lead === s.id ? ' on' : ''}`} />
          </button>
          <div className="mrow">
            <span className="t">Hears</span>
            <span className="pp-seg" role="group" aria-label="Hears">
              {(['nothing', 'brief', 'everything'] as ProjectHears[]).map((h) => (
                <button key={h} className={m.hears === h ? 'on' : ''} aria-pressed={m.hears === h} onClick={() => void setMember(p.id, s.id, { hears: h })} title={h === 'nothing' ? 'Nothing of the project' : h === 'brief' ? 'Its card (brief, decisions, who is who), not the thread' : 'Its card, and what is new on each prompt'}>
                  {h === 'brief' ? 'Card' : h === 'nothing' ? 'Nothing' : 'Everything'}
                </button>
              ))}
            </span>
          </div>
          <button className="mi" role="switch" aria-checked={!!m.canPost} onClick={() => void setMember(p.id, s.id, { canPost: !m.canPost })}>
            <span className="t">May post to the project</span>
            <i className={`tg${m.canPost ? ' on' : ''}`} />
          </button>
          <button className="mi" role="switch" aria-checked={!!m.wakes} onClick={() => void setMember(p.id, s.id, { wakes: !m.wakes })}>
            <span className="t">
              May be woken<small>A handoff or question to it may wake it when it’s idle</small>
            </span>
            <i className={`tg${m.wakes ? ' on' : ''}`} />
          </button>
          <div className="mrow">
            <span className="t">Seat name</span>
            <input
              key={`${s.id}${m.role ?? ''}`}
              defaultValue={m.role ?? ''}
              placeholder="triage, monitor…"
              aria-label="Seat name"
              title="Its role in the project: every member's card shows it"
              onBlur={(e) => e.target.value.trim() !== (m.role ?? '') && void setMember(p.id, s.id, { role: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
          </div>
          <div className="sep" />
        </>
      ) : null}
      <button className="mi bad" onClick={() => (onClose(), void leaveProject(p.id, s.id))}>
        <span className="t">
          Take out of the project<small>The session carries on, outside it</small>
        </span>
      </button>
    </div>
  );
}

/**
 * A team that has never run (just approved, or its members let go before it ran): nothing of it is running, and you
 * didn't stand it down (a team stood down on purpose, its seats all count.min 0, is not something to nag about).
 */
export function teamNotRunning(p: Project, up?: boolean): boolean {
  return !!p.team && !(up ?? p.teamUp) && !p.teamStoodDown && !p.sessions.some((sid) => p.members[sid]?.seat);
}

/** A group in Needs you: its quiet-caps label and count, then its rows (nothing when empty). */
function Group({ label, n, children }: { label: string; n: number; children: React.ReactNode }) {
  if (!n) return null;
  return (
    <>
      <div className="pc-lab">
        {label} <b>{n}</b>
      </div>
      {children}
    </>
  );
}

/**
 * Needs you: what's waiting on your word, grouped and said plainly: wakes
 * to deliver, questions to you, incidents nobody owns, known issues to approve; then what's only worth knowing (posts
 * waiting for a busy session, others' open questions, changes some haven't heard).
 */
export function LoopsPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const sessions = useBrain((s) => s.sessions);
  const wakes = useProjects((s) => s.wakes);
  const [answer, setAnswer] = useState<Record<string, string>>({});
  const { live, refresh } = useTeamLive(p);
  const [teamErr, setTeamErr] = useState<Record<string, string>>({});
  if (!p) return null;
  /** A team action: refresh after it, and say plainly in its row when it failed. */
  const teamAct = (key: string, f: TeamAct) => async () => {
    setTeamErr((e) => ({ ...e, [key]: '' }));
    const o = await teamActOutcome(f);
    const bad = o.problems.length ? o.problems.join(' ') : o.error;
    if (bad) setTeamErr((e) => ({ ...e, [key]: bad }));
    refresh();
  };
  const teamBad = (key: string) => (teamErr[key] ? <div className="tm-bad">{teamErr[key]}</div> : null);
  const who = (by: string) => (by === 'you' || by === 'user' ? 'you' : by === 'cora' ? 'Cora' : sessions[by] ? sessionName(sessions[by]) : 'a session');
  const questions = p.thread.filter((x) => isOpenQuestion(p, x)).reverse();
  const mine = questions.filter((q) => q.to?.includes('user'));
  const others = questions.filter((q) => !q.to?.includes('user'));
  const myWakes = wakes.filter((w) => w.project === p.id);
  const waiting = (p.waiting ?? []).filter((x) => !myWakes.some((w) => w.post === x.post && w.to === x.to));
  // ones Cora can't reach their member with (not running here): its sender was told; they still wait for its next prompt
  const lost = waiting.filter((x) => x.undelivered);
  const waits = waiting.filter((x) => !x.undelivered);
  // a change (or decision) some members haven't heard yet (they hear it on their next prompt)
  const unheard = p.thread
    .filter((x) => (x.kind === 'change' || x.kind === 'decision') && Date.now() - x.at < 3 * 86_400_000)
    .map((x) => ({ x, not: p.sessions.filter((sid) => sid !== x.by && (p.members[sid]?.hears ?? 'nothing') !== 'nothing' && (p.members[sid]?.heardTo ?? 0) < x.at) }))
    .filter((u) => u.not.length)
    .reverse()
    .slice(0, 6);
  // incidents nobody owns, and known issues waiting for your yes
  const unowned = (p.items ?? []).filter((i) => i.kind === 'incident' && itemOpen(i) && !i.owner).sort(bySeverity);
  const proposed = (p.items ?? []).filter((i) => i.kind === 'known' && i.state === 'proposed');
  // the team: a change waiting for you, seats waiting for a restart, seats that won't start
  const team = p.team;
  // a proposal shows even before there's a team (the lead's first one)
  const proposal = live?.proposal ?? p.teamProposal;
  const restart = team ? (live?.restart ?? []) : [];
  const failing = team ? (live?.health ?? []).filter((h) => h.failing) : [];
  const notRunning = !proposal && teamNotRunning(p, live?.up);
  const teamNeeds = (proposal ? 1 : 0) + (notRunning ? 1 : 0) + (restart.length ? 1 : 0) + failing.length;
  const yours = myWakes.length + mine.length + unowned.length + proposed.length + teamNeeds;
  const send = async (q: Post) => {
    const t = answer[q.id]?.trim();
    if (!t) return;
    const r = await postToProject(p.id, 'note', t, { re: q.id, to: q.by !== 'you' && q.by !== 'cora' ? [q.by] : [] });
    if (r.ok) setAnswer((a) => ({ ...a, [q.id]: '' }));
  };
  const close = (q: Post) => (
    <button className="pp-btn" onClick={() => void closeQuestion(p.id, q.id)} title="Nobody needs to answer it">
      Close
    </button>
  );
  return (
    <div className="pc-needs">
      {!yours ? <div className="pc-clear">Nothing waits on you. The crew is working on its own.</div> : null}
      <Group label="Team change proposed" n={proposal ? 1 : 0}>
        {proposal ? (
          <div className="pc-need" style={{ ['--kc' as any]: 'var(--cora)' }}>
            <span className="k">
              <Icon name="Network" size={11} />
            </span>
            <div className="t">
              <b>{who(proposal.by)}</b> proposes a team change: <q>{proposal.why}</q> <em>· {ago(proposal.at)}</em>
              <ChangeLines live={live} />
            </div>
            <div className="acts">
              <button className="pp-btn go" disabled={shownProposal(live, proposal) === null} onClick={() => void teamAct('prop', () => approveTeamProposal(p.id, shownProposal(live, proposal)!))()}>
                Approve
              </button>
              <button className="pp-btn" onClick={() => void teamAct('prop', () => rejectTeamProposal(p.id))()}>
                Reject
              </button>
              <button className="pp-btn" title="See it on the canvas, and edit it before you approve" onClick={() => openBuilder(p.id, { proposal: true })}>
                Open in builder
              </button>
            </div>
            {teamBad('prop')}
          </div>
        ) : null}
      </Group>
      <Group label="Team not running" n={notRunning ? 1 : 0}>
        {notRunning && team ? (
          <div className="pc-need" style={{ ['--kc' as any]: 'var(--cora)' }}>
            <span className="k">
              <Icon name="Network" size={11} />
            </span>
            <div className="t">
              The team is defined (<b>{team.seats.length}</b> {team.seats.length === 1 ? 'seat' : 'seats'}) but none of it is running. Bring it up to start its seats.
            </div>
            <div className="acts">
              <button className="pp-btn go" onClick={() => void teamAct('first-up', () => bringUpTeam(p.id))()}>
                Bring up
              </button>
            </div>
            {teamBad('first-up')}
          </div>
        ) : null}
      </Group>
      <Group label="Restart to apply" n={restart.length ? 1 : 0}>
        {team && restart.length ? (
          <div className="pc-need" style={{ ['--kc' as any]: 'var(--think)' }}>
            <span className="k">
              <Icon name="RotateCw" size={11} />
            </span>
            <div className="t">
              A team change needs <b>{restart.map((r) => seatName(team, r)).join(', ')}</b> to restart before it applies.
            </div>
            <div className="acts">
              <button className="pp-btn go" onClick={() => void teamAct('restart', () => restartTeamSeats(p.id, restart))()}>
                Restart
              </button>
            </div>
            {teamBad('restart')}
          </div>
        ) : null}
      </Group>
      <Group label="Seats failing to start" n={failing.length}>
        {failing.map((h) => (
          <div key={h.seat} className="pc-need" style={{ ['--kc' as any]: 'var(--need)' }}>
            <span className="k">!</span>
            <div className="t">
              <b>{team ? seatName(team, h.seat) : h.seat}</b> is failing to start: {h.lastError ?? 'unknown error'}
            </div>
            <div className="acts">
              <button className="pp-btn go" onClick={() => void teamAct(`up-${h.seat}`, () => bringUpTeam(p.id))()}>
                Bring up
              </button>
            </div>
            {teamBad(`up-${h.seat}`)}
          </div>
        ))}
      </Group>
      <Group label="Wakes" n={myWakes.length}>
        {myWakes.map((w) => (
          <div key={w.id} className="pc-need" style={{ ['--kc' as any]: 'var(--think)' }}>
            <span className="k">
              <Icon name="ArrowUpRight" size={11} />
            </span>
            <div className="t">
              <b>{who(w.from)}</b> wants to wake <b>{who(w.to)}</b> (idle): <q>{w.text}</q> <em>· {ago(w.at)}</em>
            </div>
            <div className="acts">
              <button className="pp-btn go" onClick={() => void answerWake(w.id, true)}>
                Deliver now
              </button>
              <button className="pp-btn" onClick={() => void answerWake(w.id, false)} title="It reaches the session on its next prompt">
                Let it wait
              </button>
            </div>
          </div>
        ))}
      </Group>
      <Group label="Questions to you" n={mine.length}>
        {mine.map((q) => (
          <div key={q.id} className="pc-need" style={{ ['--kc' as any]: 'var(--need)' }}>
            <span className="k">?</span>
            <div className="t">
              <b>{who(q.by)}</b> asks: <q>{q.text}</q> <em>· {ago(q.at)}</em>
            </div>
            <div className="ans">
              <input value={answer[q.id] ?? ''} placeholder="Answer as you…" onChange={(e) => setAnswer((a) => ({ ...a, [q.id]: e.target.value }))} onKeyDown={(e) => e.key === 'Enter' && void send(q)} />
              <button className="pp-btn go" disabled={!answer[q.id]?.trim()} onClick={() => void send(q)}>
                Send
              </button>
              {close(q)}
            </div>
          </div>
        ))}
      </Group>
      <Group label="Incidents nobody owns" n={unowned.length}>
        {unowned.map((i) => (
          <div key={i.id} className="pc-need" style={{ ['--kc' as any]: SEV_COLOR[i.severity ?? 'medium'] }}>
            <span className="k">!</span>
            <div className="t">
              <b>{i.title}</b>, {i.severity ?? 'medium'}. <em>· open {ago(i.openedAt)} · unowned</em>
            </div>
            <div className="acts">
              <select className="pp-btn" value="" onChange={(e) => e.target.value && void itemOp(p.id, 'change', { item: i.id, owner: e.target.value })} title="Give it to a session (it's told)">
                <option value="">Assign to…</option>
                {p.sessions
                  .filter((sid) => sessions[sid])
                  .map((sid) => (
                    <option key={sid} value={sid}>
                      {sessionName(sessions[sid])}
                    </option>
                  ))}
              </select>
            </div>
          </div>
        ))}
      </Group>
      <Group label="Proposed known issues" n={proposed.length}>
        {proposed.map((i) => (
          <div key={i.id} className="pc-need" style={{ ['--kc' as any]: 'var(--cora)' }}>
            <span className="k">
              <Icon name="BookMarked" size={11} />
            </span>
            <div className="t">
              <b>{who(i.openedBy)}</b> proposes: <b>{i.title}</b>.{i.rule ? <> Rule: <q>{i.rule}</q></> : null} <em>· {ago(i.openedAt)}</em>
            </div>
            <div className="acts">
              <button className="pp-btn go" onClick={() => void itemOp(p.id, 'change', { item: i.id, state: 'approved' })} title="It joins every member's project card">
                Approve
              </button>
              <button className="pp-btn" onClick={() => void itemOp(p.id, 'change', { item: i.id, state: 'retired' })}>
                Reject
              </button>
            </div>
          </div>
        ))}
      </Group>
      <Group label="Couldn't be delivered" n={lost.length}>
        {lost.map((x) => {
          const post = p.thread.find((y) => y.id === x.post);
          if (!post) return null;
          return (
            <div key={`${x.post}|${x.to}`} className="pc-need quiet" style={{ ['--kc' as any]: 'var(--need)' }}>
              <span className="k">
                <Icon name="MailX" size={11} />
              </span>
              <div className="t">
                <b>{who(post.by)}</b>'s {post.kind} to <b>{who(x.to)}</b>: <q>{post.text}</q> <em>· waiting {ago(x.since)}; {who(x.to)} isn't running in this Cora, so it gets it only on its next prompt</em>
              </div>
            </div>
          );
        })}
      </Group>
      <Group label="Waiting for a busy session" n={waits.length}>
        {waits.map((x) => {
          const post = p.thread.find((y) => y.id === x.post);
          if (!post) return null;
          return (
            <div key={`${x.post}|${x.to}`} className="pc-need quiet" style={{ ['--kc' as any]: 'var(--run)' }}>
              <span className="k">
                <Icon name="Hourglass" size={11} />
              </span>
              <div className="t">
                <b>{who(post.by)}</b>'s {post.kind} to <b>{who(x.to)}</b>: <q>{post.text}</q> <em>· waiting {ago(x.since)}; it gets it when its turn ends</em>
              </div>
            </div>
          );
        })}
      </Group>
      <Group label="Open questions between them" n={others.length}>
        {others.map((q) => (
          <div key={q.id} className="pc-need quiet" style={{ ['--kc' as any]: KIND_COLOR.question }}>
            <span className="k">?</span>
            <div className="t">
              <b>{who(q.by)}</b> asks {q.to?.length ? <b>{q.to.map(who).join(', ')}</b> : 'the project'}: <q>{q.text}</q> <em>· {ago(q.at)}</em>
            </div>
            <div className="acts">{close(q)}</div>
          </div>
        ))}
      </Group>
      <Group label="Not heard yet" n={unheard.length}>
        {unheard.map(({ x, not }) => (
          <div key={x.id} className="pc-need quiet" style={{ ['--kc' as any]: KIND_COLOR[x.kind] }}>
            <span className="k">·</span>
            <div className="t">
              <b>{who(x.by)}</b>'s {x.kind}: <q>{x.text.slice(0, 140)}</q> <em>· {not.map(who).join(', ')} {not.length === 1 ? 'hears' : 'hear'} it on the next prompt</em>
            </div>
          </div>
        ))}
      </Group>
    </div>
  );
}

/** Shared notes: the project's notes as a pinboard; pinned ones join every member's card. */
export function NotesBoardPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const sessions = useBrain((s) => s.sessions);
  const [q, setQ] = useState('');
  if (!p) return null;
  const who = (by: string) => (by === 'you' ? { name: 'You', color: YOU } : by === 'cora' ? { name: 'Cora', color: 'var(--cora)' } : sessions[by] ? { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) } : { name: 'A session', color: 'var(--ink3)' });
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const notes = p.thread
    .filter((x) => x.kind === 'note' && !x.re && !x.blocked && words.every((w) => `${x.text} ${who(x.by).name}`.toLowerCase().includes(w)))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.at - a.at)
    .slice(0, 60);
  return (
    <div className="pp-notes">
      <input className="pp-search" value={q} placeholder="Search notes…" onChange={(e) => setQ(e.target.value)} />
      {notes.length ? (
        <div className="pp-board">
          {notes.map((x) => {
            const w = who(x.by);
            return (
              <div key={x.id} className={`pp-note${x.pinned ? ' pinned' : ''}`} style={{ ['--sc' as any]: w.color }}>
                <span className="by">
                  {w.name}
                  <time>{ago(x.at)}</time>
                </span>
                <p>{x.text}</p>
                <button className="pin" title={x.pinned ? 'Unpin it' : 'Pin it: it joins every member’s project card'} onClick={() => void pinPost(p.id, x.id, !x.pinned)}>
                  <Icon name={x.pinned ? 'PinOff' : 'Pin'} size={12} />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="pp-empty">{q ? 'No note matches.' : 'No notes yet. Sessions share findings here (a note), and so can you.'}</div>
      )}
    </div>
  );
}

/** The project's conversation: every post, filtered by kind, answers under their question; compose to the project or one member. */
export function ThreadPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  return p ? <Thread p={p} /> : null;
}
const FILTERS: Array<{ k: 'all' | PostKind | 'you' | 'direct'; label: string }> = [
  { k: 'all', label: 'All' },
  { k: 'you', label: 'To you' },
  { k: 'direct', label: 'Direct' },
  { k: 'handoff', label: 'Handoffs' },
  { k: 'question', label: 'Questions' },
  { k: 'report', label: 'Reports' },
  { k: 'change', label: 'Changes' },
  { k: 'decision', label: 'Decisions' },
  { k: 'note', label: 'Notes' },
];
const YOU = '#f472b6';
/**
 * What happened to a post, in words: an open question; or, for a post to members, delivered, held for your OK, waiting
 * for a busy one's turn, not delivered (its member isn't running here), or theirs on the next prompt.
 */
export function postFate(p: Project, x: Post, wakes: ProjectWake[], answered: boolean): { t: string; c: string } | null {
  if (x.blocked) return { t: 'refused: never sent', c: 'refused' };
  if (x.kind === 'question' && !x.native) return x.closed ? { t: 'closed', c: '' } : answered ? { t: 'answered', c: '' } : { t: 'open question', c: 'open' };
  const members = (x.to ?? []).filter((t) => t !== 'user');
  if (!members.length) return null;
  if (wakes.some((y) => y.post === x.id)) return { t: 'held for your OK', c: 'held' };
  const waits = (p.waiting ?? []).filter((y) => y.post === x.id);
  if (waits.some((y) => y.undelivered)) return { t: 'not delivered: not running here', c: 'lost' };
  if (waits.length) return { t: 'waits for its turn', c: 'wait' };
  if (x.deliveredAt) return { t: 'delivered', c: '' };
  if (x.native) return { t: 'sent', c: 'wait' };
  // each member has it once a wake carried it to it, or it has heard past it
  return members.some((t) => !x.deliveredTo?.includes(t) && (p.members[t]?.heardTo ?? 0) < x.at) ? { t: 'on its next prompt', c: 'wait' } : { t: 'delivered', c: '' };
}

function Thread({ p, compact }: { p: Project; compact?: boolean }) {
  const sessions = useBrain((s) => s.sessions);
  const wakes = useProjects((s) => s.wakes);
  const [text, setText] = useState('');
  const [kind, setKind] = useState<PostKind>('note');
  const [to, setTo] = useState('');
  const [re, setRe] = useState<Post | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['k']>('all');
  // your own post being changed: its id and new words
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const who = (by: string) => (by === 'you' || by === 'user' ? { name: by === 'user' ? 'you' : 'You', color: YOU } : by === 'cora' ? { name: 'Cora', color: 'var(--cora)' } : sessions[by] ? { name: sessionName(sessions[by]), color: sessionColor(sessions[by]) } : { name: 'A session', color: 'var(--ink3)' });
  const answers = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const x of p.thread) if (x.re) m.set(x.re, [...(m.get(x.re) ?? []), x]);
    return m;
  }, [p.thread]);
  const shown = p.thread
    .filter((x) => !x.re || !p.thread.some((y) => y.id === x.re))
    .filter((x) => filter === 'all' || (filter === 'you' ? x.to?.includes('user') : filter === 'direct' ? isDirect(x) : x.kind === filter))
    .slice(compact ? -30 : -200);
  const count = (k: PostKind) => p.thread.filter((x) => x.kind === k && (k !== 'question' || isOpenQuestion(p, x))).length;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [shown.length, filter]);
  const state = (x: Post) => postFate(p, x, wakes, answers.has(x.id));
  // a direct message goes to someone: pick who first
  const needsWho = !re && kind === 'direct' && !to;
  const send = async () => {
    if (!text.trim() || needsWho) return;
    const r = await postToProject(p.id, re ? 'note' : kind, text.trim(), { ...(to ? { to: [to] } : re && re.by !== 'you' && re.by !== 'cora' ? { to: [re.by] } : {}), ...(re ? { re: re.id } : {}) });
    if (r.ok) (setText(''), setRe(null));
  };
  const one = (x: Post, nested = false) => {
    const w = who(x.by);
    const st = nested ? null : state(x);
    return (
      <div key={x.id} className={`pp-post${x.to?.includes('user') && !nested ? ' you' : ''}${nested ? ' re' : ''}${x.withdrawn ? ' gone' : ''}${x.blocked ? ' refused' : ''}`} title={x.blocked ? "The team's routes refused this message: it was never sent." : undefined}>
        <span className="pp-av" style={{ ['--sc' as any]: w.color }}>
          {w.name[0]?.toUpperCase()}
        </span>
        <div>
          <span className="who">
            <b style={{ color: `color-mix(in srgb, ${w.color} 80%, white)` }}>{w.name}</b>
            {x.to?.length && !nested ? (
              <span className="to">
                <i>→</i> {x.to.map((t) => who(t).name).join(', ')}
              </span>
            ) : null}
            {nested ? (
              <span className="pp-kind" style={{ ['--kc' as any]: 'var(--ink3)' }}>
                answer
              </span>
            ) : x.native ? (
              <span className="pp-kind" style={{ ['--kc' as any]: 'var(--ink3)' }} title="A message the session sent directly (Claude Code delivered it)">
                direct
              </span>
            ) : x.kind !== 'note' ? (
              <span className="pp-kind" style={{ ['--kc' as any]: KIND_COLOR[x.kind] }}>
                {x.kind}
              </span>
            ) : null}
            {x.pinned ? <Icon name="Pin" size={10} className="pinned" /> : null}
            <time>{new Date(x.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            {x.withdrawn ? <span className="edited">withdrawn</span> : x.editedAt ? <span className="edited" title={`Changed ${new Date(x.editedAt).toLocaleString()}`}>edited</span> : null}
            {!compact && !nested && x.kind === 'question' && !x.closed ? (
              <button className="reply" onClick={() => (setRe(x), setTo(''))} title="Answer it">
                Answer
              </button>
            ) : null}
            {!compact && x.by === 'you' && !x.withdrawn && editing?.id !== x.id ? (
              <>
                <button className="mine" onClick={() => setEditing({ id: x.id, text: x.text })} title="Change its words">
                  Edit
                </button>
                <button className="mine" onClick={() => void editPost(p.id, x.id, null)} title="Take it back: it stays, struck through">
                  Withdraw
                </button>
              </>
            ) : null}
            {st ? <span className={`fate ${st.c}`}>{st.t}</span> : null}
          </span>
          {editing?.id === x.id ? (
            <div className="pp-edit">
              <input
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: x.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditing(null);
                  if (e.key === 'Enter' && editing.text.trim()) void editPost(p.id, x.id, editing.text.trim()).then((r) => r.ok && setEditing(null));
                }}
              />
              <button className="pp-btn" onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          ) : (
            <p>{x.text}</p>
          )}
          {!nested ? answers.get(x.id)?.map((y) => one(y, true)) : null}
        </div>
      </div>
    );
  };
  return (
    <div className="pp-thread">
      {!p.coordination && !compact ? <div className="pp-off">Coordination is off: the sessions don't hear this project. Turn it on in the project's header when they should talk.</div> : null}
      {!compact ? (
        <div className="pp-chips">
          {/* the kinds the thread has (and the one you picked): no chips for what isn't there */}
          {FILTERS.filter((f) => f.k === 'all' || f.k === filter || (f.k === 'you' ? p.thread.some((x) => x.to?.includes('user')) : f.k === 'direct' ? p.thread.some(isDirect) : p.thread.some((x) => x.kind === f.k))).map((f) => {
            const n = f.k === 'question' ? count('question') : 0;
            return (
              <button key={f.k} className={`pp-chip${filter === f.k ? ' on' : ''}`} style={f.k !== 'all' && f.k !== 'you' && f.k !== 'direct' ? { ['--kc' as any]: KIND_COLOR[f.k] } : undefined} onClick={() => setFilter(f.k)}>
                {f.k !== 'all' && f.k !== 'you' && f.k !== 'direct' ? <i /> : null}
                {f.label}
                {n ? <b>{n}</b> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {/* what the dots on its posts mean: only once there are posts */}
      {!compact && p.thread.length ? (
        <div className="pc-legend">
          <span className="ok">delivered</span>
          <span className="wait">waits for its turn</span>
          <span className="held">held for your OK</span>
          <span className="open">open question</span>
        </div>
      ) : null}
      <div className="pp-posts" ref={list}>
        {shown.length ? shown.map((x) => one(x)) : <div className="pp-empty">{filter === 'all' ? 'Nothing yet. Sessions post here when it matters to another; so can you.' : 'Nothing of that kind.'}</div>}
      </div>
      <div className="pp-compose">
        {re ? (
          <button className="pp-re" onClick={() => setRe(null)} title="Not an answer after all">
            Answering {who(re.by).name} <Icon name="X" size={10} />
          </button>
        ) : (
          <select value={kind} onChange={(e) => setKind(e.target.value as PostKind)} title="What it is">
            <option value="note">Note</option>
            <option value="question">Question</option>
            <option value="handoff">Handoff</option>
            {/* (to someone: only where you can pick who) */}
            {!compact ? <option value="direct">Direct</option> : null}
            <option value="decision">Decision</option>
          </select>
        )}
        {!compact && !re ? (
          <select value={to} onChange={(e) => setTo(e.target.value)} title="Who it's for">
            <option value="">To the project</option>
            {p.sessions
              .filter((sid) => sessions[sid])
              .map((sid) => (
                <option key={sid} value={sid}>
                  To {sessionName(sessions[sid])}
                </option>
              ))}
          </select>
        ) : null}
        <input value={text} placeholder={re ? 'Your answer…' : needsWho ? 'Pick who it’s for first…' : kind === 'decision' ? 'A decision the project keeps…' : 'Write to the project…'} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} />
      </div>
    </div>
  );
}

/** The brief (edited in place) and the decisions the project keeps. */
export function BriefPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const [draft, setDraft] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  if (!p) return null;
  const save = () => {
    if (draft != null && draft !== p.brief) void updateProject(p.id, { brief: draft });
    setDraft(null);
  };
  return (
    <div className="pp-brief">
      <textarea value={draft ?? p.brief} placeholder={'The goal, the repos, when it’s done, what not to touch…'} onChange={(e) => setDraft(e.target.value)} onBlur={save} />
      {p.decisions.map((x) => (
        <div key={x.id} className="pp-dec">
          <Icon name="Check" size={12} />
          <span>{x.text}</span>
          <small>{new Date(x.at).toLocaleDateString([], { month: 'short', day: 'numeric' })}</small>
          <button className="pp-x" style={{ width: 20, height: 20 }} title="Take it back" onClick={() => void editDecision(p.id, x.id, null)}>
            <Icon name="X" size={11} />
          </button>
        </div>
      ))}
      <div className="pp-compose" style={{ padding: 0, border: 0 }}>
        <input
          value={adding}
          placeholder="Add a decision…"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && adding.trim()) void postToProject(p.id, 'decision', adding.trim()).then(() => setAdding(''));
          }}
        />
      </div>
    </div>
  );
}

/** Every member's repo, worktree, ticket and pipeline in one list. */
export function ReposPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  return (
    <div className="pp-list">
      {members.map((s) => {
        const repo = s.cwd.split(/[\\/]/).filter(Boolean).pop();
        const wt = s.wd && s.wd !== s.cwd ? s.wd.split(/[\\/]/).filter(Boolean).pop() : null;
        return (
          <div key={s.id} className="pp-li" style={{ ['--sc' as any]: sessionColor(s) }} onClick={() => open(s.id)}>
            <span className="pp-dot" />
            <span className="a">
              <code>{repo}</code>
              {wt ? <> · worktree <code>{wt}</code></> : null}
              {s.ticket ? <> · {s.ticket.key}</> : null}
              {' '}
              <span style={{ color: 'var(--ink4)' }}>({sessionName(s)})</span>
            </span>
            <CiGlyph sessionId={s.id} />
          </div>
        );
      })}
    </div>
  );
}

/** What the members did lately, together: their prompts, replies and tools, newest first. */
export function ActivityPanel({ sessionId }: Props) {
  const p = useBoardProject(sessionId);
  const members = useMembers(p);
  const versions = useBrain((s) => s.versions);
  const items = useMemo(() => {
    const all = members.flatMap((s) =>
      sessionEvents(s.id)
        .filter((e) => e.agentId === 'main' && (e.kind === 'prompt' || e.kind === 'say' || (e.kind === 'tool' && e.phase !== 'start')))
        .slice(-40)
        .map((e) => ({ e, s })),
    );
    return all.sort((a, b) => b.e.ts - a.e.ts).slice(0, 60);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members, members.map((s) => versions[s.id]).join()]);
  if (!p) return null;
  if (!members.length) return <NoMembers />;
  if (!items.length) return <div className="pp-empty">Nothing yet: what the sessions do shows here.</div>;
  return (
    <div className="pp-list">
      {items.map(({ e, s }) => (
        <div key={e.id} className="pp-li" style={{ ['--sc' as any]: sessionColor(s) }} onClick={() => open(s.id)}>
          <span className="pp-dot" />
          <span className="a">
            {e.kind === 'prompt' ? 'Asked: ' : e.kind === 'say' ? '' : `${e.tool?.name ?? 'Tool'}: `}
            {(e.kind === 'tool' ? e.tool?.summary : e.text)?.replace(/\s+/g, ' ').slice(0, 160)}
          </span>
          <small>
            {sessionName(s).slice(0, 18)} · {new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          </small>
        </div>
      ))}
    </div>
  );
}

/** On a member's own board: its project, compact (the brief, and the thread). */
export function ProjectPanel({ sessionId }: Props) {
  const p = useProjectOfSession(sessionId);
  if (!p) return <div className="pp-empty">This session isn't in a project. Its menu (right-click it in the nav) adds it to one.</div>;
  return (
    <div className="pp-thread" style={{ ['--pc' as any]: p.color }}>
      <div className="pp-off" style={{ cursor: 'pointer' }} onClick={() => useBrain.getState().openProject(p.id)} title="Open the project's board">
        <span className="pj-sq sm" /> <b style={{ color: 'var(--ink)' }}>{p.name}</b>
        {p.brief.trim() ? ` · ${p.brief.trim().split('\n')[0].slice(0, 140)}` : ''}
      </div>
      <Thread p={p} compact />
    </div>
  );
}
