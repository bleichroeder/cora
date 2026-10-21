import { issueUrl, jiraEvents, plainDescription, type TicketFacts, type JiraAlertLevel, type JiraEvent, type JiraEventKind, type JiraResult, type JiraSearch, type JiraUser, type JiraWatchStatus, type WatchedIssue } from '@cora/shared';

/** How often it looks while you're at the computer, and while you're away (idle or locked). */
export const CHECK_MS = 30_000;
export const AWAY_MS = 120_000;
const FIELDS = 'summary,status,assignee,reporter,created,updated,description,comment';

export type WatchApi = { get(site: string, path: string): Promise<JiraResult<any>>; myself(site: string): Promise<JiraResult<JiraUser>> };
/** `offered`: tickets Cora offered to start (it asks which are still yours) */
export type WatchInfo = { on: boolean; site?: string; kinds: Partial<Record<JiraEventKind, JiraAlertLevel>>; since: number | null; offered?: string[] };
/** `still`: the offered tickets still assigned to you */
export type WatchServer = { info(): Promise<WatchInfo>; send(b: { checkedAt?: number; events: JiraEvent[]; status: JiraWatchStatus; still?: string[]; tickets?: TicketFacts[] }): Promise<void> };
const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

/**
 * Watching Jira for you, from the desktop app (where your Jira login is): every couple of minutes, read-only searches
 * for tickets updated since the last check (assigned to you, mentioning you, ones you watch), turned into events
 * for Cora's server. Paused while you're signed out; three failed checks in a row are an error.
 */
export class JiraWatcher {
  private fails = 0;
  private quiet = 0;
  private fallback = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private lastAt = 0;

  constructor(private o: { api: WatchApi; server: WatchServer; sites: () => Promise<string[]>; now?: () => number; every?: number; away?: () => boolean }) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => void this.tick(), this.o.every ?? CHECK_MS);
    setTimeout(() => void this.tick(), 5000);
  }

  /** The timer: a check every 30 s, or every 2 min while you're away. */
  async tick(): Promise<void> {
    const now = this.o.now?.() ?? Date.now();
    if (this.o.away?.() && now - this.lastAt < AWAY_MS) return;
    this.lastAt = now;
    await this.check();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.once();
    } finally {
      this.busy = false;
    }
  }

  private async once(): Promise<void> {
    let info: WatchInfo;
    try {
      info = await this.o.server.info();
    } catch {
      return;
    }
    const on = (k: JiraEventKind) => !!info.kinds[k] && info.kinds[k] !== 'off';
    if (!info.on || !(['assigned', 'mentioned', 'commented', 'status', 'watched'] as const).some(on)) return;
    const site = info.site || (await this.o.sites().catch(() => [] as string[]))[0];
    if (!site) return void (await this.o.server.send({ events: [], status: { state: 'paused', message: "No Jira site yet: sign in to Jira in Cora's browser" } }).catch(() => {}));
    const me = await this.o.api.myself(site);
    if (!me.ok) {
      const status: JiraWatchStatus = me.error === 'signed-out' ? { state: 'paused', message: "You're signed out of Jira in Cora's browser" } : { state: 'error', message: `Jira: ${me.error}` };
      if (status.state === 'paused' || ++this.fails >= 3) await this.o.server.send({ events: [], status }).catch(() => {});
      return;
    }
    const now = this.o.now?.() ?? Date.now();
    const since = info.since ?? now - 2 * 60_000;
    // a small overlap so nothing falls between checks (the server drops what it's seen)
    const mins = Math.min(20_160, Math.ceil((now - since) / 60_000) + 2);
    const recent = `updated >= -${mins}m`;
    const searches: Array<[JiraSearch, string]> = [];
    if (on('assigned') || on('commented') || on('status') || (on('mentioned') && this.fallback)) searches.push(['mine', `assignee = currentUser() AND ${recent}`]);
    if (on('mentioned') && !this.fallback) searches.push(['mentions', `(comment ~ currentUser() OR description ~ currentUser()) AND ${recent}`]);
    if (on('watched') || (on('mentioned') && this.fallback)) searches.push(['watched', `watcher = currentUser() AND (assignee != currentUser() OR assignee is EMPTY) AND ${recent}`]);
    const byKey = new Map<string, WatchedIssue>();
    for (const [from, jql] of searches) {
      const q = new URLSearchParams({ jql, fields: FIELDS, expand: 'changelog', maxResults: '50' });
      const r = await this.o.api.get(site, `/rest/api/3/search/jql?${q}`);
      if (!r.ok) {
        if (++this.fails >= 3) await this.o.server.send({ events: [], status: { state: 'error', message: `Jira search failed: ${r.error}` } }).catch(() => {});
        return;
      }
      for (const i of r.value?.issues ?? []) {
        const had = byKey.get(i.key);
        if (had) had.from.push(from);
        else byKey.set(i.key, { key: i.key, fields: i.fields ?? {}, changelog: i.changelog, comments: i.fields?.comment?.comments ?? [], from: [from] });
      }
    }
    // a long thread: the newest comments
    for (const i of byKey.values()) {
      const c = i.fields?.comment;
      if (c && typeof c.total === 'number' && c.total > (c.comments?.length ?? 0)) {
        const r = await this.o.api.get(site, `/rest/api/3/issue/${i.key}/comment?orderBy=-created&maxResults=20`);
        if (r.ok) i.comments = r.value?.comments ?? i.comments;
      }
    }
    const events = jiraEvents({ site, me: me.value.accountId, since, issues: [...byKey.values()] });
    // mention search finding nothing while other searches show you tagged: rely on those instead
    if (on('mentioned') && !this.fallback) {
      const viaSearch = [...byKey.values()].some((i) => i.from.includes('mentions'));
      const elsewhere = events.some((e) => e.kind === 'mentioned' && !byKey.get(e.key)?.from.includes('mentions'));
      if (viaSearch) this.quiet = 0;
      else if (elsewhere && ++this.quiet >= 3) this.fallback = true;
    }
    // tickets Cora offered to start: which are still yours (the others' offers go)
    const offered = (info.offered ?? []).filter((k) => KEY.test(k)).slice(0, 50);
    let still: string[] | undefined;
    if (offered.length) {
      const q = new URLSearchParams({ jql: `key in (${offered.join(',')}) AND assignee = currentUser()`, fields: 'summary', maxResults: '50' });
      const r = await this.o.api.get(site, `/rest/api/3/search/jql?${q}`);
      if (r.ok) still = (r.value?.issues ?? []).map((i: { key: string }) => i.key);
    }
    this.fails = 0;
    // what it read of each ticket (its summary, status, description): Cora's ticket prompt is written from it
    const tickets: TicketFacts[] = [...byKey.values()].slice(0, 100).map((i) => ({ key: i.key, summary: String(i.fields?.summary ?? ''), status: String(i.fields?.status?.name ?? ''), url: issueUrl(site, i.key), ...(i.fields?.description ? { description: plainDescription(i.fields.description) } : {}) }));
    await this.o.server.send({ checkedAt: now, events, status: { state: 'ok', ...(this.fallback ? { mentionFallback: true } : {}) }, ...(still ? { still } : {}), tickets }).catch(() => {});
  }
}
