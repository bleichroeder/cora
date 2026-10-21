import { create } from 'zustand';
import { DEFAULT_ONEPASSWORD, type OnePasswordSettings, type OpLogin, type OpStatus } from '@cora/shared';
import { desktop } from '../lib/desktop';

/**
 * 1Password in Cora's browser, the dashboard's side: which pages have a login form (told by the desktop app), the menu,
 * and asking the desktop app to fill. No password ever comes here: the desktop app fills the page itself.
 *
 */
type Op = {
  /** by page (webContents id): its address and whether it has a login form */
  forms: Record<number, { url: string; form: boolean }>;
  /** what 1Password said when you last asked, by site: how many logins it has for it (lights the key) */
  known: Record<string, number>;
  /** the open menu: for which page, and where (see OpPlace) */
  menu: ({ from: number } & OpPlace) | null;
  /** by page: its focused login field (in the page's pixels), for Ctrl+\ to open the menu there */
  field: Record<number, PageRect>;
  settings: OnePasswordSettings;
};

/** A field in a page, in that page's pixels. */
export type PageRect = { x: number; y: number; w: number; h: number };
/**
 * Where the menu opens: under the button that opened it (`anchor`, in Cora's pixels), under a field of the page (`at`),
 * else at the top right of the page. `suggest`: opened by focusing the field (it goes when the field does).
 */
export type OpPlace = { anchor?: { left: number; top: number; right: number; bottom: number }; at?: PageRect; suggest?: boolean };

export const useOp = create<Op>(() => ({ forms: {}, known: {}, menu: null, field: {}, settings: { ...DEFAULT_ONEPASSWORD } }));

export const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Can this dashboard fill at all (the desktop app, with 1Password on)? */
export const canFill = () => !!desktop?.opFill && useOp.getState().settings.on;

/** The settings, here and told to the desktop app (it needs them for Tool windows and codes). */
export function setOpSettings(s: OnePasswordSettings | undefined): void {
  const settings = { ...DEFAULT_ONEPASSWORD, ...s };
  useOp.setState({ settings });
  desktop?.opPrefs?.(settings);
}

export function openOpMenu(from: number, place: OpPlace = {}): void {
  if (!canFill()) return;
  const at = place.at ?? (place.anchor ? undefined : useOp.getState().field[from]);
  useOp.setState({ menu: { from, ...place, ...(at ? { at } : {}) } });
}
const MENU_W = 400;
/** Under what opened it, kept on screen (above it when there's no room below); else the page's top right. */
export function menuStyle(place: OpPlace, page: { left: number; top: number; right: number } | null, view: { w: number; h: number }): Record<string, number | string> {
  const w = Math.min(MENU_W, view.w - 32);
  let r = place.anchor ?? null;
  let alignRight = !!place.anchor;
  if (!r && page && place.at) r = { left: page.left + place.at.x, top: page.top + place.at.y, right: page.left + place.at.x + place.at.w, bottom: page.top + place.at.y + place.at.h };
  if (!r && page) (r = { left: page.right - 12, right: page.right - 12, top: page.top + 2, bottom: page.top + 2 }), (alignRight = true);
  if (!r) return {};
  const left = Math.round(Math.max(8, Math.min(alignRight ? r.right - w : r.left, view.w - w - 8)));
  const below = view.h - r.bottom;
  return below >= 280 || below >= r.top ? { top: Math.round(r.bottom + 6), left, right: 'auto', maxHeight: Math.round(below - 18) } : { top: 'auto', bottom: Math.round(view.h - r.top + 6), left, right: 'auto', maxHeight: Math.round(r.top - 18) };
}

export const closeOpMenu = () => useOp.setState({ menu: null });

/** The pointer is over the menu (a field's blur, from clicking it, mustn't close it). */
let overMenu = false;
export const setOverMenu = (on: boolean) => void (overMenu = on);

/**
 * The key in a page's login field (the desktop app tells us): clicked opens the menu under the field; focused
 * remembers it, and suggests the site's logins there when that's on and 1Password is unlocked; left closes a
 * suggestion. `allowed`: a page that may be filled from here (a session's tab, or a Tool when that's on).
 */
export function onField(m: { from: number; k: 'focus' | 'blur' | 'open'; r?: PageRect; unlocked: boolean }, allowed: boolean): void {
  const st = useOp.getState();
  if (m.k === 'blur') {
    const field = { ...st.field };
    delete field[m.from];
    useOp.setState({ field });
    // after a moment: a click on the menu blurs the field first
    setTimeout(() => {
      const menu = useOp.getState().menu;
      if (menu?.suggest && menu.from === m.from && !overMenu) closeOpMenu();
    }, 200);
    return;
  }
  if (m.r) useOp.setState({ field: { ...st.field, [m.from]: m.r } });
  if (!allowed) return;
  if (m.k === 'open') return openOpMenu(m.from, { ...(m.r ? { at: m.r } : {}) });
  // focus: suggest, unless a menu you opened is showing
  if (m.unlocked && st.settings.suggest && !(st.menu && !st.menu.suggest)) openOpMenu(m.from, { ...(m.r ? { at: m.r } : {}), suggest: true });
}

/** The page's logins (asking 1Password: it may ask you to unlock). Remembers how many, to light the key. */
export async function loginsFor(from: number): Promise<{ url?: string; logins?: OpLogin[]; error?: string }> {
  const r = (await desktop?.opLogins?.(from)) ?? { error: 'not in the desktop app' };
  if (r.url && r.logins) useOp.setState({ known: { ...useOp.getState().known, [hostOf(r.url)]: r.logins.length } });
  return r;
}
export const searchOp = async (q: string) => (await desktop?.opSearch?.(q)) ?? { error: 'not in the desktop app' };
export const fillOp = async (from: number, id: string, anySite = false) => (await desktop?.opFill?.(from, id, anySite)) ?? { error: 'not in the desktop app' };
export const opStatus = async (): Promise<OpStatus | null> => (await desktop?.opStatus?.()) ?? null;

if (desktop?.onLoginForm) {
  desktop.onLoginForm((m) => useOp.setState({ forms: { ...useOp.getState().forms, [m.from]: { url: m.url, form: m.form } } }));
  // the settings from the server, once (Settings changes them through setOpSettings)
  void fetch('/api/settings')
    .then((r) => (r.ok ? r.json() : null))
    .then((s: { onepassword?: OnePasswordSettings } | null) => s && setOpSettings(s.onepassword))
    .catch(() => {});
}
