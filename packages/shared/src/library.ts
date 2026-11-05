/** The Library (everything sessions made, in one place): what an entry is, how it opens, and how it's asked for. */

export type LibraryKind = 'explain' | 'live' | 'debrief' | 'video' | 'artifact' | 'recap' | 'brief';
export const LIBRARY_KINDS: readonly LibraryKind[] = ['explain', 'live', 'debrief', 'video', 'artifact', 'recap', 'brief'];
/** How an entry opens: an explain in the viewer (its tool call), a debrief, a video, a link, a file, or its session at that moment. */
export type LibraryOpen =
  | { how: 'explain'; sessionId: string; toolUseId: string }
  | { how: 'debrief'; sessionId: string; debriefId: string }
  | { how: 'video'; videoId: string }
  | { how: 'url'; url: string }
  | { how: 'file'; path: string }
  | { how: 'session'; sessionId: string; ts: number };
export type LibraryEntry = {
  id: string;
  kind: LibraryKind;
  title: string;
  at: number;
  sessionId: string;
  /** its session's name, and its project (null: in none) */
  session: string;
  project: { id: string; name: string } | null;
  /** a line of what it says */
  snippet: string;
  open: LibraryOpen;
  starred?: true;
  /** an explain shown again (a new version): how many */
  versions?: number;
};
export type LibraryWhen = 'today' | 'week' | 'older';
export type LibraryQuery = { q?: string; kind?: LibraryKind; when?: LibraryWhen; starred?: boolean; sessionId?: string; limit?: number };
/** What the Library answers: the entries (starred first, then newest), each kind's count, and whether its first build is still going. */
export type LibraryAnswer = { entries: LibraryEntry[]; kinds: Partial<Record<LibraryKind, number>>; total: number; building?: true };
