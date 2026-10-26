/**
 * Cora notes: Scratch, where jots land, and named notes. Plain
 * markdown in ~/.cora/notes. Sessions and Cora read them and add to them; only the user edits or deletes.
 */

export const SCRATCH_ID = 'scratch';
/** The notes tools every session and Cora get (all allowed without asking: adding only appends). */
export const NOTES_TOOLS = ['notes_list', 'notes_search', 'notes_read', 'notes_add'] as const;

export type NoteSummary = {
  id: string;
  title: string;
  kind: 'scratch' | 'note' | 'template';
  pinned: boolean;
  updatedAt: number;
  /** the start of its text (Scratch: its newest jot) */
  preview: string;
  /** Scratch: how many jots */
  count?: number;
  /** a session added to it since you last opened it */
  unseen: boolean;
  /** a template Cora drafts from */
  fill?: boolean;
};

/** How a note was drafted by Cora: the template, the window, the repos, what it read. */
export type NoteDraft = { template: string; since: number; until: number; repos: string[]; read: string; at: number; /** what you added for this draft ("leave out project X"); Redraft asks the same */ asks?: string };
/** What you add for one draft: at most this long. */
export const MAX_DRAFT_ASKS = 1000;

export type Jot = { id: string; at: number; text: string; /** a session's (its name) */ by?: string; /** yours, taken from a session (its name) */ src?: string };

export type NoteDoc = NoteSummary & { text: string; version: number; jots?: Jot[]; /** the template it was made from */ from?: string; draft?: NoteDraft; /** the notes that link to it (`[[its title]]`) */ backlinks?: Backlink[] };

export type NotesMsg = { t: 'notes'; list: NoteSummary[] };

// ---------------------------------------------------------------------------------------------------------------
// Scratch's file: a marker line per jot, newest first

const JOT = /^<!-- jot (\S+) (\S+)(?: by="([^"]*)")?(?: src="([^"]*)")? -->$/;

export function parseScratch(text: string): Jot[] {
  const jots: Jot[] = [];
  let cur: Jot | null = null;
  const lines: string[] = [];
  const close = () => {
    if (cur) jots.push({ ...cur, text: lines.join('\n').trim() });
    lines.length = 0;
  };
  for (const line of text.split(/\r?\n/)) {
    const m = JOT.exec(line.trim());
    if (m) {
      close();
      cur = { id: m[1], at: Date.parse(m[2]) || 0, text: '', ...(m[3] ? { by: unq(m[3]) } : {}), ...(m[4] ? { src: unq(m[4]) } : {}) };
    } else if (cur) lines.push(line);
  }
  close();
  return jots;
}

export function formatScratch(jots: Jot[]): string {
  return jots.map((j) => `<!-- jot ${j.id} ${new Date(j.at).toISOString()}${j.by ? ` by="${q(j.by)}"` : ''}${j.src ? ` src="${q(j.src)}"` : ''} -->\n${j.text.trim()}\n`).join('\n');
}

const q = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\r?\n/g, ' ').slice(0, 120);
const unq = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** How a session's addition reads at the end of a named note. */
export function addedBlock(by: string, at: number, text: string): string {
  const when = new Date(at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  return `> **Added by ${by.replace(/[*\n]/g, '')}** · ${when}\n${text.trim().split(/\r?\n/).map((l) => `> ${l}`).join('\n')}`;
}

/** Check or uncheck the task (`- [ ]` / `- [x]`) on a line (1-based) of a note's text. */
export function toggleTask(text: string, line: number): string {
  const lines = text.split('\n');
  const i = line - 1;
  if (i < 0 || i >= lines.length) return text;
  lines[i] = lines[i].replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/, (_m, a: string, c: string, b: string) => `${a}${c === ' ' ? 'x' : ' '}${b}`);
  return lines.join('\n');
}

/** A note's file name from its title. */
export const slugOf = (title: string) =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';

// ---------------------------------------------------------------------------------------------------------------
// Links between notes: `[[Title]]`, or `[[Title|what it says]]` (not inside code)

/** A note that links to another, and the line it does it on. */
export type Backlink = { id: string; title: string; line: string };

const LINK = /\[\[([^[\]|\n]{1,120}?)(?:\|([^[\]\n]{1,120}))?\]\]/g;
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** `f` applied to the text outside code (fenced blocks and `inline code` stay as they are). */
function outsideCode(text: string, f: (s: string) => string): string {
  return text
    .split(/(^```[\s\S]*?^```[^\n]*$|^~~~[\s\S]*?^~~~[^\n]*$)/m)
    .map((block, i) => (i % 2 ? block : block.split(/(`[^`\n]*`)/).map((s, j) => (j % 2 ? s : f(s))).join('')))
    .join('');
}

/** The notes a text links to, by title (each once, as first written). */
export function noteLinks(text: string): string[] {
  const out: string[] = [];
  outsideCode(text, (s) => {
    for (const m of s.matchAll(LINK)) if (!out.some((t) => same(t, m[1]))) out.push(m[1].trim());
    return s;
  });
  return out;
}

/** Whether a line links to the note called `title`. */
export const linksTo = (line: string, title: string) => noteLinks(line).some((t) => same(t, title));

/** Links to the note called `from` made to point at `to` (a renamed note); what they say (`|…`) stays. */
export function renameNoteLinks(text: string, from: string, to: string): string {
  return outsideCode(text, (s) => s.replace(LINK, (all, t: string, shown?: string) => (same(t, from) ? `[[${to}${shown ? `|${shown}` : ''}]]` : all)));
}

/** For showing: each link as a markdown link to `#note:<title>` (what it says, or the title). */
export function linkifyNotes(text: string): string {
  return outsideCode(text, (s) => s.replace(LINK, (_all, t: string, shown?: string) => `[${(shown ?? t).trim().replace(/[[\]]/g, '')}](#note:${encodeURIComponent(t.trim())})`));
}
