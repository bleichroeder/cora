import { create } from 'zustand';
import { useBrain } from './store';
import type { MemberSettings, PostKind, Project, ProjectWake, ProjectsMsg } from '@cora/shared';

/** Your projects, as the server keeps them. */
export const useProjects = create<{ projects: Project[]; wakes: ProjectWake[]; /** what each member is on now */ doing: Record<string, string>; /** a new session being started from a project's header: it joins that project */ joining: string | null; apply(m: ProjectsMsg): void }>((set) => ({
  projects: [],
  wakes: [],
  doing: {},
  joining: null,
  apply: (m) => set({ projects: m.projects, wakes: m.wakes, ...(m.doing ? { doing: m.doing } : {}) }),
}));

/** The board key of a project ('project:<id>'), and back. */
export const projectBoard = (id: string) => `project:${id}`;
export const projectOfBoard = (owner: string) => (owner.startsWith('project:') ? owner.slice(8) : null);
export const useProject = (id: string | null) => useProjects((s) => (id ? s.projects.find((p) => p.id === id) : undefined));
/** The (live, not archived) project a session is in. */
export const projectOfSession = (sid: string) => useProjects.getState().projects.find((p) => !p.archivedAt && p.sessions.includes(sid));
export const useProjectOfSession = (sid: string) => useProjects((s) => s.projects.find((p) => !p.archivedAt && p.sessions.includes(sid)));

const call = async (method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> => {
  try {
    // a JSON content type only with a body: the server refuses an empty one (400)
    const r = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error ?? `failed (${r.status})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};
const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const createProject = (name: string, sessionId?: string) => call('POST', '/api/projects', { name, ...(sessionId ? { sessionId } : {}) }).then((r) => (r.ok ? (r.project as Project) : null));
export const updateProject = (id: string, patch: Partial<Pick<Project, 'name' | 'color' | 'brief' | 'coordination' | 'shade' | 'autoWake' | 'coraRoutes'>> & { lead?: string | null }) => call('PATCH', P(id), patch);
export const archiveProject = (id: string, on = true) => call('POST', `${P(id)}/archive`, { on });
export const deleteProject = (id: string) => call('DELETE', P(id));
export const addToProject = (id: string, sessionId: string) => call('POST', `${P(id)}/sessions`, { sessionId });
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
