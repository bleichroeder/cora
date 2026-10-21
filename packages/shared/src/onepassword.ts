/**
 * 1Password in Cora's browser: what the dashboard may know of your logins (never a password: those stay in the
 * desktop app's main process, between 1Password and the page).
 */

/** A login as 1Password lists it: no password, no code. */
export type OpLogin = { id: string; title: string; username: string; vault: string; urls: string[] };
/** Is 1Password there for Cora: the app, its command line, connected to each other. */
export type OpStatus = { app: boolean; cli: boolean; connected: boolean; error?: string };
/** `suggest`: a login field you focus shows the site's logins there (only while 1Password is unlocked: no surprise Windows Hello). */
export type OnePasswordSettings = { on: boolean; otp: boolean; tools: boolean; suggest: boolean };
export const DEFAULT_ONEPASSWORD: OnePasswordSettings = { on: true, otp: true, tools: true, suggest: true };
/** 1Password's own fill shortcut. */
export const OP_SHORTCUT = 'Ctrl+\\';

const hostOf = (u: string): string => {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
};

/**
 * A login is for this page when one of its saved sites is the page's host or a parent of it (rancher.acme.io's page
 * matches a login saved for acme.io), any port. Never by username or email: plenty of logins are service accounts.
 */
export function loginMatches(l: OpLogin, pageUrl: string): boolean {
  if (!/^https?:\/\//i.test(pageUrl)) return false;
  const page = hostOf(pageUrl);
  return (
    !!page &&
    l.urls.some((u) => {
      const h = hostOf(u);
      return !!h && (page === h || page.endsWith(`.${h}`));
    })
  );
}

/** Logins whose title or username has every word (for ones without the right site saved). */
export function searchLogins(list: OpLogin[], q: string, limit = 12): OpLogin[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return list.filter((l) => words.every((w) => `${l.title} ${l.username}`.toLowerCase().includes(w))).slice(0, limit);
}

/**
 * Where the 1Password app may be (any one there means it's installed): its own installer's per-user and per-machine
 * folders, or the app alias Windows makes for the Store-style (MSIX) package winget installs today.
 */
export function opAppPaths(env: { LOCALAPPDATA?: string; ProgramFiles?: string }): string[] {
  const local = env.LOCALAPPDATA ?? '';
  return [`${local}\\1Password\\app\\8\\1Password.exe`, `${env.ProgramFiles ?? 'C:\\Program Files'}\\1Password\\app\\8\\1Password.exe`, `${local}\\Microsoft\\WindowsApps\\1Password.exe`];
}
