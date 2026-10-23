import { create } from 'zustand';

/**
 * What the live board shows in place of the scene area's overlays: the Browser panel (the session's browser lays itself
 * over the panel, so its pages are never moved: moving a webview reloads it) and the Needs-you panel (the floating cards
 * stand down while the board shows them), and the Spotlight (new explains show there instead of opening the viewer).
 * Each panel registers while it's on screen; the newest one wins (a panel and its maximised copy can both be up).
 */
type Dock = { sessionId: string; el: HTMLElement };
export const useBoardDock = create<{ browser: Dock[]; needs: string[]; spotlight: string[] }>(() => ({ browser: [], needs: [], spotlight: [] }));

export function dockBrowser(sessionId: string, el: HTMLElement): () => void {
  const d = { sessionId, el };
  useBoardDock.setState((s) => ({ browser: [...s.browser, d] }));
  return () => useBoardDock.setState((s) => ({ browser: s.browser.filter((x) => x !== d) }));
}

/** The element the session's browser lays itself over, if the board shows a Browser panel for it. */
export const browserDockOf = (s: { browser: Dock[] }, sessionId: string) => s.browser.filter((d) => d.sessionId === sessionId).at(-1)?.el ?? null;

function dockId(k: 'needs' | 'spotlight', sessionId: string): () => void {
  useBoardDock.setState((s) => ({ [k]: [...s[k], sessionId] }));
  return () =>
    useBoardDock.setState((s) => {
      const i = s[k].lastIndexOf(sessionId);
      return { [k]: i < 0 ? s[k] : [...s[k].slice(0, i), ...s[k].slice(i + 1)] };
    });
}
export const dockNeeds = (sessionId: string) => dockId('needs', sessionId);
/** A Spotlight is up for the session: a new explain shows there instead of opening the viewer over the board. */
export const dockSpotlight = (sessionId: string) => dockId('spotlight', sessionId);
