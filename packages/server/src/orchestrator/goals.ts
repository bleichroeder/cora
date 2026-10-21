import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Goal, GoalState } from '@cora/shared';
import { writeFileAtomic } from '../fsx';

const KEEP = 20;
const LIVE: GoalState[] = ['running', 'waiting', 'blocked'];

/**
 * What you've handed Cora on autopilot: one live goal at a time (starting another stops it), its workers, what it's
 * spent, Cora's progress notes. Kept in goals.json in Cora's folder, so a restart picks it back up.
 */
export class Goals {
  private list: Goal[] = [];

  constructor(
    private dir: string,
    private onChange: () => void,
  ) {
    try {
      const j = JSON.parse(readFileSync(this.file(), 'utf8'));
      if (Array.isArray(j)) this.list = j as Goal[];
    } catch {
      /* none yet */
    }
  }

  private file() {
    return join(this.dir, 'goals.json');
  }
  private save() {
    try {
      writeFileAtomic(this.file(), JSON.stringify(this.list.slice(0, KEEP), null, 2));
    } catch {
      /* the folder isn't there yet: kept in memory */
    }
    this.onChange();
  }

  /** The goal Cora is on (running, waiting for you, or blocked), if any. */
  active(): Goal | null {
    return this.list.find((g) => LIVE.includes(g.state)) ?? null;
  }
  /** The live goal, or the one that just ended (to show how it went). */
  current(): Goal | null {
    return this.active() ?? this.list[0] ?? null;
  }
  recent(): Goal[] {
    return this.list.slice(0, KEEP);
  }

  start(text: string, budget: number, now = Date.now()): Goal {
    const live = this.active();
    if (live) this.patch(live.id, { state: 'stopped', note: 'replaced by a new goal', endedAt: now }, false);
    const g: Goal = { id: randomUUID(), text: text.trim(), state: 'running', createdAt: now, updatedAt: now, budget, spent: 0, workers: [] };
    this.list = [g, ...this.list].slice(0, KEEP);
    this.save();
    return g;
  }

  private patch(id: string, p: Partial<Goal>, save = true): Goal | null {
    const i = this.list.findIndex((g) => g.id === id);
    if (i < 0) return null;
    const next = { ...this.list[i], ...p, updatedAt: Date.now() };
    this.list = this.list.map((g, j) => (j === i ? next : g));
    if (save) this.save();
    return next;
  }

  /** Cora's report on the live goal: its state, progress (0..1) and a note. */
  update(p: { state?: GoalState; progress?: number; note?: string }): Goal | null {
    const g = this.active();
    if (!g) return null;
    const ended = p.state === 'done' || p.state === 'stopped';
    return this.patch(g.id, {
      ...(p.state ? { state: p.state } : {}),
      ...(p.progress !== undefined ? { progress: Math.max(0, Math.min(1, p.progress)) } : {}),
      ...(p.note !== undefined ? { note: p.note.slice(0, 500) } : {}),
      ...(ended ? { endedAt: Date.now(), ...(p.state === 'done' ? { progress: 1 } : {}) } : {}),
    });
  }

  addWorker(sessionId: string): void {
    const g = this.active();
    if (g && !g.workers.includes(sessionId)) this.patch(g.id, { workers: [...g.workers, sessionId] });
  }
  isWorker(sessionId: string): boolean {
    return !!this.active()?.workers.includes(sessionId);
  }

  setSpent(n: number): void {
    const g = this.active();
    if (g && g.spent !== n) this.patch(g.id, { spent: n }, false), this.onChange();
  }

  stop(why: string): Goal | null {
    const g = this.active();
    return g ? this.patch(g.id, { state: 'stopped', note: why, endedAt: Date.now() }) : null;
  }
}
