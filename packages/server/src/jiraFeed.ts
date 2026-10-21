import { existsSync, readFileSync } from 'node:fs';
import { catchupSummary, type JiraAlertEvent, type JiraEvent, type JiraEventKind, type JiraWatchSettings, type JiraWatchStatus, type TicketFacts } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/** The inbox keeps this long. */
export const KEEP_MS = 14 * 86_400_000;
/** A check this long after the last one is a catch-up (Cora was closed): told as one summary. */
export const CATCHUP_MS = 10 * 60_000;

/** What the watcher reports: when it checked (none: it didn't, e.g. paused), what it found, how it is, and which offered tickets are still yours. */
export type JiraBatch = { checkedAt?: number; events: JiraEvent[]; status: JiraWatchStatus; still?: string[]; /** what it read of each ticket */ tickets?: TicketFacts[] };
/** What's new to tell: each event with its level, or (a catch-up) one summary as well. */
export type JiraFresh = { events: JiraAlertEvent[]; summary?: string };
/** What the watcher needs to know: on or off, the site, the kinds, where to resume, the tickets Cora offered to start. */
export type WatchInfo = { on: boolean; site?: string; kinds: JiraWatchSettings['kinds']; since: number | null; offered: string[] };

type State = { checkedAt?: number; status: JiraWatchStatus; seen: Record<string, number>; events: JiraEvent[]; /** the latest of each ticket read (Cora's ticket prompt) */ tickets?: Record<string, TicketFacts & { at: number }> };

/**
 * Watching Jira, on the server's side: what's been seen (so restarts don't tell things twice), the last 14 days (Cora's
 * Jira inbox), where the watcher resumes, and what's new to tell (each event's level from your settings).
 */
export class JiraFeed {
  private st: State = { status: { state: 'ok' }, seen: {}, events: [] };

  constructor(private o: { file?: string; settings: () => JiraWatchSettings; onFresh?: (f: JiraFresh) => void; onChange?: () => void; now?: () => number; offered?: () => string[]; onStill?: (keys: string[]) => void }) {
    try {
      if (o.file && existsSync(o.file)) this.st = { ...this.st, ...(JSON.parse(readFileSync(o.file, 'utf8')) as State) };
    } catch {
      /* start afresh */
    }
  }

  private now = () => this.o.now?.() ?? Date.now();
  private save() {
    try {
      if (this.o.file) writeFileAtomic(this.o.file, JSON.stringify(this.st));
    } catch {
      /* not kept */
    }
  }

  watchInfo(): WatchInfo {
    const w = this.o.settings();
    return { on: w.on, ...(w.site ? { site: w.site } : {}), kinds: w.kinds, since: this.st.checkedAt ?? null, offered: this.o.offered?.() ?? [] };
  }

  status(): JiraWatchStatus {
    if (!this.o.settings().on) return { state: 'off' };
    return { ...this.st.status, ...(this.st.checkedAt ? { checkedAt: this.st.checkedAt } : {}) };
  }

  /** The watcher's report: new events (not seen before, kind not Off) are told; a late check is one summary too. */
  ingest(b: JiraBatch): JiraFresh {
    const kinds = this.o.settings().kinds;
    const prev = this.st.checkedAt;
    const fresh: JiraAlertEvent[] = [];
    for (const e of b.events) {
      if (this.st.seen[e.id]) continue;
      this.st.seen[e.id] = e.at;
      if (kinds[e.kind] === 'off') continue;
      fresh.push({ ...e, level: kinds[e.kind] });
      this.st.events.push(e);
    }
    const now = this.now();
    for (const t of b.tickets ?? []) (this.st.tickets ??= {})[t.key] = { ...t, at: now };
    if (b.checkedAt) this.st.checkedAt = b.checkedAt;
    this.st.status = b.status;
    if (b.still) this.o.onStill?.(b.still);
    const cutoff = this.now() - KEEP_MS;
    this.st.events = this.st.events.filter((e) => e.at >= cutoff);
    for (const [id, at] of Object.entries(this.st.seen)) if (at < cutoff) delete this.st.seen[id];
    for (const [k, t] of Object.entries(this.st.tickets ?? {})) if (t.at < cutoff) delete this.st.tickets![k];
    this.save();
    const late = prev != null && b.checkedAt != null && b.checkedAt - prev > CATCHUP_MS;
    const out: JiraFresh = { events: fresh, ...(late && fresh.length > 1 ? { summary: catchupSummary(fresh) } : {}) };
    if (fresh.length) this.o.onFresh?.(out);
    else this.o.onChange?.();
    return out;
  }

  /** The inbox: events since a while ago, newest first (optionally only some kinds). */
  recent(sinceMs: number, kinds?: JiraEventKind[]): JiraEvent[] {
    const from = this.now() - sinceMs;
    return this.st.events.filter((e) => e.at >= from && (!kinds?.length || kinds.includes(e.kind))).sort((a, b) => b.at - a.at);
  }

  /** What the watcher last read of a ticket (its summary, status, description), if it has. */
  ticket(key: string): TicketFacts | undefined {
    const t = this.st.tickets?.[key];
    if (!t) return undefined;
    const { at: _at, ...facts } = t;
    return facts;
  }

  /** Watching was turned on or off, or levels changed: the dashboard hears the status. */
  settingsChanged(): void {
    this.o.onChange?.();
  }
}
