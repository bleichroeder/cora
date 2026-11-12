import { useEffect, useRef } from 'react';
import { desktop } from '../lib/desktop';
import type { WebTab } from '../lib/webTabs';
import { useAgentPages } from '../state/agentPages';
import { agentProfileFor, useBrowserSettings } from '../state/browser';
import { useWeb } from '../state/web';
import { Page, type TabState } from './WebPane';
import './agentPages.css';

/**
 * The sessions' Playwright tabs (desktop/src/agentBrowser.ts drives them): their pages live here, mounted for as long
 * as the tab is open, whatever you're looking at (a session's browser comes and goes with its view, and a page that
 * goes mid-run would end Playwright's work). While a session's browser shows one, its page is laid over that spot
 * (BrowserView's `data-agent-slot`); otherwise it's parked behind the app, under a cover: still drawn (a page outside
 * the window isn't, and Playwright's screenshots would wait for it forever), never seen.
 */
/** Playwright tabs a page opened (a target=_blank link, window.open): which tab opened each (Playwright's popup). */
const openers = new Map<string, string>();
export const noteOpener = (tabId: string, opener: string) => void openers.set(tabId, opener);

export function AgentPages() {
  const tabs = useWeb((s) => s.tabs);
  const order = useWeb((s) => s.order);
  const loaded = useBrowserSettings((b) => b.loaded);
  const wc = useAgentPages((a) => a.wc);
  const size = useAgentPages((a) => a.size);
  /** tabs opened at the desktop's asking, until it's told their page is up */
  const asked = useRef(new Map<string, string>());
  const ids = order.filter((id) => tabs[id]?.agent);

  // the desktop app asks: open a tab for a session's Playwright, close one, show one
  useEffect(
    () =>
      desktop?.onAgentCmd?.((m) => {
        const web = useWeb.getState();
        if (m.t === 'open') {
          // (a page's own new tab opens beside it; Playwright's opens in the background when you're on another tab)
          const id = web.openAgent(m.sessionId, m.url || 'about:blank', { profile: agentProfileFor(m.sessionId) });
          asked.current.set(id, m.req);
        } else if (m.t === 'close') web.tabs[m.tabId]?.agent && web.closeTab(m.tabId);
        else if (m.t === 'activate') web.tabs[m.tabId]?.agent && web.activate(m.tabId);
      }),
    [],
  );

  // tell the desktop app which tabs there are (once a page is up it can be driven)
  useEffect(() => {
    if (!desktop?.agentTabs) return;
    const id = setTimeout(() => {
      const list = ids
        .filter((t) => wc[t])
        .map((t) => {
          const x = tabs[t];
          const req = asked.current.get(t);
          if (req) asked.current.delete(t);
          const opener = openers.get(t);
          return { tabId: t, sessionId: x.sessionId, wcId: wc[t], url: x.url, title: x.title, w: size[t]?.w ?? 0, h: size[t]?.h ?? 0, ...(req ? { req } : {}), ...(opener ? { opener } : {}) };
        });
      desktop!.agentTabs!(list);
    }, 30);
    return () => clearTimeout(id);
  }, [ids.join(','), wc, size, tabs]);

  // closed tabs: their entries go
  useEffect(() => {
    const st = useAgentPages.getState();
    const gone = Object.keys(st.wc).filter((t) => !tabs[t]?.agent);
    for (const t of [...openers.keys()]) if (!tabs[t]) openers.delete(t);
    if (!gone.length) return;
    const drop = <T,>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).filter(([k]) => !gone.includes(k)));
    useAgentPages.setState({ wc: drop(st.wc), state: drop(st.state), size: drop(st.size) });
  }, [tabs]);

  if (!desktop?.browser || !loaded) return null;
  return (
    <>
      {ids.length ? <div className="agent-cover" /> : null}
      {ids.map((id) => (
        <Holder key={id} tab={tabs[id]} />
      ))}
    </>
  );
}

const onState = (id: string, p: TabState) => useAgentPages.setState((a) => ({ state: { ...a.state, [id]: { ...a.state[id], ...p } } }));
const noVisit = () => {};
const PARKED = { w: 1280, h: 800 };
/** Menus of a session's browser that open over its page: cut out of the page laid over it, so they show. */
const OVER_PAGE = '.web-sugg, .wm-menu, .web-prof-menu, .web-find';

/** One Playwright tab's page, laid over its spot in a session's browser when that shows it, else parked behind the app. */
function Holder({ tab }: { tab: WebTab }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let last = '';
    let parked = PARKED;
    const place = () => {
      raf = requestAnimationFrame(place);
      const el = box.current;
      if (!el) return;
      const slot = document.querySelector<HTMLElement>(`[data-agent-slot="${CSS.escape(tab.id)}"]`);
      const r = slot && slot.offsetParent !== null && getComputedStyle(slot).visibility !== 'hidden' ? slot.getBoundingClientRect() : null;
      const on = !!r && r.width > 0 && r.height > 0;
      const x = on ? { l: r!.left, t: r!.top, w: r!.width, h: r!.height } : { l: 0, t: 0, ...parked };
      if (on) parked = { w: x.w, h: x.h };
      // the browser's own menus over the page: holes in it where they are
      let clip = 'none';
      const pane = on ? slot!.closest('.web-pane') : null;
      const menus = pane ? [...pane.querySelectorAll<HTMLElement>(OVER_PAGE)].map((m) => m.getBoundingClientRect()).filter((m) => m.right > x.l && m.left < x.l + x.w && m.bottom > x.t && m.top < x.t + x.h) : [];
      if (menus.length) clip = `path(evenodd, '${[`M0 0H${x.w}V${x.h}H0Z`, ...menus.map((m) => `M${m.left - x.l} ${m.top - x.t}H${m.right - x.l}V${m.bottom - x.t}H${m.left - x.l}Z`)].join(' ')}')`;
      const still = !!pane?.classList.contains('dragging');
      const key = `${on}|${x.l}|${x.t}|${x.w}|${x.h}|${clip}|${still}`;
      if (key === last) return;
      last = key;
      Object.assign(el.style, { left: `${x.l}px`, top: `${x.t}px`, width: `${x.w}px`, height: `${x.h}px`, clipPath: clip, pointerEvents: on && !still ? '' : 'none', zIndex: on ? '' : '-2' });
      el.classList.toggle('on', on);
      const was = useAgentPages.getState().size[tab.id];
      const w = Math.round(x.w), h = Math.round(x.h);
      if (!was || was.w !== w || was.h !== h) useAgentPages.setState((a) => ({ size: { ...a.size, [tab.id]: { w, h } } }));
    };
    raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [tab.id]);

  return (
    <div ref={box} className="agent-page" aria-hidden={undefined}>
      <Page tab={tab} visible onState={onState} onVisit={noVisit} onReady={(id) => useAgentPages.setState((a) => ({ wc: { ...a.wc, [tab.id]: id } }))} />
    </div>
  );
}
