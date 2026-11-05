import { create } from 'zustand';
import type { SessionFlag, SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';

/**
 * Sessions flagged to come back to (the nav row's bookmark): flagged in one click, with an optional one-line why and
 * a reminder; kept on the server, cleared only by you. No filter or list of them: the rows show it, and a folded
 * group counts its flagged ones.
 */

const call = async (method: 'POST' | 'DELETE', id: string, body?: object): Promise<string | null> => {
  const r = await fetch(`/api/sessions/${encodeURIComponent(id)}/flag`, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  if (!r.ok) return ((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'failed';
  useBrain.getState().upsertSession(await r.json());
  return null;
};

/** Flag it, or change its why (`note`) or reminder (`remindAt`; null clears one). Null when done, else why not. */
export const flagSession = (id: string, change: { note?: string | null; remindAt?: number | null } = {}) => call('POST', id, change);
export const unflagSession = (id: string) => call('DELETE', id);

/** A clock time as the nav says it: "9:00", "17:45". */
export const clock = (at: number) => {
  const d = new Date(at);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** When a reminder comes, in a few words: "17:45" today, "tomorrow 9:00", else "Thu 6 Nov 9:00". */
export function whenWords(at: number, now: number): string {
  const day = (t: number) => new Date(t).toDateString();
  if (day(at) === day(now)) return clock(at);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (day(at) === tomorrow.toDateString()) return `tomorrow ${clock(at)}`;
  const d = new Date(at);
  return `${d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${clock(at)}`;
}

/** The reminders offered: later today (three hours on, to the quarter hour, while it's still today), tomorrow at 9:00. */
export function remindChoices(now: number): Array<{ label: string; at: number }> {
  const q = 15 * 60_000;
  const later = Math.ceil((now + 3 * 3_600_000) / q) * q;
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return [...(new Date(later).toDateString() === new Date(now).toDateString() ? [{ label: `Later today, ${clock(later)}`, at: later }] : []), { label: 'Tomorrow 9:00', at: tomorrow.getTime() }];
}

/** What the bookmark says on hover. */
export function flagTitle(f: SessionFlag | null | undefined, now: number): string {
  if (!f) return 'Come back to this: flag it (click again to clear)';
  const remind = f.remindAt ? (f.due ? ` · its reminder came (${whenWords(f.remindAt, now)})` : ` · reminds you ${whenWords(f.remindAt, now)}`) : '';
  return `${f.note ? `Come back to this: ${f.note}` : 'Flagged to come back to'}${remind} · click to clear`;
}

/** How many of these are flagged (a folded group's count). */
export const flaggedCount = (list: Array<Pick<SessionInfo, 'flag'>>) => list.filter((s) => !!s.flag).length;

/** The flag's popover (its why and reminder): for which session, where. */
export const useFlagPop = create<{ id: string; x: number; y: number } | { id: null }>(() => ({ id: null }));

/**
 * Where its row is: the nav's row in the drawer when it's open (the tablet's icon rail has a tile for it too, earlier
 * in the page), else the nav's.
 */
export function rowSelectors(id: string): string[] {
  const row = `.ses[data-ping="ses:${id.replace(/["\\]/g, '\\$&')}"]`;
  return [`.tb-drawer.open ${row}`, row];
}
export function rowOf(id: string): HTMLElement | null {
  for (const sel of rowSelectors(id)) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) return el;
  }
  return null;
}

/**
 * The why field's keys: Enter and Esc save it and close; their keystroke goes no further (focus goes back to the row,
 * and the same Enter would press it: in the drawer, that opened the session and closed the drawer).
 */
export function whyKey(e: Pick<KeyboardEvent, 'key' | 'preventDefault' | 'stopPropagation'>, done: () => void): void {
  e.stopPropagation();
  if (e.key !== 'Enter' && e.key !== 'Escape') return;
  e.preventDefault();
  done();
}

/** Flag it (if it isn't) and open its popover by its row (or where it can). */
export async function comeBackTo(id: string): Promise<string | null> {
  const s = useBrain.getState().sessions[id];
  const err = s?.flag ? null : await flagSession(id);
  if (err) return err;
  const row = rowOf(id)?.getBoundingClientRect();
  useFlagPop.setState(row ? { id, x: row.right - 8, y: row.top + 6 } : { id, x: Math.round(window.innerWidth / 2 - 134), y: 120 });
  return null;
}
