/**
 * Journal 2: a journal entry with what it points at, so Cora and
 * sessions can find "everything about ACME-5340 this week" and follow the links.
 */
export type JournalEntryKind = 'entry' | 'wrapup' | 'recap';
/** What an entry is, when the session says: something done, a decision, a finding, a blocker. */
export const JOURNAL_TAGS = ['done', 'decision', 'finding', 'blocker'] as const;
export type JournalTag = (typeof JOURNAL_TAGS)[number];

export type JournalRefs = {
  /** Jira keys */
  tickets?: string[];
  /** merge requests: !412 */
  mrs?: string[];
  /** GitLab issues: #212 */
  issues?: string[];
  /** explains it wrote (since its last entry) */
  explains?: Array<{ id: string; title: string }>;
  /** what it made: claude.ai pages, files (a report, a video) */
  artifacts?: string[];
  links?: string[];
};

export type JournalEntry = {
  id: string;
  at: number;
  sessionId: string;
  /** the session's name when it wrote it */
  session: string;
  cwd: string;
  /** the repo's folder name */
  repo: string;
  branch?: string;
  kind: JournalEntryKind;
  tag?: JournalTag;
  text: string;
  refs: JournalRefs;
};

const uniq = (a: string[]) => [...new Set(a)];
const ARTIFACT = /^https:\/\/claude\.ai\/(?:code\/)?artifact\//;

/**
 * What an entry's text points at: Jira keys (of your projects, when they're known), merge requests (!412), GitLab issues
 * (#212: two digits or more), links (claude.ai pages among them as artifacts).
 */
export function findRefs(text: string, o: { projects?: string[] } = {}): JournalRefs {
  const known = new Set((o.projects ?? []).map((p) => p.toUpperCase()));
  const tickets = uniq([...text.matchAll(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g)].filter((m) => !known.size || known.has(m[1])).map((m) => `${m[1]}-${m[2]}`));
  const links = uniq([...text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)].map((m) => m[0].replace(/[.,;:]+$/, '')));
  const fromLinks = (re: RegExp) => links.flatMap((l) => [...l.matchAll(re)].map((m) => m[1]));
  const mrs = uniq([...[...text.matchAll(/(?:^|[^\w&])!(\d{1,6})\b/g)].map((m) => `!${m[1]}`), ...fromLinks(/\/merge_requests\/(\d+)/g).map((n) => `!${n}`)]);
  const issues = uniq([...[...text.matchAll(/(?:^|[\s(])#(\d{2,6})\b/g)].map((m) => `#${m[1]}`), ...fromLinks(/\/-\/issues\/(\d+)/g).map((n) => `#${n}`)]);
  const artifacts = links.filter((l) => ARTIFACT.test(l));
  const r: JournalRefs = {};
  if (tickets.length) r.tickets = tickets;
  if (mrs.length) r.mrs = mrs;
  if (issues.length) r.issues = issues;
  if (artifacts.length) r.artifacts = artifacts;
  const rest = links.filter((l) => !ARTIFACT.test(l));
  if (rest.length) r.links = rest.slice(0, 12);
  return r;
}

/** Two sets of refs as one (in order, no repeats). */
export function mergeRefs(...all: JournalRefs[]): JournalRefs {
  const r: JournalRefs = {};
  for (const k of ['tickets', 'mrs', 'issues', 'artifacts', 'links'] as const) {
    const v = uniq(all.flatMap((a) => a[k] ?? []));
    if (v.length) r[k] = v;
  }
  const ex = all.flatMap((a) => a.explains ?? []).filter((e, i, xs) => xs.findIndex((x) => x.id === e.id) === i);
  if (ex.length) r.explains = ex;
  return r;
}

/** The line under an entry in its markdown file: `Refs: ACME-5340 · !412 · #212 · explain "Release 2.4"`; none: ''. */
export function refsLine(r: JournalRefs, tag?: JournalTag): string {
  const parts = [...(tag ? [tag] : []), ...(r.tickets ?? []), ...(r.mrs ?? []), ...(r.issues ?? []), ...(r.explains ?? []).map((e) => `explain "${e.title}"`), ...(r.artifacts ?? []).map((a) => `[artifact](${a})`)];
  return parts.length ? `Refs: ${parts.join(' · ')}` : '';
}

/** An entry's headline: its first line, its markdown taken off (`**#421 check 1/3: OK**` → `#421 check 1/3: OK`), short. */
export function headline(text: string, max = 160): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const plain = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
