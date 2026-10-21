import { randomBytes } from 'node:crypto';
import { BrowserWindow, ipcMain, Menu, webContents, type WebContents } from 'electron';
import { DEFAULT_ONEPASSWORD, loginMatches, searchLogins, type OnePasswordSettings } from '@cora/shared';
import { OnePassword } from './onepassword';
import { FIELD_KEY_JS, FILL_LOGIN_JS, HAS_LOGIN_FORM_JS, inPage } from './pageScripts';

/**
 * 1Password in Cora's browser, the desktop side: which pages have a login form, the logins for a page (no secrets), and
 * filling the one you pick. A password or a code exists only here, between `op` and the page; the dashboard gets
 * titles, usernames and what was filled.
 */

const op = new OnePassword();
/** the dashboard's settings for it (on, codes, Tools), told on load and on change */
let prefs: OnePasswordSettings = { ...DEFAULT_ONEPASSWORD };
/** Tool windows (their own BrowserWindow, no address bar): Ctrl+\ there gives a menu */
const toolWindows = new Set<number>();
const isWeb = (u: string) => /^https?:\/\//i.test(u);

let host: { win: BrowserWindow; base: string } | null = null;

/** A page Cora may fill: a web page in one of its webviews or Tool windows, never the dashboard. */
function target(id: number): WebContents | null {
  const wc = webContents.fromId(id);
  if (!wc || wc.isDestroyed() || !host) return null;
  const ours = (wc.getType() === 'webview' && wc.hostWebContents === host.win.webContents) || toolWindows.has(wc.id);
  const url = wc.getURL();
  return ours && isWeb(url) && !url.startsWith(host.base) ? wc : null;
}

/** Fill a login into a page: it must still be for that page's site (unless you picked it by search and said yes). */
async function fill(wc: WebContents, id: string, anySite: boolean): Promise<{ username: boolean; password: boolean; totp: boolean }> {
  const login = (await op.logins()).find((l) => l.id === id);
  if (!login) throw new Error("1Password doesn't have that login any more");
  if (!anySite && !loginMatches(login, wc.getURL())) throw new Error("that login isn't for this site");
  const s = await op.secrets(id);
  // 1Password may have asked you to unlock meanwhile: the page has to still be where it was, or one that login is for
  if (wc.isDestroyed() || (!anySite && !loginMatches(login, wc.getURL()))) throw new Error('the page changed: nothing was filled');
  const creds = { ...(s.username ? { username: s.username } : {}), ...(s.password ? { password: s.password } : {}), ...(prefs.otp && s.totp ? { totp: s.totp } : {}) };
  return (await wc.executeJavaScriptInIsolatedWorld(1003, [{ code: inPage(FILL_LOGIN_JS, creds) }])) as { username: boolean; password: boolean; totp: boolean };
}

/** The key in a page's login field: focused, left, or clicked (where the field is, in the page's own pixels). */
export type FieldMsg = { k: 'focus' | 'blur' | 'open'; r?: { x: number; y: number; w: number; h: number } };

/**
 * The key in the page's own login fields (FIELD_KEY_JS): put in once a page has a login form, and what it says read
 * from the console, only with this page's nonce (the page can't write one: it can't see Cora's isolated world).
 */
function fieldKeys(wc: WebContents, on: (m: FieldMsg) => void): () => void {
  const nonce = `cora-op:${randomBytes(12).toString('hex')}:`;
  wc.on('console-message', (e: any, _level?: unknown, message?: unknown) => {
    const text = String(e?.message ?? message ?? '');
    if (!text.startsWith(nonce)) return;
    try {
      const m = JSON.parse(text.slice(nonce.length)) as FieldMsg;
      const r = m.r && [m.r.x, m.r.y, m.r.w, m.r.h].every((n) => typeof n === 'number' && Number.isFinite(n)) ? m.r : undefined;
      if (m.k === 'focus' || m.k === 'blur' || m.k === 'open') on({ k: m.k, ...(r ? { r } : {}) });
    } catch {
      /* not one of ours */
    }
  });
  return () => void wc.executeJavaScriptInIsolatedWorld(1002, [{ code: inPage(FIELD_KEY_JS, nonce) }]).catch(() => {});
}

/**
 * Tell the dashboard whether this webview's page has a login form (on loading, and again for pages that draw it
 * late), and put the key in its fields: what that says goes to `field`.
 */
export function watchLoginForms(wc: WebContents, tell: (m: { from: number; url: string; form: boolean }) => void, field?: (m: FieldMsg & { from: number; unlocked: boolean }) => void): void {
  let timers: NodeJS.Timeout[] = [];
  const keys = field ? fieldKeys(wc, (m) => prefs.on && field({ ...m, from: wc.id, unlocked: op.unlocked() })) : null;
  const check = () => {
    if (wc.isDestroyed() || !prefs.on || !isWeb(wc.getURL())) return;
    void wc
      .executeJavaScriptInIsolatedWorld(1002, [{ code: inPage(HAS_LOGIN_FORM_JS) }])
      .then((form) => {
        if (wc.isDestroyed()) return;
        tell({ from: wc.id, url: wc.getURL(), form: !!form });
        if (form) keys?.();
      })
      .catch(() => {});
  };
  const soon = () => {
    timers.forEach(clearTimeout);
    check();
    timers = [setTimeout(check, 1500), setTimeout(check, 4000)];
  };
  wc.on('dom-ready', soon);
  wc.on('did-navigate-in-page', soon);
  wc.on('did-stop-loading', check);
  wc.on('destroyed', () => timers.forEach(clearTimeout));
}

/** A Tool window: Ctrl+\ (or the key in a login field) shows its page's logins as a menu; a click fills. */
export function toolWindowFill(w: BrowserWindow): void {
  const wc = w.webContents;
  toolWindows.add(wc.id);
  wc.on('destroyed', () => toolWindows.delete(wc.id));
  // the key in the page's login fields: a click opens the menu under that field
  watchLoginForms(wc, () => {}, (m) => m.k === 'open' && prefs.tools && menu(m.r ? { x: Math.round(m.r.x), y: Math.round(m.r.y + m.r.h + 4) } : undefined));
  wc.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.control || i.shift || i.alt || i.key !== '\\') return;
    e.preventDefault();
    if (prefs.tools) menu();
  });
  const menu = (at?: { x: number; y: number }) => {
    if (!prefs.on) return;
    void (async () => {
      let items: Electron.MenuItemConstructorOptions[];
      try {
        const url = wc.getURL();
        const mine = (await op.logins()).filter((l) => loginMatches(l, url));
        items = mine.length
          ? mine.slice(0, 12).map((l) => ({ label: `${l.title}${l.username ? `  ·  ${l.username}` : ''}`, click: () => void fill(wc, l.id, false).catch(() => {}) }))
          : [{ label: 'No 1Password login for this site', enabled: false }];
      } catch (err) {
        items = [{ label: `1Password: ${(err as Error).message}`.slice(0, 80), enabled: false }];
      }
      if (!w.isDestroyed()) Menu.buildFromTemplate(items).popup({ window: w, ...(at ?? {}) });
    })();
  };
}

/** The dashboard's side: status, the page's logins, search, fill. Only Cora's window may ask. */
export function setupOnePassword(win: BrowserWindow, base: string): void {
  host = { win, base };
  const ours = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => e.sender === win.webContents;
  ipcMain.on('ab:op-prefs', (e, p: Partial<OnePasswordSettings>) => {
    if (ours(e)) prefs = { on: p?.on !== false, otp: p?.otp !== false, tools: p?.tools !== false, suggest: p?.suggest !== false };
  });
  ipcMain.handle('ab:op-status', async (e) => (ours(e) ? op.status() : null));
  ipcMain.handle('ab:op-logins', async (e, m: { from?: unknown }) => {
    const wc = ours(e) ? target(Number(m?.from)) : null;
    if (!wc) return { error: 'not a page Cora can fill' };
    try {
      const url = wc.getURL();
      return { url, logins: (await op.logins()).filter((l) => loginMatches(l, url)) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  ipcMain.handle('ab:op-search', async (e, m: { q?: unknown }) => {
    if (!ours(e)) return { error: 'not allowed' };
    try {
      return { logins: searchLogins(await op.logins(), String(m?.q ?? '').slice(0, 100)) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
  ipcMain.handle('ab:op-fill', async (e, m: { from?: unknown; id?: unknown; anySite?: unknown }) => {
    const wc = ours(e) ? target(Number(m?.from)) : null;
    if (!wc || !prefs.on) return { error: 'not a page Cora can fill' };
    try {
      return { filled: await fill(wc, String(m?.id ?? ''), m?.anySite === true) };
    } catch (err) {
      return { error: (err as Error).message };
    }
  });
}
