import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { headline, type BrainEvent, type Debrief, type JournalEntry, type LibraryEntry, type LibraryKind, type LibraryQuery, type Recap, type VideoJob } from '@cora/shared';
export { LIBRARY_KINDS, type LibraryEntry, type LibraryKind, type LibraryOpen, type LibraryQuery, type LibraryWhen } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * The Library (the user's idea, agreed Nov 4): one place for everything sessions made, ended sessions' too, so nothing
 * has to be hunted for. Its sources: explains and live explains, debriefs and their videos, the artifacts journal
 * entries name (claude.ai pages, files), recaps, and Cora's briefs. Each entry says what it is, whose it is, when, the
 * text it's searched by, and how it opens. The index is kept, not rebuilt for each ask: the events are read after the
 * last one seen, debriefs' folders only when one changed, the rest (in memory already) at most every few seconds.
 * Stars are yours, kept on the server.
 */

/** An entry as kept: with the text it's searched by. */
type Kept = Omit<LibraryEntry, 'session' | 'project' | 'starred'> & { text: string };

const TEXT_MAX = 4000;
const SNIPPET_MAX = 160;
/** the sources kept in memory elsewhere (the journal, videos, recaps) are looked at again at most this often */
const REFRESH_MS = 10_000;
/**
 * The events are read this many seqs at a time. More than one range behind (the first build, over a big brain.db):
 * read in the background, a range at a time with the server free between them, and asked meanwhile it answers with
 * what's ready (`building`).
 */
export const EVENT_RANGE = 20_000;

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
/** A page or markdown as plain words (to search, and for a snippet). */
export function plainText(s: string): string {
  return squash(
    s
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      // markdown's marks (before the entities: a "&gt;" is a word's)
      .replace(/[#*_`>|]+/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'"),
  ).slice(0, TEXT_MAX);
}
const snip = (s: string) => (s.length > SNIPPET_MAX ? `${s.slice(0, SNIPPET_MAX - 1)}…` : s);

export type LibraryDeps = {
  /** what Cora stored: the explains and briefs (after a seq), a brief's reply, recaps */
  store: {
    lastSeq(): number;
    libraryEvents(from: number, to: number): BrainEvent[];
    replyAfter(sessionId: string, ts: number): BrainEvent | null;
    recaps(q: { since?: number; limit?: number }): Recap[];
  };
  debriefs?: { root: string; get(sessionId: string, id: string): Debrief | null };
  videos?: { list(): VideoJob[] };
  journal?: { query?(q: { limit?: number }): JournalEntry[] };
  /** a session's name and project, as they are now */
  sessionName(sessionId: string): string;
  projectOf(sessionId: string): { id: string; name: string } | null;
  /** where stars are kept (null: not kept, in tests) */
  file: string | null;
  now?(): number;
};

export class Library {
  private kept = new Map<string, Kept>();
  private seq = 0;
  /** briefs asked whose reply hasn't come (their turn still going) */
  private briefs = new Map<string, { sessionId: string; ts: number; kind: 'brief' | 'wrap' }>();
  /** each session's debriefs folder, as last read (its time) */
  private debriefDirs = new Map<string, number>();
  private recapsSince = 0;
  private lastRefresh = -Infinity;
  /** reading the events in the background (the first build): until it's caught up */
  private building: Promise<void> | null = null;
  private stars: Record<string, number> = {};
  private now: () => number;

  constructor(private d: LibraryDeps) {
    this.now = d.now ?? Date.now;
    try {
      if (d.file && existsSync(d.file)) this.stars = JSON.parse(readFileSync(d.file, 'utf8')) as Record<string, number>;
    } catch {
      this.stars = {};
    }
  }

  /** Bring the index up to date: what's new since it was last looked at. */
  refresh(): void {
    this.events();
    const now = this.now();
    if (now - this.lastRefresh < REFRESH_MS) return;
    this.lastRefresh = now;
    this.pendingBriefs();
    this.debriefsNow();
    this.videosNow();
    this.artifactsNow();
    this.recapsNow();
  }

  /**
   * Entries that match, starred first, then newest; with how many of each kind matched (before the kind filter).
   * `guest` (a live share's): only what the shared page can open (no files on this PC, by path; no videos), and never
   * Cora's briefs (her own words to you, with your Slack, mail and Jira in them: whichever conversation of hers).
   */
  query(q: LibraryQuery = {}, hidden: (sessionId: string) => boolean = () => false, guest = false): { entries: LibraryEntry[]; kinds: Partial<Record<LibraryKind, number>>; total: number; building?: true } {
    this.refresh();
    const now = this.now();
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const weekAgo = now - 7 * 86_400_000;
    const words = squash(q.q ?? '').toLowerCase().split(' ').filter(Boolean);
    const names = new Map<string, { session: string; project: LibraryEntry['project'] }>();
    const who = (sid: string) => {
      let w = names.get(sid);
      if (!w) names.set(sid, (w = { session: this.d.sessionName(sid), project: this.d.projectOf(sid) }));
      return w;
    };
    const kinds: Partial<Record<LibraryKind, number>> = {};
    const out: LibraryEntry[] = [];
    for (const k of this.kept.values()) {
      if (hidden(k.sessionId) || (q.sessionId && k.sessionId !== q.sessionId)) continue;
      if (guest && (k.kind === 'brief' || k.open.how === 'file' || k.open.how === 'video')) continue;
      const starred = this.stars[k.id] != null;
      if (q.starred && !starred) continue;
      if (q.when === 'today' && k.at < midnight.getTime()) continue;
      if (q.when === 'week' && k.at < weekAgo) continue;
      if (q.when === 'older' && k.at >= weekAgo) continue;
      const w = who(k.sessionId);
      if (words.length) {
        const hay = `${k.title} ${k.text} ${w.session} ${w.project?.name ?? ''}`.toLowerCase();
        if (!words.every((x) => hay.includes(x))) continue;
      }
      kinds[k.kind] = (kinds[k.kind] ?? 0) + 1;
      if (q.kind && k.kind !== q.kind) continue;
      const { text: _text, ...rest } = k;
      out.push({ ...rest, session: w.session, project: w.project, ...(starred ? { starred: true as const } : {}) });
    }
    out.sort((a, b) => (a.starred === b.starred ? b.at - a.at : a.starred ? -1 : 1));
    return { entries: out.slice(0, Math.max(1, Math.min(Math.round(q.limit ?? 500) || 500, 500))), kinds, total: out.length, ...(this.building ? { building: true as const } : {}) };
  }

  /** Done once the events have all been read (the first build, in the background). */
  ready(): Promise<void> {
    this.events();
    return this.building ?? Promise.resolve();
  }

  /** Star an entry (it goes to the top) or not. False: there's no such entry. */
  star(id: string, on: boolean): boolean {
    this.refresh();
    if (!this.kept.has(id)) return false;
    if (on) this.stars[id] = this.now();
    else delete this.stars[id];
    try {
      if (this.d.file) writeFileAtomic(this.d.file, JSON.stringify(this.stars));
    } catch {
      /* kept in memory this time */
    }
    return true;
  }

  // ---------------------------------------------------------------- sources

  private put(k: Kept): void {
    this.kept.set(k.id, k);
  }

  /** The events after the last one seen: read now when it's a range or less, else in the background (`building`). */
  private events(): void {
    if (this.building) return;
    const last = this.d.store.lastSeq();
    if (last <= this.seq) return;
    // a range or less behind (what came since the last ask): read now
    if (last - this.seq <= EVENT_RANGE) {
      this.take(this.d.store.libraryEvents(this.seq, last));
      this.seq = last;
      this.pendingBriefs();
      return;
    }
    // far behind: a range at a time, the server free between them
    this.building = (async () => {
      try {
        while (this.d.store.lastSeq() > this.seq) {
          const to = Math.min(this.d.store.lastSeq(), this.seq + EVENT_RANGE);
          this.take(this.d.store.libraryEvents(this.seq, to));
          this.seq = to;
          await new Promise((r) => setImmediate(r));
        }
        this.pendingBriefs();
      } finally {
        this.building = null;
      }
    })();
  }

  /** Explains (each one once: its newest version, counted) and briefs asked, as they come. */
  private take(evs: BrainEvent[]): void {
    for (const e of evs) {
      if (e.kind === 'prompt') {
        const wrap = (e.text ?? '').startsWith('[Cora wrap-up]');
        this.briefs.set(e.id, { sessionId: e.sessionId, ts: e.ts, kind: wrap ? 'wrap' : 'brief' });
        continue;
      }
      const input = (e.tool?.input ?? {}) as { title?: unknown; content?: unknown; live?: unknown };
      const title = squash(String(input.title ?? '')) || 'Untitled explain';
      const live = typeof input.live === 'string' && input.live ? input.live : null;
      const id = live ? `live:${e.sessionId}:${live}` : `explain:${e.sessionId}:${title.toLowerCase()}`;
      const prev = this.kept.get(id);
      // (an event stored again, merged: the same version)
      const again = prev?.open.how === 'explain' && prev.open.toolUseId === e.toolUseId;
      const versions = (prev?.versions ?? (prev ? 1 : 0)) + (again ? 0 : 1);
      if (prev && prev.at > e.ts) {
        if (!again) prev.versions = versions;
        continue;
      }
      const text = plainText(String(input.content ?? ''));
      this.put({ id, kind: live ? 'live' : 'explain', title, at: e.ts, sessionId: e.sessionId, snippet: snip(text), text: `${title} ${text}`, open: { how: 'explain', sessionId: e.sessionId, toolUseId: e.toolUseId ?? '' }, ...(versions > 1 ? { versions } : {}) });
    }
  }

  /** A brief's reply, once its turn is over: the brief is that reply. */
  private pendingBriefs(): void {
    for (const [pid, b] of this.briefs) {
      const r = this.d.store.replyAfter(b.sessionId, b.ts);
      if (!r) {
        // a turn that never ended (Cora restarted mid-brief): not waited for past a day
        if (this.now() - b.ts > 86_400_000) this.briefs.delete(pid);
        continue;
      }
      this.briefs.delete(pid);
      const text = squash(r.text ?? '').slice(0, TEXT_MAX);
      if (!text) continue;
      const day = new Date(b.ts).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      this.put({ id: `brief:${pid}`, kind: 'brief', title: `${b.kind === 'wrap' ? "Cora's wrap-up" : "Cora's brief"}, ${day}`, at: r.ts, sessionId: b.sessionId, snippet: snip(text), text, open: { how: 'session', sessionId: b.sessionId, ts: b.ts } });
    }
  }

  /** Debriefs: a session's folder read again only when it changed (one was made or removed). */
  private debriefsNow(): void {
    const db = this.d.debriefs;
    if (!db) return;
    let sids: string[];
    try {
      sids = readdirSync(db.root, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name);
    } catch {
      return;
    }
    for (const sid of sids) {
      const dir = join(db.root, sid);
      let m: number;
      try {
        m = statSync(dir).mtimeMs;
      } catch {
        continue;
      }
      if (this.debriefDirs.get(sid) === m) continue;
      this.debriefDirs.set(sid, m);
      for (const [id, k] of this.kept) if (k.kind === 'debrief' && k.sessionId === sid) this.kept.delete(id);
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json')) continue;
        const x = db.get(sid, f.slice(0, -5));
        if (!x) continue;
        const words = plainText([x.task, ...x.steps.flatMap((s) => [s.title, ...s.beats.map((b) => b.text), s.why ?? ''])].join(' '));
        this.put({ id: `debrief:${sid}:${x.id}`, kind: 'debrief', title: x.title, at: x.createdAt, sessionId: sid, snippet: snip(squash(x.task)), text: `${x.title} ${words}`, open: { how: 'debrief', sessionId: sid, debriefId: x.id } });
      }
    }
  }

  /** Videos made of debriefs: the ready ones still kept. */
  private videosNow(): void {
    if (!this.d.videos) return;
    for (const [id, k] of this.kept) if (k.kind === 'video') this.kept.delete(id);
    for (const v of this.d.videos.list()) {
      if (v.stage !== 'ready') continue;
      this.put({ id: `video:${v.id}`, kind: 'video', title: v.title, at: v.createdAt, sessionId: v.sessionId, snippet: `A video of its debrief${v.seconds ? `, ${Math.round(v.seconds)}s` : ''}`, text: v.title, open: { how: 'video', videoId: v.id } });
    }
  }

  /** What journal entries say a session made: claude.ai pages and files (each once: the newest mention). */
  private artifactsNow(): void {
    const entries = this.d.journal?.query?.({ limit: 100_000 }) ?? [];
    for (const [id, k] of this.kept) if (k.kind === 'artifact') this.kept.delete(id);
    for (const e of entries) {
      for (const a of e.refs.artifacts ?? []) {
        const id = `artifact:${a}`;
        const prev = this.kept.get(id);
        if (prev && prev.at >= e.at) continue;
        const url = /^https?:\/\//.test(a);
        const text = squash(e.text).slice(0, TEXT_MAX);
        this.put({ id, kind: 'artifact', title: url ? headline(e.text) || a : basename(a), at: e.at, sessionId: e.sessionId, snippet: snip(text), text: `${a} ${text}`, open: url ? { how: 'url', url: a } : { how: 'file', path: a } });
      }
    }
  }

  /** Claude Code's recaps of sessions: the ones since the last look. */
  private recapsNow(): void {
    const rs = this.d.store.recaps({ since: this.recapsSince, limit: 20_000 });
    for (const r of rs) {
      this.recapsSince = Math.max(this.recapsSince, r.at);
      const text = squash(r.text).slice(0, TEXT_MAX);
      this.put({ id: `recap:${r.id}`, kind: 'recap', title: headline(r.text) || 'Recap', at: r.at, sessionId: r.sessionId, snippet: snip(text), text, open: { how: 'session', sessionId: r.sessionId, ts: r.at } });
    }
  }
}
