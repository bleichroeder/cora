import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
  constructor(private o: { dir: () => string; dataDir: string | null; now?: () => number }) {
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
  add(s: JournalSession, kind: JournalKind, text: string, at = this.now()): string {
    const file = this.fileFor(s);
    const label = kind === 'wrapup' ? ' · Wrap-up' : kind === 'recap' ? ' · Recap' : '';
    appendFileSync(file, `\n## ${stamp(at)}${label}\n\n${text.trim()}\n`);
    return file;
  }
}
