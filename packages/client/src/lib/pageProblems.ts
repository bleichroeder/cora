/**
 * What went wrong in a page in Cora's browser, as its console said it: errors (uncaught ones, `console.error`, a
 * resource that failed: Chromium logs those as errors too) and requests that didn't load. Kept for the page you're on
 * (a navigation starts again), so one click hands them to the session: "it's broken, look" with the evidence.
 */

export type PageProblem = { kind: 'error' | 'load'; text: string; source?: string; line?: number; /** how many times */ n: number };

export const MOST = 40;
const TEXT_MAX = 600;

/** A console message's level as Electron gives it (a number on the webview tag, a word on newer events): an error? */
export const isErrorLevel = (level: unknown): boolean => level === 3 || level === 'error';

/** The list with one more: the same thing again is counted, not repeated; the oldest fall off. */
export function addProblem(list: PageProblem[], p: Omit<PageProblem, 'n'>): PageProblem[] {
  const text = p.text.replace(/\s+$/g, '').slice(0, TEXT_MAX);
  if (!text) return list;
  const i = list.findIndex((x) => x.kind === p.kind && x.text === text && x.source === p.source && x.line === p.line);
  if (i >= 0) return list.map((x, k) => (k === i ? { ...x, n: x.n + 1 } : x));
  return [...list, { ...p, text, n: 1 }].slice(-MOST);
}

/** How many problems, repeats counted. */
export const problemCount = (list: PageProblem[]): number => list.reduce((n, p) => n + p.n, 0);

const where = (p: PageProblem): string => {
  if (!p.source) return '';
  let s = p.source;
  try {
    const u = new URL(p.source);
    s = `${u.host}${u.pathname}`;
  } catch {
    /* not an address: as it is */
  }
  return ` (${s}${p.line ? `:${p.line}` : ''})`;
};

/** What's put in the composer: the page, then each problem on a line, in the order they came. */
export function problemsPrompt(page: { url: string; title?: string }, list: PageProblem[]): string {
  const head = `The page ${page.url}${page.title ? ` ("${page.title.slice(0, 80)}")` : ''} in my browser shows ${problemCount(list) === 1 ? 'this problem' : 'these problems'} in its console:`;
  const lines = list.map((p) => `- ${p.kind === 'load' ? 'Failed to load: ' : ''}${p.text.replace(/\n+/g, '\n  ')}${where(p)}${p.n > 1 ? ` ×${p.n}` : ''}`);
  return `${head}\n\n${lines.join('\n')}\n`;
}
