import { execFile } from 'node:child_process';
import { openSync, readSync, closeSync, readFileSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { structuredPatch } from 'diff';
import { MAX_CHANGE_LINES, type Hunk } from '@cora/shared';

/** Paths compared case-insensitively with one kind of slash (Windows). */
export const normPath = (p: string) => resolve(p).replace(/\\/g, '/').toLowerCase();

type Backup = { name: string | null };
/** One prompt's file snapshot (Claude Code's rewind data): every tracked file as it was when the prompt was sent. */
export type Snapshot = { messageId: string; ts: number; files: Map<string, Backup> };

/** A transcript is read this much at a time. */
const CHUNK = 16 << 20;

/** Reads a transcript's file-history snapshots, incrementally (transcripts grow; we only parse what's new). */
export class SnapshotReader {
  constructor(/** read this much at a time (tests make it small) */ private chunk = CHUNK) {}
  private cache = new Map<string, { offset: number; byId: Map<string, Snapshot>; list: Snapshot[] }>();

  read(transcript: string): Snapshot[] {
    let c = this.cache.get(transcript);
    if (!c) this.cache.set(transcript, (c = { offset: 0, byId: new Map(), list: [] }));
    let size: number;
    try {
      size = statSync(transcript).size;
    } catch {
      return c.list;
    }
    if (size < c.offset) c.offset = 0; // rewritten
    if (size === c.offset) return c.list;
    // a piece at a time: a long session's transcript can be bigger than one string can hold
    const fd = openSync(transcript, 'r');
    try {
      let want = this.chunk;
      while (c.offset < size) {
        const buf = Buffer.alloc(Math.min(want, size - c.offset));
        readSync(fd, buf, 0, buf.length, c.offset);
        const end = buf.lastIndexOf(0x0a);
        if (end < 0) {
          // a line longer than the piece: read a bigger one, unless it's the last line still being written
          if (c.offset + buf.length >= size) break;
          want *= 2;
          continue;
        }
        want = this.chunk;
        for (const line of buf.toString('utf8', 0, end).split('\n')) {
          if (!line.includes('"file-history-snapshot"')) continue;
          let o: any;
          try {
            o = JSON.parse(line);
          } catch {
            continue;
          }
          if (o?.type !== 'file-history-snapshot' || !o.snapshot?.trackedFileBackups) continue;
          let s = c.byId.get(o.messageId);
          if (!s) {
            s = { messageId: o.messageId, ts: Date.parse(o.snapshot.timestamp) || 0, files: new Map() };
            c.byId.set(o.messageId, s);
            c.list.push(s);
          }
          // updates for the same prompt add the files first touched during its turn
          for (const [k, v] of Object.entries<any>(o.snapshot.trackedFileBackups)) {
            const abs = v?.realParentDir ? join(v.realParentDir, basename(k)) : k;
            // a backup is a plain file name inside the session's file-history folder: never a path out of it
            // (docs/audit-2026-10-20.md S9)
            const name = typeof v?.backupFileName === 'string' && /^[^\\/]+$/.test(v.backupFileName) && v.backupFileName !== '..' ? v.backupFileName : null;
            s.files.set(normPath(abs), { name });
          }
        }
        c.offset += end + 1;
      }
      c.list.sort((a, b) => a.ts - b.ts);
    } finally {
      closeSync(fd);
    }
    return c.list;
  }
}
export const snapshots = new SnapshotReader();

export const fileHistoryDir = (sessionId: string, home = homedir()) => join(home, '.claude', 'file-history', sessionId);

const readText = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

export type NetChange = { hunks: Hunk[] | null; add: number; del: number; exact: boolean; before: 'snapshot' | 'none'; tooBig?: boolean };

/**
 * What a span of the session did to one file: the file as it was when the span's prompt was sent (Claude Code's
 * snapshot) against the file at the next prompt's snapshot, or on disk now. Includes changes made any way during
 * the span (edit tools, scripts, shell). `exact: false` when there's no snapshot to start from.
 */
/**
 * A file as it was when a span's prompt was sent (Claude Code's snapshot then): '' when it didn't exist yet, null
 * when there's no snapshot of it.
 */
export function turnBefore(o: { transcript: string; sessionId: string; path: string; from: number; home?: string }): string | null {
  const key = normPath(o.path);
  const list = snapshots.read(o.transcript);
  // the snapshot taken when this span's prompt was sent (a moment after the prompt's own timestamp)
  const start = list.filter((s) => s.ts <= o.from + 10_000 && s.files.has(key)).pop() ?? list.find((s) => s.ts >= o.from - 10_000 && s.files.has(key));
  if (!start) return null;
  const b = start.files.get(key)!;
  return b.name ? readText(join(fileHistoryDir(o.sessionId, o.home), b.name)) : ''; // no backup: the file didn't exist yet
}

export function netChange(o: { transcript: string; sessionId: string; path: string; from: number; to: number | null; home?: string }): NetChange {
  const key = normPath(o.path);
  const list = snapshots.read(o.transcript);
  const dir = fileHistoryDir(o.sessionId, o.home);
  let before = turnBefore(o);
  if (before == null) return { hunks: null, add: 0, del: 0, exact: false, before: 'none' };
  // the end: the next prompt's snapshot of the file, or the file now
  let after: string | null = null;
  if (o.to != null) {
    const next = list.find((s) => s.ts > o.to! && s.files.has(key));
    const b = next?.files.get(key);
    if (b) after = b.name ? readText(join(dir, b.name)) : '';
  }
  if (after == null) after = readText(o.path) ?? '';
  // line endings aren't a change worth showing (a CRLF rewrite would otherwise mark every line)
  before = before.replace(/\r\n/g, '\n');
  after = after.replace(/\r\n/g, '\n');
  const hunks = structuredPatch('a', 'b', before, after, '', '', { context: 3 }).hunks.map((h) => ({ oldStart: h.oldStart, oldLines: h.oldLines, newStart: h.newStart, newLines: h.newLines, lines: h.lines }));
  let add = 0;
  let del = 0;
  let n = 0;
  for (const h of hunks) for (const l of h.lines) (n++, l[0] === '+' ? add++ : l[0] === '-' ? del++ : 0);
  return n > MAX_CHANGE_LINES * 4 ? { hunks: null, add, del, exact: true, before: 'snapshot', tooBig: true } : { hunks, add, del, exact: true, before: 'snapshot' };
}

// ---------------------------------------------------------------- git: everything uncommitted (shell edits included)
const git = (cwd: string, args: string[]) =>
  new Promise<{ code: number; out: string }>((res) =>
    execFile('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 32 << 20, timeout: 8000, windowsHide: true }, (err, stdout) =>
      res({ code: err ? ((err as any).code ?? 1) : 0, out: String(stdout ?? '') }),
    ),
  );

export type GitFile = { path: string; status: string; add: number; del: number; binary?: boolean };

/** Uncommitted changes in the repo containing `cwd`: tracked files against HEAD, plus untracked files. */
export async function gitChanges(cwd: string): Promise<{ repo: boolean; root?: string; branch?: string; files: GitFile[] }> {
  if (!cwd || !existsSync(cwd)) return { repo: false, files: [] };
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { repo: false, files: [] };
  const root = top.out.trim();
  const [status, num, branch] = await Promise.all([git(root, ['status', '--porcelain=v1', '-uall']), git(root, ['diff', 'HEAD', '--numstat']), git(root, ['branch', '--show-current'])]);
  const counts = new Map<string, { add: number; del: number; binary: boolean }>();
  for (const l of num.out.split('\n')) {
    const m = l.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (m) counts.set(m[3], { add: m[1] === '-' ? 0 : Number(m[1]), del: m[2] === '-' ? 0 : Number(m[2]), binary: m[1] === '-' });
  }
  const files: GitFile[] = [];
  for (const l of status.out.split('\n')) {
    if (l.length < 4) continue;
    const st = l.slice(0, 2);
    let p = l.slice(3);
    if (p.includes(' -> ')) p = p.split(' -> ')[1];
    p = p.replace(/^"|"$/g, '');
    const c = counts.get(p);
    let add = c?.add ?? 0;
    if (st === '??') {
      const t = readText(join(root, p));
      add = t == null ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
    }
    files.push({ path: join(root, p), status: st.trim() || st, add, del: c?.del ?? 0, ...(c?.binary ? { binary: true } : {}) });
  }
  return { repo: true, root, branch: branch.out.trim() || undefined, files };
}

/** One file's uncommitted diff (unified text): against HEAD, or the whole file when it's untracked. */
export async function gitDiff(cwd: string, path: string): Promise<{ patch: string } | { error: string }> {
  const top = await git(cwd, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return { error: 'not a git repository' };
  const root = top.out.trim();
  const abs = isAbsolute(path) ? path : join(root, path);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return { error: 'that file is outside the repository' };
  const tracked = await git(root, ['ls-files', '--error-unmatch', '--', rel]);
  const r = tracked.code === 0 ? await git(root, ['diff', 'HEAD', '--', rel]) : await git(root, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', rel]);
  return { patch: r.out };
}
