import { create } from 'zustand';
import type { LibraryAnswer, LibraryEntry, LibraryKind, LibraryWhen } from '@cora/shared';

/** Cora's Library tool (in Tools, beside Notes and Secrets): everything sessions made, in one place. */
export const LIBRARY_ID = 'cora:library';

export type LibraryFilter = { q: string; kind: LibraryKind | null; when: LibraryWhen | null; starred: boolean };
export const NO_FILTER: LibraryFilter = { q: '', kind: null, when: null, starred: false };

/** The ask for these filters (the server searches and filters; a guest's answer is already cut to what it may open). */
export function libraryUrl(f: LibraryFilter): string {
  const p = new URLSearchParams();
  if (f.q.trim()) p.set('q', f.q.trim());
  if (f.kind) p.set('kind', f.kind);
  if (f.when) p.set('when', f.when);
  if (f.starred) p.set('starred', '1');
  const s = p.toString();
  return `/api/library${s ? `?${s}` : ''}`;
}

/** What the kinds are called (their chips, a row's word) and their icons. */
export const KIND_WORDS: Record<LibraryKind, { label: string; one: string; icon: string }> = {
  explain: { label: 'Explains', one: 'explain', icon: 'Presentation' },
  live: { label: 'Live', one: 'live explain', icon: 'Activity' },
  debrief: { label: 'Debriefs', one: 'debrief', icon: 'GraduationCap' },
  video: { label: 'Videos', one: 'video', icon: 'Clapperboard' },
  artifact: { label: 'Artifacts', one: 'artifact', icon: 'Package' },
  recap: { label: 'Recaps', one: 'recap', icon: 'ScrollText' },
  brief: { label: 'Briefs', one: "Cora's brief", icon: 'Sparkles' },
};

export type LibraryGroups = {
  starred: LibraryEntry[];
  projects: Array<{ key: string; name: string | null; sessions: Array<{ sessionId: string; name: string; entries: LibraryEntry[] }> }>;
};

/**
 * The answer as the Library shows it: the starred ones first (pinned, on their own), then by project (those in none
 * last), then by session, newest first throughout (a group's place: its newest entry's).
 */
export function groupLibrary(entries: LibraryEntry[]): LibraryGroups {
  const starred = entries.filter((e) => e.starred);
  const rest = entries.filter((e) => !e.starred).sort((a, b) => b.at - a.at);
  const projects = new Map<string, { key: string; name: string | null; newest: number; sessions: Map<string, { sessionId: string; name: string; newest: number; entries: LibraryEntry[] }> }>();
  for (const e of rest) {
    const key = e.project?.id ?? '';
    let p = projects.get(key);
    if (!p) projects.set(key, (p = { key, name: e.project?.name ?? null, newest: e.at, sessions: new Map() }));
    let s = p.sessions.get(e.sessionId);
    if (!s) p.sessions.set(e.sessionId, (s = { sessionId: e.sessionId, name: e.session, newest: e.at, entries: [] }));
    s.entries.push(e);
  }
  return {
    starred: starred.sort((a, b) => b.at - a.at),
    projects: [...projects.values()]
      .sort((a, b) => (!a.key === !b.key ? b.newest - a.newest : a.key ? -1 : 1))
      .map((p) => ({ key: p.key, name: p.name, sessions: [...p.sessions.values()].sort((a, b) => b.newest - a.newest).map(({ newest: _n, ...s }) => s) })),
  };
}

/** The Library's state: its filters, the latest answer, and loading it. */
export const useLibrary = create<{
  filter: LibraryFilter;
  answer: LibraryAnswer | null;
  error: string | null;
  setFilter(f: Partial<LibraryFilter>): void;
  load(): Promise<void>;
  star(id: string, on: boolean): Promise<void>;
}>((set, get) => {
  let asked = 0;
  let again: ReturnType<typeof setTimeout> | null = null;
  return {
    filter: NO_FILTER,
    answer: null,
    error: null,
    setFilter(f) {
      set({ filter: { ...get().filter, ...f } });
      void get().load();
    },
    async load() {
      const n = ++asked;
      if (again) clearTimeout(again);
      again = null;
      const r = await fetch(libraryUrl(get().filter)).catch(() => null);
      // an older ask answered after a newer one: not shown
      if (n !== asked) return;
      if (!r?.ok) return set({ error: r ? `The Library couldn't be read (${r.status})` : "Cora didn't answer" });
      const answer = (await r.json()) as LibraryAnswer;
      if (n !== asked) return;
      set({ answer, error: null });
      // its first look still going: asked again shortly, for the rest
      if (answer.building) again = setTimeout(() => void get().load(), 1500);
    },
    async star(id, on) {
      const a = get().answer;
      // at once, then as the server has it
      if (a) set({ answer: { ...a, entries: a.entries.map((e) => (e.id === id ? { ...e, ...(on ? { starred: true as const } : { starred: undefined }) } : e)) } });
      await fetch('/api/library/star', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, on }) }).catch(() => null);
      await get().load();
    },
  };
});
