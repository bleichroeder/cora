import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { JiraIssue, JiraResult, JiraUser } from '@cora/shared';
import { desktop } from '../lib/desktop';
import { batcher, freshness, projectOf, settle, type Entry } from '../lib/jira';

/**
 * Jira, read-only, through the desktop app (the built-in browser's Jira login is the auth): issues by key, cached
 * for a minute and a half and shown stale while they're looked up again, asked for in batches; your open issues;
 * which projects the site has (what makes "ACME-5206" a ticket and "UTF-8" not). In a plain browser it's unavailable.
 */
export type JiraAuth = 'unknown' | 'ok' | 'signed-out' | 'offline' | 'unavailable';
type Saved = { site: string; detected: string | null; projects: string[]; projectsAt: number; seen: string[] };
type State = Saved & {
  auth: JiraAuth;
  me: JiraUser | null;
  /** by `${site} ${key}` */
  issues: Record<string, Entry>;
};

const KEY = 'ab:jira';
const PROJECTS_TTL = 6 * 3600_000;
const load = (): Saved => {
  const d: Saved = { site: '', detected: null, projects: [], projectsAt: 0, seen: [] };
  try {
    return { ...d, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return d;
  }
};

export const useJira = create<State>(() => ({ ...load(), auth: desktop?.jira ? 'unknown' : 'unavailable', me: null, issues: {} }));
// in dev, the store is window.__jira (as useBrain is __brain)
if (import.meta.env?.DEV) (globalThis as { __jira?: unknown }).__jira = useJira;
useJira.subscribe((st, prev) => {
  if (st.site === prev.site && st.detected === prev.detected && st.projects === prev.projects && st.seen === prev.seen) return;
  try {
    const { site, detected, projects, projectsAt, seen } = st;
    localStorage.setItem(KEY, JSON.stringify({ site, detected, projects, projectsAt, seen }));
  } catch {
    /* storage unavailable: projects are fetched again next time */
  }
});

const bridge = () => desktop?.jira;
/** Whether Jira can be asked at all (the desktop app); elsewhere there are no chips. */
export const jiraAvailable = () => !!bridge();
/** The Jira site lookups go to: the one set in Settings, else the one found (browser cookies, then links seen). */
export const jiraSite = (st: Pick<Saved, 'site' | 'detected'> = useJira.getState()) => st.site || st.detected || null;
const ck = (site: string, key: string) => `${site} ${key}`;

const authOf = (r: JiraResult<unknown>): JiraAuth => (r.ok ? 'ok' : r.error === 'signed-out' ? 'signed-out' : r.error === 'offline' ? 'offline' : useJira.getState().auth);

// ---- issues: batched, de-duplicated, cached ----

const inflight = new Map<string, Promise<JiraResult<JiraIssue>>>();
const waiting = new Map<string, (r: JiraResult<JiraIssue>) => void>();
const queues = new Map<string, (key: string) => void>();

function queueFor(site: string) {
  let q = queues.get(site);
  if (!q)
    queues.set(
      site,
      (q = batcher<string>(async (keys) => {
        const res = await bridge()!.issues(site, keys).catch((e: Error) => ({ ok: false as const, error: 'offline' as const, message: e?.message }));
        const now = Date.now();
        const each = (k: string): JiraResult<JiraIssue> => ('ok' in res && typeof res.ok === 'boolean' ? (res as JiraResult<JiraIssue>) : (res as Record<string, JiraResult<JiraIssue>>)[k] ?? { ok: false, error: 'error' });
        const issues = { ...useJira.getState().issues };
        let auth: JiraAuth | null = null;
        for (const k of keys) {
          const r = each(k);
          issues[ck(site, k)] = settle(issues[ck(site, k)], r, now);
          if (r.ok || r.error === 'signed-out' || r.error === 'offline') auth = authOf(r);
        }
        useJira.setState({ issues, ...(auth ? { auth } : {}) });
        for (const k of keys) {
          inflight.delete(ck(site, k));
          waiting.get(ck(site, k))?.(issues[ck(site, k)].r);
          waiting.delete(ck(site, k));
        }
      })),
    );
  return q;
}

/**
 * An issue by key: from the cache while it's fresh, else asked for (along with whatever else is asked for in the
 * same moment). A stale answer is returned at once and refreshed behind it.
 */
export function lookupIssue(key: string, o: { site?: string; force?: boolean } = {}): Promise<JiraResult<JiraIssue>> {
  init();
  if (!bridge()) return Promise.resolve({ ok: false, error: 'unavailable' });
  const site = o.site || jiraSite();
  if (!site) return Promise.resolve({ ok: false, error: 'no-site' });
  const id = ck(site, key);
  const have = useJira.getState().issues[id];
  const f = freshness(have, Date.now());
  if (f === 'fresh' && !o.force) return Promise.resolve(have!.r);
  let p = inflight.get(id);
  if (!p) {
    p = new Promise((resolve) => waiting.set(id, resolve));
    inflight.set(id, p);
    queueFor(site)(key);
  }
  return f === 'stale' && !o.force ? Promise.resolve(have!.r) : p;
}

/** An issue for a component: its cached answer (undefined while the first lookup runs); looked up when stale. */
export function useJiraIssue(key: string, site?: string): JiraResult<JiraIssue> | undefined {
  const s = useJira((st) => site || jiraSite(st));
  const e = useJira((st) => (s ? st.issues[ck(s, key)] : undefined));
  useEffect(() => {
    if (freshness(e, Date.now()) !== 'fresh') void lookupIssue(key, { site: s ?? undefined });
  }, [key, s, e]);
  if (!bridge()) return { ok: false, error: 'unavailable' };
  if (!s) return { ok: false, error: 'no-site' };
  return e?.r;
}

/** Your open issues (assigned to you, not done), newest change first. Not cached: for the /jira list to ask when shown. */
export async function myOpenIssues(max = 50): Promise<JiraResult<JiraIssue[]>> {
  init();
  const site = jiraSite();
  if (!bridge()) return { ok: false, error: 'unavailable' };
  if (!site) return { ok: false, error: 'no-site' };
  const r = await bridge()!.myOpenIssues(site, max).catch((e: Error) => ({ ok: false as const, error: 'offline' as const, message: e?.message }));
  useJira.setState({ auth: authOf(r) });
  if (r.ok) {
    // the list doubles as fresh lookups for the chips of the same issues
    const now = Date.now();
    const issues = { ...useJira.getState().issues };
    for (const i of r.value) issues[ck(site, i.key)] = { r: { ok: true, value: i }, at: now };
    useJira.setState({ issues });
  }
  return r;
}

// ---- which keys are tickets ----

/** Whether KEY-123 is a ticket: its project is one the site has (or one seen in a Jira link). */
export function isKnownKey(key: string, st: Pick<Saved, 'projects' | 'seen'> = useJira.getState()) {
  if (!bridge()) return false;
  const p = projectOf(key);
  return st.projects.includes(p) || st.seen.includes(p);
}

/** isKnownKey for rendering: the component re-renders when the project list changes. */
export function useKnownKey(): ((key: string) => boolean) | null {
  const projects = useJira((st) => st.projects);
  const seen = useJira((st) => st.seen);
  useEffect(() => init(), []);
  // stable while the lists are (Markdown re-parses when it changes)
  return useMemo(() => (!bridge() || (!projects.length && !seen.length) ? null : (key: string) => isKnownKey(key, { projects, seen })), [projects, seen]);
}

/** A Jira link went by: its site is a fallback for which Jira this is, its project a ticket project. */
export function noteLink(site: string, key: string) {
  if (!bridge()) return;
  const st = useJira.getState();
  const p = projectOf(key);
  const patch: Partial<State> = {};
  if (!st.detected && !st.site) patch.detected = site;
  if (site === jiraSite(st) && !st.projects.includes(p) && !st.seen.includes(p)) patch.seen = [...st.seen, p].slice(-50);
  if (Object.keys(patch).length) queueMicrotask(() => useJira.setState(patch));
}

// ---- the site, the login, the projects ----

let started = false;
let refreshing: Promise<void> | null = null;

/**
 * Look at the login again: which site (browser cookies), whether you're signed in and as whom, the project list
 * (when it's old, or `projects`). Answers known not to be right any more (signed out, offline) are dropped.
 */
export function refreshJira(o: { projects?: boolean } = {}): Promise<void> {
  const b = bridge();
  if (!b) return Promise.resolve();
  return (refreshing ??= (async () => {
    const sites = await b.sites().catch(() => null);
    if (sites?.ok && sites.value.length && !useJira.getState().site) useJira.setState({ detected: sites.value[0] });
    const site = jiraSite();
    if (!site) return useJira.setState({ auth: 'unknown', me: null });
    const me = await b.myself(site).catch(() => ({ ok: false as const, error: 'offline' as const }));
    useJira.setState({ me: me.ok ? me.value : null, auth: authOf(me) });
    // a fresh login: chips that said "sign in" look again
    const issues = Object.fromEntries(Object.entries(useJira.getState().issues).filter(([, e]) => e.r.ok || e.r.error === 'not-found'));
    useJira.setState({ issues });
    const st = useJira.getState();
    if (me.ok && (o.projects || !st.projects.length || Date.now() - st.projectsAt > PROJECTS_TTL)) {
      const p = await b.projectKeys(site).catch(() => null);
      if (p?.ok) useJira.setState({ projects: p.value, projectsAt: Date.now(), seen: st.seen.filter((k) => !p.value.includes(k)) });
    }
  })().finally(() => (refreshing = null)));
}

/** The site to use; '' goes back to finding it. A new site starts over: its projects and answers aren't this one's. */
export function setJiraSite(site: string) {
  const s = site.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  if (s === useJira.getState().site) return;
  useJira.setState({ site: s, projects: [], projectsAt: 0, seen: [], issues: {}, me: null, auth: 'unknown' });
  void refreshJira({ projects: true });
}

function init() {
  if (started || !bridge()) return;
  started = true;
  bridge()!.onAuthChange(() => void refreshJira({ projects: !useJira.getState().projects.length }));
  // back in the window while signed out: look again (in case the login cookie's change was missed)
  globalThis.window?.addEventListener('focus', () => useJira.getState().auth === 'signed-out' && void refreshJira());
  void refreshJira();
}
