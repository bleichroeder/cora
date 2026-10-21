/**
 * Setting Cora up:
 * the first-run checklist and Settings › Setup. Each feature is an item; each thing it needs says who does it: Cora
 * itself, Cora with your OK (a command, shown first, run in a window you can watch), or you, with steps.
 */

export type SetupHow = 'itself' | 'ok' | 'you';
export type SetupStatus = 'ready' | 'partial' | 'needs' | 'skipped';

export type SetupNeed = {
  id: string;
  label: string;
  how: SetupHow;
  done: boolean;
  /** an extra: the feature is ready without it */
  optional?: boolean;
  /** what's there (a version, a path, an account) */
  value?: string;
  /** one line about it */
  detail?: string;
  /** with your OK: the command Cora runs (shown before it does) */
  command?: string;
  /** you: what to do, step by step */
  steps?: string[];
  /** its settings page (Settings › …) */
  page?: string;
  /** it can only be done after this other need */
  after?: string;
};

export type SetupItem = {
  id: string;
  title: string;
  /** what it gives you, in one line */
  blurb: string;
  required: boolean;
  status: SetupStatus;
  needs: SetupNeed[];
  /** what you go without */
  without?: string;
  /** its settings page */
  page?: string;
};

/** What the dashboard gets: the items, whether the first run was seen, and whether this is a fresh install (no sessions yet). */
export type SetupState = { items: SetupItem[]; seen: boolean; fresh: boolean };

/** Ready when everything it needs (extras aside) is done; skipped when you said so (a required item can't be). */
export function setupStatus(needs: Array<Pick<SetupNeed, 'done' | 'optional'> & { how?: SetupNeed['how'] }>, skipped: boolean, required = false): SetupStatus {
  const must = needs.filter((n) => !n.optional);
  if (must.every((n) => n.done)) return 'ready';
  // what Cora does itself doesn't make it look started: only what you've done does
  const done = must.filter((n) => n.done && n.how !== 'itself').length;
  if (skipped && !required) return 'skipped';
  return done ? 'partial' : 'needs';
}

/** The first run shows (instead of the app) while something required isn't ready, or on a fresh install until it's seen. */
export const setupFirstRun = (s: SetupState): boolean => s.items.some((i) => i.required && i.status !== 'ready') || (!s.seen && s.fresh);
