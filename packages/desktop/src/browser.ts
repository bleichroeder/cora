import { app, BrowserWindow, desktopCapturer, dialog, session, shell, type WebContents } from 'electron';
import { attachContextMenu, enableSpellcheck } from './contextMenu';
import { toolWindowFill, watchLoginForms } from './opFill';
import { windowFind } from './findBar';
import { chromeUserAgent } from './userAgent';
import { chromeIdentity, chromeSession } from './chromeIdentity';

/** The built-in browser's logins and cookies: saved across restarts, kept apart from the dashboard's. */
export const WEB_PARTITION = 'persist:web';
export const isWeb = (u: string) => /^https?:\/\//i.test(u);
/** A browser profile's logins (persist:web, or persist:web-<profile>): what a page in Cora may use. */
export const isWebPartition = (p: string) => p === WEB_PARTITION || /^persist:web-[a-z0-9-]{1,40}$/.test(p);


/**
 * Let the dashboard host web pages in a <webview>: only http(s), only in the browser partition, never with the
 * app's preload or Node. Sign-in popups get a real window (same logins); links that want a new tab become a tab in
 * the page's session, and tab shortcuts pressed inside a page reach the app.
 */
export function setupBrowser(win: BrowserWindow, base: string) {
  webSession(WEB_PARTITION);

  win.webContents.on('will-attach-webview', (e, prefs, params) => {
    delete prefs.preload;
    prefs.nodeIntegration = false;
    prefs.contextIsolation = true;
    prefs.sandbox = true;
    // a browser profile's own logins (persist:web-…), else the browser's: never the app's
    prefs.partition = isWebPartition(prefs.partition ?? '') ? prefs.partition : WEB_PARTITION;
    webSession(prefs.partition!);
    if (!isWeb(params.src) || !win.webContents.getURL().startsWith(base)) e.preventDefault();
  });
  attachWebviews(win);
}

/** Each browser profile's logins, set up once like the browser's: what pages may ask for, kept sign-ins, spelling. */
const readied = new Set<string>();
function webSession(partition: string): Electron.Session {
  const ses = session.fromPartition(partition);
  if (readied.has(partition)) return ses;
  readied.add(partition);
  // Chrome's user agent, as Chrome sends it (Electron's leaves Chrome out, and sign-in pages turn that away)
  ses.setUserAgent(chromeUserAgent(ses.getUserAgent(), process.versions.chrome));
  chromeSession(ses);
  // notifications, mic and camera, screen sharing only for the Tools' sites (Slack: messages, huddles); other pages get
  // clipboard writes and fullscreen, nothing else
  ses.setPermissionRequestHandler((wc, perm, cb, details) => cb(perm === 'clipboard-sanitized-write' || perm === 'fullscreen' || (TOOL_PERMS.has(perm) && isToolPage(wc, details?.requestingUrl))));
  // a Tool's notifications (Slack's) only while you're away from Cora: in Cora you see what's new already (its Inbox,
  // the Tool's count), and Slack, its page out of sight in the drawer, would otherwise pop one up for every message.
  // Chromium asks this each time a page shows one: denied, it doesn't show.
  ses.setPermissionCheckHandler((wc, perm, origin) => (perm === 'notifications' ? isToolPage(wc, origin) && !BrowserWindow.getFocusedWindow() : TOOL_PERMS.has(perm) ? isToolPage(wc, origin) : true));
  // sharing a screen (a huddle): you pick which one, every time
  ses.setDisplayMediaRequestHandler((req, cb) => void pickScreen(req.securityOrigin, cb));
  keepLogins(ses);
  enableSpellcheck(ses);
  return ses;
}

function attachWebviews(win: BrowserWindow) {
  win.webContents.on('did-attach-webview', (_e, wc) => {
    // right-click: spelling, copy/paste, links, images, the page; new tabs open in this page's session
    const newTab = (url: string, background: boolean) => win.webContents.send('ab:web-tab', { from: wc.id, url, background });
    attachContextMenu(wc, { window: win, web: true, newTab });
    // the page sees Chrome as Chrome shows itself (sign-in pages turn away embedded browsers)
    chromeIdentity(wc);
    // 1Password: tell the dashboard when the page has a login form (the key in its address bar)
    // and the key in its login fields: clicked, or focused (to suggest logins there)
    watchLoginForms(
      wc,
      (m) => !win.isDestroyed() && win.webContents.send('ab:login-form', m),
      (m) => !win.isDestroyed() && win.webContents.send('ab:op-field', m),
    );
    wc.on('did-create-window', (popup) => {
      attachContextMenu(popup.webContents, { window: popup, web: true, newTab });
      chromeIdentity(popup.webContents);
      // a sign-in or a huddle window: its links open as tabs, and it can't take you anywhere that isn't a web page
      // (the same guards as a tab's: audit S12)
      popup.webContents.setWindowOpenHandler(({ url }) => {
        if (isWeb(url)) newTab(url, false);
        return { action: 'deny' };
      });
      popup.webContents.on('will-navigate', (e, url) => {
        if (isWeb(url)) return;
        e.preventDefault();
        if (/^mailto:/i.test(url)) void shell.openExternal(url);
      });
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (!isWeb(url)) return { action: 'deny' };
      if (disposition === 'new-window')
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 560,
            height: 720,
            parent: win,
            autoHideMenuBar: true,
            backgroundColor: '#ffffff',
            // signing in: with the logins of the tab that opened it (its profile's)
            webPreferences: { session: wc.session, sandbox: true, contextIsolation: true, nodeIntegration: false },
          },
        };
      win.webContents.send('ab:web-tab', { from: wc.id, url, background: disposition === 'background-tab' });
      return { action: 'deny' };
    });
    // Ctrl+T / W / L / F / Tab inside a page work on the app's tabs and find bar (and Ctrl+W must not close the app window);
    // Ctrl+K opens the app's command palette
    wc.on('before-input-event', (e, i) => {
      // Esc: a find bar open over this page closes (the page gets the key as well)
      if (i.type === 'keyDown' && i.key === 'Escape' && !i.control && !i.alt && !i.meta && !i.shift) return void win.webContents.send('ab:web-tab', { from: wc.id, key: 'esc' });
      if (i.type !== 'keyDown' || !i.control || i.alt || i.meta) return;
      const k = i.key.toLowerCase();
      // Ctrl+\: fill from 1Password (its own shortcut)
      const key = k === 'tab' ? (i.shift ? 'prev' : 'next') : !i.shift && k === '\\' ? 'fill' : !i.shift && ['t', 'w', 'l', 'f', 'k'].includes(k) ? k : null;
      if (!key) return;
      e.preventDefault();
      win.webContents.send('ab:web-tab', { from: wc.id, key });
    });
    // The mouse's back/forward buttons over a page would navigate the app window (the embedder), not the page:
    // cancel them in the page and step the page's own history instead. Isolated world: the page can't see or undo it.
    wc.on('dom-ready', () => void wc.executeJavaScriptInIsolatedWorld(1001, [{ code: MOUSE_BACK_FORWARD }]).catch(() => {}));
    wc.on('will-navigate', (e, url) => {
      if (isWeb(url)) return;
      e.preventDefault();
      if (/^mailto:/i.test(url)) void shell.openExternal(url);
    });
  });
}

const MOUSE_BACK_FORWARD = `addEventListener('mouseup', (e) => {
  if (e.button !== 3 && e.button !== 4) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  history.go(e.button === 3 ? -1 : 1);
}, true);`;

/** How long a sign-in that would end with the browser (a session cookie) is kept instead. */
export const KEEP_LOGIN_DAYS = 30;

/**
 * Stay signed in across restarts, as Chrome does with "continue where you left off": cookies meant to last only
 * until the browser closes (GitLab's and Jira's sign-ins without "remember me") get an expiry instead, and the
 * cookie store is written out often so a crash or a forced restart doesn't lose a fresh sign-in.
 */
export function keepLogins(ses: Electron.Session, quietMs = 1500) {
  // Kept once it has settled, with its value then: a sign-in sets the same cookie several times in a row, and keeping
  // each as it came could set an older one back after a newer (Google then turns the sign-in away as malformed)
  const waiting = new Map<string, NodeJS.Timeout>();
  ses.cookies.on('changed', (_e, c, _cause, removed) => {
    if (!c.domain || !keepable(c.domain)) return;
    const key = `${c.domain}|${c.path}|${c.name}`;
    clearTimeout(waiting.get(key));
    if (removed || !c.session) return void waiting.delete(key);
    const url = `${c.secure ? 'https' : 'http'}://${c.domain.replace(/^\./, '')}${c.path ?? '/'}`;
    waiting.set(
      key,
      setTimeout(() => {
        waiting.delete(key);
        void ses.cookies
          .get({ url, name: c.name })
          .then((now) => {
            const x = now.find((k) => k.domain === c.domain && k.path === c.path);
            if (!x?.session) return;
            return ses.cookies.set({
              url,
              name: x.name,
              value: x.value,
              ...(x.hostOnly ? {} : { domain: x.domain }),
              path: x.path,
              secure: x.secure,
              httpOnly: x.httpOnly,
              sameSite: x.sameSite,
              expirationDate: Math.floor(Date.now() / 1000) + KEEP_LOGIN_DAYS * 86400,
            });
          })
          .catch(() => {});
      }, quietMs),
    );
  });
  const flush = () => void ses.cookies.flushStore().catch(() => {});
  setInterval(flush, 10_000).unref?.();
  app.on('before-quit', flush);
}

/**
 * Google's account cookies are left as they are: its sign-in already lasts (two years), and its session cookies are
 * the steps of a sign-in in progress, which kept would get in the next one's way.
 */
export const keepable = (domain: string) => !/(^|\.)(google\.com|accounts\.youtube\.com|googleusercontent\.com)$/i.test(domain.replace(/^\./, ''));

/** What a tool's pages may do that other pages may not. */
const TOOL_PERMS = new Set(['notifications', 'media', 'display-capture']);

/**
 * The Tools' sites (from the dashboard), as their site's domain (app.slack.com → slack.com: a huddle or a sign-in
 * may come from another of its hosts): their pages may notify, use the mic and camera, and share a screen.
 */
let toolSites = new Set<string>();
/**
 * Shared names where everyone's site sits side by side (someone.github.io, bbc.co.uk): there a site is three labels,
 * so one tool's site doesn't vouch for all its neighbours (audit S12).
 */
const SHARED = new Set(['github.io', 'gitlab.io', 'vercel.app', 'netlify.app', 'herokuapp.com', 'azurewebsites.net', 'cloudfront.net', 'pages.dev', 'workers.dev', 'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'com.br', 'co.in', 'co.za']);
const siteOf = (host: string) => {
  const parts = host.split('.');
  return parts.slice(SHARED.has(parts.slice(-2).join('.')) ? -3 : -2).join('.');
};
export function setToolHosts(hosts: string[]): void {
  toolSites = new Set(hosts.map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]+$/.test(h)).map(siteOf));
}
function isToolPage(wc: WebContents | null, url?: string): boolean {
  let host = '';
  try {
    host = new URL(url || wc?.getURL() || '').hostname.toLowerCase();
  } catch {
    return false;
  }
  return !!host && toolSites.has(siteOf(host));
}

/** A tool asks to share a screen: say which (or cancel). Other pages can't. */
async function pickScreen(origin: string | undefined, cb: (s: Electron.Streams) => void): Promise<void> {
  if (!isToolPage(null, origin)) return cb({});
  try {
    const screens = await desktopCapturer.getSources({ types: ['screen'] });
    if (!screens.length) return cb({});
    const parent = BrowserWindow.getFocusedWindow();
    const opts = {
      type: 'question' as const,
      title: 'Share your screen',
      message: `${new URL(origin ?? '').hostname} wants to share your screen.`,
      detail: screens.length > 1 ? 'Which one?' : undefined,
      buttons: [...(screens.length > 1 ? screens.map((s, i) => s.name || `Screen ${i + 1}`) : ['Share it']), 'Cancel'],
      cancelId: screens.length > 1 ? screens.length : 1,
      defaultId: 0,
      noLink: true,
    };
    const { response } = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
    const pick = screens[response];
    cb(pick && response < screens.length ? { video: pick } : {});
  } catch {
    cb({});
  }
}

/** A tool (Slack) in its own window: same logins as the browser; its links go to your browser; sign-in popups allowed. */
const toolWindows = new Set<BrowserWindow>();
/** Lockdown: every tool window out of sight (they open again from the dashboard). */
export function hideToolWindows(): void {
  for (const w of toolWindows) if (!w.isDestroyed()) w.close();
}

export function openToolWindow(url: string, title: string, icon?: Electron.NativeImage): void {
  if (!isWeb(url)) return;
  const w = new BrowserWindow({
    width: 1200,
    height: 860,
    title,
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  toolWindows.add(w);
  w.on('closed', () => toolWindows.delete(w));
  w.webContents.on('page-title-updated', (e) => (e.preventDefault(), w.setTitle(`${title} · ${w.webContents.getTitle()}`)));
  toolWindowFill(w);
  // Ctrl+F: find in its page (a bar of Cora's over the page, since the window has no Cora around it)
  const find = windowFind(w);
  w.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown' || !i.control || i.alt || i.shift || i.meta || i.key.toLowerCase() !== 'f') return;
    e.preventDefault();
    find();
  });
  attachContextMenu(w.webContents, { window: w, web: true, newTab: (u: string) => void shell.openExternal(u) });
  w.webContents.setWindowOpenHandler(({ url: u, disposition }) => {
    if (!isWeb(u)) return { action: 'deny' };
    if (disposition === 'new-window') return { action: 'allow', overrideBrowserWindowOptions: { parent: w, autoHideMenuBar: true, webPreferences: { partition: WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } } };
    void shell.openExternal(u);
    return { action: 'deny' };
  });
  w.webContents.on('will-navigate', (e, u) => {
    if (!isWeb(u)) e.preventDefault();
  });
  // the mouse's back/forward buttons step its history (as in the drawer)
  w.webContents.on('dom-ready', () => void w.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: MOUSE_BACK_FORWARD }]).catch(() => {}));
  void w.loadURL(url);
}
