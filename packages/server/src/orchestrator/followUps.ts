import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { MAX_FOLLOW_UPS, type BrainEvent, type FollowUp } from '@cora/shared';
import { writeFileAtomic } from '../fsx';
import { turnSince } from './talk';

/**
 * Cora's follow-ups (shared/followUps.ts): kept in her folder (they survive a restart), looked at every few seconds.
 * One comes as a line for Cora: what the user wanted to hear about, and what the session said and did since.
 */
export type FollowUpDeps = {
  file?: string;
  events(sessionId: string, since: number): BrainEvent[];
  nameOf(sessionId: string): string;
  /** the session ended (its process went) */
  ended?(sessionId: string): boolean;
  /** a line for Cora */
  tell(line: string): void;
  onChange?(): void;
  now?: () => number;
};

const MAX_TEXT = 2000;

export class FollowUps {
  private list_: FollowUp[] = [];

  constructor(private d: FollowUpDeps) {
    try {
      if (d.file && existsSync(d.file)) {
        const j = JSON.parse(readFileSync(d.file, 'utf8'));
        if (Array.isArray(j)) this.list_ = j.filter((f) => f && typeof f.id === 'string' && typeof f.about === 'string');
      }
    } catch {
      /* none */
    }
  }
  private now = () => this.d.now?.() ?? Date.now();

  list(): FollowUp[] {
    return [...this.list_];
  }

  add(f: Omit<FollowUp, 'id' | 'createdAt' | 'since'>): FollowUp | { error: string } {
    if (this.list_.length >= MAX_FOLLOW_UPS) return { error: `There are already ${MAX_FOLLOW_UPS} follow-ups: cancel one first.` };
    const now = this.now();
    const x: FollowUp = { ...f, id: randomUUID().slice(0, 8), since: now, createdAt: now };
    this.list_.push(x);
    this.changed();
    return x;
  }

  cancel(id: string): boolean {
    const n = this.list_.length;
    this.list_ = this.list_.filter((f) => f.id !== id);
    if (this.list_.length === n) return false;
    this.changed();
    return true;
  }

  /** Look at each: due ones come (and go when they've come as often as asked); run-out ones go, said so. */
  tick(): void {
    const now = this.now();
    let changed = false;
    for (const f of [...this.list_]) {
      const name = f.sessionId ? this.d.nameOf(f.sessionId) : '';
      const who = f.sessionId ? `"${name}" (${f.sessionId})` : '';
      if (now > f.until) {
        this.list_ = this.list_.filter((x) => x !== f);
        this.d.tell(`[Follow-up] ran out: ${f.about}${who ? ` (${who})` : ''}: nothing came in time.`);
        changed = true;
        continue;
      }
      let due = false;
      let how = '';
      if (f.on === 'turn' && f.sessionId) {
        const ev = this.d.events(f.sessionId, f.since);
        const end = ev.find((e) => e.agentId === 'main' && e.kind === 'turn_end' && e.ts > f.since);
        if (end) (due = true), (how = 'finished its turn');
        else if (this.d.ended?.(f.sessionId)) (due = true), (how = 'ended');
      } else if (f.on === 'time' && f.next != null && now >= f.next) {
        due = true;
        how = 'at the time you set';
      }
      if (!due) continue;
      const r = f.sessionId ? turnSince(this.d.events(f.sessionId, f.since), f.since) : null;
      const body = r ? (r.text.length > MAX_TEXT ? `${r.text.slice(0, MAX_TEXT - 1)}… (session for the rest)` : r.text) || '(nothing said since)' : '';
      const tools = r?.tools.length ? ` (it used ${r.tools.join(', ')})` : '';
      // brackets in what the session said can't pass for Cora's own markers
      const said = body.replace(/\[/g, '(').replace(/\]/g, ')');
      this.d.tell(`[Follow-up] ${f.about}${who ? `: ${who} ${how}${tools}` : ` (${how})`}${said ? `:\n${said}` : ''}`);
      f.left--;
      f.since = now;
      if (f.on === 'time' && f.everyMs) f.next = (f.next ?? now) + f.everyMs;
      if (f.left <= 0 || (f.on === 'time' && !f.everyMs)) this.list_ = this.list_.filter((x) => x !== f);
      changed = true;
    }
    if (changed) this.changed();
  }

  private changed(): void {
    try {
      if (this.d.file) writeFileAtomic(this.d.file, JSON.stringify(this.list_));
    } catch {
      /* kept in memory */
    }
    this.d.onChange?.();
  }
}

/** "14:30", "2:30 PM", "in 30m", "30m", "2h" or an ISO time: when, from now (null: not a time). */
export function parseWhen(s: string, now: number): number | null {
  const t = s.trim().toLowerCase().replace(/^in\s+/, '');
  const rel = /^(\d+)\s*(m|min|mins|minutes|h|hr|hrs|hours)$/.exec(t);
  if (rel) return now + Number(rel[1]) * (rel[2].startsWith('h') ? 3_600_000 : 60_000);
  const clock = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(t);
  if (clock && (clock[2] || clock[3])) {
    let h = Number(clock[1]) % (clock[3] ? 12 : 24);
    if (clock[3] === 'pm') h += 12;
    const d = new Date(now);
    d.setHours(h, Number(clock[2] ?? 0), 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }
  const iso = Date.parse(s);
  return Number.isFinite(iso) && iso > now ? iso : null;
}
