/** What you typed in the browser's address bar, as a URL: a link as is, a host gets https (http for local), else a search. */
export function toUrl(input: string): string {
  const t = input.trim();
  if (!t) return '';
  if (/^https?:\/\//i.test(t)) return t;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(t)) return `http://${t}`;
  if (!/\s/.test(t) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#].*)?$/.test(t)) return `https://${t}`;
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`;
}

export type Recent = { url: string; title: string };
const KEY = 'ab:web.recent';
const MAX = 12;

/** Pages you've visited, newest first, one per address (ignoring the #fragment). */
export function addRecent(list: Recent[], r: Recent): Recent[] {
  const same = (u: string) => u.replace(/#.*$/, '');
  return [r, ...list.filter((x) => same(x.url) !== same(r.url))].slice(0, MAX);
}

export function loadRecent(): Recent[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x?.url === 'string' && /^https?:/i.test(x.url)) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: Recent[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* private window or storage blocked: recents just aren't kept */
  }
}
