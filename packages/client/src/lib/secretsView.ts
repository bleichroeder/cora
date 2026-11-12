import type { SecretInfo, SecretKind } from '@cora/shared';

/**
 * How Settings › Secrets shows the list: searched, filtered by kind (or to the ones needing you), grouped (by who
 * may use them, by kind, or not at all) and sorted. Pure, so it's tested without the page.
 */
export type SecretsGroupBy = 'where' | 'kind' | 'none';
export type SecretsSort = 'name' | 'used' | 'newest';
export type SecretsView = { q: string; kind: 'all' | SecretKind; group: SecretsGroupBy; sort: SecretsSort; attention: boolean };
export const DEFAULT_VIEW: SecretsView = { q: '', kind: 'all', group: 'where', sort: 'name', attention: false };

/** Expiring within this long: it needs you soon. */
export const SOON_MS = 24 * 3600_000;
/** Not used for this long: worth a look (still needed?). */
export const STALE_MS = 30 * 86400_000;

export const kindOf = (s: SecretInfo): SecretKind => s.kind ?? 'value';
/** A folder by its last part (`C:\gitlab\orion-services` → `orion-services`). */
export const folderName = (f: string) => f.split(/[\\/]/).filter(Boolean).pop() ?? f;

/** Expired, or expiring soon: what the strip at the top lists. */
export function health(s: SecretInfo, now = Date.now()): 'expired' | 'soon' | null {
  if (!s.expiresAt) return null;
  if (s.expiresAt <= now) return 'expired';
  return s.expiresAt - now < SOON_MS ? 'soon' : null;
}
export const needsYou = (list: SecretInfo[], now = Date.now()) =>
  list.filter((s) => health(s, now)).sort((a, b) => (a.expiresAt ?? 0) - (b.expiresAt ?? 0));

/** Used before, but not for a while. */
export const stale = (s: SecretInfo, now = Date.now()) => !!s.lastUsed && now - s.lastUsed.at > STALE_MS;

/** Does it match what's typed: its name, note, username or a folder it's for (every word, any order). */
export function matches(s: SecretInfo, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [s.name, s.note, s.user ?? '', ...('folders' in s.scope ? s.scope.folders : ['all sessions'])].join('\n').toLowerCase();
  return words.every((w) => hay.includes(w));
}

const byName = (a: SecretInfo, b: SecretInfo) => a.name.localeCompare(b.name);
const SORTS: Record<SecretsSort, (a: SecretInfo, b: SecretInfo) => number> = {
  name: byName,
  // most recently used first; never used last
  used: (a, b) => (b.lastUsed?.at ?? -1) - (a.lastUsed?.at ?? -1) || byName(a, b),
  newest: (a, b) => b.createdAt - a.createdAt || byName(a, b),
};

export type SecretsGroup = { key: string; label: string; title?: string; items: SecretInfo[] };

/**
 * The list as shown. Grouped by who may use it: "All sessions" first, then each folder (a secret for two folders is
 * in both); by kind: secrets, then usernames and passwords; or one group with no heading.
 */
export function viewSecrets(list: SecretInfo[], v: SecretsView, now = Date.now()): SecretsGroup[] {
  const shown = list
    .filter((s) => (v.kind === 'all' || kindOf(s) === v.kind) && (!v.attention || health(s, now)) && matches(s, v.q))
    .sort(SORTS[v.sort]);
  if (v.group === 'none') return shown.length ? [{ key: 'all', label: '', items: shown }] : [];
  if (v.group === 'kind') {
    return [
      { key: 'value', label: 'Secrets', items: shown.filter((s) => kindOf(s) === 'value') },
      { key: 'login', label: 'Usernames + passwords', items: shown.filter((s) => kindOf(s) === 'login') },
    ].filter((g) => g.items.length);
  }
  const everyone = shown.filter((s) => 'all' in s.scope);
  const folders = new Map<string, SecretInfo[]>();
  for (const s of shown) if ('folders' in s.scope) for (const f of s.scope.folders) folders.set(f, [...(folders.get(f) ?? []), s]);
  // folders with the same last part (two checkouts of one repo) keep their full path apart
  const names = [...folders.keys()].map(folderName);
  const groups = [...folders.entries()]
    .map(([f, items]) => ({ key: `f:${f}`, label: names.filter((n) => n === folderName(f)).length > 1 ? f : folderName(f), title: f, items }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return [...(everyone.length ? [{ key: 'all', label: 'All sessions', items: everyone }] : []), ...groups];
}

/** How many of each kind (the filter's counts). */
export const kindCounts = (list: SecretInfo[]) => ({ all: list.length, value: list.filter((s) => kindOf(s) === 'value').length, login: list.filter((s) => kindOf(s) === 'login').length });

/** Kept on this PC (how you last left it), without what you'd typed in the search. */
const KEY = 'cora.secrets.view';
export function loadView(): SecretsView {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<SecretsView>;
    return {
      ...DEFAULT_VIEW,
      ...(v.kind === 'value' || v.kind === 'login' ? { kind: v.kind } : {}),
      ...(v.group === 'kind' || v.group === 'none' ? { group: v.group } : {}),
      ...(v.sort === 'used' || v.sort === 'newest' ? { sort: v.sort } : {}),
    };
  } catch {
    return DEFAULT_VIEW;
  }
}
export function saveView(v: SecretsView): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ kind: v.kind, group: v.group, sort: v.sort }));
  } catch {
    /* this time only */
  }
}
