import { existsSync, readFileSync } from 'node:fs';
import { looksLikeStandup, type CalAttendee, type CalEvent, type CalendarMsg, type CalendarStatus } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * Cora knows your day: your primary Google calendar, read only,
 * through Gmail's Google sign-in. Today's and tomorrow's calls, every 5 minutes; a call coming up is handed on once
 * (again if it moves). Nothing is ever written to the calendar.
 */

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const CALENDAR_POLL_MS = 5 * 60_000;
/** How often Cora looks for a call coming up. */
export const CALENDAR_TICK_MS = 30_000;
const MAX_ABOUT = 1500;
/** Told calls are forgotten after this. */
const TOLD_KEEP_MS = 3 * 86_400_000;

export type CalendarDeps = {
  /** Gmail's Google sign-in is there */
  connected(): boolean;
  /** an access token from it */
  token(): Promise<string>;
  /** did Google grant the calendar (undefined: not known yet) */
  granted(): boolean | undefined;
  /** minutes before a call to hand it on (0: never) */
  lead(): number;
  /** calendar.json: the calls you marked (or unmarked) as standups, the calls told, their prep notes */
  file?: string;
  fetch?: typeof fetch;
  now?: () => number;
  onChange?(m: CalendarMsg): void;
  /** a call is coming up (once per call and start time) */
  due?(e: CalEvent, minutes: number): void;
};

type Kept = { standup: Record<string, boolean>; told: Record<string, number>; prep: Record<string, string> };

/** Strip an invite's HTML down to its text. */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

const VIDEO = /https:\/\/(?:[\w-]+\.)?(?:zoom\.us|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|webex\.com|whereby\.com)\/[^\s<>"]+/i;

/** Google's event as a call, or null: cancelled, all day, declined by you, or not a meeting (out of office, focus time…). */
export function mapEvent(raw: any, marks: Record<string, boolean> = {}): CalEvent | null {
  if (!raw?.id || raw.status === 'cancelled') return null;
  if (raw.eventType && raw.eventType !== 'default' && raw.eventType !== 'fromGmail') return null;
  const start = Date.parse(raw.start?.dateTime ?? '');
  const end = Date.parse(raw.end?.dateTime ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const attendees: CalAttendee[] = (Array.isArray(raw.attendees) ? raw.attendees : [])
    .filter((a: any) => a?.email && !a.resource)
    .map((a: any) => ({ email: String(a.email), ...(a.displayName ? { name: String(a.displayName) } : {}), ...(a.self ? { self: true } : {}), ...(a.responseStatus ? { response: a.responseStatus } : {}) }));
  if (attendees.some((a) => a.self && a.response === 'declined')) return null;
  const video = (raw.conferenceData?.entryPoints ?? []).find((p: any) => p?.entryPointType === 'video' && /^https:\/\//.test(p.uri ?? ''))?.uri;
  const about = plainText(String(raw.description ?? ''));
  const link: string | undefined = raw.hangoutLink || video || VIDEO.exec(String(raw.location ?? ''))?.[0] || VIDEO.exec(about)?.[0];
  const title = String(raw.summary ?? '').trim() || '(no title)';
  const series = raw.recurringEventId ? String(raw.recurringEventId) : undefined;
  const key = series ?? String(raw.id);
  return {
    id: String(raw.id),
    ...(series ? { series } : {}),
    title,
    start,
    end,
    attendees,
    ...(link ? { link } : {}),
    ...(about ? { about: about.length > MAX_ABOUT ? `${about.slice(0, MAX_ABOUT - 1)}…` : about } : {}),
    ...(raw.htmlLink ? { url: String(raw.htmlLink) } : {}),
    standup: marks[key] ?? looksLikeStandup(title, !!series),
  };
}

/** The calls to hand on now: starting within `lead` minutes, not started, not told at this start time. */
export function dueNow(events: CalEvent[], now: number, lead: number, told: Record<string, number>): CalEvent[] {
  if (!lead) return [];
  return events.filter((e) => e.start > now && e.start - now <= lead * 60_000 && !told[`${e.id}@${e.start}`]);
}

/** The people on a call (not you): names, else addresses. */
export const withWhom = (e: CalEvent, max = 4): string => {
  const others = e.attendees.filter((a) => !a.self).map((a) => a.name ?? a.email);
  return others.length > max ? `${others.slice(0, max).join(', ')} and ${others.length - max} more` : others.join(', ');
};

export class Calendar {
  private events: CalEvent[] = [];
  private status: CalendarStatus = { state: 'off' };
  private kept: Kept = { standup: {}, told: {}, prep: {} };
  private poll: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  private fetch: typeof fetch;
  private now: () => number;

  constructor(private d: CalendarDeps) {
    this.fetch = d.fetch ?? fetch;
    this.now = d.now ?? Date.now;
    try {
      if (d.file && existsSync(d.file)) {
        const j = JSON.parse(readFileSync(d.file, 'utf8'));
        this.kept = { standup: j.standup ?? {}, told: j.told ?? {}, prep: j.prep ?? {} };
      }
    } catch {
      /* start afresh */
    }
  }

  start(): void {
    if (this.poll) return;
    void this.refresh();
    this.poll = setInterval(() => void this.refresh(), CALENDAR_POLL_MS);
    this.tick = setInterval(() => this.check(), CALENDAR_TICK_MS);
    this.poll.unref?.();
    this.tick.unref?.();
  }
  stop(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.tick) clearInterval(this.tick);
    this.poll = this.tick = null;
  }

  msg(): CalendarMsg {
    return { t: 'calendar', status: this.status, events: this.events.map((e) => (this.kept.prep[e.id] ? { ...e, prep: this.kept.prep[e.id] } : e)) };
  }
  /** Today's and tomorrow's calls, soonest first. */
  list(): CalEvent[] {
    return this.msg().events;
  }
  get(id: string): CalEvent | undefined {
    return this.list().find((e) => e.id === id);
  }

  /** Read the calendar again now (after a reconnect, or when you ask). */
  refresh(): Promise<void> {
    this.busy ??= this.load().finally(() => (this.busy = null));
    return this.busy;
  }

  private async load(): Promise<void> {
    const was = JSON.stringify(this.msg());
    if (!this.d.connected()) {
      this.status = { state: 'off' };
      this.events = [];
    } else if (this.d.granted() === false) {
      this.status = { state: 'scope' };
      this.events = [];
    } else {
      try {
        const day = new Date(this.now());
        day.setHours(0, 0, 0, 0);
        const q = new URLSearchParams({ timeMin: day.toISOString(), timeMax: new Date(day.getTime() + 2 * 86_400_000).toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '100' });
        const r = await this.fetch(`${API}?${q}`, { headers: { authorization: `Bearer ${await this.d.token()}` } });
        const j: any = await r.json().catch(() => ({}));
        if (r.status === 403 && /insufficient|scope/i.test(JSON.stringify(j.error ?? ''))) {
          this.status = { state: 'scope' };
          this.events = [];
        } else if (!r.ok) {
          const why = String(j.error?.message ?? r.status);
          // the API isn't switched on in the user's Google Cloud project
          const hint = /has not been used|is disabled/i.test(why) ? 'Turn on the Google Calendar API in your Google Cloud project (APIs & Services › Library), then wait a minute.' : `Google Calendar: ${why}`;
          this.status = { ...this.status, state: this.status.state === 'off' ? 'connected' : this.status.state, error: hint };
        } else {
          this.events = (Array.isArray(j.items) ? j.items : [])
            .map((x: any) => mapEvent(x, this.kept.standup))
            .filter((e: CalEvent | null): e is CalEvent => !!e)
            .sort((a: CalEvent, b: CalEvent) => a.start - b.start);
          this.status = { state: 'connected', lastCheck: this.now() };
        }
      } catch (e) {
        this.status = { ...this.status, error: `Couldn't read your calendar: ${(e as Error).message}` };
      }
    }
    if (JSON.stringify(this.msg()) !== was) this.d.onChange?.(this.msg());
    this.check();
  }

  /** Calls coming up: each handed on once (again at a new time if it moves). */
  check(): void {
    const now = this.now();
    const lead = this.d.lead();
    const due = dueNow(this.list(), now, lead, this.kept.told);
    if (!due.length) return;
    for (const e of due) this.kept.told[`${e.id}@${e.start}`] = now;
    for (const [k, at] of Object.entries(this.kept.told)) if (now - at > TOLD_KEEP_MS) delete this.kept.told[k];
    this.save();
    for (const e of due) this.d.due?.(e, Math.max(1, Math.round((e.start - now) / 60_000)));
  }

  /** Mark a call (its whole series) as a standup, or not. */
  markStandup(id: string, on: boolean): CalEvent | null {
    const e = this.events.find((x) => x.id === id);
    if (!e) return null;
    const key = e.series ?? e.id;
    this.kept.standup[key] = on;
    this.events = this.events.map((x) => ((x.series ?? x.id) === key ? { ...x, standup: on } : x));
    this.save();
    this.d.onChange?.(this.msg());
    return this.get(id) ?? null;
  }

  /** A call's prep note (or a standup's notes). */
  setPrep(id: string, note: string): void {
    this.kept.prep[id] = note;
    // only the calls still on the calendar keep theirs
    const live = new Set(this.events.map((e) => e.id));
    for (const k of Object.keys(this.kept.prep)) if (!live.has(k) && k !== id) delete this.kept.prep[k];
    this.save();
    this.d.onChange?.(this.msg());
  }

  private save(): void {
    try {
      if (this.d.file) writeFileAtomic(this.d.file, JSON.stringify(this.kept));
    } catch {
      /* not kept */
    }
  }
}

/** What the app's routes and Cora's tools use. */
export type CalendarApi = {
  msg(): CalendarMsg;
  refresh(): Promise<void>;
  markStandup(id: string, on: boolean): CalEvent | null;
  /** its prep note (made once; a standup's from the Standup template) */
  prep(id: string): Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  /** Cora's brief, kept with the call's Inbox item */
  brief(id: string, text: string): boolean;
};
