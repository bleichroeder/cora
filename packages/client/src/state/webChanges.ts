import { webChangeUrl, type BrainEvent, type Settings } from '@cora/shared';
import { jiraSite } from './jira';
import { useWeb } from './web';
import { familiar } from './openTab';

/**
 * What sessions change on the web (a Jira comment, a moved ticket, a merge request's note: shared/webChange), as it
 * happens: loaded in the session's browser at the change (the site highlights it), in the background or shown
 * (Settings › Cora's browser › What sessions change on the web). Only on the user's own sites (their Jira, GitLab,
 * GitHub, or one they already use in Cora): a link from a tool's answer could have come from someone else's words.
 */

/** the settings it needs, fetched now and then (the setting can change in another window) */
let known: { at: number; s: Pick<Settings, 'browser' | 'gitlab' | 'jira'> | null } = { at: 0, s: null };
function settings(): Pick<Settings, 'browser' | 'gitlab' | 'jira'> | null {
  if (Date.now() - known.at > 30_000) {
    known = { ...known, at: Date.now() };
    void fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : null))
      .then((s: Settings | null) => s && (known = { at: Date.now(), s }))
      .catch(() => undefined);
  }
  return known.s;
}
settings();

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** The link to a change (null: none, or not on one of the user's own sites). */
export function webChangeLink(e: BrainEvent): string | null {
  const w = e.tool?.web;
  if (!w) return null;
  const url = webChangeUrl(w, jiraSite());
  if (!url || !/^https:\/\//i.test(url)) return null;
  const host = hostOf(url);
  const s = settings();
  const mine = [jiraSite(), s?.jira?.watch?.site, s?.gitlab?.host, 'github.com'].filter((h): h is string => !!h).map((h) => h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase());
  return mine.some((h) => host === h || host.endsWith(`.${h}`)) || familiar(host) ? url : null;
}

/** Events just in (live, not a replay of old ones): open what a session changed on the web, as the setting says. */
export function onWebChanges(events: BrainEvent[]): void {
  const mode = settings()?.browser?.webChanges ?? 'tab';
  if (mode === 'off') return;
  const now = Date.now();
  for (const e of events) {
    if (e.kind !== 'tool' || e.phase !== 'end' || !e.tool?.web || now - e.ts > 60_000) continue;
    const url = webChangeLink(e);
    if (!url) continue;
    useWeb.getState().open(e.sessionId, url, { reload: true, background: mode !== 'show' });
    if (mode === 'show') useWeb.getState().setShown(e.sessionId, true);
  }
}
