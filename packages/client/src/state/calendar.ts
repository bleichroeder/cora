import { create } from 'zustand';
import type { CalendarDueMsg, CalendarMsg, CalEvent, CalendarStatus } from '@cora/shared';
import { desktop } from '../lib/desktop';
import { askNotes, NOTES_ID } from './notes';
import { useTools } from './tools';

/** Your Google calendar (pushed by the server): today's and tomorrow's calls. */
export const useCalendar = create<{ status: CalendarStatus | null; events: CalEvent[]; apply(m: CalendarMsg): void }>((set) => ({
  status: null,
  events: [],
  apply: (m) => set({ status: m.status, events: m.events }),
}));

/** A call is coming: a desktop notification, when you asked for one (Settings › Calendar) or Cora's agent is off. */
export function calendarDue(m: CalendarDueMsg): void {
  if (!m.notify) return;
  const when = new Date(m.event.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  desktop?.notify(m.event.title, `${m.event.standup ? 'Standup' : 'Call'} at ${when} (in ${m.minutes} min)`, '', m.event.link);
}

const post = async (url: string, body: unknown): Promise<{ ok: true; j: any } | { ok: false; error: string }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!r) return { ok: false, error: "Cora didn't answer" };
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, j } : { ok: false, error: j.error ?? `failed (${r.status})` };
};

export const refreshCalendar = () => post('/api/calendar/refresh', {});
export const markStandup = (id: string, on: boolean) => post('/api/calendar/standup', { id, on });

/** Open a note in Notes. */
export const openNote = (id: string) => (useTools.getState().show(NOTES_ID), askNotes('open', id));

/** A call's prep notes: drafted once (a minute or so), then opened. */
export async function prepNotes(id: string): Promise<string | null> {
  const r = await post('/api/calendar/prep', { id });
  if (!r.ok) return r.error;
  openNote(r.j.id);
  return null;
}

/** Join a call: its video link, in your own browser (where your Google account and camera are). */
export function joinCall(link: string): void {
  if (desktop?.openExternal) desktop.openExternal(link);
  else window.open(link, '_blank', 'noopener');
}
