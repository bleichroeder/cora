/**
 * Cora knows your day: your primary Google calendar, read only,
 * through the same Google sign-in as Gmail. Today's and tomorrow's calls; a brief before each.
 */
export type CalAttendee = { name?: string; email: string; self?: boolean; response?: 'accepted' | 'declined' | 'tentative' | 'needsAction' };

/** A call (a timed event you haven't declined): when, what, with whom, where to join. */
export type CalEvent = {
  id: string;
  /** its recurring series (a standup's), when it is one */
  series?: string;
  title: string;
  start: number;
  end: number;
  attendees: CalAttendee[];
  /** its video link (Meet, Zoom, Teams…), else a link in its location */
  link?: string;
  /** what the invite says (trimmed) */
  about?: string;
  /** a link to it in Google Calendar */
  url?: string;
  /** a standup: by its title (recurring, "standup", "daily"…) or because you marked it */
  standup: boolean;
  /** its prep note (or a standup's drafted note), when there is one */
  prep?: string;
};

/** connected: the Google sign-in has the calendar permission; scope: signed in, but without it (reconnect to add it). */
export type CalendarStatus = { state: 'connected' | 'scope' | 'off'; error?: string; lastCheck?: number };
export type CalendarMsg = { t: 'calendar'; status: CalendarStatus; events: CalEvent[] };
/** A call is coming (the lead time before it): a desktop notification when you asked for one. */
export type CalendarDueMsg = { t: 'calendarDue'; event: CalEvent; minutes: number; notify: boolean };

export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export type CalendarBrief = 'spoken' | 'written' | 'off';
export const CALENDAR_BRIEFS: readonly CalendarBrief[] = ['spoken', 'written', 'off'];
export type CalendarSettings = {
  /** how long before a call (minutes, 5 to 60; 0: never) */
  lead: number;
  /** Cora's brief before a call: spoken (when voice is on), written in her console only, or none */
  brief: CalendarBrief;
  /** an Inbox item for the call (Join, Prep notes, Ask Cora) */
  inbox: boolean;
  /** a desktop notification too (Google sends one already) */
  notify: boolean;
  /** a standup's notes drafted (the Standup template) before it */
  standupDraft: boolean;
};
export const DEFAULT_CALENDAR: CalendarSettings = { lead: 15, brief: 'spoken', inbox: true, notify: false, standupDraft: true };
/** Cora's agent's calendar tools. */
export const CALENDAR_TOOLS = ['calendar_today', 'calendar_prep', 'calendar_brief'] as const;

const STANDUP = /\b(stand[\s-]?up|daily|scrum|sync[\s-]?up)\b/i;
/** A standup by its title: a recurring call called standup, daily, scrum or sync-up (you can mark or unmark any). */
export const looksLikeStandup = (title: string, recurring: boolean): boolean => recurring && STANDUP.test(title);
