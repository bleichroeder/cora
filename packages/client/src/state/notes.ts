import { create } from 'zustand';
import type { Jot, NoteDoc, NoteSummary, NotesMsg } from '@cora/shared';
import { desktop } from '../lib/desktop';
import { sessionName } from '../lib/format';
import { useBrain } from './store';

/** The built-in Notes tool's id in the Tools drawer (Cora's group, under your tools). */
export const NOTES_ID = 'cora:notes';

/** Your notes' list, as the server last said (see server/src/notes.ts). `focusJot`: Scratch's box should take the keyboard. */
type Ask = { n: number; id: string };
export const useNotes = create<{
  list: NoteSummary[];
  focusJot: number;
  /** a jot just added from elsewhere (a flash on the Notes tile) */
  flash: number;
  /** open this note (the palette) */
  open: Ask | null;
  /** start a note from this template (the palette) */
  start: Ask | null;
  /** notes Cora is drafting now, and the last draft's error per note */
  drafting: Record<string, true>;
  draftError: Record<string, string>;
  apply(m: NotesMsg): void;
}>((set) => ({
  list: [],
  focusJot: 0,
  flash: 0,
  open: null,
  start: null,
  drafting: {},
  draftError: {},
  apply: (m) => set({ list: m.list }),
}));

export const notesUnseen = (list: NoteSummary[]) => list.some((n) => n.unseen);

type R<T> = { ok: true; v: T } | { ok: false; error: string };
async function call<T>(method: string, url: string, body?: unknown): Promise<R<T>> {
  try {
    const r = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, v: j as T } : { ok: false, error: (j as { error?: string }).error ?? `HTTP ${r.status}` };
  } catch {
    return { ok: false, error: "Couldn't reach Cora's server" };
  }
}

const enc = encodeURIComponent;
export const notesApi = {
  list: () => call<{ list: NoteSummary[] }>('GET', '/api/notes'),
  read: (id: string) => call<NoteDoc>('GET', `/api/notes/${enc(id)}`),
  create: (title: string, text = '') => call<{ id: string }>('POST', '/api/notes', { title, text }),
  save: (id: string, text: string, base: number) => call<{ version: number; text: string }>('PUT', `/api/notes/${enc(id)}`, { text, base }),
  meta: (id: string, p: { title?: string; pinned?: boolean }) => call<{ ok: true }>('POST', `/api/notes/${enc(id)}/meta`, p),
  remove: (id: string) => call<{ ok: true }>('DELETE', `/api/notes/${enc(id)}`),
  /** a jot on Scratch, or (with `to`) text at a note's end / a new note */
  jot: (text: string, to?: { id?: string; title?: string }, src?: string) => call<{ jot?: Jot; id?: string }>('POST', '/api/notes/jots', { text, ...(to ? { to } : {}), ...(src ? { src } : {}) }),
  fromTemplate: (template: string, keepHints: boolean) => call<{ id: string }>('POST', '/api/notes/from-template', { template, keepHints }),
  restoreTemplates: () => call<{ added: number }>('POST', '/api/notes/templates/restore', {}),
  createTemplate: (name: string) => call<{ id: string }>('POST', '/api/notes/templates', { name }),
  draftPreview: (template: string, window: string, note?: string) => call<DraftPreview>('POST', '/api/notes/draft/preview', { template, window, ...(note ? { note } : {}) }),
  restoreJot: (jot: Jot) => call<{ ok: true }>('POST', '/api/notes/jots/restore', { jot }),
  search: (q: string) => call<{ hits: Array<{ id: string; title: string; lines: string[] }> }>('GET', `/api/notes/search?q=${enc(q)}`),
  deleteJot: (id: string) => call<{ ok: true }>('DELETE', `/api/notes/jots/${enc(id)}`),
  moveJot: (id: string, to: { id?: string; title?: string }) => call<{ id: string }>('POST', `/api/notes/jots/${enc(id)}/move`, to),
};

/** "Add to Scratch" from the right-click menu: a jot, marked with the session in front (where it was taken from). */
desktop?.onJot?.((text) => {
  const b = useBrain.getState();
  const s = b.focus ? b.sessions[b.focus] : undefined;
  void notesApi.jot(text, undefined, s ? sessionName(s) : undefined).then((r) => r.ok && useNotes.setState({ flash: Date.now() }));
});

export type DraftPreview = { since: number; until: number; window: string; last: number | null; repos: Array<{ repo: string; sessions: number }>; counts: { sessions: number; tickets: string[]; mrs: string[]; deploys: number; jira: number; jots: number } };

/** Cora drafts a note (it may take a minute): the note shows it's drafting, then its text. Null: done; else why not. */
export async function draftNote(note: string, template: string, since: number, until: number, repos: string[], asks?: string): Promise<string | null> {
  const st = useNotes.getState();
  const { [note]: _e, ...draftError } = st.draftError;
  useNotes.setState({ drafting: { ...st.drafting, [note]: true }, draftError });
  const r = await call<{ id: string; version: number }>('POST', '/api/notes/draft', { note, template, since, until, repos, ...(asks?.trim() ? { asks: asks.trim() } : {}) });
  const { [note]: _d, ...drafting } = useNotes.getState().drafting;
  useNotes.setState({ drafting, ...(r.ok ? {} : { draftError: { ...useNotes.getState().draftError, [note]: r.error } }) });
  return r.ok ? null : r.error;
}

/** Open Notes at a note, or starting a note from a template (the palette). */
export const askNotes = (k: 'open' | 'start', id: string) => useNotes.setState({ [k]: { n: Date.now(), id } } as never);

if (import.meta.env?.DEV) (globalThis as { __notes?: typeof useNotes }).__notes = useNotes;
