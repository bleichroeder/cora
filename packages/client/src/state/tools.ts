import { create } from 'zustand';

/** The Tools drawer: which tool is on show, which have been opened (their pages stay loaded), unread news, icons. */
type ToolsUi = {
  /** the tool on show in the drawer (null: the drawer is closed) */
  open: string | null;
  /** tools opened at least once: their pages stay loaded while the drawer is closed */
  mounted: Record<string, true>;
  unread: Record<string, number | 'dot'>;
  /** each tool's favicon, once its page said */
  icons: Record<string, string>;
  /** a page to go to in a tool (`n` counts asks, so asking for the same page again reloads it) */
  go: Record<string, { url: string; n: number }>;
  /** each open tool's page: where it is, and whether it's loading */
  page: Record<string, { url?: string; loading?: boolean }>;
  toggle(id: string): void;
  show(id: string, url?: string): void;
  close(): void;
  forget(id: string): void;
  setUnread(id: string, v: number | 'dot' | null): void;
  setIcon(id: string, url: string): void;
  setPage(id: string, p: { url?: string; loading?: boolean }): void;
};

const ICONS = 'ab:tool-icons';
const loadIcons = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(ICONS) ?? '{}');
  } catch {
    return {};
  }
};

export const useTools = create<ToolsUi>((set, get) => ({
  open: null,
  mounted: {},
  unread: {},
  icons: loadIcons(),
  go: {},
  page: {},
  setPage: (id, p) => set({ page: { ...get().page, [id]: { ...get().page[id], ...p } } }),
  toggle: (id) => (get().open === id ? get().close() : get().show(id)),
  show: (id, url) => {
    const go = url ? { ...get().go, [id]: { url, n: (get().go[id]?.n ?? 0) + 1 } } : get().go;
    set({ open: id, mounted: { ...get().mounted, [id]: true }, go });
  },
  close: () => set({ open: null }),
  forget: (id) => {
    const { [id]: _m, ...mounted } = get().mounted;
    // and the page it was last asked to go to: opened again later, it starts at home
    const { [id]: _g, ...go } = get().go;
    set({ mounted, go, open: get().open === id ? null : get().open });
  },
  setUnread: (id, v) => {
    if ((get().unread[id] ?? null) === v) return;
    const { [id]: _was, ...rest } = get().unread;
    set({ unread: v == null ? rest : { ...rest, [id]: v } });
  },
  setIcon: (id, url) => {
    if (get().icons[id] === url) return;
    const icons = { ...get().icons, [id]: url };
    set({ icons });
    try {
      localStorage.setItem(ICONS, JSON.stringify(icons));
    } catch {
      /* not kept */
    }
  },
}));
