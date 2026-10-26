import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TerminalInfo } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** A terminal that was open: a session's Claude, or a shell beside it (its kind's name; the Board's own, or a tab). */
export type Frozen = { id: string; sessionId: string; cwd: string; claude: boolean; shell?: string; place?: 'board'; at: number };

/** What there is to bring back: per session, its Claude (to resume) and its shells. */
export type ThawItem = { sessionId: string; cwd: string; claude: boolean; shells: Array<{ id: string; shell?: string; place?: 'board' }> };

/**
 * Deep freeze: the terminals open in Cora, kept current in a file, so that after the PC restarts (the terminal host
 * and everything in it gone) Cora can offer to bring them back: each session resumed in its folder, its shells opened
 * again. A terminal that ends while Cora watches (you ended the session, closed the shell, Claude quit) leaves it;
 * the terminal host going away (the PC shutting down) doesn't: that's exactly what to bring back.
 */
export class Freeze {
  private kept = new Map<string, Frozen>();
  /** terminals seen alive by this server: one gone from them since ended (unless the host went) */
  private seen = new Set<string>();
  private file: string | null;
  private timer: NodeJS.Timeout | null = null;
  constructor(dataDir: string | null, private now: () => number = Date.now) {
    this.file = dataDir ? join(dataDir, 'freeze.json') : null;
    try {
      if (this.file && existsSync(this.file)) for (const f of (JSON.parse(readFileSync(this.file, 'utf8')) as { terms?: Frozen[] }).terms ?? []) if (f?.id && f.sessionId && f.cwd) this.kept.set(f.id, f);
    } catch {
      /* none */
    }
  }

  /** The terminals as they are now (`hostGone`: the terminal host just went away, taking them with it). */
  update(list: TerminalInfo[], hostGone = false): void {
    let changed = false;
    const alive = new Set<string>();
    for (const t of list) {
      if (!t.alive) continue;
      alive.add(t.terminalId);
      this.seen.add(t.terminalId);
      const f: Frozen = { id: t.terminalId, sessionId: t.sessionId, cwd: t.cwd, claude: t.mode !== 'shell', ...(t.shell ? { shell: t.shell } : {}), ...(t.place ? { place: t.place } : {}), at: this.kept.get(t.terminalId)?.at ?? this.now() };
      const was = this.kept.get(t.terminalId);
      if (!was || was.sessionId !== f.sessionId || was.cwd !== f.cwd) changed = true;
      this.kept.set(t.terminalId, f);
    }
    // listed as ended (one that ended while Cora was closed, its host still running): not to bring back
    if (!hostGone) for (const t of list) if (!t.alive && this.kept.delete(t.terminalId)) changed = true;
    if (!hostGone)
      for (const id of [...this.seen])
        if (!alive.has(id)) {
          this.seen.delete(id);
          if (this.kept.delete(id)) changed = true;
        }
    if (changed) this.save();
  }

  /** What could be brought back now: sessions (and shells) kept, none of them open any more (`live`: open sessions' ids). */
  items(live: (sessionId: string, claude: boolean) => boolean): ThawItem[] {
    const by = new Map<string, ThawItem>();
    for (const f of this.kept.values()) {
      if (this.seen.has(f.id) || live(f.sessionId, f.claude)) continue;
      const it = by.get(f.sessionId) ?? { sessionId: f.sessionId, cwd: f.cwd, claude: false, shells: [] };
      if (f.claude) (it.claude = true), (it.cwd = f.cwd);
      else it.shells.push({ id: f.id, ...(f.shell ? { shell: f.shell } : {}), ...(f.place ? { place: f.place } : {}) });
      by.set(f.sessionId, it);
    }
    return [...by.values()];
  }

  /** When the newest of them was opened. */
  get at(): number | null {
    const ats = [...this.kept.values()].filter((f) => !this.seen.has(f.id)).map((f) => f.at);
    return ats.length ? Math.max(...ats) : null;
  }

  /** Let go of these sessions' kept terminals (brought back, or not wanted); none given: all of them. */
  forget(sessionIds?: string[]): void {
    let changed = false;
    for (const [id, f] of this.kept) if ((!sessionIds || sessionIds.includes(f.sessionId)) && !this.seen.has(id)) (this.kept.delete(id), (changed = true));
    if (changed) this.save();
  }

  private save(): void {
    if (!this.file) return;
    if (this.timer) clearTimeout(this.timer);
    // a burst of changes (a start, a restore) written once
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        writeFileAtomic(this.file!, JSON.stringify({ v: 1, terms: [...this.kept.values()] }));
      } catch {
        /* next change */
      }
    }, 500);
    this.timer.unref?.();
  }

  /** Written now (the server stopping). */
  flush(): void {
    if (!this.timer || !this.file) return;
    clearTimeout(this.timer);
    this.timer = null;
    try {
      writeFileAtomic(this.file, JSON.stringify({ v: 1, terms: [...this.kept.values()] }));
    } catch {
      /* lost */
    }
  }
}
