/**
 * The built-in browser's tabs: each session has its own (a GitLab and a Jira tab per piece of work), all sharing one
 * set of logins. Pure state changes here; the store (state/web.ts) wires them up and keeps them across reloads.
 */
export type WebTab = { id: string; sessionId: string; url: string; title: string; /** bumped for each navigation asked of the tab from outside */ nav: number };
export type SessionWeb = { tabs: string[]; active: string | null; shown: boolean };
export type WebState = {
  tabs: Record<string, WebTab>;
  sessions: Record<string, SessionWeb>;
  /** every tab ever opened, oldest first: page elements are never reordered (moving one reloads it) */
  order: string[];
  wide: boolean;
  /** the browser's share of the scene area (docked on its right; the scene keeps the rest); 1 = all of it */
  split: number;
};

export const EMPTY_WEB: WebState = { tabs: {}, sessions: {}, order: [], wide: false, split: 0.6 };
export const SPLIT_MIN = 0.25;
/** Dragged this close to the left edge, the browser takes the whole scene area. */
export const SPLIT_FULL = 0.97;
export const clampSplit = (f: number) => (f >= SPLIT_FULL ? 1 : Math.max(SPLIT_MIN, Math.min(1, f)));

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;
const noHash = (u: string) => u.replace(/#.*$/, '');
const sw = (st: WebState, sid: string): SessionWeb => st.sessions[sid] ?? { tabs: [], active: null, shown: false };

/** A new tab in the session (after `after`, else after the active tab), shown and active unless `background`. */
export function newTab(st: WebState, sid: string, url = '', o: { after?: string; background?: boolean } = {}): WebState {
  const s = sw(st, sid);
  const id = newId();
  const at = s.tabs.indexOf(o.after ?? s.active ?? '');
  const tabs = [...s.tabs];
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, id);
  return {
    ...st,
    tabs: { ...st.tabs, [id]: { id, sessionId: sid, url, title: '', nav: 0 } },
    order: [...st.order, id],
    sessions: { ...st.sessions, [sid]: { tabs, active: o.background && s.active ? s.active : id, shown: true } },
  };
}

/** Open a link in the session: its tab if one is already at that address, otherwise a new tab. */
export function openUrl(st: WebState, sid: string, url: string, o: { after?: string; background?: boolean; reload?: boolean } = {}): WebState {
  const s = sw(st, sid);
  const have = s.tabs.find((id) => noHash(st.tabs[id]?.url ?? '') === noHash(url));
  // already open: switch to it (and, when asked, load it again so it shows the latest)
  if (have) return o.background ? st : activate(o.reload ? navigate(st, have, url) : st, have);
  // a blank active tab takes the link instead of leaving an empty tab behind
  const blank = s.active && !st.tabs[s.active]?.url && !o.background ? s.active : null;
  if (blank) return { ...navigate(st, blank, url), sessions: { ...st.sessions, [sid]: { ...s, shown: true } } };
  return newTab(st, sid, url, o);
}

export function activate(st: WebState, id: string): WebState {
  const t = st.tabs[id];
  if (!t) return st;
  const s = sw(st, t.sessionId);
  return { ...st, sessions: { ...st.sessions, [t.sessionId]: { ...s, active: id, shown: true } } };
}

/** Close a tab; the one to its right (else left) takes over, and with none left the browser hides. */
export function closeTab(st: WebState, id: string): WebState {
  const t = st.tabs[id];
  if (!t) return st;
  const s = sw(st, t.sessionId);
  const i = s.tabs.indexOf(id);
  const tabs = s.tabs.filter((x) => x !== id);
  const active = s.active === id ? (tabs[i] ?? tabs[i - 1] ?? null) : s.active;
  const { [id]: _gone, ...rest } = st.tabs;
  return { ...st, tabs: rest, order: st.order.filter((x) => x !== id), sessions: { ...st.sessions, [t.sessionId]: { tabs, active, shown: s.shown && tabs.length > 0 } } };
}

/** Send a tab somewhere (from the address bar or a link). */
export function navigate(st: WebState, id: string, url: string): WebState {
  const t = st.tabs[id];
  return t ? { ...st, tabs: { ...st.tabs, [id]: { ...t, url, nav: t.nav + 1 } } } : st;
}

/** What the page itself reports (it navigated, its title changed): no navigation is asked of it. */
export function update(st: WebState, id: string, p: { url?: string; title?: string }): WebState {
  const t = st.tabs[id];
  if (!t || ((p.url == null || p.url === t.url) && (p.title == null || p.title === t.title))) return st;
  return { ...st, tabs: { ...st.tabs, [id]: { ...t, ...p } } };
}

/** Show or hide the session's browser (its tabs stay loaded); showing it with no tabs opens a blank one. */
export function setShown(st: WebState, sid: string, shown: boolean): WebState {
  const s = sw(st, sid);
  if (shown && !s.tabs.length) return newTab(st, sid);
  if (s.shown === shown) return st;
  return { ...st, sessions: { ...st.sessions, [sid]: { ...s, shown } } };
}

/** The tab after (or before) the active one, wrapping. */
export function cycle(st: WebState, sid: string, dir: 1 | -1): WebState {
  const s = sw(st, sid);
  if (s.tabs.length < 2 || !s.active) return st;
  const i = s.tabs.indexOf(s.active);
  return activate(st, s.tabs[(i + dir + s.tabs.length) % s.tabs.length]);
}

/** Kept across reloads: tabs and their addresses (the pages themselves reload when you come back to them). */
export function serialize(st: WebState): string {
  return JSON.stringify({ v: 2, wide: st.wide, split: st.split, sessions: st.sessions, tabs: Object.values(st.tabs).map(({ id, sessionId, url, title }) => ({ id, sessionId, url, title })) });
}

export function deserialize(raw: string | null): WebState {
  try {
    const d = JSON.parse(raw ?? '');
    if (d?.v !== 2) return EMPTY_WEB;
    const tabs: Record<string, WebTab> = {};
    for (const t of d.tabs ?? []) if (typeof t?.id === 'string' && typeof t.sessionId === 'string' && (t.url === '' || /^https?:/i.test(t.url))) tabs[t.id] = { id: t.id, sessionId: t.sessionId, url: t.url, title: String(t.title ?? ''), nav: 0 };
    const sessions: Record<string, SessionWeb> = {};
    for (const [sid, s] of Object.entries<any>(d.sessions ?? {})) {
      const ids = (Array.isArray(s?.tabs) ? s.tabs : []).filter((id: string) => tabs[id]?.sessionId === sid);
      if (ids.length) sessions[sid] = { tabs: ids, active: ids.includes(s.active) ? s.active : ids[0], shown: !!s.shown };
    }
    const kept = Object.values(sessions).flatMap((s) => s.tabs);
    const split = typeof d.split === 'number' ? clampSplit(d.split) : EMPTY_WEB.split;
    return { tabs: Object.fromEntries(kept.map((id) => [id, tabs[id]])), sessions, order: kept, wide: !!d.wide, split };
  } catch {
    return EMPTY_WEB;
  }
}
