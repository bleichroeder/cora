import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { useWeb } from '../state/web';
import { useBrain } from '../state/store';
import { useTools } from '../state/tools';
import { BROWSER_ID, browserGroup, panelGroup, partitionOfTab, profileOfGroup, useBrowserProfile, useBrowserSettings, usePanelProfile, useSessionProfile, sessionProfile } from '../state/browser';
import { openSettings } from './SettingsModal';
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

/**
 * Ask a browser to open its find bar (Ctrl+F pressed inside a page reaches the app as an event). `group`: whose tabs
 * (a session's, or the Browser tool's); with none, the session browser on show.
 */
export const openFind = (group?: string) => window.dispatchEvent(new CustomEvent('cora:web-find', { detail: group }));

/** The bookmarks bar under the address bar: on unless you turned it off (one setting for every browser). */
const BAR_KEY = 'cora.web.bookmarks';
const barOn = () => {
  try {
    return localStorage.getItem(BAR_KEY) !== '0';
  } catch {
    return true;
  }
};

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
  // its profile's sign-ins, fixed when it's made (a webview can't change them)
  const partition = useRef(partitionOfTab(tab));
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

  return <webview ref={el as never} className={visible ? '' : 'off'} src={first.current} partition={partition.current} {...({ allowpopups: 'true' } as object)} />;
}

/**
 * A browser: one tab group's tabs (a session's, or the Browser tool's), the address bar, the bookmarks bar, find in
 * page, the pages and a new tab's start page. The session pane and the Browser tool both show one. `buttons`: the
 * host's own, at the end of the address bar row. `keys`: its shortcuts are live (it's the browser in front).
 */
function BrowserView({ group, shown, keys, buttons, intro }: { group: string; shown: boolean; keys: boolean; buttons?: React.ReactNode; intro: string }) {
  const web = useWeb();
  // whose bookmarks and history: the group's profile (followed as Settings change)
  const loaded = useBrowserSettings((b) => b.loaded);
  useBrowserSettings((b) => b.profiles);
  // (a session's browser switched to another profile: its pages are made again, signed in as it)
  useSessionProfile((p) => p.by[group]);
  const profile = profileOfGroup(group);
  const q = profile ? `profile=${encodeURIComponent(profile)}` : '';
  const s = web.sessions[group];
  const activeId = s?.active ?? null;
  const active = activeId ? web.tabs[activeId] : undefined;
  const [mounted, setMounted] = useState<Set<string>>(() => new Set());
  const [state, setState] = useState<Record<string, TabState>>({});
  const [recent, setRecent] = useState<Recent[]>(loadRecent);
  const [addr, setAddr] = useState(active?.url ?? '');
  const [editing, setEditing] = useState(false);
  const [showBar, setShowBar] = useState(barOn);
  const input = useRef<HTMLInputElement>(null);
  // find in page (Ctrl+F): open (already open: focused again)
  const [finding, setFinding] = useState(0);
  useEffect(() => {
    const open = (e: Event) => {
      const g = (e as CustomEvent<string | undefined>).detail;
      if (g === group || (g == null && keys)) setFinding((n) => n + 1);
    };
    window.addEventListener('cora:web-find', open);
    return () => window.removeEventListener('cora:web-find', open);
  }, [group, keys]);
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

  // shortcuts while this browser is in front and you're not typing somewhere
  useEffect(() => {
    if (!shown || !keys) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!e.ctrlKey || e.altKey || (t && t !== input.current && /^(INPUT|TEXTAREA)$/.test(t.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 't' && !e.shiftKey) useWeb.getState().newTab(group);
      else if (k === 'l' && !e.shiftKey) input.current?.focus();
      else if (k === 'f' && !e.shiftKey) openFind(group);
      // (only while you're in the browser: elsewhere Ctrl+Tab switches sessions)
      else if (k === 'tab' && t?.closest?.('.web-pane')) useWeb.getState().cycle(group, e.shiftKey ? -1 : 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shown, keys, group]);

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
    const typed = addr.trim();
    if (!editing || !typed || typed === active?.url) return void setSugg([]);
    const lq = typed.toLowerCase();
    const mine = recent.filter((r) => `${r.url} ${r.title}`.toLowerCase().includes(lq)).slice(0, 3).map((r) => ({ ...r, from: 'recent' }));
    setSugg(mine);
    let live = true;
    const t = setTimeout(() => {
      void fetch(`/api/browser/suggest?q=${encodeURIComponent(typed)}${q ? `&${q}` : ''}`)
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
  }, [addr, editing, q]);
  // your Chrome bookmarks bar (the profile's): under the address bar, and on a new tab
  const [bar, setBar] = useState<Array<{ url: string; title: string }>>([]);
  useEffect(() => {
    let live = true;
    void fetch(`/api/browser/bar${q ? `?${q}` : ''}`)
      .then((r) => (r.ok ? r.json() : { bookmarks: [] }))
      .then((j: { bookmarks: Array<{ url: string; title: string }> }) => live && setBar(j.bookmarks))
      .catch(() => {});
    return () => void (live = false);
  }, [q]);
  const toggleBar = () => {
    const on = !showBar;
    setShowBar(on);
    try {
      localStorage.setItem(BAR_KEY, on ? '1' : '0');
    } catch {
      /* this time only */
    }
  };

  // drag a tab to reorder the strip (its page doesn't move: moving one reloads it)
  const [dragId, setDragId] = useState<string | null>(null);
  const mine = s?.tabs ?? [];
  const dragOver = (e: React.DragEvent, overId: string) => {
    if (!dragId || dragId === overId) return;
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const i = mine.indexOf(overId);
    const from = mine.indexOf(dragId);
    // past the middle of the tab it's over: it takes that tab's place
    const after = e.clientX > r.left + r.width / 2;
    const to = from < i ? (after ? i : i - 1) : after ? i + 1 : i;
    if (to !== from) web.moveTab(dragId, to);
  };

  // 1Password: the active tab's page, whether it has a login form, and what 1Password said for its site
  const activeWc = [...tabOfPage.entries()].find(([, t]) => t === activeId)?.[0] ?? 0;
  const opForm = useOp((o) => (activeWc ? o.forms[activeWc] : undefined));
  const opOn = useOp((o) => o.settings.on) && !!desktop?.opFill;
  const opKnown = useOp((o) => (opForm ? (o.known[hostOf(opForm.url)] ?? 0) > 0 : false));
  // Ctrl+\ in Cora (not in the page): the active tab's menu
  useEffect(() => {
    if (!shown || !keys) return;
    const k = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === '\\' && activeWc && opForm?.form) {
        e.preventDefault();
        openOpMenu(activeWc);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [shown, keys, activeWc, opForm?.form]);

  const favicon = (u: string) => (
    <img
      src={(() => {
        try {
          return `${new URL(u).origin}/favicon.ico`;
        } catch {
          return '';
        }
      })()}
      alt=""
      onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
    />
  );

  return (
    <>
      <div className="web-tabs">
        {mine.map((id) => {
          const t = web.tabs[id];
          const ts = state[id] ?? {};
          return (
            <div
              key={id}
              className={`web-tab${id === activeId ? ' on' : ''}${id === dragId ? ' dragging' : ''}`}
              title={t.title || t.url || 'New tab'}
              draggable
              onDragStart={(e) => (setDragId(id), (e.dataTransfer.effectAllowed = 'move'), e.dataTransfer.setData('text/plain', ''))}
              onDragOver={(e) => dragOver(e, id)}
              onDragEnd={() => setDragId(null)}
              onDrop={(e) => (e.preventDefault(), setDragId(null))}
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
        <button className="web-new" title="New tab (Ctrl+T)" onClick={() => web.newTab(group)}>
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
          data-group={group}
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
        {bar.length ? (
          <button className={`ib${showBar ? ' on' : ''}`} onClick={toggleBar} title={showBar ? 'Hide the bookmarks bar' : 'Show the bookmarks bar'}>
            <Icon name="Bookmark" size={13} />
          </button>
        ) : null}
        <button className="ib" disabled={!active?.url} onClick={() => active?.url && desktop?.openExternal?.(active.url)} title="Open in your browser">
          <Icon name="ExternalLink" size={13} />
        </button>
        {buttons}
      </div>
      {showBar && bar.length ? <MarksBar bar={bar} icon={favicon} onGo={(u) => (active ? go(u) : web.open(group, u))} onNewTab={(u) => web.newTab(group, u, { background: true })} /> : null}
      {st.loading ? <div className="web-progress" /> : <div className="web-progress idle" />}
      {finding && shown ? <FindBar press={finding} page={page() as never} onClose={() => setFinding(0)} /> : null}
      <div className="web-body">
        {web.order
          .filter((id) => loaded && mounted.has(id) && web.tabs[id]?.url)
          .map((id) => (
            // (a profile switched: each page made again, signed in as it)
            <Page key={`${id}@${partitionOfTab(web.tabs[id])}`} tab={web.tabs[id]} visible={shown && id === activeId} onState={onState} onVisit={onVisit} />
          ))}
        {active && !active.url ? (
          <div className="web-start">
            <div className="ws-h">New tab</div>
            <div className="ws-tip">{intro}</div>
            {bar.length ? <div className="ws-gl">Your bookmarks</div> : null}
            {bar.length ? (
              <div className="ws-list">
                {bar.map((r) => (
                  <button key={r.url} onClick={() => go(r.url)} title={r.url}>
                    {favicon(r.url)}
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
                    {favicon(r.url)}
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
    </>
  );
}

/**
 * The bookmarks bar, as Chrome does it: the bookmarks that fit the bar's width, then » with the rest in a menu. Each
 * one's width is measured off-screen, so what fits follows the bar as it's resized.
 */
function MarksBar({ bar, icon, onGo, onNewTab }: { bar: Array<{ url: string; title: string }>; icon(u: string): React.ReactNode; onGo(u: string): void; onNewTab(u: string): void }) {
  const box = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(bar.length);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const b = box.current;
    const m = measure.current;
    if (!b || !m) return;
    const GAP = 2;
    const MORE = 30; // the » button
    const calc = () => {
      const widths = [...m.children].map((c) => (c as HTMLElement).offsetWidth);
      const room = b.clientWidth - 16; // the bar's side padding
      const total = widths.reduce((s, w, i) => s + w + (i ? GAP : 0), 0);
      if (total <= room) return setFit(widths.length);
      let used = 0;
      let n = 0;
      for (const w of widths) {
        const next = used + w + (n ? GAP : 0);
        if (next + GAP + MORE > room) break;
        used = next;
        n++;
      }
      setFit(n);
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(b);
    return () => ro.disconnect();
  }, [bar]);
  useEffect(() => {
    if (!more) return;
    const away = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && setMore(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), setMore(false));
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [more]);
  const mark = (r: { url: string; title: string }, after?: () => void) => (
    <button
      key={r.url}
      title={r.url}
      onClick={() => (onGo(r.url), after?.())}
      onAuxClick={(e) => e.button === 1 && (onNewTab(r.url), after?.())}
    >
      {icon(r.url)}
      <span>{r.title || host(r.url)}</span>
    </button>
  );
  const rest = bar.slice(fit);
  return (
    <div className="web-marks-wrap">
      <div className="web-marks" ref={box}>
        {bar.slice(0, fit).map((r) => mark(r))}
        {rest.length ? (
          <button className={`wm-more${more ? ' on' : ''}`} title={`${rest.length} more bookmark${rest.length === 1 ? '' : 's'}`} onClick={() => setMore(!more)}>
            <Icon name="ChevronsRight" size={14} />
          </button>
        ) : null}
        {/* every bookmark at its own width, out of sight: what fits is worked out from these */}
        <div className="wm-measure" ref={measure} aria-hidden>
          {bar.map((r) => (
            <button key={r.url} tabIndex={-1}>
              {icon(r.url)}
              <span>{r.title || host(r.url)}</span>
            </button>
          ))}
        </div>
      </div>
      {more && rest.length ? <div className="wm-menu">{rest.map((r) => mark(r, () => setMore(false)))}</div> : null}
    </div>
  );
}

/**
 * The built-in browser for a session: its own tabs (a GitLab and a Jira tab per piece of work), laid over the scene
 * or the whole focus area when wide. Every session's pages stay loaded while you're elsewhere; logins are shared.
 */
export function WebPane({ view, sessionId }: { view: React.RefObject<HTMLDivElement | null>; sessionId: string }) {
  const web = useWeb();
  const s = web.sessions[sessionId];
  const active = s?.active ? web.tabs[s.active] : undefined;
  const shown = !!s?.shown && !!active;
  // the Browser tool in the drawer, in front of it, takes the browser shortcuts
  const behind = useTools((t) => t.open === BROWSER_ID);
  // (you're in this session's Browser panel: the shortcuts are the panel's)
  const panelIn = usePanelIn((p) => p.sid === sessionId);
  const [rect, setRect] = useState<React.CSSProperties>({});
  const [dragging, setDragging] = useState(false);
  // your browser profiles: the session's browser can switch who it's signed in as (Settings › Tools brings them in)
  const profiles = useBrowserSettings((b) => b.profiles);
  useSessionProfile((p) => p.by[sessionId]);
  // over the Board (3D off): a drawer, sliding over it, never pushing it aside
  const over = useBrain((st) => st.prefs.scene3d === false);

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

  return (
    <div className={`web-pane${shown ? '' : ' hidden'}${web.wide ? ' wide' : ''}${dragging ? ' dragging' : ''}${over && !web.wide ? ' over' : ''}`} style={web.wide ? { inset: 0 } : rect}>
      {!web.wide ? (
        <div
          className="web-resize"
          title="Drag to resize (all the way left fills the scene area; double-click toggles)"
          onPointerDown={resize}
          onDoubleClick={() => web.setSplit(web.split >= 1 ? 0.6 : 1)}
        />
      ) : null}
      <BrowserView
        group={sessionId}
        shown={shown}
        keys={!behind && !panelIn}
        intro="Each session keeps its own tabs. Links you click in the app open here (Ctrl+click uses your usual browser); sign in to a site once and every session's tabs share it."
        buttons={
          <>
            {profiles.length > 1 ? <ProfileSwitch profiles={profiles} current={sessionProfile(sessionId)} pick={(id) => useSessionProfile.getState().set(sessionId, id)} /> : null}
            <button className="ib" onClick={() => web.setWide(!web.wide)} title={web.wide ? 'Back to the scene area' : 'Use the whole width'}>
              <Icon name={web.wide ? 'Minimize2' : 'Maximize2'} size={13} />
            </button>
            <button className="ib" onClick={() => web.setShown(sessionId, false)} title="Hide (tabs stay loaded; Browser in the header brings it back)">
              <Icon name="EyeOff" size={13} />
            </button>
          </>
        }
      />
    </div>
  );
}

/**
 * Cora's Browser, in the Tools drawer: tabs that belong to no session, with everything a session's tabs have (find,
 * 1Password, bookmarks, your Chrome history in the address bar). With profiles, a switcher like Chrome's: each profile
 * has its own sign-ins, bookmarks and tabs, kept as they were. Opened with no tabs, it starts with a new one; closing
 * its last tab closes the drawer.
 */
export function BrowserTool({ visible }: { visible: boolean }) {
  const profiles = useBrowserSettings((b) => b.profiles);
  const picked = useBrowserProfile((p) => p.id);
  const sessions = useBrowserSettings((b) => b.sessions);
  const profile = !profiles.length ? '' : profiles.some((p) => p.id === picked) ? picked : defaultProfile(profiles, sessions);
  const group = browserGroup(profile);
  const n = useWeb((w) => w.sessions[group]?.tabs.length ?? 0);
  const active = useWeb((w) => !!w.sessions[group]?.active);
  const had = useRef(n > 0);
  useEffect(() => void (had.current = n > 0), [group]);
  useEffect(() => {
    if (!visible) return void (had.current = n > 0);
    if (n > 0) return void (had.current = true);
    if (had.current) {
      had.current = false;
      useTools.getState().close();
    } else useWeb.getState().newTab(group);
  }, [visible, n, group]);
  return (
    <div className={`web-pane browser-tool${visible ? '' : ' off'}`}>
      <BrowserView
        group={group}
        shown={visible && active}
        keys={visible}
        intro="Cora's own browser: its tabs belong to no session. Links with nowhere better to go open here (an Inbox item with no Tool for its site). Sign in to a site once and every tab of this profile shares it."
        buttons={profiles.length > 1 ? <ProfileSwitch profiles={profiles} current={profile} pick={(id) => useBrowserProfile.getState().set(id)} groupOf={browserGroup} /> : null}
      />
    </div>
  );
}

/** The profile a list of profiles defaults to: the one sessions use, else the browser's own, else the first. */
const defaultProfile = (profiles: Array<{ id: string; partition: string }>, sessions?: string) => (profiles.find((p) => p.id === sessions) ?? profiles.find((p) => p.partition === 'persist:web') ?? profiles[0]).id;

/**
 * A Browser panel on the live board: a browser of its own, apart from the session's (which keeps its place and still
 * gets the links you open and Claude's tabs). Its own tabs, with a profile switcher like Chrome's (each profile's tabs
 * kept as they were). Its shortcuts are live while you're in it.
 */
/** The session whose Browser panel you're in: its shortcuts are the panel's then, not the session browser's. */
const usePanelIn = create<{ sid: string | null }>(() => ({ sid: null }));

export function PanelBrowser({ sessionId }: { sessionId: string }) {
  const profiles = useBrowserSettings((b) => b.profiles);
  const sessions = useBrowserSettings((b) => b.sessions);
  const picked = usePanelProfile((p) => p.by[sessionId]);
  const profile = !profiles.length ? '' : picked && profiles.some((p) => p.id === picked) ? picked : defaultProfile(profiles, sessions);
  const group = panelGroup(sessionId, profile);
  const n = useWeb((w) => w.sessions[group]?.tabs.length ?? 0);
  const active = useWeb((w) => !!w.sessions[group]?.active);
  // it always has a tab: a new one to start, and again after its last is closed
  useEffect(() => {
    if (!n) useWeb.getState().newTab(group);
  }, [n, group]);
  const [inside, setIn] = useState(false);
  const setInside = (on: boolean) => (setIn(on), usePanelIn.setState({ sid: on ? sessionId : null }));
  useEffect(() => () => usePanelIn.setState((p) => (p.sid === sessionId ? { sid: null } : p)), [sessionId]);
  return (
    <div
      className="web-pane panel-browser"
      onPointerDownCapture={() => setInside(true)}
      onFocusCapture={() => setInside(true)}
      onBlurCapture={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setInside(false)}
    >
      <BrowserView
        group={group}
        shown={active}
        keys={inside}
        intro="This panel's own browser: its tabs are apart from the session's (links you open and Claude's tabs go there). Pick a profile to browse as; each keeps its own tabs and sign-ins."
        buttons={profiles.length > 1 ? <ProfileSwitch profiles={profiles} current={profile} pick={(id) => usePanelProfile.getState().set(sessionId, id)} groupOf={(id) => panelGroup(sessionId, id)} /> : null}
      />
    </div>
  );
}

/** A profile's colour (its avatar): steady for its id. */
const AVATAR = ['#f472b6', '#38bdf8', '#a78bfa', '#34d399', '#fbbf24', '#fb923c', '#f87171', '#22d3ee'];
const avatarOf = (id: string) => AVATAR[[...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % AVATAR.length];

/** Chrome's profile button: who you're browsing as; pick another (its tabs come back as they were). */
function ProfileSwitch({ profiles, current, pick, groupOf }: { profiles: Array<{ id: string; name: string }>; current: string; pick(id: string): void; /** each profile's own tabs (none: one set of tabs, switching who they're signed in as) */ groupOf?(id: string): string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  const me = profiles.find((p) => p.id === current);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), setOpen(false));
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  const web = useWeb();
  const count = (id: string) => (groupOf ? (web.sessions[groupOf(id)]?.tabs.filter((t) => web.tabs[t]?.url).length ?? 0) : 0);
  return (
    <span className="web-prof" ref={box}>
      <button className={`web-prof-b${open ? ' on' : ''}`} title={`${me?.name ?? 'You'}: switch profile`} onClick={() => setOpen(!open)}>
        <span className="web-av" style={{ background: avatarOf(current) }}>
          {(me?.name ?? '?').slice(0, 1).toUpperCase()}
        </span>
      </button>
      {open ? (
        <div className="web-prof-menu" role="menu">
          <div className="wpm-h">Profiles</div>
          {profiles.map((p) => (
            <button key={p.id} role="menuitemradio" aria-checked={p.id === current} className={p.id === current ? 'on' : ''} onClick={() => (pick(p.id), setOpen(false))}>
              <span className="web-av" style={{ background: avatarOf(p.id) }}>
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <span className="t">{p.name}</span>
              <span className="u">{count(p.id) ? `${count(p.id)} tab${count(p.id) === 1 ? '' : 's'}` : ''}</span>
              {p.id === current ? <Icon name="Check" size={13} /> : <span />}
            </button>
          ))}
          <button className="wpm-manage" onClick={() => (setOpen(false), openSettings('tools'))}>
            <Icon name="Settings" size={13} /> Manage profiles
          </button>
        </div>
      ) : null}
    </span>
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
