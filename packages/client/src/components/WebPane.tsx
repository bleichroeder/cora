import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useWeb } from '../state/web';
import { hostOf, openOpMenu, useOp } from '../state/onepassword';
import './onepassword.css';
import type { WebTab } from '../lib/webTabs';
import { desktop } from '../lib/desktop';
import { addRecent, loadRecent, saveRecent, toUrl, type Recent } from '../lib/web';
import { Icon } from './Icon';
import { FindBar } from './FindBar';
import './browser.css';

/** Electron's <webview> (desktop app only): a real browser page in its own process. */
type Webview = HTMLElement & {
  loadURL(u: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  stop(): void;
  findInPage(text: string, o?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
};

/** Step a tab back or forward (the mouse's back/forward buttons, when the browser is on show). */
export function stepTab(tabId: string | null, dir: -1 | 1): void {
  const p = tabId ? pages.get(tabId) : undefined;
  if (!p) return;
  if (dir < 0 ? p.canGoBack() : p.canGoForward()) dir < 0 ? p.goBack() : p.goForward();
}

/** The browser's saved logins and cookies, shared by every session's tabs and kept apart from the app's. */
export const WEB_PARTITION = 'persist:web';

/** Which tab a page belongs to, by its web contents id (pages ask for new tabs and shortcuts through the app). */
export const tabOfPage = new Map<number, string>();
const pages = new Map<string, Webview>();

type TabState = { loading?: boolean; back?: boolean; fwd?: boolean; err?: string | null; icon?: string };

/** Ask the browser to open its find bar (Ctrl+F pressed inside a page reaches the app as an event). */
export const openFind = () => window.dispatchEvent(new Event('cora:web-find'));

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** One tab's page. Its element is created once and never moved (moving a webview reloads it); hidden, not removed. */
function Page({ tab, visible, onState, onVisit }: { tab: WebTab; visible: boolean; onState(id: string, s: TabState): void; onVisit(r: Recent): void }) {
  const el = useRef<Webview>(null);
  const first = useRef(tab.url); // src is set once; later navigation goes through loadURL
  const ready = useRef(false);
  const navSeen = useRef(tab.nav);

  useEffect(() => {
    const w = el.current;
    if (!w) return;
    pages.set(tab.id, w);
    let wcId = 0;
    const { update } = useWeb.getState();
    const hist = () => ({ back: w.canGoBack(), fwd: w.canGoForward() });
    const sync = () => {
      const u = w.getURL();
      if (/^https?:/i.test(u)) update(tab.id, { url: u });
      onState(tab.id, hist());
    };
    const on: Array<[string, (e: any) => void]> = [
      [
        'dom-ready',
        () => {
          ready.current = true;
          wcId = w.getWebContentsId();
          tabOfPage.set(wcId, tab.id);
        },
      ],
      ['did-navigate', sync],
      ['did-navigate-in-page', (e) => e.isMainFrame && sync()],
      ['page-title-updated', (e) => update(tab.id, { title: e.title })],
      ['page-favicon-updated', (e) => e.favicons?.[0] && onState(tab.id, { icon: e.favicons[0] })],
      ['did-start-loading', () => onState(tab.id, { loading: true, err: null })],
      [
        'did-stop-loading',
        () => {
          onState(tab.id, { loading: false, ...hist() });
          const u = w.getURL();
          if (/^https?:/i.test(u)) onVisit({ url: u, title: w.getTitle() || host(u) });
        },
      ],
      ['did-fail-load', (e) => e.isMainFrame && e.errorCode !== -3 && onState(tab.id, { err: `${e.errorDescription || 'failed to load'} (${e.errorCode})` })],
    ];
    for (const [k, f] of on) w.addEventListener(k, f);
    return () => {
      for (const [k, f] of on) w.removeEventListener(k, f);
      pages.delete(tab.id);
      if (wcId) tabOfPage.delete(wcId);
    };
  }, [tab.id]);

  // navigation asked of this tab (address bar, a clicked link)
  useEffect(() => {
    if (tab.nav === navSeen.current) return;
    navSeen.current = tab.nav;
    const w = el.current;
    if (!w || !ready.current || !tab.url) return;
    // asked for the address it's already on: reload it (to show the latest)
    if (w.getURL() === tab.url) w.reload();
    else void w.loadURL(tab.url).catch(() => {});
  }, [tab.nav]);

  return <webview ref={el as never} className={visible ? '' : 'off'} src={first.current} partition={WEB_PARTITION} {...({ allowpopups: 'true' } as object)} />;
}

/**
 * The built-in browser for a session: its own tabs (a GitLab and a Jira tab per piece of work), laid over the scene
 * or the whole focus area when wide. Every session's pages stay loaded while you're elsewhere; logins are shared.
 */
export function WebPane({ view, sessionId }: { view: React.RefObject<HTMLDivElement | null>; sessionId: string }) {
  const web = useWeb();
  const s = web.sessions[sessionId];
  const activeId = s?.active ?? null;
  const active = activeId ? web.tabs[activeId] : undefined;
  const shown = !!s?.shown && !!active;
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<Record<string, TabState>>({});
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [addr, setAddr] = useState(active?.url ?? '');
  const [editing, setEditing] = useState(false);
  const [rect, setRect] = useState<React.CSSProperties>({});
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // find in page (Ctrl+F)
  const [finding, setFinding] = useState(0);
  useEffect(() => {
    // open (already open: focused again)
    const open = () => setFinding((n) => n + 1);
    window.addEventListener('cora:web-find', open);
    return () => window.removeEventListener('cora:web-find', open);
  }, []);
  const st = (activeId && state[activeId]) || {};
  const page = () => (activeId ? pages.get(activeId) : undefined);

  // a tab's page is created the first time it's on show (restored tabs load when you come back to them)
  useEffect(() => {
    if (shown && activeId && active?.url && !mounted.has(activeId)) setMounted((m) => new Set(m).add(activeId));
  }, [shown, activeId, active?.url]);
  // closed tabs drop their pages
  useEffect(() => {
    if ([...mounted].some((id) => !web.tabs[id])) setMounted((m) => new Set([...m].filter((id) => web.tabs[id])));
  }, [web.tabs]);

  // the address bar follows the active tab
  useEffect(() => {
    if (!editing) setAddr(active?.url ?? '');
  }, [activeId, active?.url]);
  // a new blank tab is ready to type into
  useEffect(() => {
    if (shown && active && !active.url) setTimeout(() => input.current?.focus(), 30);
  }, [shown, activeId]);

  // docked on the right of the scene area (all of it at full split); layout offsets, not bounding rects (the view
  // zooms in on each session switch)
  useLayoutEffect(() => {
    const v = view.current;
    const box = v?.closest('.focus') as HTMLElement | null;
    if (!v || !box) return;
    const place = () => {
      let left = 0, top = 0;
      for (let el: HTMLElement | null = v; el && el !== box; el = el.offsetParent as HTMLElement | null) {
        left += el.offsetLeft;
        top += el.offsetTop;
      }
      const w = Math.round(v.offsetWidth * web.split);
      setRect({ left: left + v.offsetWidth - w, top, width: w, height: v.offsetHeight });
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(v);
    ro.observe(box);
    return () => ro.disconnect();
  }, [view, web.split]);

  // drag the left edge to resize; pages ignore the mouse meanwhile (a page would swallow the moves)
  const resize = (e: React.PointerEvent) => {
    const v = view.current;
    if (!v) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const r = v.getBoundingClientRect();
      useWeb.getState().setSplit((r.right - ev.clientX) / r.width);
    };
    const up = () => {
      setDragging(false);
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('lostpointercapture', up);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('lostpointercapture', up);
  };

  // shortcuts while the browser is on show and you're not typing somewhere
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!e.ctrlKey || e.altKey || (t && t !== input.current && /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 't') useWeb.getState().newTab(sessionId);
      else if (k === 'l') input.current?.focus();
      else if (k === 'f') openFind();
      else if (k === 'tab') useWeb.getState().cycle(sessionId, e.shiftKey ? -1 : 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, sessionId]);

  const onState = (id: string, p: TabState) => setState((m) => ({ ...m, [id]: { ...m[id], ...p } }));
  const onVisit = (r: Recent) =>
    setRecent((l) => {
      const next = addRecent(l, r);
      saveRecent(next);
      return next;
    });
  const go = (raw: string) => {
    const u = toUrl(raw);
    if (!u || !activeId) return;
    setEditing(false);
    setSugg([]);
    input.current?.blur();
    web.navigate(activeId, u);
  };

  // as you type an address: pages you've been to here first, then your Chrome bookmarks and history
  const [sugg, setSugg] = useState<Array<{ url: string; title: string; from: string }>>([]);
  const [pick, setPick] = useState(-1);
  useEffect(() => {
    setPick(-1);
    const q = addr.trim();
    if (!editing || !q || q === active?.url) return void setSugg([]);
    const lq = q.toLowerCase();
    const mine = recent.filter((r) => `${r.url} ${r.title}`.toLowerCase().includes(lq)).slice(0, 3).map((r) => ({ ...r, from: 'recent' }));
    setSugg(mine);
    let live = true;
    const t = setTimeout(() => {
      void fetch(`/api/browser/suggest?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { suggestions: [] }))
        .then((j: { suggestions: Array<{ url: string; title: string; from: string }> }) => {
          if (!live) return;
          const seen = new Set(mine.map((m) => m.url));
          setSugg([...mine, ...j.suggestions.filter((s) => !seen.has(s.url))].slice(0, 8));
        })
        .catch(() => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [addr, editing]);
  // your Chrome bookmarks bar, for a new tab
  const [bar, setBar] = useState<Array<{ url: string; title: string }>>([]);
  useEffect(() => {
    void fetch('/api/browser/bar')
      .then((r) => (r.ok ? r.json() : { bookmarks: [] }))
      .then((j: { bookmarks: Array<{ url: string; title: string }> }) => setBar(j.bookmarks))
      .catch(() => {});
  }, []);

  const mine = s?.tabs ?? [];
  // 1Password: the active tab's page, whether it has a login form, and what 1Password said for its site
  const activeWc = [...tabOfPage.entries()].find(([, t]) => t === activeId)?.[0] ?? 0;
  const opForm = useOp((o) => (activeWc ? o.forms[activeWc] : undefined));
  const opOn = useOp((o) => o.settings.on) && !!desktop?.opFill;
  const opKnown = useOp((o) => (opForm ? (o.known[hostOf(opForm.url)] ?? 0) > 0 : false));
  // Ctrl+\ in Cora (not in the page): the active tab's menu
  useEffect(() => {
    if (!shown) return;
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '\\' && activeWc && opForm?.form) {
        e.preventDefault();
        openOpMenu(activeWc);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [shown, activeWc, opForm?.form]);
  return (
    <div className={`web-pane${shown ? '' : ' hidden'}${web.wide ? ' wide' : ''}${dragging ? ' dragging' : ''}`} style={web.wide ? { inset: 0 } : rect}>
      {!web.wide ? (
        <div
          className="web-resize"
          title="Drag to resize (all the way left fills the scene area; double-click toggles)"
          onPointerDown={resize}
          onDoubleClick={() => web.setSplit(web.split >= 1 ? 0.6 : 1)}
        />
      ) : null}
      <div className="web-tabs">
        {mine.map((id) => {
          const t = web.tabs[id];
          const ts = state[id] ?? {};
          return (
            <div
              key={id}
              className={`web-tab${id === activeId ? ' on' : ''}`}
              title={t.title || t.url || 'New tab'}
              onClick={() => web.activate(id)}
              onAuxClick={(e) => e.button === 1 && web.closeTab(id)}
            >
              {ts.loading ? <span className="wt-spin" /> : ts.icon ? <img src={ts.icon} alt="" onError={(e) => (e.currentTarget.style.display = 'none')} /> : <Icon name="Globe" size={12} />}
              <span className="wt-t">{t.title || (t.url ? host(t.url) : 'New tab')}</span>
              <button
                className="wt-x"
                title="Close tab (Ctrl+W)"
                onClick={(e) => {
                  e.stopPropagation();
                  web.closeTab(id);
                }}
              >
                <Icon name="X" size={11} />
              </button>
            </div>
          );
        })}
        <button className="web-new" title="New tab (Ctrl+T)" onClick={() => web.newTab(sessionId)}>
          <Icon name="Plus" size={13} />
        </button>
      </div>
      <div className="web-bar">
        <button className="ib" disabled={!st.back} onClick={() => page()?.goBack()} title="Back">
          <Icon name="ArrowLeft" size={14} />
        </button>
        <button className="ib" disabled={!st.fwd} onClick={() => page()?.goForward()} title="Forward">
          <Icon name="ArrowRight" size={14} />
        </button>
        <button className="ib" disabled={!active?.url} onClick={() => (st.loading ? page()?.stop() : page()?.reload())} title={st.loading ? 'Stop' : 'Reload'}>
          <Icon name={st.loading ? 'X' : 'RotateCw'} size={13} />
        </button>
        <form
          className={`web-addr${editing || !active?.url ? ' editing' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            go(pick >= 0 && sugg[pick] ? sugg[pick].url : addr);
          }}
        >
          <Icon name={active?.url.startsWith('https:') ? 'Lock' : 'Globe'} size={11} />
          <input
            ref={input}
            value={addr}
            placeholder="Search or type an address (gitlab, jira, docs…)"
            spellCheck={false}
            onFocus={(e) => (setEditing(true), e.currentTarget.select())}
            onBlur={() => (setEditing(false), setAddr(active?.url ?? ''))}
            onChange={(e) => setAddr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') return void (setAddr(active?.url ?? ''), input.current?.blur());
              if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && sugg.length) {
                e.preventDefault();
                setPick((i) => Math.max(-1, Math.min(sugg.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1))));
              }
            }}
          />
          {editing && sugg.length ? (
            <div className="web-sugg" role="listbox">
              {sugg.map((s, i) => (
                <button
                  key={s.url}
                  type="button"
                  className={`ws-s${i === pick ? ' on' : ''}`}
                  onMouseDown={(e) => (e.preventDefault(), go(s.url))}
                  onMouseMove={() => i !== pick && setPick(i)}
                  title={s.url}
                >
                  <Icon name={s.from === 'bookmark' ? 'Star' : s.from === 'recent' ? 'History' : 'Globe'} size={12} />
                  <span className="t">{s.title || host(s.url)}</span>
                  <span className="u">{s.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
                </button>
              ))}
            </div>
          ) : null}
          {/* 1Password: on a page with a login form (lit once it's said it has logins for the site) */}
          {activeWc && opForm?.form && opOn ? (
            <button type="button" className={`web-key${opKnown ? ' lit' : ''}`} title="Fill from 1Password (Ctrl+\\)" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openOpMenu(activeWc, { anchor: e.currentTarget.getBoundingClientRect() })}>
              <Icon name="KeyRound" size={12} />
            </button>
          ) : null}
          {/* at rest: the host bright, the rest of the address quiet (the whole of it once you click in) */}
          {!editing && active?.url ? <AddrShow url={active.url} /> : null}
        </form>
        <button className="ib" disabled={!active?.url} onClick={() => active?.url && desktop?.openExternal?.(active.url)} title="Open in your browser">
          <Icon name="ExternalLink" size={13} />
        </button>
        <button className="ib" onClick={() => web.setWide(!web.wide)} title={web.wide ? 'Back to the scene area' : 'Use the whole width'}>
          <Icon name={web.wide ? 'Minimize2' : 'Maximize2'} size={13} />
        </button>
        <button className="ib" onClick={() => web.setShown(sessionId, false)} title="Hide (tabs stay loaded; Browser in the header brings it back)">
          <Icon name="EyeOff" size={13} />
        </button>
      </div>
      {st.loading ? <div className="web-progress" /> : <div className="web-progress idle" />}
      {finding && shown ? <FindBar press={finding} page={page() as never} onClose={() => setFinding(0)} /> : null}
      <div className="web-body">
        {web.order
          .filter((id) => mounted.has(id) && web.tabs[id]?.url)
          .map((id) => (
            <Page key={id} tab={web.tabs[id]} visible={shown && id === activeId} onState={onState} onVisit={onVisit} />
          ))}
        {active && !active.url ? (
          <div className="web-start">
            <div className="ws-h">New tab</div>
            <div className="ws-tip">
              Each session keeps its own tabs. Links you click in the app open here (Ctrl+click uses your usual browser); sign in
              to a site once and every session's tabs share it.
            </div>
            {bar.length ? <div className="ws-gl">Your bookmarks</div> : null}
            {bar.length ? (
              <div className="ws-list">
                {bar.map((r) => (
                  <button key={r.url} onClick={() => go(r.url)} title={r.url}>
                    <img src={`${new URL(r.url).origin}/favicon.ico`} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                    <span className="t">{r.title || host(r.url)}</span>
                    <span className="u">{host(r.url)}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {recent.length ? <div className="ws-gl">Recent</div> : null}
            {recent.length ? (
              <div className="ws-list">
                {recent.map((r) => (
                  <button key={r.url} onClick={() => go(r.url)} title={r.url}>
                    <img src={`${new URL(r.url).origin}/favicon.ico`} alt="" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                    <span className="t">{r.title}</span>
                    <span className="u">{host(r.url)}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {st.err && active?.url ? (
          <div className="web-err">
            <Icon name="TriangleAlert" size={13} /> {st.err}
            <button className="btn ghost" onClick={() => page()?.reload()}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** An address at rest: the host bright, the rest quiet. */
function AddrShow({ url }: { url: string }) {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return <span className="web-addr-show"><em>{url}</em></span>;
  }
  const rest = `${u.pathname === '/' ? '' : u.pathname}${u.search}${u.hash}`;
  return (
    <span className="web-addr-show" aria-hidden>
      <b>{u.host || url}</b>
      {rest ? <em>{rest}</em> : null}
    </span>
  );
}
