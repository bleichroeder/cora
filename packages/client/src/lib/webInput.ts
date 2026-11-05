/**
 * When you last used a session's browser (its tabs, address bar, buttons, or a click into its page: a page's own keys
 * and scrolling stay in its own process, out of Cora's sight). A change a session makes on the web switches the view
 * only when you've left it alone a while (webChanges.ts).
 */
const last = new Map<string, number>();

export function noteWebInput(sessionId: string, at = Date.now()): void {
  last.set(sessionId, at);
}

/** How long since you last used this session's browser (forever: never). */
export function webIdleFor(sessionId: string, now = Date.now()): number {
  const at = last.get(sessionId);
  return at == null ? Infinity : now - at;
}
