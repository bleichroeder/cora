import { create } from 'zustand';
import { setBuilderSessions, useBrain } from './store';
import type { MemberSettings, PostKind, Project, ProjectWake, ProjectsMsg, SessionInfo, Team, TeamChange } from '@cora/shared';

/** Your projects, as the server keeps them. */
export const useProjects = create<{ projects: Project[]; wakes: ProjectWake[]; /** what each member is on now */ doing: Record<string, string>; /** a new session being started from a project's header: it joins that project */ joining: string | null; apply(m: ProjectsMsg): void }>((set) => ({
  projects: [],
  wakes: [],
  doing: {},
  joining: null,
  apply: (m) => {
    // the builder's sessions (one per project building a team) stay out of every session list
    setBuilderSessions(m.projects.flatMap((p) => (p.builderSession ? [p.builderSession] : [])));
    set({ projects: m.projects, wakes: m.wakes, ...(m.doing ? { doing: m.doing } : {}) });
  },
}));

/** The board key of a project ('project:<id>'), and back. */
export const projectBoard = (id: string) => `project:${id}`;
export const projectOfBoard = (owner: string) => (owner.startsWith('project:') ? owner.slice(8) : null);
export const useProject = (id: string | null) => useProjects((s) => (id ? s.projects.find((p) => p.id === id) : undefined));
/** The (live, not archived) project a session is in. */
export const useProjectOfSession = (sid: string) => useProjects((s) => s.projects.find((p) => !p.archivedAt && p.sessions.includes(sid)));

export const call = async (method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> => {
  try {
    // a JSON content type only with a body: the server refuses an empty one (400)
    const r = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    // (a refusal keeps what came with it: a team's problems, the version that's there now)
    return r.ok ? { ok: true, ...j } : { ...j, ok: false, error: j.error ?? `failed (${r.status})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};
export const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const createProject = (name: string, sessionId?: string) => call('POST', '/api/projects', { name, ...(sessionId ? { sessionId } : {}) }).then((r) => (r.ok ? (r.project as Project) : null));
export const updateProject = (id: string, patch: Partial<Pick<Project, 'name' | 'color' | 'brief' | 'coordination' | 'shade' | 'autoWake' | 'coraRoutes'>> & { lead?: string | null; wakeLimit?: number | 'none' | null }) => call('PATCH', P(id), patch);
export const archiveProject = (id: string, on = true) => call('POST', `${P(id)}/archive`, { on });
/**
 * The sessions the nav's groups (live, Ended) leave out: a project's members show under it, and an archived project's
 * are hidden with it (Resume says where they belong), never loose as if they had no project.
 */
export const projectMembers = (projects: Project[]): Set<string> => new Set(projects.flatMap((p) => p.sessions));
/** Each session of an archived project, with its project's name (hidden in the nav; Resume says where it belongs). */
export const archivedHomes = (projects: Project[]): Map<string, string> => new Map(projects.filter((p) => p.archivedAt).flatMap((p) => p.sessions.map((sid) => [sid, p.name] as const)));
/** How many of its sessions are running (archiving stops them). */
export const runningIn = (p: Pick<Project, 'sessions'>, sessions: Record<string, Pick<SessionInfo, 'state'>>) => p.sessions.filter((sid) => sessions[sid] && sessions[sid].state !== 'ended').length;
/** What you're asked before archiving a project with sessions running (none: nothing to ask). */
export const archiveAsk = (name: string, n: number) => (n ? `Archive "${name}"? Its ${n} running session${n === 1 ? '' : 's'} will be stopped.` : null);
/** Archive it, asking once first when sessions of it are running: they're stopped, and hidden with it. */
export function archiveAsking(p: Project): Promise<unknown> | void {
  const ask = archiveAsk(p.name, runningIn(p, useBrain.getState().sessions));
  if (ask && !window.confirm(ask)) return;
  return archiveProject(p.id, true);
}
export const deleteProject = (id: string) => call('DELETE', P(id));
export const addToProject = (id: string, sessionId: string) => call('POST', `${P(id)}/sessions`, { sessionId });
export const orderMembers = (id: string, ids: string[]) => call('POST', `${P(id)}/sessions/order`, { ids });
export const leaveProject = (id: string, sessionId: string) => call('DELETE', `${P(id)}/sessions/${encodeURIComponent(sessionId)}`);
export const setMember = (id: string, sessionId: string, patch: Partial<Pick<MemberSettings, 'hears' | 'canPost' | 'wakes' | 'role'>>) => call('PATCH', `${P(id)}/members/${encodeURIComponent(sessionId)}`, patch);
export const postToProject = (id: string, kind: PostKind, text: string, o: { to?: string[]; re?: string } = {}) => call('POST', `${P(id)}/posts`, { kind, text, ...(o.to?.length ? { to: o.to } : {}), ...(o.re ? { re: o.re } : {}) });
export const pinPost = (id: string, post: string, on: boolean) => call('POST', `${P(id)}/posts/${encodeURIComponent(post)}/pin`, { on });
export const closeQuestion = (id: string, post: string) => call('POST', `${P(id)}/posts/${encodeURIComponent(post)}/close`, {});
/** your own post changed, or withdrawn (null) */
export const editPost = (id: string, post: string, text: string | null) => call('PATCH', `${P(id)}/posts/${encodeURIComponent(post)}`, text === null ? { withdraw: true } : { text });
/** you, on its incidents and known issues */
export const itemOp = (id: string, op: 'open' | 'change' | 'claim' | 'annotate' | 'close' | 'merge', f: Record<string, unknown>) => call('POST', `${P(id)}/items`, { op, ...f });
export const editDecision = (id: string, did: string, text: string | null) => call('PATCH', `${P(id)}/decisions/${encodeURIComponent(did)}`, { text });
// the New session dialog closed (started or not): nothing joins a project any more
useBrain.subscribe((s, p) => {
  if (p.modal === 'new-session' && s.modal !== 'new-session' && useProjects.getState().joining) setTimeout(() => useProjects.setState({ joining: null }), 0);
});
export const reorderProjects = (ids: string[]) => call('POST', '/api/projects/order', { ids });

// shades of a project's colour for its sessions (the server keeps them on while its shading is on)
export { shadesOf } from '@cora/shared';

export const answerWake = (wid: string, allow: boolean) => call('POST', `/api/projects/wakes/${encodeURIComponent(wid)}`, { allow });
export const wrapUpProject = (id: string) => call('POST', `${P(id)}/wrapup`);

// its team
/** `short`: a standing seat of a team that is up with fewer running than its minimum (Bring up starts it again now) */
export type TeamHealth = { seat: string; failing: boolean; short?: boolean; lastError?: string; nextTryAt?: number };
/** its lead's proposed change, waiting for you (`base`: the version it edits) */
export type TeamProposal = NonNullable<Project['teamProposal']>;
/** A line of what a proposal changes, and (when the line was cut) the same line in full. */
export type TeamChangeDetail = { line: string; full?: string };
/** the team, its version (0: none yet), whether it's up, each seat's restarts, the seats waiting for a restart, any proposal */
export const getTeam = (id: string) => call('GET', `${P(id)}/team`) as Promise<{ ok: boolean; error?: string; team?: Team; version?: number; up?: boolean; health?: TeamHealth[]; restart?: string[]; proposal?: TeamProposal; proposalDetails?: TeamChangeDetail[] }>;
/** a team set (or rolled back, or a proposal approved): what changed for its running seats, and the seats needing a restart */
export type TeamEdited = { ok: boolean; error?: string; problems?: string[]; team?: Team; version?: number; changes?: TeamChange[]; restart?: string[] };

/** restart these seats (stood down and brought up again, on their new definition) */
export const restartTeamSeats = (id: string, seats: string[]) => call('POST', `${P(id)}/team/restart`, { seats }) as Promise<{ ok: boolean; error?: string; started?: string[]; problems?: string[] }>;
/** its lead's proposal: taken (409 when the team changed since), or not (the lead is told) */
/** `at`: the proposal you were shown (a newer one isn't approved unseen); `team`: as you edited it in the builder */
export const approveTeamProposal = (id: string, at: number, team?: Team) => call('POST', `${P(id)}/team/proposal/approve`, { at, ...(team ? { team } : {}) }) as Promise<TeamEdited & { edited?: boolean }>;
export const rejectTeamProposal = (id: string) => call('POST', `${P(id)}/team/proposal/reject`, {});
/** Bring up: its standing seats started and kept running */
export const bringUpTeam = (id: string, o: { fresh?: boolean } = {}) => call('POST', `${P(id)}/team/bring-up`, o.fresh ? { fresh: true } : {}) as Promise<{ ok: boolean; error?: string; started?: string[]; problems?: string[] }>;
/** Stand down one seat, or the whole team */
export const standDownTeam = (id: string, seat?: string) => call('POST', `${P(id)}/team/stand-down`, seat ? { seat } : {});
/** its earlier versions, newest first */
export const teamHistory = (id: string) => call('GET', `${P(id)}/team/history`) as Promise<{ ok: boolean; error?: string; current?: number; versions?: Array<{ version: number; at: number; by: string }> }>;
/** an earlier version again, as a new one */
export const rollbackTeam = (id: string, version: number) => call('POST', `${P(id)}/team/rollback`, { version }) as Promise<TeamEdited>;
