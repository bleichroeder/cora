import { clipboard, Menu, shell, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';

/** What a right-click can do; each item carries the text or address it acts on. */
export type MenuAction =
  | 'replace'
  | 'learn'
  | 'back'
  | 'forward'
  | 'reload'
  | 'copyPageUrl'
  | 'openPageExternal'
  | 'openLinkTab'
  | 'openLinkExternal'
  | 'copyLink'
  | 'openImageTab'
  | 'copyImage'
  | 'copyImageUrl'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pastePlain'
  | 'selectAll'
  | 'search'
  | 'jot'
  | 'inspect';

export type MenuEntry = { action: MenuAction; label: string; value?: string; enabled?: boolean; accelerator?: string } | { separator: true };

/** The parts of Electron's context-menu params the menu looks at. */
export type MenuParams = Pick<ContextMenuParams, 'isEditable' | 'editFlags' | 'selectionText' | 'misspelledWord' | 'dictionarySuggestions' | 'linkURL' | 'srcURL' | 'mediaType' | 'hasImageContents' | 'pageURL' | 'formControlType'>;

export type MenuFlags = {
  /** a page in the built-in browser (links, images, the page itself, web search, Inspect), not the dashboard */
  web: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
};

const isHttp = (u: string) => /^https?:\/\//i.test(u);
/** Windows menus read "&" as a shortcut-key marker */
const text = (s: string) => s.replace(/&/g, '&&');
/** The selection as Chrome quotes it in "Search Google for": one line, cut short. */
export const quote = (s: string, max = 32) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};
const emailOf = (mailto: string) => {
  const a = mailto.replace(/^mailto:/i, '').split('?')[0];
  try {
    return decodeURIComponent(a);
  } catch {
    return a;
  }
};
export const searchUrl = (q: string) => `https://www.google.com/search?q=${encodeURIComponent(q.trim())}`;

/**
 * The right-click menu for what's under the cursor, in Chrome's order and wording: spelling, the page (when
 * nothing else is there), the link, the image, editing, the selection, Inspect. Empty groups are left out and the
 * rest get a separator between them; no groups means no menu.
 */
export function menuItems(p: MenuParams, f: MenuFlags): MenuEntry[] {
  const groups: MenuEntry[][] = [];
  const add = (g: (MenuEntry | false | undefined | '')[]) => {
    const items = g.filter(Boolean) as MenuEntry[];
    if (items.length) groups.push(items);
  };
  const sel = p.selectionText.trim();
  const link = f.web ? p.linkURL : '';
  const image = f.web && p.mediaType === 'image';
  const spell = p.isEditable && !!p.misspelledWord;

  if (spell) {
    const words = p.dictionarySuggestions.slice(0, 5);
    add([
      ...words.map((w): MenuEntry => ({ action: 'replace', label: text(w), value: w })),
      !words.length && { action: 'replace', label: 'No spelling suggestions', enabled: false },
      { action: 'learn', label: 'Add to dictionary', value: p.misspelledWord },
    ]);
  }
  if (f.web && !link && !image && !sel && !p.isEditable) {
    add([
      { action: 'back', label: 'Back', enabled: !!f.canGoBack },
      { action: 'forward', label: 'Forward', enabled: !!f.canGoForward },
      { action: 'reload', label: 'Reload' },
    ]);
    add([
      !!p.pageURL && { action: 'copyPageUrl', label: 'Copy page address', value: p.pageURL },
      isHttp(p.pageURL) && { action: 'openPageExternal', label: 'Open page in your browser', value: p.pageURL },
    ]);
  }
  if (link) {
    const mail = /^mailto:/i.test(link);
    add([
      isHttp(link) && { action: 'openLinkTab', label: 'Open link in new tab', value: link },
      isHttp(link) && { action: 'openLinkExternal', label: 'Open link in your browser', value: link },
      mail
        ? { action: 'copyLink', label: 'Copy email address', value: emailOf(link) }
        : { action: 'copyLink', label: 'Copy link address', value: link },
    ]);
  }
  if (image) {
    add([
      isHttp(p.srcURL) && { action: 'openImageTab', label: 'Open image in new tab', value: p.srcURL },
      { action: 'copyImage', label: 'Copy image', enabled: p.hasImageContents },
      !!p.srcURL && { action: 'copyImageUrl', label: 'Copy image address', value: p.srcURL },
    ]);
  }
  if (p.isEditable) {
    const e = p.editFlags;
    if (f.web)
      add([
        { action: 'undo', label: 'Undo', enabled: e.canUndo, accelerator: 'CmdOrCtrl+Z' },
        { action: 'redo', label: 'Redo', enabled: e.canRedo, accelerator: 'CmdOrCtrl+Shift+Z' },
      ]);
    add([
      { action: 'cut', label: 'Cut', enabled: e.canCut, accelerator: 'CmdOrCtrl+X' },
      { action: 'copy', label: 'Copy', enabled: e.canCopy, accelerator: 'CmdOrCtrl+C' },
      { action: 'paste', label: 'Paste', enabled: e.canPaste, accelerator: 'CmdOrCtrl+V' },
      f.web && { action: 'pastePlain', label: 'Paste as plain text', enabled: e.canPaste, accelerator: 'CmdOrCtrl+Shift+V' },
      { action: 'selectAll', label: 'Select all', enabled: e.canSelectAll, accelerator: 'CmdOrCtrl+A' },
    ]);
  } else if (sel) add([{ action: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C' }]);
  // in the dashboard: the selection (a transcript's text, say) into Cora's notes
  if (!f.web && sel && !p.isEditable) add([{ action: 'jot', label: 'Add to Scratch', value: p.selectionText.trim().slice(0, 20_000) }]);
  // web search for the selection (not a password's, not while fixing a misspelling)
  if (f.web && sel && !spell && p.formControlType !== 'input-password')
    add([{ action: 'search', label: text(`Search Google for “${quote(sel)}”`), value: sel }]);
  if (f.web && groups.length) add([{ action: 'inspect', label: 'Inspect' }]);

  return groups.flatMap((g, i) => (i ? [{ separator: true } as const, ...g] : g));
}

type Target = {
  /** the window the menu opens over */
  window: BrowserWindow;
  web: boolean;
  /** open a page in a new tab of the browser this page belongs to */
  newTab?: (url: string, background: boolean) => void;
};

/** Give a page (a browser tab, a sign-in popup or the dashboard itself) a right-click menu. */
export function attachContextMenu(wc: WebContents, t: Target) {
  wc.on('context-menu', (_e, p) => {
    const nav = wc.navigationHistory;
    const items = menuItems(p, { web: t.web, canGoBack: nav.canGoBack(), canGoForward: nav.canGoForward() });
    if (!items.length || t.window.isDestroyed()) return;
    const template = items.map((m): MenuItemConstructorOptions =>
      'separator' in m
        ? { type: 'separator' }
        : { label: m.label, enabled: m.enabled ?? true, accelerator: m.accelerator, registerAccelerator: false, click: () => run(wc, m.action, m.value ?? '', p, t) },
    );
    Menu.buildFromTemplate(template).popup({ window: t.window });
  });
}

function run(wc: WebContents, action: MenuAction, v: string, p: ContextMenuParams, t: Target) {
  if (wc.isDestroyed()) return;
  switch (action) {
    case 'replace':
      return wc.replaceMisspelling(v);
    case 'learn':
      return void wc.session.addWordToSpellCheckerDictionary(v);
    case 'back':
      return wc.navigationHistory.goBack();
    case 'forward':
      return wc.navigationHistory.goForward();
    case 'reload':
      return wc.reload();
    case 'openLinkTab':
    case 'openImageTab':
      return t.newTab?.(v, true);
    case 'search':
      return t.newTab?.(searchUrl(v), false);
    case 'openLinkExternal':
    case 'openPageExternal':
      return void (isHttp(v) && shell.openExternal(v));
    case 'copyLink':
    case 'copyImageUrl':
    case 'copyPageUrl':
      return void clipboard.writeText(v).catch(() => {});
    case 'copyImage':
      return wc.copyImageAt(p.x, p.y);
    case 'undo':
      return wc.undo();
    case 'redo':
      return wc.redo();
    case 'cut':
      return wc.cut();
    case 'copy':
      return wc.copy();
    case 'paste':
      return wc.paste();
    case 'pastePlain':
      return wc.pasteAndMatchStyle();
    case 'selectAll':
      return wc.selectAll();
    case 'jot':
      return wc.send('ab:jot', v);
    case 'inspect':
      wc.inspectElement(p.x, p.y);
      if (wc.isDevToolsOpened()) wc.devToolsWebContents?.focus();
      return;
  }
}

/**
 * Underline misspellings in a session's text fields. Windows and Linux check only the languages they're given
 * (Electron starts with the system's, when it has a dictionary for it): fall back to US English.
 */
export function enableSpellcheck(ses: Session) {
  ses.setSpellCheckerEnabled(true);
  if (process.platform === 'darwin' || ses.getSpellCheckerLanguages().length) return;
  try {
    if (ses.availableSpellCheckerLanguages.includes('en-US')) ses.setSpellCheckerLanguages(['en-US']);
  } catch {}
}
