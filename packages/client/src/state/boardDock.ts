import { create } from 'zustand';

/**
 * What the Board shows in place of the scene area's overlays: the Needs-you panel (the floating cards stand down while
 * the Board shows them), and the Spotlight (new explains show there instead of opening the viewer). Each panel
 * registers while it's on screen.
 */
export const useBoardDock = create<{ needs: string[]; spotlight: string[] }>(() => ({ needs: [], spotlight: [] }));

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

/**
 * A panel asking its board to show another (the team map's "N unassigned": the Work panel): the board goes to the page
 * that has one and brings it into view, or adds one to the page showing. `board`: the board's owner (a project's
 * `project:<id>`); `at` tells one ask from the next.
 */
export const useBoardShow = create<{ ask: { board: string; k: string; at: number } | null }>(() => ({ ask: null }));
export const showPanel = (board: string, k: string) => useBoardShow.setState({ ask: { board, k, at: Date.now() } });
