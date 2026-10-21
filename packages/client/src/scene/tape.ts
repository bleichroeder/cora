/** The shell tape's rows: at most TAPE_ROWS, running commands first, then the newest finished ones (oldest at top). */
const TAPE_ROWS = 5;
export function tapeRows<T extends { live: boolean }>(all: T[], open: boolean): { shown: T[]; hidden: number; hiddenRunning: number } {
  if (open || all.length <= TAPE_ROWS) return { shown: all, hidden: 0, hiddenRunning: 0 };
  const running = all.filter((c) => c.live);
  const keepRunning = running.slice(-TAPE_ROWS);
  const room = TAPE_ROWS - keepRunning.length;
  const done = room > 0 ? all.filter((c) => !c.live).slice(-room) : [];
  const keep = new Set<T>([...keepRunning, ...done]);
  const shown = all.filter((c) => keep.has(c));
  return { shown, hidden: all.length - shown.length, hiddenRunning: running.length - keepRunning.length };
}
