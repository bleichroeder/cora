import { create } from 'zustand';
import { wipeSynced } from '../lib/synced';
import type { LiveAsk, LiveState, LiveView, ServerMsg } from '@cora/shared';
import { useBrain } from './store';

/**
 * Go live: your Cora shared with a teammate. On your
 * screen (the host's): the share, its link, the guests' asks. On a guest's: whose Cora, whether they follow the host.
 */
export type LiveCursor = { id: string; name: string; x: number; y: number; at: number; anchor?: string; ax?: number; ay?: number };
/** someone pointing at something: a pulse that fades */
export type LivePing = { key: number; id: string; name: string; x: number; y: number; anchor?: string; ax?: number; ay?: number };
type S = {
  role: 'host' | 'guest' | null;
  live: LiveState | null;
  asks: LiveAsk[];
  cursors: Record<string, LiveCursor>;
  pings: LivePing[];
  /** a guest: going where the host goes */
  following: boolean;
  /** the Live chip's popover */
  open: boolean;
  /** a short word on this screen ("Asked David") */
  note: string | null;
  /** going live couldn't (public links need Tailscale Funnel turned on for this PC, once): why, and where to fix it */
  setup: { error: string; enableUrl?: string; remoteOff?: boolean } | null;
};
export const useLive = create<S>(() => ({ role: null, live: null, asks: [], cursors: {}, pings: [], following: true, open: false, note: null, setup: null }));
let noteTimer: ReturnType<typeof setTimeout> | undefined;
export function liveNote(text: string): void {
  clearTimeout(noteTimer);
  useLive.setState({ note: text });
  noteTimer = setTimeout(() => useLive.setState({ note: null }), 4000);
}

export const isGuest = () => useLive.getState().role === 'guest';
/** A private area this screen may not see (a guest's, while the host keeps it closed). */
export const usePrivate = (area: 'inbox' | 'notes' | 'messages' | 'console') => useLive((s) => s.role === 'guest' && !s.live?.open.includes(area));

const post = async (url: string, body: unknown = {}): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> => {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { ok: true, ...j } : { ok: false, error: j.error ?? `failed (${r.status})`, ...j };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
};

/** Who this screen is in a share (asked once at the start, before anything is drawn). */
export async function loadLive(): Promise<void> {
  const r = await fetch('/api/live').catch(() => null);
  if (!r?.ok) return;
  const j = (await r.json().catch(() => null)) as { role: 'host' | 'guest'; live: LiveState | null; asks: LiveAsk[] } | null;
  if (j) useLive.setState({ role: j.role, live: j.live, asks: j.asks ?? [] });
}

/** The link, on your clipboard (to paste in Slack). */
export function copyLink(link: string): void {
  const d = (globalThis as { coraDesktop?: { writeClipboard?(t: string): void } }).coraDesktop;
  if (d?.writeClipboard) d.writeClipboard(link);
  else void navigator.clipboard?.writeText(link).catch(() => {});
}
/**
 * Go live: public by default (anyone with the link, in a browser), or your tailnet. The link goes on your clipboard;
 * if it can't (Funnel not turned on yet), the popover says how.
 */
export async function goLive(reach: 'public' | 'tailnet' = 'public') {
  const r = await post('/api/live/start', { reach });
  if (r.ok && r.live) {
    const live = r.live as LiveState;
    useLive.setState({ live, role: 'host', open: true, setup: null });
    if (live.link) {
      copyLink(live.link);
      liveNote('Live. The link is copied: paste it in Slack.');
    }
  } else useLive.setState({ open: true, setup: { error: r.error ?? "Couldn't go live", ...(typeof r.enableUrl === 'string' ? { enableUrl: r.enableUrl } : {}), ...(r.remoteOff ? { remoteOff: true } : {}) } });
  return r;
}
export const setLiveReach = (reach: 'public' | 'tailnet') =>
  post('/api/live/reach', { reach }).then((r) => {
    if (r.ok && r.live) useLive.setState({ live: r.live as LiveState });
    else liveNote(r.error ?? "Couldn't change that");
    return r;
  });
export const endLive = () => post('/api/live/end');
export const setLiveMode = (mode: LiveState['mode']) => post('/api/live/mode', { mode });
export const setLiveArea = (area: string, open: boolean) => post('/api/live/area', { area, open });
export const setFollowOnly = (on: boolean) => post('/api/live/follow', { on });
export const removeGuest = (id: string) => post(`/api/live/guests/${encodeURIComponent(id)}/remove`);
export const answerAsk = (id: string, allow: boolean) => post(`/api/live/asks/${encodeURIComponent(id)}`, { allow });
/** A guest acting in a session: a prompt, or an answer to its prompt (interactive: it waits for the host). */
export const guestAct = (body: { kind: 'prompt'; sessionId: string; text: string } | { kind: 'answer'; pendingId: string; decision: string; answers?: Record<string, string> }) => post('/api/live/act', body);

// --- the live stream ---------------------------------------------------------------------------------------------
let send: ((m: unknown) => void) | null = null;
/** the stream's sender (set by ws.ts once it's open) */
export function liveSender(fn: ((m: unknown) => void) | null): void {
  send = fn;
  // a fresh stream: guests see where you are
  if (fn) lastSent = '';
  if (fn) shareView(true);
}

let applying = false;
let applied = '';
export function applyLive(msg: ServerMsg): void {
  if (msg.t === 'live') {
    const was = useLive.getState().live;
    // whoever left takes their pointer with them
    const here = new Set(msg.live?.guests.map((g) => `guest:${g.id}`) ?? []);
    const cursors = Object.fromEntries(Object.entries(useLive.getState().cursors).filter(([id]) => !id.startsWith('guest:') || here.has(id)));
    useLive.setState({ live: msg.live, cursors, ...(msg.live ? {} : { asks: [], cursors: {} }) });
    // a guest's share ended (or they were removed): their screen says so
    if (!msg.live && useLive.getState().role === 'guest') (wipeSynced(), location.replace('/live/ended'));
    // someone joined: they see where you are, now
    if (msg.live && (msg.live.guests.length ?? 0) > (was?.guests.length ?? 0)) shareView(true);
  } else if (msg.t === 'live-asks') useLive.setState({ asks: msg.asks });
  else if (msg.t === 'cursor') {
    const cursors = { ...useLive.getState().cursors };
    if (msg.gone) delete cursors[msg.id];
    else cursors[msg.id] = { id: msg.id, name: msg.name, x: msg.x, y: msg.y, at: Date.now(), ...(msg.anchor ? { anchor: msg.anchor, ax: msg.ax, ay: msg.ay } : {}) };
    useLive.setState({ cursors });
  } else if (msg.t === 'ping') {
    const key = Date.now() + Math.random();
    useLive.setState((s) => ({ pings: [...s.pings.slice(-8), { key, id: msg.id, name: msg.name, x: msg.x, y: msg.y, ...(msg.anchor ? { anchor: msg.anchor, ax: msg.ax, ay: msg.ay } : {}) }] }));
    setTimeout(() => useLive.setState((s) => ({ pings: s.pings.filter((p) => p.key !== key) })), 2600);
  } else if (msg.t === 'live-view') {
    lastView = msg.view;
    if (useLive.getState().following) goTo(msg.view);
  }
}
let lastView: LiveView | null = null;

/** A guest following: where the host is. */
function goTo(v: LiveView): void {
  const st = useBrain.getState();
  applying = true;
  try {
    if (v.focus && st.sessions[v.focus] && st.focus !== v.focus) st.setFocus(v.focus);
    if (!v.focus && st.focus) useBrain.setState({ focus: null });
    if (st.overview !== v.overview) st.toggleOverview(v.overview);
    if (v.rightTab && useBrain.getState().rightTab !== v.rightTab) st.setRightTab(v.rightTab as never);
  } finally {
    applied = sig();
    applying = false;
  }
}
/** A guest following again: back to where the host is. */
export function follow(on: boolean): void {
  useLive.setState({ following: on });
  if (on && lastView) goTo(lastView);
}

const sig = () => {
  const s = useBrain.getState();
  return `${s.focus}|${s.overview}|${s.rightTab}`;
};
let lastSent = '';
let viewTimer: ReturnType<typeof setTimeout> | undefined;
/** The host: where you are, for the guests following you (only while live). */
function shareView(now = false): void {
  const l = useLive.getState();
  if (l.role !== 'host' || !l.live || !send) return;
  clearTimeout(viewTimer);
  const go = () => {
    const s = useBrain.getState();
    const view: LiveView = { focus: s.focus, overview: s.overview, rightTab: s.rightTab };
    const k = JSON.stringify(view);
    if (k === lastSent && !now) return;
    lastSent = k;
    send?.({ t: 'view', view });
  };
  if (now) go();
  else viewTimer = setTimeout(go, 120);
}

// where you are, as it changes: the host shares it; a guest going somewhere themselves stops following
useBrain.subscribe((s, p) => {
  if (s.focus === p.focus && s.overview === p.overview && s.rightTab === p.rightTab) return;
  const role = useLive.getState().role;
  if (role === 'host') shareView();
  else if (role === 'guest' && !applying && useLive.getState().live?.followOnly && lastView && sig() !== applied) queueMicrotask(() => lastView && goTo(lastView));
  else if (role === 'guest' && !applying && useLive.getState().following && sig() !== applied) {
    if (Date.now() - lastInput < 1500) useLive.setState({ following: false });
    // Cora moved on its own (picking a session on load): back to where the host is
    else if (lastView) queueMicrotask(() => lastView && useLive.getState().following && goTo(lastView));
  }
});
let lastInput = 0;
if (typeof window !== 'undefined') {
  const mark = (e: Event) => {
    // the guest bar's own buttons aren't going somewhere
    if (!(e.target as Element | null)?.closest?.('.guest-bar')) lastInput = Date.now();
  };
  window.addEventListener('pointerdown', mark, true);
  window.addEventListener('keydown', mark, true);
}

// --- pointers: yours to the others (a share of the window), theirs drawn over yours ---------------------------------
let lastMove = 0;
let pend: { x: number; y: number; anchor?: string; ax?: number; ay?: number } | null = null;
let moveTimer: ReturnType<typeof setTimeout> | undefined;
const sharing = () => {
  const l = useLive.getState();
  return !!send && !!l.live && (l.role === 'guest' || l.live.guests.length > 0);
};
function flushMove(): void {
  moveTimer = undefined;
  if (!pend || !sharing()) return;
  lastMove = Date.now();
  send?.({ t: 'cursor', ...pend });
  pend = null;
}
if (typeof window !== 'undefined') {
  window.addEventListener('pointermove', (e) => {
    if (!sharing() || e.pointerType === 'touch') return;
    pend = { ...toShare(e.clientX, e.clientY), ...anchorAt(e.target as Element | null, e.clientX, e.clientY) };
    const wait = 80 - (Date.now() - lastMove);
    if (wait <= 0) flushMove();
    else moveTimer ??= setTimeout(flushMove, wait);
  });
  document.addEventListener('mouseleave', () => sharing() && send?.({ t: 'cursor-gone' }));
}


// Follow only (a guest's screen): their clicks don't act; each is a pulse on everyone else's screen, where they pointed
/** Point at something: a pulse there on the others' screens (a share of the window). */
export function ping(x: number, y: number, at?: { anchor: string; ax: number; ay: number }): void {
  send?.({ t: 'ping', x, y, ...at });
}
/** What's under a point that every screen has (a session's row, a panel, a tab: [data-ping]), and where on it. */
function anchorAt(el: Element | null, cx: number, cy: number): { anchor: string; ax: number; ay: number } | undefined {
  const a = el?.closest?.('[data-ping]') as HTMLElement | null;
  const name = a?.dataset.ping;
  if (!a || !name) return undefined;
  const r = a.getBoundingClientRect();
  return { anchor: name, ax: (cx - r.left) / Math.max(1, r.width), ay: (cy - r.top) / Math.max(1, r.height) };
}
if (typeof window !== 'undefined') {
  const stop = (e: Event) => {
    const l = useLive.getState();
    if (l.role !== 'guest' || !l.live?.followOnly) return;
    const el = e.target as Element | null;
    // the guest bar (Follow only's own word) stays theirs
    if (el?.closest?.('.guest-bar')) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'pointerdown' && e instanceof PointerEvent) {
      const at = toShare(e.clientX, e.clientY);
      const on = anchorAt(el, e.clientX, e.clientY);
      ping(at.x, at.y, on);
      // and on their own screen too, so they see where they pointed
      const key = Date.now() + Math.random();
      useLive.setState((s) => ({ pings: [...s.pings.slice(-8), { key, id: 'me', name: 'You', ...at, ...on }] }));
      setTimeout(() => useLive.setState((s) => ({ pings: s.pings.filter((p) => p.key !== key) })), 1600);
    }
  };
  for (const t of ['pointerdown', 'pointerup', 'click', 'dblclick', 'contextmenu', 'mousedown', 'mouseup', 'touchstart']) window.addEventListener(t, stop, { capture: true, passive: false });
}

/**
 * Where a pointer is, as a share of Cora's own area (the nav and the main view, without a guest's bar on top), so it
 * lands on the same thing on every screen in the share.
 */
export function placeOnScreen(p: { x: number; y: number; anchor?: string; ax?: number; ay?: number }): { left: number; top: number } {
  const el = p.anchor ? (document.querySelector(`[data-ping="${CSS.escape(p.anchor)}"]`) as HTMLElement | null) : null;
  const r = el?.getBoundingClientRect();
  if (r && r.width && r.height) return { left: r.left + (p.ax ?? 0.5) * r.width, top: r.top + (p.ay ?? 0.5) * r.height };
  const a = shareArea();
  return { left: a.left + p.x * a.width, top: a.top + p.y * a.height };
}
export const shareArea = () => document.querySelector('.shell-body')?.getBoundingClientRect() ?? new DOMRect(0, 0, window.innerWidth, window.innerHeight);
function toShare(cx: number, cy: number): { x: number; y: number } {
  const r = shareArea();
  return { x: (cx - r.left) / Math.max(1, r.width), y: (cy - r.top) / Math.max(1, r.height) };
}
