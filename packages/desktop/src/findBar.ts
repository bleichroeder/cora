import { WebContentsView, type BrowserWindow } from 'electron';

/**
 * Find in page (Ctrl+F) for a Tool's own window, which has no Cora around it: a small bar of Cora's over the page's
 * top right, as in Cora's browser. It's a page of our own (sandboxed, can't go anywhere else) that says what to do
 * through its console; the window's page does the finding.
 */

const BAR_W = 360;
const BAR_H = 46;
const SAY = 'cora-find:';

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; background: transparent; overflow: hidden; font: 12.5px system-ui, 'Segoe UI', sans-serif; }
  .bar { display: flex; align-items: center; gap: 2px; box-sizing: border-box; height: 38px; margin: 4px; padding: 0 4px 0 11px; border-radius: 10px; background: #161b26; box-shadow: inset 0 0 0 1px #2b3446, 0 8px 22px rgba(0,0,0,.45); }
  input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: #e6ebf5; font: inherit; }
  input::placeholder { color: #6b7488; }
  .n { min-width: 44px; margin-right: 4px; color: #6b7488; font: 500 10.5px ui-monospace, Consolas, monospace; text-align: right; }
  button { display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 7px; background: none; color: #9aa4b8; cursor: pointer; }
  button:hover:not(:disabled) { background: #232b3b; color: #fff; }
  button:disabled { opacity: .35; cursor: default; }
  svg { width: 14px; height: 14px; }
</style></head><body><div class="bar">
  <input id="q" placeholder="Find in page" spellcheck="false" autofocus>
  <span class="n" id="n"></span>
  <button id="up" title="Previous (Shift+Enter)" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 15-6-6-6 6"/></svg></button>
  <button id="down" title="Next (Enter)" disabled><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
  <button id="x" title="Close (Esc)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
</div><script>
  var q = document.getElementById('q'), n = document.getElementById('n');
  var say = function (m) { console.log('${SAY}' + JSON.stringify(m)); };
  var sync = function () { document.getElementById('up').disabled = document.getElementById('down').disabled = !q.value; if (!q.value) n.textContent = ''; };
  q.addEventListener('input', function () { sync(); say({ t: 'find', text: q.value }); });
  q.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') say({ t: 'close' });
    else if (e.key === 'Enter' && q.value) say({ t: 'find', text: q.value, next: true, forward: !e.shiftKey });
  });
  document.getElementById('up').onclick = function () { say({ t: 'find', text: q.value, next: true, forward: false }); };
  document.getElementById('down').onclick = function () { say({ t: 'find', text: q.value, next: true, forward: true }); };
  document.getElementById('x').onclick = function () { say({ t: 'close' }); };
  window.found = function (at, of) { n.textContent = q.value ? at + '/' + of : ''; };
  window.again = function () { q.focus(); q.select(); };
</script></body></html>`;

/** Give a Tool's window Ctrl+F: returns what opens the bar (or focuses it again). */
export function windowFind(w: BrowserWindow): () => void {
  let view: WebContentsView | null = null;
  const page = w.webContents;
  const place = () => {
    if (!view || w.isDestroyed()) return;
    const [width] = w.getContentSize();
    view.setBounds({ x: Math.max(0, width - BAR_W - 12), y: 8, width: Math.min(BAR_W, width), height: BAR_H });
  };
  const close = () => {
    if (!view) return;
    if (!page.isDestroyed()) page.stopFindInPage('clearSelection');
    view.setVisible(false);
    if (!page.isDestroyed()) page.focus();
  };
  page.on('found-in-page', (_e, r) => {
    if (view && r.finalUpdate !== false) void view.webContents.executeJavaScript(`window.found(${Number(r.activeMatchOrdinal) || 0}, ${Number(r.matches) || 0})`).catch(() => {});
  });
  // a new page: what was found there doesn't hold
  page.on('did-navigate', close);
  // Esc in the page closes the bar, as in Chrome (the page gets the key as well)
  page.on('before-input-event', (_e, i) => {
    if (i.type === 'keyDown' && i.key === 'Escape' && !i.control && !i.alt && !i.meta && view?.getVisible()) close();
  });
  w.on('resize', place);
  return () => {
    if (w.isDestroyed()) return;
    if (!view) {
      view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
      view.setBackgroundColor('#00000000');
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (e) => e.preventDefault());
      wc.on('console-message', (e: any, _level?: unknown, message?: unknown) => {
        const text = String(e?.message ?? message ?? '');
        if (!text.startsWith(SAY)) return;
        let m: { t?: string; text?: unknown; next?: boolean; forward?: boolean };
        try {
          m = JSON.parse(text.slice(SAY.length));
        } catch {
          return;
        }
        if (m.t === 'close') return close();
        if (m.t !== 'find' || page.isDestroyed()) return;
        const q = String(m.text ?? '').slice(0, 500);
        if (!q) return page.stopFindInPage('clearSelection');
        page.findInPage(q, { forward: m.forward !== false, findNext: !!m.next });
      });
      // Ctrl+F again, or Esc, in the bar itself
      wc.on('before-input-event', (e, i) => {
        if (i.type === 'keyDown' && i.control && !i.alt && !i.shift && i.key.toLowerCase() === 'f') (e.preventDefault(), void wc.executeJavaScript('window.again()').catch(() => {}));
      });
      w.contentView.addChildView(view);
      void wc.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
      w.on('closed', () => (view = null));
    }
    view.setVisible(true);
    place();
    view.webContents.focus();
    void view.webContents.executeJavaScript('window.again && window.again()').catch(() => {});
  };
}
