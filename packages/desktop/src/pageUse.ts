/**
 * You using a page in a session's browser (reading it by scrolling, typing, clicking): its input stays in the page's
 * own process, so the main process tells the dashboard, at most once a second. A session's change on the web then
 * waits behind the tab you're on instead of switching you away (client webChanges.ts).
 */

/** The input that says you're using it: not the mouse merely passing over. */
const USED = new Set(['mouseWheel', 'mouseDown', 'keyDown', 'rawKeyDown', 'touchStart', 'gestureScrollBegin', 'gestureScrollUpdate']);
export const PING_MS = 1000;

/** For one page: is this input worth telling now (one of those, and the last told a second ago or more)? */
export function usedPings(now: () => number = Date.now): (type: string | undefined) => boolean {
  let last = -Infinity;
  return (type) => {
    if (!type || !USED.has(type)) return false;
    const t = now();
    if (t - last < PING_MS) return false;
    last = t;
    return true;
  };
}
