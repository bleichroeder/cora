import { create } from 'zustand';
import { useEffect } from 'react';
import { rebaseTeam, sameValue, type BuilderDraftView, type BuilderMsg, type Project, type Team, type TeamLayout } from '@cora/shared';
import { call, createProject, P, useProjects, type TeamEdited } from './projects';
import { useBrain } from './store';
import { ago } from '../lib/format';
import type { Sending } from '../components/builder/talkLines';

/**
 * The team builder: which projects have their builder open
 * (shown in place of the project's view whenever that project is open), and each project's draft as the server
 * publishes it. Going to another session, project or the Overview leaves a builder open, and Cora keeps drafting; only
 * its Back closes it. Kept per window, in memory: after a reload a draft shows as Continue on its project.
 */
export type LeaveAsk = { project: string; text: string };
export type BuilderOpen = { proposal?: true; /** the left panel's tab, as you left it */ left?: 'talk' | 'words' };
/**
 * `talkErrors`: per project, the last time what you said in Talk didn't reach Cora (each one a new object, so it shows again).
 * `sending`: per project, what you said in Talk that her conversation doesn't show yet (kept while you're elsewhere).
 * `leaveAsk`: what to ask before leaving the project whose builder set it (edits on its screen that would be lost); null: nothing to ask.
 */
export const useBuilder = create<{ open: Record<string, BuilderOpen>; drafts: Record<string, BuilderDraftView | null>; talkErrors: Record<string, { text: string }>; sending: Record<string, Sending[]>; leaveAsk: LeaveAsk | null; apply(m: BuilderMsg): void }>((set) => ({
  open: {},
  drafts: {},
  talkErrors: {},
  sending: {},
  leaveAsk: null,
  apply: (m) => set((s) => ({ drafts: { ...s.drafts, [m.project]: m.draft }, ...(m.talkError ? { talkErrors: { ...s.talkErrors, [m.project]: { text: m.talkError } } } : {}) })),
}));
/** The builder shown in place of the open project's view, if it has one open. */
export function builderShown(open: Record<string, BuilderOpen>, projectOpen: string | null): BuilderOpen | null {
  return projectOpen && Object.hasOwn(open, projectOpen) ? open[projectOpen] : null;
}
const without = <T,>(r: Record<string, T>, k: string): Record<string, T> => {
  if (!Object.hasOwn(r, k)) return r;
  const { [k]: _gone, ...rest } = r;
  return rest;
};

/** The builder in place of the project's view (a lead's proposal: `proposal`). */
export function openBuilder(project: string, o: { proposal?: boolean } = {}): void {
  // the same project's builder the other way (its draft, or the proposal): what this one would lose is asked first
  const { open, leaveAsk } = useBuilder.getState();
  const was = open[project];
  const other = !!was && !was.proposal !== !o.proposal;
  if (other && leaveAsk?.project === project && !window.confirm(leaveAsk.text)) return;
  useBrain.getState().openProject(project);
  // (you chose to stay in the builder that was open)
  if (useBrain.getState().projectOpen !== project) return;
  // already open this way: as you left it
  if (was && !other) return;
  // (the other way round: on the tab you were on)
  useBuilder.setState((s) => ({ open: { ...s.open, [project]: { ...(o.proposal ? { proposal: true as const } : {}), ...(was?.left ? { left: was.left } : {}) } } }));
}
/** A new project, straight into its builder (at its start sheet: there's no team yet). */
export async function createWithTeam(name: string): Promise<Project | null> {
  const p = await createProject(name);
  if (p) openBuilder(p.id);
  return p;
}
/** The builder's Back: the project's view again; its builder session rests until you talk again (the draft stays). */
export function closeBuilder(project: string): void {
  if (!Object.hasOwn(useBuilder.getState().open, project)) return;
  // what didn't reach Cora, and what was on its way to her session (it rests), are old news the next time it opens
  useBuilder.setState((s) => ({ open: without(s.open, project), talkErrors: without(s.talkErrors, project), sending: without(s.sending, project), ...(s.leaveAsk?.project === project ? { leaveAsk: null } : {}) }));
  void call('POST', `${P(project)}/builder/close`, {}).then((r) => !r.ok && console.warn(`builder: Cora's session wasn't told the builder closed: ${r.error ?? 'no answer'}`));
}
/** What you said in Talk didn't reach Cora, and that has been shown: it isn't said again when you come back. */
export function talkErrorSeen(project: string): void {
  useBuilder.setState((s) => (Object.hasOwn(s.talkErrors, project) ? { talkErrors: without(s.talkErrors, project) } : s));
}
/**
 * Your words to Cora from Talk: shown at once as sending (kept while you're elsewhere); refused: taken back and the
 * reason kept to show (here, or when you come back); taken: an older reason is old news.
 */
export async function sayInTalk(project: string, text: string, o: { live: boolean; why(r: { ok: boolean; error?: string }): string }): Promise<void> {
  const mine: Sending = { id: `sending:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, text, at: Date.now(), ...(o.live ? { live: true as const } : {}) };
  useBuilder.setState((s) => ({ sending: { ...s.sending, [project]: [...(s.sending[project] ?? []), mine] } }));
  const r = await talkToBuilder(project, text);
  if (r.ok) return talkErrorSeen(project);
  useBuilder.setState((s) => ({ sending: { ...s.sending, [project]: (s.sending[project] ?? []).filter((x) => x.id !== mine.id) }, talkErrors: { ...s.talkErrors, [project]: { text: o.why(r) } } }));
}
/** The lead's proposal on screen was approved or rejected there: from then on it's the draft's builder (on the same tab). */
export function proposalDone(project: string): void {
  useBuilder.setState((s) => {
    const o = s.open[project];
    if (!o?.proposal) return s;
    const { proposal: _was, ...rest } = o;
    return { open: { ...s.open, [project]: rest } };
  });
}
/** The builder's left panel tab, kept for when you come back. */
export function setBuilderLeft(project: string, left: 'talk' | 'words'): void {
  useBuilder.setState((s) => (Object.hasOwn(s.open, project) && s.open[project].left !== left ? { open: { ...s.open, [project]: { ...s.open[project], left } } } : s));
}
// another project (or a session, or the Overview) opened: the builder stays open behind it, unless it shows a lead's
// proposal you edited, whose edits live only on screen: asked first (No: it stays in front; a session picked stays the
// focus behind it, so the question isn't asked again). A session going away never reaches this: watchSessions moves the
// focus with `stay`.
let reverting = false;
useBrain.subscribe((s, prev) => {
  const { leaveAsk, open } = useBuilder.getState();
  const was = prev.projectOpen;
  // (putting it back in front below isn't a leaving of its own)
  if (reverting || !was || s.projectOpen === was || leaveAsk?.project !== was || !builderShown(open, was)) return;
  if (!window.confirm(leaveAsk.text)) {
    reverting = true;
    try {
      useBrain.setState({ projectOpen: was, overview: false });
    } finally {
      reverting = false;
    }
    return;
  }
  useBuilder.setState({ leaveAsk: null });
});
// a project archived or removed: its builder isn't open any more (the server rested or ended its session), and
// what was on its way or went wrong there is gone with it
useProjects.subscribe((s, prev) => {
  if (s.projects === prev.projects) return;
  const { open, sending, talkErrors } = useBuilder.getState();
  const gone = [...new Set([...Object.keys(open), ...Object.keys(sending), ...Object.keys(talkErrors)])].filter((pid) => !s.projects.some((p) => p.id === pid && !p.archivedAt));
  if (!gone.length) return;
  useBuilder.setState((b) => ({ open: gone.reduce(without, b.open), sending: gone.reduce(without, b.sending), talkErrors: gone.reduce(without, b.talkErrors) }));
});

type Draft = { ok: boolean; error?: string; draft?: BuilderDraftView | null };
export const getDraft = (pid: string) => call('GET', `${P(pid)}/builder`) as Promise<Draft>;
/** your edit: the whole draft on the revision you have (a newer one there: refused, 409, with the live draft) */
export const putDraft = (pid: string, team: Team, rev: number, base?: number) => call('PUT', `${P(pid)}/builder`, { team, rev, ...(base !== undefined ? { base } : {}) }) as Promise<Draft>;
export const discardDraft = (pid: string) => call('DELETE', `${P(pid)}/builder`);
export const undoTurns = (pid: string, turns: string[]) => call('POST', `${P(pid)}/builder/undo`, { turns }) as Promise<Draft>;
/** after a refused apply: what changed under you and the conflicts (`dry`), or the rebase itself (with `draft`) */
export const rebaseDraft = (pid: string, dry: boolean) => call('POST', `${P(pid)}/builder/rebase`, { dry }) as Promise<{ ok: boolean; error?: string; theirs?: string[]; conflicts?: string[]; problems?: string[]; draft?: BuilderDraftView }>;
/** Apply (and bring up); 409 `conflict`: the team changed meanwhile; 409 `rev`: the draft changed; `upProblems`: it is applied but did not all start */
export const applyDraft = (pid: string, rev: number, bringUp: boolean) => call('POST', `${P(pid)}/builder/apply`, { rev, bringUp }) as Promise<TeamEdited & { conflict?: boolean; rev?: number; started?: string[]; upProblems?: string[] }>;
export const talkToBuilder = (pid: string, text: string) => call('POST', `${P(pid)}/builder/talk`, { text });
export const putLayout = (pid: string, layout: TeamLayout) => call('PUT', `${P(pid)}/team/layout`, { layout });
/** the folders not on this PC, and those of `worktrees` (folders a seat wants a worktree of) that aren't git repositories */
export const missingFolders = (pid: string, paths: string[], worktrees: string[] = [], files: string[] = []) => call('POST', `${P(pid)}/builder/folders`, { paths, worktrees, files }) as Promise<{ ok: boolean; missing?: string[]; notRepo?: string[]; missingFiles?: string[] }>;


/** The draft as this screen holds it: the server's last word (its revision and team), what's on screen, and what clashed when theirs came in. */
export type Synced = { rev: number; base: number; server: Team; mine: Team; conflicts: string[] };

/** Where the builder starts: the draft kept on the server (it survives a reload), else the team as it is, else nothing (the start sheet). */
export function startingDraft(p: Pick<Project, 'team'>, d: BuilderDraftView | null | undefined): Synced | null {
  if (d) return { rev: d.rev, base: d.base, server: d.team, mine: d.team, conflicts: [] };
  if (p.team) return { rev: 0, base: p.team.version, server: p.team, mine: p.team, conflicts: [] };
  return null;
}
/** The server's draft came in: a newer one replaces ours, your unsent edits put back on top of it (what clashed is kept in `conflicts`). */
export function received(s: Synced | null, d: BuilderDraftView): Synced {
  if (!s) return { rev: d.rev, base: d.base, server: d.team, mine: d.team, conflicts: [] };
  if (d.rev <= s.rev && d.base === s.base) return s;
  // a stale message (older revision, other base) never lowers the revision
  if (d.rev < s.rev) return s;
  const pending = !sameValue(s.mine, s.server);
  const r = pending ? rebaseTeam(s.server, d.team, s.mine) : { team: d.team, conflicts: [] as string[] };
  return { rev: d.rev, base: d.base, server: d.team, mine: r.team, conflicts: [...s.conflicts, ...r.conflicts] };
}
/** Your edit was saved as `d`: the server's word now, unless you typed more since (or a newer draft came in while it was on its way). */
export function saved(s: Synced, sent: Team, d: BuilderDraftView): Synced {
  if (d.rev < s.rev) return s;
  const same = sameValue(s.mine, sent);
  return { rev: d.rev, base: d.base, server: d.team, mine: same ? d.team : s.mine, conflicts: same ? [] : s.conflicts };
}

/** What a project's view says about a team draft in progress (null: there's none, or it's the same as the team). */
export function draftInProgress(d: BuilderDraftView | null | undefined, team: Team | undefined, now = Date.now()): { label: string; line: string } | null {
  if (!d || (team && sameValue(d.team, team))) return null;
  const n = d.team.seats.length;
  return { label: 'Continue team draft', line: `A team draft is in progress: ${n} seat${n === 1 ? '' : 's'}, changed ${ago(d.at, now)} ago by ${d.by === 'cora' ? 'Cora' : 'you'}.` };
}
/**
 * A project's draft as screens know it: asked for once when something showing the project opens (the published
 * projects leave drafts out), then kept current by the server's 'builder' messages. undefined: not known yet.
 */
export function useProjectDraft(pid: string | undefined): BuilderDraftView | null | undefined {
  const d = useBuilder((s) => (pid && pid in s.drafts ? s.drafts[pid] : undefined));
  useEffect(() => {
    if (!pid || pid in useBuilder.getState().drafts) return;
    void getDraft(pid).then((r) => {
      if (r.ok && !(pid in useBuilder.getState().drafts)) useBuilder.getState().apply({ t: 'builder', project: pid, draft: r.draft ?? null });
    });
  }, [pid]);
  return d;
}
