import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { NODE_H, NODE_W, fullPath, monitorFiles, applyOverview, buildShape, changeCount, checkTeam, describeTeam, emptyTeam, endpointsOf, groupById, listWords, rebaseTeam, routeName, sameValue, seatById, seatsOf, sessionEffects, snap, traceMessage, type BuilderDraftView, type Endpoint, type LintCtx, type LintTarget, type Pos, type Project, type SessionInfo, type ShapeAnswers, type ShapeKind, type Team, type TeamLayout, type TraceMsg, type TraceStep } from '@cora/shared';
import { approveTeamProposal, rejectTeamProposal, useProject, useProjects } from '../../state/projects';
import { sessionEvents, useBrain } from '../../state/store';
import { applyDraft, closeBuilder, discardDraft, getDraft, missingFolders, proposalDone, putDraft, putLayout, rebaseDraft, received, saved, sayInTalk, setBuilderLeft, startingDraft, talkErrorSeen, undoTurns, useBuilder, type Synced } from '../../state/builder';
import { sessionName } from '../../lib/format';
import { loadSession } from '../../state/ws';
import { seatMembers } from '../board/TeamPanel';
import { Canvas, type SeatState, type TraceMarks } from './Canvas';
import { addSeat, createRoute, deleteSel, editField, groupThem, isTyping, moveMembership, renameEntity, renameInLook, type Sel } from './draftOps';
import { canvasMeasure, flashOf, marksOf, placeNew, proposalMarks, setMeasure, withColors, withPositions, type Flash } from './geometry';
import { Inspector } from './Inspector';
import { Words } from './Words';
import { Talk } from './Talk';
import { builderRunning, sendingGone, sendingStopped, stillSending, suggestions, talkActivity, talkBusy, talkLines, TRY_CHIP, withSending, type Sending } from './talkLines';
import { Strip, TryPanel, type Notice } from './Strip';
import { ApplySheet, ConflictSheet } from './Sheets';
import { StartSheet } from './StartSheet';
import { markTourSeen, Tour, tourSeen, TOUR } from './Tour';
import './builder.css';

export type Prop = { team: Team; at: number; edited: boolean };
type TraceState = { form: TraceMsg; steps: TraceStep[]; shown: number; continuedAt: number[]; reached: string | null; marks: TraceMarks | null; dot: { route: string; from: number; key: number } | null; flash: boolean; then: boolean };
type Summary = { text: string; tone: '' | 'ok' | 'bad' };
const NO_TRACE: Omit<TraceState, 'form'> = { steps: [], shown: 0, continuedAt: [], reached: null, marks: null, dot: null, flash: false, then: false };
const LEFT_KEY = 'cora.builder.left';
const NOT_SENDING: Sending[] = [];

/** How the builder opens: a lead's proposal (a draft on the current team), the draft kept on the server or the team as it is, or the start sheet. */
export function openingState(p: Project, draft: BuilderDraftView | null | undefined, proposal: boolean): { sync: Synced | null; prop: Prop | null; sheet: 'start' | null } {
  const prop = proposal && p.teamProposal ? { team: p.teamProposal.team, at: p.teamProposal.at, edited: false } : null;
  const sync = startingDraft(p, draft);
  return { sync, prop, sheet: !prop && !sync ? 'start' : null };
}
const liveMembers = (p: Project, sessions: Record<string, SessionInfo>, id: string) => seatMembers(p, id).map((sid) => sessions[sid]).filter((s): s is SessionInfo => !!s && s.state !== 'ended');
/** A seat's state on its tile's corner, as in Crew; a seat not applied yet has none. */
export function seatStateOf(p: Project, base: Team | undefined, sessions: Record<string, SessionInfo>, id: string): SeatState {
  if (!base?.seats.some((s) => s.id === id)) return 'none';
  const live = liveMembers(p, sessions, id);
  if (!live.length) return 'down';
  return live.some((s) => s.state === 'working' || s.state === 'thinking') ? 'work' : 'idle';
}
/** Usually idle (for the checks' ask-route warning): it has members running, and every one is idle. */
export function usuallyIdle(p: Project, sessions: Record<string, SessionInfo>, id: string): boolean {
  const live = liveMembers(p, sessions, id);
  return live.length > 0 && live.every((s) => s.state === 'idle');
}
/** Where a new seat works: the team's first seat's folder, else a member session's, else nothing yet (the checks ask for one). */
export function defaultFolder(p: Project, sessions: Record<string, SessionInfo>, team: Team | null): string {
  return team?.seats[0]?.folder.path || p.sessions.map((sid) => sessions[sid]?.cwd).find((c): c is string => !!c) || '';
}
const firstLabels = (r?: { labels?: Record<string, string[]> }) => Object.fromEntries(Object.entries(r?.labels ?? {}).filter(([, v]) => v.length).map(([k, v]) => [k, v[0]]));
/** A few example messages for Try a message, along the team's own first routes. */
export function traceExamples(t: Team): Array<[string, TraceMsg]> {
  return t.routes
    .slice(0, 3)
    .map((r): [string, TraceMsg] => {
      const f = r.from[0];
      const from = (f.startsWith('group:') ? `seat:${seatsOf(t, f.slice(6))[0] ?? ''}` : f) as Endpoint;
      return [routeName(t, r), { from, to: r.to, kind: r.kinds === 'any' ? 'direct' : r.kinds[0], labels: firstLabels(r) }];
    })
    .filter(([, m]) => m.from !== 'seat:');
}
/** Then what?: a reply from the seat it reached, along its first route out (none: to you). */
export function thenForm(t: Team, seat: string): TraceMsg {
  const eps = endpointsOf(t, `seat:${seat}`);
  const r = t.routes.find((x) => x.from.some((f) => eps.includes(f)));
  return { from: `seat:${seat}`, to: r ? r.to : 'user', kind: r && r.kinds !== 'any' ? r.kinds[0] : 'direct', labels: firstLabels(r) };
}

/** What clashed when theirs came in, with who "they" were (Cora, or another edit of yours); each line ends saying yours was kept. */
export function clashWords(lines: string[], by: string): string[] {
  const who = by === 'cora' ? 'Cora' : 'another edit';
  // only the words after the label ("Seat Triage, instructions: they set …"): the values quoted after them stay as they are
  return lines.map((l) => l.replace(/: (they|you both) /, (_m, w: string) => (w === 'they' ? `: ${who} ` : `: ${who} and you both `)));
}
/** A lead's proposal on screen moved on elsewhere: replaced by a newer one (shown now), or approved or rejected (the team as it is now). */
export function proposalMoved(prop: Prop, now: Project['teamProposal']): { prop: Prop | null; note: string } | null {
  if (now && now.at === prop.at) return null;
  const lost = prop.edited ? ' Your edits to it were not kept.' : '';
  if (now) return { prop: { team: now.team, at: now.at, edited: false }, note: `The lead sent a new proposal; this is it now.${lost}` };
  return { prop: null, note: `The lead's proposal was approved, rejected or set aside (the team changed) elsewhere; this is the team as it is now.${lost}` };
}
/** The draft went (applied, or thrown away): the team as it is now, with your unsent edits put back on top. */
export function draftGone(s: Synced | null, p: Pick<Project, 'team'>): Synced | null {
  if (!s || sameValue(s.mine, s.server)) return startingDraft(p, null);
  const theirs = p.team ?? emptyTeam(s.base);
  const r = rebaseTeam(s.server, theirs, s.mine);
  return { rev: 0, base: theirs.version, server: theirs, mine: r.team, conflicts: [...s.conflicts, ...r.conflicts] };
}
/**
 * Your edits on their way to the server: one PUT at a time, sent a quarter second after the last edit (and at most a
 * second and a half after the first, while you keep typing). `run` sends what's on screen and says whether something
 * is still unsent (refused as stale: put on top of the live draft, so it goes again).
 */
export function draftSender(run: () => Promise<boolean>, wait = 250, maxWait = 1500) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  let busy = false;
  let again = false;
  const now = async (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    if (busy) return void (again = true);
    busy = true;
    first = 0;
    let more = false;
    try {
      more = await run();
    } catch {
      more = false;
    } finally {
      busy = false;
    }
    if (more || again) {
      again = false;
      poke();
    }
  };
  const poke = () => {
    const t = Date.now();
    if (!first) first = t;
    clearTimeout(timer);
    timer = setTimeout(() => void now(), Math.max(0, Math.min(wait, first + maxWait - t)));
  };
  return { poke, now, busy: () => busy };
}
/** Said when the draft moved on (Cora changed it) after you opened Apply: what you reviewed isn't what's there now. */
export const DRAFT_MOVED = 'The draft changed since you opened this; review it again.';
/**
 * What Apply sends: the revision you reviewed (recorded when the sheet opened, once your edits were saved), never the
 * one there at the click. Refused here when an edit of yours isn't on the server, or the draft moved on since you
 * opened the sheet (`seen`: the revision you're looking at now, to apply on the next click).
 */
export function applyRev(s: Synced | null, opened: number | null, saveErr: string): { rev: number } | { error: string; seen?: number } {
  if (!s) return { error: 'There is no draft to apply.' };
  // what's applied is the draft on the server: an edit that didn't reach it would be left out
  if (!sameValue(s.mine, s.server)) return { error: saveErr ? `Your last edit isn't saved (${saveErr.replace(/[.\s]+$/, '')}), so nothing was applied.` : 'Your last edit is still on its way, so nothing was applied. Apply again in a moment.' };
  if (opened === null) return { error: 'Your edits are still being saved. Apply again in a moment.' };
  if (s.rev !== opened) return { error: DRAFT_MOVED, seen: s.rev };
  return { rev: opened };
}
/**
 * The team moved on since the draft was made (Cora's edit, a rollback, an approval) and the draft has edits on it: what
 * it changes can't be read against the team as it is now, so Apply shows what changed under it and rebases first.
 */
export function draftMoved(s: Synced | null, version: number): boolean {
  return !!s && s.rev > 0 && s.base !== version;
}
/** Back from a lead's proposal you edited: asked first (the edits stay on this screen only). Null: nothing to ask. */
export function leavingAsk(prop: Prop | null): string | null {
  return prop?.edited ? "Leave the lead's proposal? Your edits to it are only on this screen, so they'll be lost." : null;
}
/** Talk in proposal mode: off, and why. */
export const TALK_OFF_PROPOSAL = "Talk edits your draft; you're looking at the lead's proposal.";
/** `f` in `ms`, its timeout held in `waits` (to clear on closing) until it runs. */
export function waitIn(waits: number[], ms: number, f: () => void): void {
  const id = window.setTimeout(() => {
    const i = waits.indexOf(id);
    if (i >= 0) waits.splice(i, 1);
    f();
  }, ms);
  waits.push(id);
}
const warn = (text: string): Notice => ({ text, level: 'warn' });
const info = (text: string): Notice => ({ text, level: 'info' });
export type KeyAct = 'tour-next' | 'tour-end' | 'blur' | 'deselect' | 'delete' | null;
/** What a key does on the builder: the tour's keys while it shows; nothing under a sheet (it has its own); Delete only when you aren't typing. */
export function keyAction(key: string, s: { tour: boolean; sheet: boolean; typing: boolean; sel: boolean }): KeyAct {
  if (s.tour) return key === 'Escape' ? 'tour-end' : key === 'Enter' || key === 'ArrowRight' ? 'tour-next' : null;
  if (s.sheet) return null;
  if (key === 'Escape') return s.typing ? 'blur' : 'deselect';
  if (s.typing) return null;
  return (key === 'Delete' || key === 'Backspace') && s.sel ? 'delete' : null;
}
/** A refusal in plain words: its problems, the server's own words, or that Cora isn't answering. */
export function plainError(r: { ok?: boolean; error?: string; problems?: string[] }, after = 'Nothing changed.'): string {
  if (r.problems?.length) return r.problems.join(' ');
  if (!r.error) return 'That did not work.';
  return /failed to fetch|networkerror|load failed|failed \(5\d\d\)/i.test(r.error) ? `Cora isn't answering.${after ? ` ${after}` : ''}` : r.error;
}
export type FolderCheck = { missing: string[]; notRepo: string[]; missingFiles: string[]; note: string };
/**
 * The folder check's answer (null: no folders to check): the folders not on this PC and the ones not git repositories,
 * or, not checked, none (an earlier check's warnings may be wrong now) and a note saying so.
 */
export function folderCheck(r: { ok: boolean; missing?: string[]; notRepo?: string[]; missingFiles?: string[] } | null): FolderCheck {
  if (!r) return { missing: [], notRepo: [], missingFiles: [], note: '' };
  return r.ok ? { missing: r.missing ?? [], notRepo: r.notRepo ?? [], missingFiles: r.missingFiles ?? [], note: '' } : { missing: [], notRepo: [], missingFiles: [], note: "The seats' folders couldn't be checked on this PC just now." };
}
/** A layout save's answer, for the strip: nothing when it saved, else why (the next move saves it again). */
export function layoutNote(r: { ok?: boolean; error?: string }): string {
  return r.ok ? '' : `Where the seats are drawn wasn't saved: ${plainError(r, '')}`;
}
/** What an Apply did, for the strip: its version, who restarts when you say, or what came up (a bring-up that failed after the team was applied is reported, not a failed apply). */
export function appliedOutcome(r: { ok?: boolean; version?: number; restart?: string[]; started?: string[]; upProblems?: string[]; problems?: string[] }, bringUp: boolean, team: Team): { sum: string; tone: 'ok' | 'bad'; notes: Notice[] } {
  const as = `Applied as v${r.version}`;
  const n = r.started?.length ?? 0;
  const sessions = `${n} session${n === 1 ? '' : 's'} started`;
  // what the running team couldn't take (its files not written, a seat added that didn't start)
  const didnt = (r.problems ?? []).map((x) => warn(`Didn't take: ${x}`));
  if (bringUp && r.upProblems?.length) return { sum: `${as}, but it didn't all come up (see Checks)`, tone: 'bad', notes: [info(n ? `${sessions}.` : 'Nothing started.'), ...didnt, ...r.upProblems.map((x) => warn(`Didn't come up: ${x}`))] };
  if (didnt.length) return { sum: `${as}, but not all of it took (see Checks)`, tone: 'bad', notes: [...(bringUp ? [info(n ? `${sessions}.` : 'Nothing started.')] : []), ...didnt] };
  if (bringUp) return { sum: `${as} and brought up${n ? `: ${sessions}` : ''}`, tone: 'ok', notes: [] };
  const restarts = (r.restart ?? []).map((sid) => seatById(team, sid)?.name ?? sid);
  return { sum: `${as}${restarts.length ? `: ${listWords(restarts)} ${restarts.length > 1 ? 'restart' : 'restarts'} when you say (Team panel)` : ''}`, tone: 'ok', notes: [] };
}

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}
/** The left panel's width you dragged it to, kept per browser (none: the default, by the window's width). */
export const LEFT_W_KEY = 'cora.builder.leftWidth';
export const LEFT_W_MIN = 240;
type WidthStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): WidthStore | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
/** At least 240px, at most half the builder (a builder too narrow for both: 240). */
export function clampLeftWidth(w: number, total: number): number {
  return Math.round(Math.max(LEFT_W_MIN, Math.min(w, total / 2)));
}
export function loadLeftWidth(s: WidthStore | undefined = storage()): number | null {
  try {
    const n = Number(s?.getItem(LEFT_W_KEY));
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}
/** Kept for next time; null forgets it (the default again). */
export function saveLeftWidth(w: number | null, s: WidthStore | undefined = storage()): void {
  try {
    if (w === null) s?.removeItem(LEFT_W_KEY);
    else s?.setItem(LEFT_W_KEY, String(Math.round(w)));
  } catch {
    /* storage refused: it's the default next time */
  }
}
/** The left column at the width kept, clamped by CSS as the builder's own width changes (collapsed, or none kept: the stylesheet's). */
export function leftWidthStyle(w: number | null, open: boolean): Record<string, string> | undefined {
  return w && open ? { '--lw': `max(${LEFT_W_MIN}px, min(${Math.round(w)}px, 50%))` } : undefined;
}
/**
 * A drag of the left panel's edge, from where the pointer went down: the width follows it (clamped); it ends however
 * the pointer goes (let go, cancelled, its capture lost) or when the returned stop is called (the builder going away),
 * once, with the width it ended on (null: it never moved). While it lasts, `root` says so (the cursor everywhere).
 */
export function leftDrag(el: EventTarget, o: { x0: number; w0: number; total: number; root: { dataset: Record<string, string | undefined> }; onMove(w: number): void; onDone(w: number | null): void }): () => void {
  let w: number | null = null;
  let over = false;
  const move = (ev: Event) => {
    w = clampLeftWidth(o.w0 + (ev as PointerEvent).clientX - o.x0, o.total);
    o.onMove(w);
  };
  const ends = ['pointerup', 'pointercancel', 'lostpointercapture'];
  const stop = () => {
    if (over) return;
    over = true;
    el.removeEventListener('pointermove', move);
    for (const t of ends) el.removeEventListener(t, stop);
    delete o.root.dataset.tbDrag;
    o.onDone(w);
  };
  o.root.dataset.tbDrag = '1';
  el.addEventListener('pointermove', move);
  for (const t of ends) el.addEventListener(t, stop);
  return stop;
}
/** The left panel's edge from the keyboard: arrows move it 16px (Shift: 64), Home and End to the least and the most; null: not its key. */
export function leftKeyWidth(key: string, shift: boolean, w: number, total: number): number | null {
  const step = shift ? 64 : 16;
  if (key === 'ArrowLeft' || key === 'ArrowRight') return clampLeftWidth(w + (key === 'ArrowLeft' ? -step : step), total);
  if (key === 'Home') return clampLeftWidth(0, total);
  if (key === 'End') return clampLeftWidth(Infinity, total);
  return null;
}

const leftAtStart = () => {
  try {
    const v = localStorage.getItem(LEFT_KEY);
    if (v === '1' || v === '0') return v === '1';
  } catch {
    /* storage refused: by the window's width */
  }
  return typeof window === 'undefined' || window.innerWidth >= 1240;
};
const chev = (d: string) => (
  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
    <path d={d} />
  </svg>
);

/**
 * The team builder: a full view in place of the project's,
 * with Talk and In words on the left, the canvas, the inspector, and the strip. Every edit, yours or Cora's, changes one
 * draft kept on the server; nothing reaches the project's team until Apply (or, for a lead's proposal, Approve).
 */
export function BuilderView({ id, proposal }: { id: string; proposal?: boolean }) {
  const p = useProject(id);
  const sessions = useBrain((s) => s.sessions);
  const serverDraft = useBuilder((s) => s.drafts[id]);
  // back to a builder still open (or opened from a view that already asked): the draft known here draws at once, then
  // the server's answer comes in as any newer draft does
  const [seed] = useState(() => {
    const known = useBuilder.getState().drafts[id];
    return p && known !== undefined ? openingState(p, known, !!proposal) : null;
  });
  const seeded = useRef(!!seed);
  const syncRef = useRef<Synced | null>(seed?.sync ?? null);
  const [sync, setSyncState] = useState<Synced | null>(syncRef.current);
  const setSync = useCallback((f: Synced | null | ((s: Synced | null) => Synced | null)) => {
    const next = typeof f === 'function' ? f(syncRef.current) : f;
    syncRef.current = next;
    setSyncState(next);
  }, []);
  const [loaded, setLoaded] = useState(!!seed);
  const [prop, setProp] = useState<Prop | null>(seed?.prop ?? null);
  const propRef = useRef(prop);
  propRef.current = prop;
  const [look, setLook] = useState<TeamLayout>(() => {
    const l = p?.teamLayout ?? { pos: {} };
    const t = seed?.prop?.team ?? seed?.sync?.mine;
    return t ? withColors(withPositions(l, t), t) : l;
  });
  const [sel, setSel] = useState<Sel>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [clashes, setClashes] = useState<string[]>([]);
  const [saveNote, setSaveNote] = useState('');
  const saveErr = useRef('');
  const [loadErr, setLoadErr] = useState('');
  const [reload, setReload] = useState(0);
  // opened on a lead's proposal: until it's approved, rejected or gone (then the draft or the team, as any other opening)
  const asProposal = useRef(!!proposal);
  const acting = useRef(false);
  // the draft's revision when you opened Apply (your edits saved first): what you reviewed, and what Apply sends
  const opened = useRef<number | null>(null);
  const [applied, setApplied] = useState<Summary | null>(null);
  const [left, setLeftState] = useState<'talk' | 'words'>(() => useBuilder.getState().open[id]?.left ?? 'words');
  const setLeft = (l: 'talk' | 'words') => {
    setLeftState(l);
    setBuilderLeft(id, l);
  };
  const [leftOpen, setLeftOpen] = useState(leftAtStart);
  const [leftW, setLeftW] = useState<number | null>(() => loadLeftWidth());
  const mainRef = useRef<HTMLDivElement>(null);
  const [hovI, setHovI] = useState<number | null>(null);
  const [tab, setTab] = useState<'checks' | 'try'>('checks');
  const [sheet, setSheet] = useState<null | 'apply' | 'conflict' | 'start'>(seed?.sheet ?? null);
  const [conflict, setConflict] = useState<{ theirs: string[]; conflicts: string[]; problems: string[]; to: number } | null>(null);
  const [banner, setBanner] = useState('');
  const [busy, setBusy] = useState(false);
  const [sheetErr, setSheetErr] = useState('');
  const [flash, setFlash] = useState<Flash | null>(null);
  const [fitKey, setFitKey] = useState(0);
  const [focusName, setFocusName] = useState(0);
  const [talkFocus, setTalkFocus] = useState(0);
  // (a reason that came while you were elsewhere shows at once)
  const [talkErr, setTalkErr] = useState(() => useBuilder.getState().talkErrors[id]?.text ?? '');
  const [talkNote, setTalkNote] = useState('');
  const [tour, setTour] = useState<number | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [folderNote, setFolderNote] = useState('');
  const [notRepo, setNotRepo] = useState<string[]>([]);
  const [missingFiles, setMissingFiles] = useState<string[]>([]);
  const [tr, setTr] = useState<TraceState>({ form: { from: 'user', to: 'user', kind: 'direct', labels: {} }, ...NO_TRACE });
  const timers = useRef<number[]>([]);
  const waits = useRef<number[]>([]);
  const raf = useRef(0);
  const saveTimer = useRef(0);
  const after = (ms: number, f: () => void) => waitIn(waits.current, ms, f);
  const fresh = () => useProjects.getState().projects.find((x) => x.id === id);

  const base = p?.team;
  // (the draft couldn't be loaded: nothing to edit, so nothing is drawn over a draft that may be there)
  const team = loadErr ? null : (prop?.team ?? sync?.mine ?? null);
  const v = base?.version ?? 0;
  const startTour = () => {
    setLeftOpen(true);
    setLeft('words');
    setTour(0);
  };

  // theirs taken in: Cora's change flashes and her new seats go where the layout puts them; what clashed with yours is
  // said in the checks, in plain words (yours was kept)
  const takeIn = (prev: Synced | null, next: Synced | null, by: string) => {
    if (by === 'cora' && prev && next) {
      const to = next.mine;
      setFlash(flashOf(prev.mine, to, performance.now()));
      setLook((l) => placeNew(prev.mine, to, l));
    }
    if (next?.conflicts.length) {
      setClashes(clashWords(next.conflicts, by));
      next = { ...next, conflicts: [] };
    }
    setSync(next);
  };

  // your edits go to the server (debounced, one at a time); refused as stale: put back on top of the live draft and sent again
  const sendNow = async (): Promise<boolean> => {
    const s = syncRef.current;
    if (!s || propRef.current || sameValue(s.mine, s.server)) return false;
    const sent = s.mine;
    const r = await putDraft(id, sent, s.rev, s.base);
    if (r.ok && r.draft) {
      setSync((x) => (x ? saved(x, sent, r.draft!) : x));
      saveErr.current = '';
      setSaveNote('');
    } else {
      const cur = syncRef.current;
      const proj = fresh();
      const next = r.draft ? received(cur, r.draft) : r.draft === null && proj ? draftGone(cur, proj) : cur;
      if (next !== cur) takeIn(cur, next, r.draft?.by ?? 'you');
      // the draft moved on since this was sent (the refusal brought the live one, or it came in meanwhile): yours goes again
      // on top; otherwise (refused for itself, or no answer) it stops and says why
      if (!next || (next.rev === s.rev && next.base === s.base)) {
        saveErr.current = plainError(r, '');
        setSaveNote(`Your last edit isn't saved yet: ${saveErr.current}`);
        return false;
      }
    }
    const now = syncRef.current;
    return !!now && !sameValue(now.mine, now.server);
  };
  const sendRef = useRef(sendNow);
  sendRef.current = sendNow;
  const sender = useMemo(() => draftSender(() => sendRef.current()), []);
  // before Apply: everything you typed is on the server
  const flush = async () => {
    saveErr.current = '';
    for (let i = 0; i < 8 && syncRef.current && !sameValue(syncRef.current.mine, syncRef.current.server) && !saveErr.current; i++) {
      if (sender.busy()) await new Promise((r) => setTimeout(r, 120));
      else await sender.now();
    }
  };
  // where the seats are drawn isn't part of the team: a save that fails is said (the next move saves it again)
  const [lookNote, setLookNote] = useState('');
  const saveLook = (l: TeamLayout) => {
    clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => void putLayout(id, l).then((r) => setLookNote(layoutNote(r))), 600);
  };
  // closing the builder: what's waiting goes now; the trace, the timers and Tidy's easing stop
  useEffect(
    () => () => {
      void sender.now();
      timers.current.forEach(clearTimeout);
      waits.current.forEach(clearTimeout);
      cancelAnimationFrame(raf.current);
    },
    [sender],
  );
  // opening something else asks first when your edits to a lead's proposal would be lost (as Back does)
  useEffect(() => {
    const text = leavingAsk(prop);
    useBuilder.setState((s) => (text ? { leaveAsk: { project: id, text } } : s.leaveAsk?.project === id ? { leaveAsk: null } : s));
  }, [prop, id]);
  useEffect(() => () => useBuilder.setState((s) => (s.leaveAsk?.project === id ? { leaveAsk: null } : s)), [id]);

  // open: the draft from the server (it survives a reload), else the team, else the start sheet; the screen's own measure
  useEffect(() => {
    const proj = fresh();
    if (!proj) return;
    let gone = false;
    const m = canvasMeasure();
    if (m) setMeasure(m);
    void getDraft(id).then((r) => {
      if (gone) return;
      // not loaded is not "no draft": the start sheet never goes over a draft that may be there
      if (!r.ok) return setLoadErr(`Couldn't load the draft: ${plainError(r, '')}`);
      setLoadErr('');
      const draft = r.draft ?? null;
      useBuilder.getState().apply({ t: 'builder', project: id, draft });
      // drawn from what was known: the answer came in above as any newer draft does (unless the start sheet showed
      // and there is a draft after all: then it opens as usual)
      const wasSeeded = seeded.current;
      seeded.current = false;
      if (wasSeeded && !(seed?.sheet === 'start' && draft)) {
        if (!tourSeen() && !seed?.sheet) after(350, () => !gone && startTour());
        return;
      }
      const o = openingState(proj, draft, asProposal.current);
      setSync(o.sync);
      setProp(o.prop);
      setSheet(o.sheet);
      const t = o.prop?.team ?? o.sync?.mine;
      if (t) setLook(withColors(withPositions(proj.teamLayout ?? { pos: {} }, t), t));
      setLoaded(true);
      setFitKey((k) => k + 1);
      if (!tourSeen() && !o.sheet) after(350, () => !gone && startTour());
    });
    void document.fonts?.ready.then(() => {
      const mm = canvasMeasure();
      if (mm && !gone) (setMeasure(mm), setFitKey((k) => k + 1));
    });
    return () => {
      gone = true;
    };
    // (again once the project is known: the projects list can arrive after the view opens; and on Try again, or after a proposal)
  }, [id, !!p, reload]); // eslint-disable-line react-hooks/exhaustive-deps
  // after a lead's proposal (approved, rejected, gone): the draft or the team, or the start sheet when there's neither
  // (and from then on it's the draft's builder: coming back doesn't open a later proposal in its place)
  const reopen = () => {
    asProposal.current = false;
    setProp(null);
    setReload((k) => k + 1);
    proposalDone(id);
  };
  // opened the other way while it's open (its draft, or the lead's proposal): this screen follows, without what the
  // other way had said; your edits to the draft are sent first
  useEffect(() => {
    if (!!proposal === asProposal.current) return;
    setApplied(null);
    setNotices([]);
    setClashes([]);
    setBanner('');
    setSheet(null);
    setSel(null);
    // the other team's traced path (and a trace still running) doesn't carry over; nor does the seeded first draw
    clearTrace();
    seeded.current = false;
    if (!proposal) return reopen();
    void flush().then(() => {
      asProposal.current = true;
      setReload((k) => k + 1);
    });
  }, [proposal]); // eslint-disable-line react-hooks/exhaustive-deps
  // the proposal on screen moved on elsewhere (approved, rejected, replaced): said, and the screen follows
  useEffect(() => {
    if (!prop || !p || acting.current) return;
    const m = proposalMoved(prop, p.teamProposal);
    if (!m) return;
    // never approve one you didn't review: an open Approve sheet closes
    setSheet(null);
    setNotices([warn(m.note)]);
    if (m.prop) setProp(m.prop);
    else reopen();
  }, [p?.teamProposal?.at, !!p?.teamProposal]); // eslint-disable-line react-hooks/exhaustive-deps

  // the server's draft came in: Cora's change flashes, her new seats go where the layout puts them; yours, unsent, stay on top
  useEffect(() => {
    if (!loaded || serverDraft === undefined || prop) return;
    const prev = syncRef.current;
    if (serverDraft === null) {
      const proj = fresh();
      if (prev && prev.rev > 0 && proj) takeIn(prev, draftGone(prev, proj), 'you');
      return;
    }
    const next = received(prev, serverDraft);
    if (next === prev) return;
    takeIn(prev, next, serverDraft.by);
    if (!sameValue(next.mine, next.server)) sender.poke();
  }, [serverDraft, loaded]); // eslint-disable-line react-hooks/exhaustive-deps
  // the team moved on (applied, approved) and nothing of yours is pending: show it as it is now
  useEffect(() => {
    const s = syncRef.current;
    if (loaded && p?.team && s && s.rev === 0 && sameValue(s.mine, s.server) && s.base !== p.team.version) setSync(startingDraft(p, null));
  }, [p?.team?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 3400);
    return () => clearTimeout(t);
  }, [flash]);
  // every seat has a place and a colour
  const seatKey = team?.seats.map((s) => s.id).join(',') ?? '';
  useEffect(() => {
    if (team) setLook((l) => withColors(withPositions(l, team), team));
  }, [seatKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // the checks (debounced), In words, folders that aren't on this PC (or aren't git repositories, for a seat that wants a worktree)
  const folders = [...new Set((team?.seats ?? []).map((s) => s.folder?.path?.trim()).filter((x): x is string => !!x))].join('|');
  const trees = [...new Set((team?.seats ?? []).filter((s) => s.folder?.worktree).map((s) => s.folder.path?.trim()).filter((x): x is string => !!x))].join('|');
  // the files seats' monitors read (the checks warn about one that isn't there and nothing makes)
  const files = [...new Set((team?.seats ?? []).flatMap((s) => monitorFiles(s).map((f) => f.path)).filter((x) => fullPath(x)))].join('|');
  useEffect(() => {
    const take = (c: FolderCheck) => (setMissing(c.missing), setNotRepo(c.notRepo), setMissingFiles(c.missingFiles), setFolderNote(c.note));
    if (!folders && !files) return void take(folderCheck(null));
    const split = (x: string) => (x ? x.split('|') : []);
    const t = setTimeout(() => void missingFolders(id, split(folders), split(trees), split(files)).then((r) => take(folderCheck(r))), 400);
    return () => clearTimeout(t);
  }, [folders, trees, files, id]);
  const ctx: LintCtx = useMemo(() => ({ folderExists: (path) => !missing.includes(path), gitRepo: (path) => !notRepo.includes(path), fileExists: (path) => !missingFiles.includes(path), usuallyIdle: (sid) => !!p && usuallyIdle(p, sessions, sid) }), [missing, notRepo, missingFiles, sessions, p]);
  const later = useDebounced(team, 120);
  const checks = useMemo(() => (later ? checkTeam(later, ctx) : []), [later, ctx]);
  const words = useMemo(() => (team ? describeTeam(team, ctx) : []), [team, ctx]);

  // Talk: the builder session's events, as Cora's console reads hers
  const bsid = p?.builderSession ?? serverDraft?.session ?? null;
  const evVersion = useBrain((s) => (bsid ? s.versions[bsid] : 0));
  useEffect(() => {
    if (bsid) void loadSession(bsid);
  }, [bsid]);
  const evs = useMemo(() => (bsid ? sessionEvents(bsid) : []), [bsid, evVersion]); // eslint-disable-line react-hooks/exhaustive-deps
  const said = useMemo(() => talkLines(evs, serverDraft?.turns ?? []), [evs, serverDraft?.turns]);
  // what you sent shows at once (sending…) until her conversation has it, and she shows as working meanwhile
  // (kept with the builder's other state in the store: it's still on its way while you're elsewhere)
  const sending = useBuilder((s) => s.sending[id] ?? NOT_SENDING);
  const setSending = useCallback(
    (f: (s: Sending[]) => Sending[]) =>
      useBuilder.setState((st) => {
        const was = st.sending[id] ?? NOT_SENDING;
        const next = f(was);
        return next === was ? st : { sending: { ...st.sending, [id]: next } };
      }),
    [id],
  );
  useEffect(() => setSending((s) => (s.length ? stillSending(s, said) : s)), [said]);
  // words on their way too long (Cora restarted while her session was starting): given up on, and said
  useEffect(() => {
    if (!sending.length) return;
    const t = setInterval(() => {
      const gone = sendingGone(sending, Date.now());
      if (!gone.length) return;
      setSending((s) => s.filter((x) => !gone.some((g) => g.id === x.id)));
      setTalkErr("What you said didn't reach Cora (her session didn't start in time). Say it again.");
    }, 5000);
    return () => clearInterval(t);
  }, [sending]);
  const lines = useMemo(() => withSending(said, sending), [said, sending]);
  // her session stopped (ended, killed): she isn't drafting, and what you said while she ran won't reach her
  const running = useBrain((s) => builderRunning(s.terminals, bsid));
  useEffect(() => setSending((s) => sendingStopped(s, running)), [running, setSending]);
  const inTurn = talkBusy(evs, running);
  const coraBusy = inTurn || sending.length > 0;
  // what she's doing in her turn (none while what you sent is still on its way to her)
  const activity = (now: number) => (inTurn ? talkActivity(evs, now) : null);
  // what you said didn't reach Cora's session (it didn't start, it ended): the server says why, and it isn't on its way
  // any more; once shown it's done with (coming back doesn't say it again, nor take back what you sent since)
  const told = useBuilder((s) => s.talkErrors[id]);
  useEffect(() => {
    if (!told) return;
    setTalkErr(told.text);
    setSending(() => NOT_SENDING);
    talkErrorSeen(id);
  }, [told]); // eslint-disable-line react-hooks/exhaustive-deps
  const say = async (text: string) => {
    setTalkErr('');
    await sayInTalk(id, text, { live: builderRunning(useBrain.getState().terminals, bsid), why: (r) => plainError(r, '') });
  };
  const undo = async (ids: string[]) => {
    setTalkNote('');
    const r = await undoTurns(id, ids);
    if (!r.ok) setTalkNote(`That Undo didn't work: ${plainError(r, '')}`);
  };

  // edits: one draft, yours and Cora's (a proposal's edits stay on this screen until you approve); the screen changes at once, the server hears after
  const edit = (next: Team, notice?: string) => {
    if (prop) setProp({ ...prop, team: next, edited: true });
    else {
      setSync((s) => (s ? { ...s, mine: next } : { rev: 0, base: v, server: base ?? emptyTeam(v), mine: next, conflicts: [] }));
      sender.poke();
    }
    setNotices(notice ? [info(notice)] : []);
    setApplied(null);
  };
  const onEdit = (path: string, value: unknown) => team && edit(editField(team, sel, path, value));
  const onRename = (name: string) => {
    if (!team || !sel || sel.kind === 'route') return;
    const old = sel.ids[0];
    // the id follows the name until the seat or group has been applied (it's in the team the draft is on)
    const kept = sel.kind === 'seat' ? !!(base && seatById(base, old)) : !!(base && groupById(base, old));
    const r = renameEntity(team, sel.kind, old, name, kept);
    edit(r.team);
    if (r.id !== old) {
      setSel({ kind: sel.kind, ids: [r.id] });
      setLook((l) => renameInLook(l, old, r.id));
    }
  };
  const onDelete = () => {
    if (!team || !sel) return;
    const r = deleteSel(team, sel);
    edit(r.team, r.notice || undefined);
    setSel(null);
  };
  const onGroupThem = () => {
    if (!team || sel?.kind !== 'seat') return;
    const r = groupThem(team, sel.ids);
    edit(r.team);
    setSel({ kind: 'group', ids: [r.id] });
  };
  const onLink = (from: Endpoint, to: Endpoint) => {
    if (!team) return;
    const r = createRoute(team, from, to);
    edit(r.team);
    setSel({ kind: 'route', ids: [r.id] });
  };
  const onMove = (l: TeamLayout, done: boolean) => {
    setLook(l);
    if (done) saveLook(l);
  };
  const onDrop = (sid: string, d: { into: string } | { out: true }) => {
    if (!team) return;
    const r = moveMembership(team, sid, d);
    edit(r.team, r.notice);
  };
  const onAddSeat = (at?: Pos) => {
    if (!p) return;
    const r = addSeat(team ?? emptyTeam(v), defaultFolder(p, sessions, team));
    edit(r.team);
    const pt = at ?? { x: 0, y: 0 };
    const l = withColors({ ...look, pos: { ...look.pos, [r.id]: { x: snap(pt.x - NODE_W / 2), y: snap(pt.y - NODE_H / 2) } } }, r.team);
    setLook(l);
    saveLook(l);
    setSel({ kind: 'seat', ids: [r.id] });
    setFocusName((k) => k + 1);
  };
  const pick = (t?: LintTarget) => {
    if (!t) return;
    setSel(t.kind === 'team' ? null : { kind: t.kind, ids: [t.id] });
  };
  const isSelected = (t?: LintTarget) => !!t && t.kind !== 'team' && !!sel && sel.kind === t.kind && sel.ids.includes(t.id);
  // a selection whose thing is gone: nothing selected
  useEffect(() => {
    if (!sel || !team) return;
    const there = sel.kind === 'seat' ? sel.ids.every((x) => seatById(team, x)) : sel.kind === 'group' ? !!groupById(team, sel.ids[0]) : team.routes.some((r) => r.id === sel.ids[0]);
    if (!there) setSel(null);
  }, [team, sel]);

  // Tidy: the automatic layout again, eased into place, then framed
  const tidy = () => {
    if (!team) return;
    const to = withPositions({ ...look, pos: {} }, team);
    const from = look.pos;
    const t0 = performance.now();
    const step = (now: number) => {
      const q = Math.min(1, (now - t0) / 260);
      const e = 1 - Math.pow(1 - q, 3);
      const pos: TeamLayout['pos'] = {};
      for (const k of Object.keys(to.pos)) {
        const a = from[k] ?? to.pos[k];
        pos[k] = { x: a.x + (to.pos[k].x - a.x) * e, y: a.y + (to.pos[k].y - a.y) * e };
      }
      setLook((l) => ({ ...l, pos }));
      if (q < 1) raf.current = requestAnimationFrame(step);
      else {
        const fin = { ...look, pos: to.pos };
        setLook(fin);
        saveLook(fin);
        setFitKey((k) => k + 1);
      }
    };
    raf.current = requestAnimationFrame(step);
  };

  // the start sheet: a shape's answers, Blank, or Build with Cora
  const build = (kind: ShapeKind | 'blank', a: ShapeAnswers) => {
    if (!p) return;
    const t = buildShape(kind, a, { folder: defaultFolder(p, sessions, team), version: v });
    edit(t);
    setClashes([]);
    const l = withColors(withPositions({ pos: {} }, t), t);
    setLook(l);
    saveLook(l);
    setSel(null);
    setSheet(null);
    setLeft('words');
    setFitKey((k) => k + 1);
    if (!tourSeen()) after(350, startTour);
  };
  const startTalk = () => {
    const t = emptyTeam(v);
    edit(t);
    setClashes([]);
    setLook(withColors(withPositions({ pos: {} }, t), t));
    setSheet(null);
    setLeft('talk');
    setLeftOpen(true);
    setTalkFocus((k) => k + 1);
  };
  // the left panel's edge: drag to resize (the column follows as you drag; the width is kept when you let go), double-click for the default
  const endDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => endDrag.current?.(), []);
  const keepLeftW = (w: number) => {
    setLeftW(w);
    saveLeftWidth(w);
  };
  const gripDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    const main = mainRef.current;
    const aside = el.parentElement;
    if (!main || !aside) return;
    endDrag.current?.();
    el.setPointerCapture(e.pointerId);
    endDrag.current = leftDrag(el, {
      x0: e.clientX,
      w0: aside.getBoundingClientRect().width,
      total: main.clientWidth,
      root: document.documentElement,
      onMove: (w) => main.style.setProperty('--lw', leftWidthStyle(w, true)!['--lw']),
      // (a click that didn't move keeps what was there)
      onDone: (w) => {
        endDrag.current = null;
        if (w !== null) keepLeftW(w);
      },
    });
  };
  const gripKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const main = mainRef.current;
    const aside = e.currentTarget.parentElement;
    if (!main || !aside) return;
    const w = leftKeyWidth(e.key, e.shiftKey, aside.getBoundingClientRect().width, main.clientWidth);
    if (w === null) return;
    e.preventDefault();
    keepLeftW(w);
  };
  const gripReset = () => {
    mainRef.current?.style.removeProperty('--lw');
    setLeftW(null);
    saveLeftWidth(null);
  };
  const toggleLeft = (open: boolean) => {
    setLeftOpen(open);
    try {
      localStorage.setItem(LEFT_KEY, open ? '1' : '0');
    } catch {
      /* storage refused: it opens by the window's width next time */
    }
  };

  // Try a message: the steps appear one by one, the path lights up, a dot travels the route
  useEffect(() => {
    if (!team) return;
    const known = (e: string) => e === 'user' || e === 'cora' || seatById(team, e.slice(5)) || groupById(team, e.slice(6));
    if (!known(tr.form.from) || !known(tr.form.to) || (tr.form.from === 'user' && tr.form.to === 'user')) {
      const ex = traceExamples(team)[0];
      if (ex) setTr((x) => ({ ...x, form: ex[1] }));
    }
  }, [seatKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const runTrace = (form: TraceMsg = tr.form, cont: boolean = tr.then) => {
    if (!team) return;
    timers.current.forEach(clearTimeout);
    timers.current = [];
    const res = traceMessage(team, form);
    const go = cont && tr.steps.length > 0;
    const startAt = go ? tr.steps.length : 0;
    const marks: TraceMarks = { routes: new Set(), seats: new Set(), groups: new Set(), from: form.from.startsWith('seat:') ? form.from.slice(5) : null };
    setTr((x) => ({ ...x, steps: go ? [...x.steps, ...res.steps] : res.steps, shown: startAt, continuedAt: go ? [...x.continuedAt, startAt] : [], reached: null, marks, flash: false, then: false }));
    res.steps.forEach((s, i) =>
      timers.current.push(
        window.setTimeout(() => {
          if (s.route) marks.routes.add(s.route);
          if (s.mark) (s.mark.kind === 'group' ? marks.groups : marks.seats).add(s.mark.id);
          if (s.blocked) marks.blocked = s.blocked;
          setTr((x) => ({ ...x, shown: startAt + i + 1, marks: { ...marks }, ...(s.route ? { dot: { route: s.route, from: s.from ?? 0, key: Date.now() } } : {}), ...(i === res.steps.length - 1 ? { reached: res.reached } : {}) }));
        }, 120 + i * 520),
      ),
    );
  };
  const thenWhat = () => {
    if (!team || !tr.reached || !seatById(team, tr.reached)) return;
    setTr((x) => ({ ...x, form: thenForm(team, x.reached!), flash: true, then: true, reached: null }));
    after(900, () => setTr((x) => ({ ...x, flash: false })));
  };
  const clearTrace = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setTr((x) => ({ form: x.form, ...NO_TRACE }));
  };

  // Apply (or Approve), only on your click; a refused one's rebase; Reject
  const doApply = async (bringUp: boolean) => {
    if (!team || !p) return;
    setBusy(true);
    setSheetErr('');
    try {
      if (prop) {
        acting.current = true;
        const r = await approveTeamProposal(id, prop.at, prop.edited ? prop.team : undefined).finally(() => (acting.current = false));
        if (!r.ok) return setSheetErr(plainError(r));
        setSheet(null);
        setClashes([]);
        setApplied({ text: `Approved as v${r.version}${r.edited ? ', with your edits' : ''}${r.problems?.length ? ', but not all of it took (see Checks)' : ''}`, tone: r.problems?.length ? 'bad' : 'ok' });
        reopen();
        if (r.problems?.length) setNotices(r.problems.map((x) => warn(`Didn't take: ${x}`)));
        return;
      }
      await flush();
      const a = applyRev(syncRef.current, opened.current, saveErr.current);
      if ('error' in a) {
        // the draft moved on while the sheet was open: it shows what's there now, and the next click applies that
        if (a.seen !== undefined) opened.current = a.seen;
        return setSheetErr(a.error);
      }
      const r = await applyDraft(id, a.rev, bringUp);
      if (r.conflict) return void (await showConflict(r.version ?? v));
      if (!r.ok) {
        if (r.rev !== undefined) {
          const g = await getDraft(id);
          if (g.draft) takeIn(syncRef.current, received(syncRef.current, g.draft), g.draft.by);
          opened.current = syncRef.current?.rev ?? null;
          return setSheetErr(DRAFT_MOVED);
        }
        return setSheetErr(plainError(r));
      }
      const o = appliedOutcome(r, bringUp, team);
      setApplied({ text: o.sum, tone: o.tone });
      setNotices(o.notes);
      saveErr.current = '';
      setSaveNote('');
      setClashes([]);
      setSheet(null);
      setBanner('');
      setSel(null);
    } finally {
      setBusy(false);
    }
  };
  const doRebase = async () => {
    setBusy(true);
    const r = await rebaseDraft(id, false);
    setBusy(false);
    if (!r.ok || !r.draft) {
      if (r.problems?.length && conflict) return setConflict({ ...conflict, problems: r.problems });
      setSheet(null);
      return setNotices([warn(`Rebasing didn't work: ${plainError(r)}`)]);
    }
    takeIn(syncRef.current, received(syncRef.current, r.draft), 'you');
    opened.current = r.draft.rev;
    setBanner(`Rebased onto v${r.draft.base}.${r.conflicts?.length ? ` ${r.conflicts.length} conflict${r.conflicts.length > 1 ? 's' : ''}: yours kept.` : ' No conflicts.'} Review it, then apply.`);
    setSheetErr('');
    setSheet('apply');
  };
  // what changed under the draft and what clashes: the sheet that rebases it
  const showConflict = async (to: number) => {
    const d = await rebaseDraft(id, true);
    if (!d.ok && !d.theirs) {
      setSheet('apply');
      return setSheetErr(plainError(d));
    }
    setConflict({ theirs: d.theirs ?? [], conflicts: d.conflicts ?? [], problems: d.problems ?? [], to });
    setSheet('conflict');
  };
  // Apply opened: your edits saved first, and the revision you're reviewing recorded (Apply sends it, never a later one)
  const openApply = async () => {
    setSheetErr('');
    // the team moved on under the draft: what changed, and the rebase, first (the sheet would read against the wrong team)
    if (!prop && draftMoved(syncRef.current, v)) {
      setBusy(true);
      try {
        await flush();
        await showConflict(v);
      } finally {
        setBusy(false);
      }
      return;
    }
    setSheet('apply');
    if (prop) return;
    opened.current = null;
    setBusy(true);
    try {
      await flush();
    } finally {
      setBusy(false);
    }
    opened.current = syncRef.current?.rev ?? null;
  };
  // the draft thrown away (and Cora's session for it ended): the team as it is now, or the start sheet
  const doDiscard = async () => {
    setBusy(true);
    // what's unsent goes with it (nothing of yours is sent after it)
    setSync((s) => (s ? { ...s, mine: s.server } : s));
    const r = await discardDraft(id).finally(() => setBusy(false));
    setSheet(null);
    if (!r.ok) return setNotices([warn(`Discarding the draft didn't work: ${plainError(r)}`)]);
    saveErr.current = '';
    setSaveNote('');
    setClashes([]);
    setBanner('');
    setSel(null);
    setNotices([info(base ? `Draft discarded; this is v${v} as it is.` : 'Draft discarded.')]);
    reopen();
  };
  const back = () => {
    const ask = leavingAsk(prop);
    if (ask && !window.confirm(ask)) return;
    closeBuilder(id);
  };
  const doReject = async () => {
    if (!prop) return;
    acting.current = true;
    const r = await rejectTeamProposal(id).finally(() => (acting.current = false));
    if (!r.ok) return setNotices([warn(`Rejecting didn't work: ${plainError(r)}`)]);
    setApplied({ text: "Rejected the lead's proposal; the lead is told", tone: 'ok' });
    reopen();
  };

  // the tour, Delete, Escape (never while you type, nor under a sheet)
  const endTour = () => {
    setTour(null);
    markTourSeen();
    document.querySelectorAll('.tourhint').forEach((n) => n.classList.remove('tourhint'));
  };
  const nextTour = () => {
    if (tour === null) return;
    if (tour >= TOUR.length - 1) endTour();
    else setTour(tour + 1);
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const a = keyAction(e.key, { tour: tour !== null, sheet: !!sheet, typing: isTyping(document.activeElement), sel: !!sel });
      if (a === 'tour-end') endTour();
      else if (a === 'tour-next') (e.preventDefault(), nextTour());
      else if (a === 'blur') (document.activeElement as HTMLElement).blur();
      else if (a === 'deselect') setSel(null);
      else if (a === 'delete') (e.preventDefault(), onDelete());
    };
    document.addEventListener('keydown', on);
    return () => document.removeEventListener('keydown', on);
  });

  if (!p) return null;
  const n = team ? changeCount(base, team) : 0;
  const errs = checks.filter((c) => c.level === 'error').length;
  const leadName = p.teamProposal && sessions[p.teamProposal.by] ? sessionName(sessions[p.teamProposal.by]) : 'the lead';
  const moved = !prop && draftMoved(sync, v);
  const verText = prop ? `Proposal from the lead (${leadName}) · v${v} → v${v + 1}${prop.edited ? ' · edited by you' : ''}` : moved ? `Team v${v} · your draft is on v${sync!.base}` : `${base ? `Team v${v}` : 'No team yet'} · ${n ? 'draft' : 'no changes'}`;
  const sum: Summary = applied ?? (errs ? { text: `Fix ${errs} error${errs > 1 ? 's' : ''} to ${prop ? 'approve' : 'apply'}`, tone: 'bad' } : moved ? { text: `The team moved to v${v}: Apply rebases your draft first`, tone: '' } : { text: n ? `${n} change${n > 1 ? 's' : ''} since v${v}` : 'Nothing to apply', tone: '' });
  const hov = hovI !== null && words[hovI] ? marksOf(words[hovI].targets) : null;
  const marks = prop ? proposalMarks(base, prop.team) : null;
  const stateOf = (sid: string) => seatStateOf(p, base, sessions, sid);
  const locked = !!sheet || tour !== null;
  const done = tr.steps.length > 0 && tr.shown >= tr.steps.length;

  return (
    <div className="tb" style={{ ['--pc' as string]: p.color } as CSSProperties}>
      <header className="top">
        <button className="iconbtn" title="Back to the project" onClick={back}>
          {chev('M8.5 3 4.5 7l4 4')}
        </button>
        <span className="sq" />
        <b>{p.name}</b>
        <span className="vsep" />
        <span className={`ver${prop ? ' prop' : ''}`}>{verText}</span>
        <span className="sp" />
        <button className="iconbtn help" title="Show me around (the tour)" onClick={startTour}>
          ?
        </button>
        <button className="btn" title="Start from a shape (replaces the draft)" disabled={!!prop || !!loadErr} onClick={() => setSheet('start')}>
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 7a4.5 4.5 0 1 0 1.4-3.3" />
            <path d="M2.5 2v2.7h2.7" />
          </svg>
          Start over
        </button>
        <button className="btn" title="Frame everything" onClick={() => setFitKey((k) => k + 1)}>
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 5V2h3M9 2h3v3M12 9v3H9M5 12H2V9" />
          </svg>
          Fit
        </button>
        <button className="btn" title="Lay it out again, left to right" onClick={tidy}>
          <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round">
            <path d="M2 3.5h4M2 7h4M2 10.5h4M9 5.2h3M9 8.8h3" />
          </svg>
          Tidy
        </button>
      </header>
      <div ref={mainRef} className={`main${leftOpen ? '' : ' wc'}`} style={leftWidthStyle(leftW, leftOpen) as CSSProperties | undefined}>
        <aside className="words" data-tour="left">
          {leftOpen ? (
            <>
              <div className="lgrip" tabIndex={0} role="separator" aria-orientation="vertical" aria-label="Resize Talk and In words (arrow keys)" aria-valuemin={LEFT_W_MIN} aria-valuenow={leftW ?? undefined} title="Drag to resize · double-click for the default" onPointerDown={gripDown} onKeyDown={gripKey} onDoubleClick={gripReset} />
              <div className="wh">
                <button className={`tab${left === 'talk' ? ' on' : ''}`} onClick={() => setLeft('talk')}>
                  Talk
                </button>
                <button className={`tab${left === 'words' ? ' on' : ''}`} onClick={() => setLeft('words')}>
                  In words
                </button>
                <span className="n" />
                <button className="iconbtn" title="Collapse" onClick={() => toggleLeft(false)}>
                  {chev('M8.5 3 4.5 7l4 4')}
                </button>
              </div>
              <div className="lbody">
                {left === 'words' ? (
                  <Words lines={words} sel={sel} onHover={setHovI} onPick={pick} />
                ) : (
                  <Talk lines={lines} busy={coraBusy} activity={activity} off={prop ? TALK_OFF_PROPOSAL : undefined} offline={talkErr} chips={team ? suggestions(team, checks) : []} onSend={(t) => void say(t)} note={talkNote} onUndo={(ids) => void undo(ids)} onChip={(c) => (c === TRY_CHIP ? setTab('try') : void say(c))} focusKey={talkFocus} />
                )}
              </div>
            </>
          ) : (
            <button className="wtab" title="Open" onClick={() => toggleLeft(true)}>
              {chev('M5.5 3 9.5 7l-4 4')}
              <span>{left === 'talk' ? 'Talk · In words' : 'In words · Talk'}</span>
            </button>
          )}
        </aside>
        {loadErr ? (
          <section className="cv" data-tour="canvas">
            <div className="loaderr">
              <span>{loadErr}</span>
              <button className="btn" onClick={() => setReload((k) => k + 1)}>
                Try again
              </button>
            </div>
          </section>
        ) : team ? (
          <Canvas team={team} look={look} sel={sel} hov={hov} flash={flash} trace={tab === 'try' ? tr.marks : null} marks={marks} stateOf={stateOf} fitKey={fitKey} dot={tr.dot} busy={coraBusy} locked={locked} onSelect={setSel} onLink={onLink} onMove={onMove} onDrop={onDrop} onAddSeat={onAddSeat} onGroupThem={onGroupThem} />
        ) : (
          <section className="cv" data-tour="canvas" />
        )}
        {team ? <Inspector team={team} base={base} sel={sel} look={look} projectName={p.name} version={v} stateOf={stateOf} focusName={focusName} onEdit={onEdit} onTeam={(t) => edit(t)} onRename={onRename} onDelete={onDelete} onGroupThem={onGroupThem} /> : <aside className="insp" />}
      </div>
      <Strip
        tab={tab}
        onTab={setTab}
        checks={checks}
        notices={[...clashes.map(warn), ...(saveNote ? [warn(saveNote)] : []), ...(lookNote ? [warn(lookNote)] : []), ...(folderNote ? [info(folderNote)] : []), ...notices]}
        isSelected={isSelected}
        onPickCheck={pick}
        sum={sum}
        applyLabel={prop ? 'Approve' : 'Apply'}
        applyDisabled={!team || !!errs || (!n && !moved)}
        applyTitle={errs ? 'Fix the errors in Checks first' : !n ? 'The draft is the same as the team' : ''}
        onApply={() => void openApply()}
        onReject={prop ? () => void doReject() : undefined}
        tryPanel={team ? <TryPanel team={team} form={tr.form} onForm={(f) => setTr((x) => ({ ...x, form: f }))} shown={tr.steps.slice(0, tr.shown)} continuedAt={tr.continuedAt} done={done} canThen={done && !!tr.reached && !!seatById(team, tr.reached) && !tr.then} flash={tr.flash} onRun={() => runTrace()} onThen={thenWhat} onClear={clearTrace} examples={traceExamples(team)} onExample={(m) => (setTr((x) => ({ ...x, form: m, then: false })), runTrace(m, false))} /> : null}
      />
      {sheet === 'start' ? <StartSheet name={p.name} version={v} coraDown={!!talkErr} onCora={startTalk} onBuild={build} onClose={() => setSheet(null)} onDiscard={serverDraft && !prop ? () => void doDiscard() : undefined} busy={busy} /> : null}
      {sheet === 'apply' && team ? (
        <ApplySheet
          title={prop ? "Approve the lead's proposal" : 'Apply the draft'}
          sub={`${p.name} · v${v} → v${v + 1}${prop ? ` · proposed by ${leadName}` : ''}`}
          banner={banner || undefined}
          overview={applyOverview(base, team)}
          effects={p.teamUp ? sessionEffects(base, team) : null}
          note={prop ? (prop.edited ? 'You edited it: the approval records that you changed it.' : '') : `Saved with v${sync?.base ?? v} as its base; if the team changed meanwhile, you can rebase.`}
          tag={prop ? 'Approve' : 'Apply'}
          colorOf={(sid) => look.color?.[sid] ?? '#94a3b8'}
          busy={busy}
          error={sheetErr || undefined}
          onCancel={() => setSheet(null)}
          onApply={(b) => void doApply(b)}
        />
      ) : null}
      {sheet === 'conflict' && conflict ? <ConflictSheet from={sync?.base ?? v} to={conflict.to} theirs={conflict.theirs} conflicts={conflict.conflicts} problems={conflict.problems} busy={busy} onCancel={() => setSheet(null)} onRebase={() => void doRebase()} /> : null}
      {tour !== null ? <Tour step={tour} onNext={nextTour} onSkip={endTour} /> : null}
    </div>
  );
}
