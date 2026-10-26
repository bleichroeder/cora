import { create } from 'zustand';
import * as W from '../lib/webTabs';

const KEY = 'ab:web.v2';
const load = () => {
  try {
    return W.deserialize(localStorage.getItem(KEY));
  } catch {
    return W.EMPTY_WEB;
  }
};

type Actions = {
  /** Open a link in the session's browser (its tab if already open there, else a new one). */
  open(sid: string, url: string, o?: { after?: string; background?: boolean; reload?: boolean; profile?: string }): void;
  newTab(sid: string, url?: string, o?: { after?: string; background?: boolean }): void;
  closeTab(id: string): void;
  /** a tab dragged to another place in its strip */
  moveTab(id: string, to: number): void;
  activate(id: string): void;
  navigate(id: string, url: string): void;
  update(id: string, p: { url?: string; title?: string }): void;
  setShown(sid: string, shown: boolean): void;
  cycle(sid: string, dir: 1 | -1): void;
  setWide(wide: boolean): void;
  setSplit(f: number): void;
};

/** The built-in browser: tabs per session, one shared set of logins. */
export const useWeb = create<W.WebState & Actions>((set, get) => {
  const apply = (f: (st: W.WebState) => W.WebState) => {
    const st = get();
    const next = f(st);
    if (next !== st) set(next);
  };
  return {
    ...load(),
    open: (sid, url, o) => apply((st) => W.openUrl(st, sid, url, o)),
    newTab: (sid, url, o) => apply((st) => W.newTab(st, sid, url, o)),
    closeTab: (id) => apply((st) => W.closeTab(st, id)),
    moveTab: (id, to) => apply((st) => W.moveTab(st, id, to)),
    activate: (id) => apply((st) => W.activate(st, id)),
    navigate: (id, url) => apply((st) => W.navigate(st, id, url)),
    update: (id, p) => apply((st) => W.update(st, id, p)),
    setShown: (sid, shown) => apply((st) => W.setShown(st, sid, shown)),
    cycle: (sid, dir) => apply((st) => W.cycle(st, sid, dir)),
    setWide: (wide) => set({ wide }),
    setSplit: (f) => set({ split: W.clampSplit(f) }),
  };
});

// keep tabs across reloads (written a moment after changes settle)
let timer: ReturnType<typeof setTimeout> | undefined;
useWeb.subscribe((st) => {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, W.serialize(st));
    } catch {
      /* storage unavailable: tabs just aren't kept */
    }
  }, 400);
});
