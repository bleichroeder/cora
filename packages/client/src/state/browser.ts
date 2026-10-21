import { useBrain } from './store';
import { useTools } from './tools';
import { useWeb } from './web';

/**
 * Cora's Browser: a Tool of its own (in the Tools drawer, like Notes) with tabs that belong to no session. Links with
 * nowhere better to go open here: an Inbox item with no Tool for its site, a link with no session open. Its tabs are a
 * tab group in the same store as the sessions' (keyed by this id), so they get everything a session's tabs do.
 */
export const BROWSER_ID = 'cora:browser';

/** Show the Browser (a blank tab when it has none). */
export function showBrowser(): void {
  useBrain.getState().setInbox(false);
  useTools.getState().show(BROWSER_ID);
}

/** Open a link in the Browser: its tab if one is already there, else a new one; the drawer shows it. */
export function openInBrowser(url: string, o: { background?: boolean } = {}): void {
  useWeb.getState().open(BROWSER_ID, url, o);
  showBrowser();
}
