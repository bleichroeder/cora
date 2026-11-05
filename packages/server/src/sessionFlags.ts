import type { SessionFlag, SessionInfo } from '@cora/shared';

/**
 * Sessions flagged to come back to (the nav row's bookmark): set, changed and cleared only by you, kept with the
 * session (so a restart keeps them); a reminder, when it's due, brightens the flag and sends a notification.
 */

/** Its "why": one line, this long at most. */
export const FLAG_NOTE_MAX = 120;
/** A reminder this far ahead at most. */
const REMIND_MAX_MS = 366 * 24 * 3_600_000;

/**
 * The flag a request makes: `note` and `remindAt` as given (null clears one, left out keeps it), on the session's
 * flag or a new one. A reminder that changes is due again (when its time comes). Or why it can't.
 */
export function flagFrom(prev: SessionFlag | null | undefined, body: unknown, now: number): { flag: SessionFlag } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as { note?: unknown; remindAt?: unknown };
  const flag: SessionFlag = { ...(prev ?? {}), at: prev?.at ?? now };
  if (b.note !== undefined) {
    if (b.note !== null && typeof b.note !== 'string') return { error: 'note must be a line of text' };
    const note = (b.note ?? '').replace(/\s+/g, ' ').trim();
    if (note.length > FLAG_NOTE_MAX) return { error: `note must be at most ${FLAG_NOTE_MAX} characters` };
    if (note) flag.note = note;
    else delete flag.note;
  }
  if (b.remindAt !== undefined) {
    if (b.remindAt !== null && (typeof b.remindAt !== 'number' || !Number.isFinite(b.remindAt) || b.remindAt > now + REMIND_MAX_MS)) return { error: 'remindAt must be a time (ms) within a year' };
    if (b.remindAt !== (prev?.remindAt ?? null)) delete flag.due;
    if (b.remindAt === null) delete flag.remindAt;
    else flag.remindAt = Math.round(b.remindAt);
  }
  return { flag };
}

/** What the reminder says. */
export const remindText = (name: string, f: SessionFlag) => `Come back to "${name}"${f.note ? `: ${f.note}` : ''}`;

/** The reminders due by now, each marked come (once): the sessions as they are now. */
export function dueReminders(store: { dueFlags(now: number): SessionInfo[]; setFlag(id: string, f: SessionFlag | null): SessionInfo | undefined }, now: number): SessionInfo[] {
  const out: SessionInfo[] = [];
  for (const s of store.dueFlags(now)) {
    if (!s.flag) continue;
    const next = store.setFlag(s.id, { ...s.flag, due: true });
    if (next) out.push(next);
  }
  return out;
}
