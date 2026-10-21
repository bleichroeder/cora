import { create } from 'zustand';
import { HOME_PARTITION, type BrowserProfile, type Settings } from '@cora/shared';
import { useBrain } from './store';
import { useTools } from './tools';
import { useWeb } from './web';

/**
 * Cora's Browser: a Tool of its own (in the Tools drawer, like Notes) with tabs that belong to no session. Links with
 * nowhere better to go open here: an Inbox item with no Tool for its site, a link with no session open. Its tabs are a
 * tab group in the same store as the sessions' (keyed like `cora:browser`), so they get everything a session's tabs do.
 *
 * With profiles (your Chrome / Edge ones you brought in, Settings › Tools), it switches between them like Chrome: each
 * has its own sign-ins, bookmarks bar, suggestions and tabs, kept as they were when you switch back.
 */
export const BROWSER_ID = 'cora:browser';

/** The browser's profiles and the sessions' one, from the server's settings (Settings › Tools keeps it current). */
/** `loaded`: pages wait for it, so each is made with its profile's sign-ins (a webview can't change them later). */
export const useBrowserSettings = create<{ profiles: BrowserProfile[]; sessions?: string; loaded: boolean }>(() => ({ profiles: [], loaded: false }));
export const setBrowserSettings = (b: Settings['browser'] | undefined) => useBrowserSettings.setState({ profiles: b?.profiles ?? [], sessions: b?.sessions, loaded: true });
void fetch('/api/settings')
  .then((r) => (r.ok ? r.json() : null))
  .then((s: Settings | null) => setBrowserSettings(s?.browser))
  .catch(() => useBrowserSettings.setState({ loaded: true }));

/** The profiles you brought in (none: one profile, as before). */
export const browserProfiles = (): BrowserProfile[] => useBrowserSettings.getState().profiles;

/** A profile's tab group in the Browser ('': the one there is without profiles). */
export const browserGroup = (profile: string) => (profile ? `${BROWSER_ID}:${profile}` : BROWSER_ID);
/** Every group the Browser's tabs live in. */
export const isBrowserGroup = (g: string) => g === BROWSER_ID || g.startsWith(`${BROWSER_ID}:`);

/** A profile's sign-ins (its webviews' partition); without profiles, or one not found, the browser's own. */
export const partitionFor = (profile: string | undefined) => browserProfiles().find((p) => p.id === profile)?.partition ?? HOME_PARTITION;

/** The profile sessions' browsers use (Settings › Tools: Sessions use), else the one with Cora's old logins. */
export const sessionsProfile = (): string => {
  const { profiles: list, sessions } = useBrowserSettings.getState();
  return list.find((p) => p.id === sessions)?.id ?? list.find((p) => p.partition === HOME_PARTITION)?.id ?? '';
};

/** Whose bookmarks and history a tab group shows: a Browser profile's, or for a session's tabs, the sessions' profile. */
export const profileOfGroup = (g: string): string => (isBrowserGroup(g) ? (g === BROWSER_ID ? '' : g.slice(BROWSER_ID.length + 1)) : sessionsProfile());
/** A tab group's sign-ins: its profile's (a page keeps the ones it was made with). */
export const partitionOfGroup = (g: string): string => partitionFor(profileOfGroup(g));

const KEY = 'cora.browser.profile';
const saved = () => {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
};

/** The profile Cora's Browser is on (kept across restarts). */
export const useBrowserProfile = create<{ id: string; set(id: string): void }>((set) => ({
  id: saved(),
  set: (id) => {
    set({ id });
    try {
      localStorage.setItem(KEY, id);
    } catch {
      /* this time only */
    }
  },
}));

/** The profile the Browser is on: the one you picked, while it's still one of yours; else the sessions' one. */
export function currentProfile(): string {
  const list = browserProfiles();
  if (!list.length) return '';
  const id = useBrowserProfile.getState().id;
  return list.some((p) => p.id === id) ? id : sessionsProfile() || list[0].id;
}
export const currentGroup = () => browserGroup(currentProfile());

/** Show the Browser (a blank tab when its profile has none). */
export function showBrowser(): void {
  useBrain.getState().setInbox(false);
  useTools.getState().show(BROWSER_ID);
}

/** Open a link in the Browser, in the profile it's on: its tab if one is already there, else a new one. */
export function openInBrowser(url: string, o: { background?: boolean } = {}): void {
  useWeb.getState().open(currentGroup(), url, o);
  showBrowser();
}
