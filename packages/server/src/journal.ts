import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { JOURNAL_TAGS, findRefs, mergeRefs, refsLine, type JournalEntry, type JournalRefs, type JournalTag } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** Where your Documents folder is (Windows may have moved it, to OneDrive): asked once, else ~/Documents. */
let docs: string | null = null;
export function documentsDir(): string {
  if (docs) return docs;
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("MyDocuments")'], { timeout: 8000, windowsHide: true, encoding: 'utf8' }).trim();
      if (out && existsSync(out)) return (docs = out);
    } catch {
      /* the usual place */
    }
  }
  return (docs = join(homedir(), 'Documents'));
}

/** The journal's folder: Documents\Cora\Journal. */
export const journalDir = () => join(documentsDir(), 'Cora', 'Journal');

export type JournalKind = 'entry' | 'wrapup' | 'recap';
export type JournalSession = { id: string; name: string; cwd: string; startedAt: number; ticket?: string };

/** A name a file can have (Windows'), short. */
const fileSafe = (s: string) =>
  s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 60) || 'session';

const pad = (n: number) => String(n).padStart(2, '0');
const day = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const stamp = (t: number) => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Each session's journal: a markdown file of its own (Documents\Cora\Journal\<year>\<month>\<date> <name> (<id>).md)
 * the session adds to at its milestones and wraps up when the work is done, with Claude Code's recaps along the way.
 * A plain file: readable anywhere, and kept wherever Documents is (OneDrive, if that's where yours is).
 */
export class Journal {
  /** each session's file (it keeps its first name: a rename doesn't move it) */
  private files = new Map<string, string>();
  private index: string | null;
  constructor(private o: { dir: () => string; dataDir: string | null; now?: () => number; /** your Jira projects' keys (an entry's tickets are found among them) */ projects?: () => string[] }) {
    this.index = o.dataDir ? join(o.dataDir, 'journal-index.json') : null;
    try {
      if (this.index && existsSync(this.index)) for (const [k, v] of Object.entries(JSON.parse(readFileSync(this.index, 'utf8')) as Record<string, string>)) this.files.set(k, v);
    } catch {
      /* new */
    }
  }
  private now = () => this.o.now?.() ?? Date.now();

  /** The session's journal file (made, with its heading, the first time). */
  fileFor(s: JournalSession): string {
    const known = this.files.get(s.id);
    if (known && existsSync(known)) return known;
    const d = new Date(s.startedAt || this.now());
    const folder = join(this.o.dir(), String(d.getFullYear()), pad(d.getMonth() + 1));
    mkdirSync(folder, { recursive: true });
    const file = join(folder, `${day(d.getTime())} ${fileSafe(s.name)} (${s.id.slice(0, 8)}).md`);
    if (!existsSync(file)) {
      const head = [`# ${s.name}`, '', `- **Folder:** \`${s.cwd}\``, `- **Started:** ${stamp(s.startedAt || this.now())}`, ...(s.ticket ? [`- **Ticket:** ${s.ticket}`] : []), `- **Session:** \`${s.id}\``, ''];
      writeFileAtomic(file, head.join('\n') + '\n');
    }
    this.files.set(s.id, file);
    try {
      if (this.index) writeFileAtomic(this.index, JSON.stringify(Object.fromEntries([...this.files].slice(-2000))));
    } catch {
      /* found again by its name next time */
    }
    return file;
  }

  /** A session's journal as it stands (none yet: null). */
  read(sessionId: string): { file: string; text: string } | null {
    const file = this.files.get(sessionId);
    if (!file || !existsSync(file)) return null;
    try {
      return { file, text: readFileSync(file, 'utf8') };
    } catch {
      return null;
    }
  }

  /** Add to a session's journal: an entry, its wrap-up, or a recap. The file's path. */
  add(s: JournalSession, kind: JournalKind, text: string, at = this.now(), more: { refs?: JournalRefs; tag?: JournalTag; repo?: string; branch?: string } = {}): string {
    // the index first (made from the files the first time: this entry isn't in them yet)
    this.all();
    const file = this.fileFor(s);
    const label = kind === 'wrapup' ? ' · Wrap-up' : kind === 'recap' ? ' · Recap' : '';
    const refs = more.refs ?? {};
    const line = refsLine(refs, more.tag);
    appendFileSync(file, `\n## ${stamp(at)}${label}\n\n${text.trim()}\n${line ? `\n${line}\n` : ''}`);
    this.keep({ id: `${s.id.slice(0, 8)}-${at.toString(36)}`, at, sessionId: s.id, session: s.name, cwd: s.cwd, repo: more.repo ?? repoName(s.cwd), ...(more.branch ? { branch: more.branch } : {}), kind, ...(more.tag ? { tag: more.tag } : {}), text: text.trim(), refs });
    return file;
  }

  // ---- Journal 2: every entry, searchable ----
  private entries: JournalEntry[] | null = null;
  private get entriesFile(): string | null {
    return this.o.dataDir ? join(this.o.dataDir, 'journal-entries.jsonl') : null;
  }
  private keep(e: JournalEntry): void {
    this.all().push(e);
    try {
      if (this.entriesFile) appendFileSync(this.entriesFile, JSON.stringify(e) + '\n');
    } catch {
      /* kept in memory until the next start, which reads the files again */
    }
  }
  /** Every entry: from the index; the first time (none yet), read from the journal files that are there. */
  private all(): JournalEntry[] {
    if (this.entries) return this.entries;
    const f = this.entriesFile;
    if (f && existsSync(f)) {
      this.entries = readFileSync(f, 'utf8')
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l) as JournalEntry];
          } catch {
            return [];
          }
        });
      return this.entries;
    }
    this.entries = readJournalFiles(this.o.dir(), this.o.projects?.() ?? []);
    try {
      if (f) writeFileAtomic(f, this.entries.map((e) => JSON.stringify(e)).join('\n') + (this.entries.length ? '\n' : ''));
    } catch {
      /* read again next time */
    }
    return this.entries;
  }

  /** When a session last wrote an entry (none: 0). */
  lastAt(sessionId: string): number {
    return this.all().reduce((m, e) => (e.sessionId === sessionId && e.at > m ? e.at : m), 0);
  }

  /** Entries that match, newest first: in a time window, about a ticket or merge request, in a repo, of a session, a kind, with these words. */
  query(q: { since?: number; until?: number; ticket?: string; mr?: string; repos?: string[]; sessionId?: string; tag?: JournalTag; words?: string; limit?: number } = {}): JournalEntry[] {
    const words = (q.words ?? '').toLowerCase().split(/\s+/).filter((w) => w.length >= 2);
    const repos = q.repos?.length ? new Set(q.repos.map((r) => r.toLowerCase())) : null;
    return this.all()
      .filter(
        (e) =>
          (q.since == null || e.at >= q.since) &&
          (q.until == null || e.at <= q.until) &&
          (!q.ticket || e.refs.tickets?.includes(q.ticket.toUpperCase())) &&
          (!q.mr || e.refs.mrs?.includes(q.mr.startsWith('!') ? q.mr : `!${q.mr}`)) &&
          (!repos || repos.has(e.repo.toLowerCase())) &&
          (!q.sessionId || e.sessionId === q.sessionId) &&
          (!q.tag || e.tag === q.tag) &&
          words.every((w) => `${e.session} ${e.text} ${refsLine(e.refs)}`.toLowerCase().includes(w)),
      )
      .sort((a, b) => b.at - a.at)
      .slice(0, q.limit ?? 50);
  }
}

/** A folder's repo name: its last part (a worktree's: the repo it's of). */
export function repoName(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  const at = parts.lastIndexOf('worktrees');
  if (at >= 2 && parts[at - 1] === '.claude') return parts[at - 2];
  return parts.at(-1) ?? '';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Oct 29, 7:37 PM" in a year: a time (null when it isn't one). */
export function parseStamp(s: string, year: number): number | null {
  const m = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{1,2}):(\d{2}) ([AP]M)$/.exec(s.trim());
  if (!m) return null;
  const mon = MONTHS.indexOf(m[1]);
  if (mon < 0) return null;
  const h = (Number(m[3]) % 12) + (m[5] === 'PM' ? 12 : 0);
  return new Date(year, mon, Number(m[2]), h, Number(m[4])).getTime();
}

/** The entries in the journal files already written (the first time the index is made): their refs found in their text. */
export function readJournalFiles(dir: string, projects: string[]): JournalEntry[] {
  const out: JournalEntry[] = [];
  const walk = (d: string): string[] => {
    try {
      return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith('.md') ? [join(d, e.name)] : []));
    } catch {
      return [];
    }
  };
  for (const file of walk(dir)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const year = Number(/(\d{4})-\d{2}-\d{2}/.exec(file.replace(/\\/g, '/').split('/').pop() ?? '')?.[1]) || new Date().getFullYear();
    const name = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? 'session';
    const sessionId = /\*\*Session:\*\* `([^`]+)`/.exec(text)?.[1] ?? '';
    const cwd = /\*\*Folder:\*\* `([^`]+)`/.exec(text)?.[1] ?? '';
    const ticket = /\*\*Ticket:\*\* ([A-Z][A-Z0-9]+-\d+)/.exec(text)?.[1];
    const parts = text.split(/^## /m).slice(1);
    for (const p of parts) {
      const nl = p.indexOf('\n');
      const head = (nl < 0 ? p : p.slice(0, nl)).trim();
      const [when, label] = head.split(' · ');
      const at = parseStamp(when, year);
      if (at == null) continue;
      const rest = nl < 0 ? '' : p.slice(nl + 1);
      const refsAt = /^Refs: (.*)$/m.exec(rest);
      const body = rest.replace(/^Refs: .*$/m, '').trim();
      if (!body) continue;
      const kind: JournalKind = label === 'Wrap-up' ? 'wrapup' : label === 'Recap' ? 'recap' : 'entry';
      // its Refs line: its kind first, when it had one; its tickets, merge requests and issues found with the text's
      const first = refsAt?.[1].split(' · ')[0] as JournalTag | undefined;
      const tag = first && (JOURNAL_TAGS as readonly string[]).includes(first) ? first : undefined;
      const refs = mergeRefs(ticket ? { tickets: [ticket] } : {}, findRefs(`${body}\n${refsAt?.[1] ?? ''}`, { projects }));
      out.push({ id: `${sessionId.slice(0, 8)}-${at.toString(36)}`, at, sessionId, session: name, cwd, repo: repoName(cwd), kind, ...(tag ? { tag } : {}), text: body, refs });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const branches = new Map<string, { v: string | null; at: number }>();
/** The branch a folder is on (a minute's cache; none: not a repo, or a detached head). */
export function gitBranch(cwd: string): string | null {
  const hit = branches.get(cwd);
  if (hit && Date.now() - hit.at < 60_000) return hit.v;
  let v: string | null = null;
  try {
    v = execFileSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], { timeout: 2000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    if (v === 'HEAD') v = null;
  } catch {
    v = null;
  }
  branches.set(cwd, { v, at: Date.now() });
  return v;
}
