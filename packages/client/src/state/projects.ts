import { create } from 'zustand';
import { useBrain } from './store';
import type { MemberSettings, PostKind, Project, ProjectWake, ProjectsMsg } from '@cora/shared';

/** Your projects, as the server keeps them. */
export const useProjects = create<{ projects: Project[]; wakes: ProjectWake[]; /** a new session being started from a project's header: it joins that project */ joining: string | null; apply(m: ProjectsMsg): void }>((set) => ({
  projects: [],
  wakes: [],
  joining: null,
  apply: (m) => set({ projects: m.projects, wakes: m.wakes }),
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
    const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error ?? `failed (${r.status})` };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};
const P = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export const createProject = (name: string, sessionId?: string) => call('POST', '/api/projects', { name, ...(sessionId ? { sessionId } : {}) }).then((r) => (r.ok ? (r.project as Project) : null));
export const updateProject = (id: string, patch: Partial<Pick<Project, 'name' | 'color' | 'brief' | 'coordination'>>) => call('PATCH', P(id), patch);
export const archiveProject = (id: string, on = true) => call('POST', `${P(id)}/archive`, { on });
export const deleteProject = (id: string) => call('DELETE', P(id));
export const addToProject = (id: string, sessionId: string) => call('POST', `${P(id)}/sessions`, { sessionId });
export const leaveProject = (id: string, sessionId: string) => call('DELETE', `${P(id)}/sessions/${encodeURIComponent(sessionId)}`);
export const setMember = (id: string, sessionId: string, patch: Partial<Pick<MemberSettings, 'hears' | 'canPost' | 'wakes'>>) => call('PATCH', `${P(id)}/members/${encodeURIComponent(sessionId)}`, patch);
export const postToProject = (id: string, kind: PostKind, text: string) => call('POST', `${P(id)}/posts`, { kind, text });
export const editDecision = (id: string, did: string, text: string | null) => call('PATCH', `${P(id)}/decisions/${encodeURIComponent(did)}`, { text });
// the New session dialog closed (started or not): nothing joins a project any more
useBrain.subscribe((s, p) => {
  if (p.modal === 'new-session' && s.modal !== 'new-session' && useProjects.getState().joining) setTimeout(() => useProjects.setState({ joining: null }), 0);
});
export const reorderProjects = (ids: string[]) => call('POST', '/api/projects/order', { ids });

/**
 * Shades of a project's colour, one per session (lighter and darker, the hue nudged a little each way), so its sessions
 * read as one family and still apart.
 */
export function shadesOf(hex: string, n: number): string[] {
  const [h, s, l] = toHsl(hex);
  if (n <= 1) return [hex];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1); // 0 … 1
    const light = Math.max(32, Math.min(78, l - 18 + t * 36));
    const hue = (h + (i % 2 ? 1 : -1) * Math.min(14, 4 + i * 2) + 360) % 360;
    const sat = Math.max(35, Math.min(95, s + (i % 3 === 1 ? -10 : i % 3 === 2 ? 6 : 0)));
    return toHex(hue, sat, light);
  });
}
function toHsl(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = m ? parseInt(m[1], 16) : 0x60a5fa;
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}
function toHex(h: number, s: number, l: number): string {
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[f(0), f(8), f(4)].map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('')}`;
}

export const answerWake = (wid: string, allow: boolean) => call('POST', `/api/projects/wakes/${encodeURIComponent(wid)}`, { allow });
export const wrapUpProject = (id: string) => call('POST', `${P(id)}/wrapup`);
