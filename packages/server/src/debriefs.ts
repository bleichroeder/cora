import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { checkScript, type Debrief, type DebriefCovers, type DebriefSnap, type DebriefSummary } from '@cora/shared';
import { normPath, snapshots, turnBefore } from './changes';
import { writeFileAtomic } from './fsx';

/** Lines kept around a step's range, so a replay later shows it in its place. */
const AROUND = 20;
/** A file's before-text kept for a diff step at most (bigger: the step shows the file now). */
const MAX_BEFORE = 400_000;
const okId = (s: string) => /^[\w-]{1,80}$/.test(s);

/** The git repo a file or folder is in (its top folder), or null. Asked once per folder. */
const roots = new Map<string, string | null>();
export function repoOf(p: string): string | null {
  let dir = p;
  try {
    if (!statSync(p).isDirectory()) dir = dirname(p);
  } catch {
    dir = dirname(p);
  }
  const k = normPath(dir);
  if (roots.has(k)) return roots.get(k)!;
  let top: string | null = null;
  try {
    top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    /* not in a repo */
  }
  roots.set(k, top ? resolve(top) : null);
  return roots.get(k)!;
}

/** A file as git last committed it (a change made through the shell has no Claude Code snapshot), or null. */
function committed(abs: string): string | null {
  const top = repoOf(abs);
  if (!top) return null;
  try {
    return execFileSync('git', ['show', `HEAD:${relative(top, resolve(abs)).replace(/\\/g, '/')}`], { cwd: top, encoding: 'utf8', timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // new since (or not in git)
  }
}

type Before = (o: { transcript: string; sessionId: string; path: string; from: number }) => string | null;

/**
 * Sessions' debriefs: a script checked against the files (each
 * one the session's, there, its lines within it), its code kept as it is now (and a diff step's file as it was before
 * the work), stored in <dir>/<session>/<id>.json. Never half-saved: a failing step goes back to the session, named.
 */
export class Debriefs {
  constructor(private o: { dir: string; onChange?: (sessionId: string) => void; before?: Before }) {}

  make(sessionId: string, cwd: string, transcript: string | null | undefined, raw: unknown, o: { from?: number; covers?: DebriefCovers } = {}): { ok: true; debrief: Debrief } | { ok: false; errors: string[] } {
    const from = o.from ?? 0;
    if (!okId(sessionId)) return { ok: false, errors: ['not a session'] };
    const checked = checkScript(raw);
    if (!checked.ok) return checked;
    const script = checked.script;
    const errors: string[] = [];
    const snaps: Record<number, DebriefSnap> = {};
    // the session's: its folder, the files it changed (Claude Code's snapshots), and the repos it changed files in (a
    // file changed through the shell is in no snapshot, but it's in the same repo as the rest of the work)
    const changed = transcript ? [...new Set(snapshots.read(transcript).flatMap((s) => [...s.files.keys()]))] : [];
    const repos = new Set([...changed, ...(cwd ? [cwd] : [])].map(repoOf).filter((r): r is string => !!r).map(normPath));
    const mineOf = (abs: string) => {
      const repo = repoOf(abs);
      return (!!cwd && normPath(abs).startsWith(normPath(cwd) + '/')) || changed.includes(normPath(abs)) || (!!repo && repos.has(normPath(repo)));
    };
    const steps = script.steps.map((raw, i) => {
      const at = `step ${i + 1}`;
      let st = raw;
      // its picture: the session's, and there
      if (st.shot) {
        const abs = isAbsolute(st.shot.file) ? resolve(st.shot.file) : resolve(cwd || '.', st.shot.file);
        if (!mineOf(abs)) errors.push(`${at}: ${st.shot.file} isn't in the session's folder or a repo it changed files in`);
        else if (!existsSync(abs) || !statSync(abs).isFile()) errors.push(`${at}: there's no picture ${st.shot.file}`);
        else st = { ...st, shot: { ...st.shot, file: abs } };
      }
      if (!st.path) return st;
      const abs = isAbsolute(st.path) ? resolve(st.path) : resolve(cwd || '.', st.path);
      if (!mineOf(abs)) {
        errors.push(`${at}: ${st.path} isn't in the session's folder, a file it changed, or a repo it changed files in`);
        return st;
      }
      let text: string;
      try {
        if (!statSync(abs).isFile()) throw new Error('not a file');
        text = readFileSync(abs, 'utf8');
      } catch {
        errors.push(`${at}: there's no file ${st.path}`);
        return st;
      }
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
      const n = lines.length;
      const past = (r?: [number, number]) => !!r && r[1] > n;
      if (past(st.range)) errors.push(`${at}: lines ${st.range![0]}-${st.range![1]} are past the end of ${st.path} (${n} lines)`);
      st.beats.forEach((b, j) => past(b.range) && errors.push(`${at}, beat ${j + 1}: lines ${b.range![0]}-${b.range![1]} are past the end of ${st.path} (${n} lines)`));
      const span = [st.range, ...st.beats.map((b) => b.range)].filter((r): r is [number, number] => !!r);
      if (span.length) {
        const start = Math.max(1, Math.min(...span.map((r) => r[0])) - AROUND);
        const end = Math.min(n, Math.max(...span.map((r) => r[1])) + AROUND);
        snaps[i] = { start, lines: lines.slice(start - 1, end) };
      }
      if (st.diff) {
        // as it was before the work: Claude Code's snapshot, else (changed through the shell) git's last commit
        const before = (transcript ? (this.o.before ?? turnBefore)({ transcript, sessionId, path: abs, from }) : null) ?? committed(abs);
        if (before != null && before.length <= MAX_BEFORE) snaps[i] = { ...(snaps[i] ?? { start: 1, lines: [] }), before };
      }
      return { ...st, path: abs };
    });
    if (errors.length) return { ok: false, errors };
    const debrief: Debrief = { ...script, steps, id: `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`, sessionId, createdAt: Date.now(), ...(from ? { from, to: Date.now() } : {}), snaps, ...(o.covers ? { covers: o.covers } : {}) };
    const dir = join(this.o.dir, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${debrief.id}.json`), JSON.stringify(debrief));
    this.o.onChange?.(sessionId);
    return { ok: true, debrief };
  }

  /** A session's debriefs, newest first. */
  list(sessionId: string): DebriefSummary[] {
    if (!okId(sessionId)) return [];
    const dir = join(this.o.dir, sessionId);
    if (!existsSync(dir)) return [];
    const out: DebriefSummary[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const d = this.get(sessionId, f.slice(0, -5));
      if (d) out.push({ id: d.id, title: d.title, depth: d.depth, steps: d.steps.length, createdAt: d.createdAt, ...(d.from ? { from: d.from } : {}), ...(d.covers ? { changed: d.covers.changed.length, missed: d.covers.missed } : {}) });
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  get(sessionId: string, id: string): Debrief | null {
    if (!okId(sessionId) || !okId(id)) return null;
    try {
      const d = JSON.parse(readFileSync(join(this.o.dir, sessionId, `${id}.json`), 'utf8')) as Debrief;
      return d && d.id === id && Array.isArray(d.steps) ? d : null;
    } catch {
      return null;
    }
  }
}
