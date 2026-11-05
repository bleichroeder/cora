import { webChangeUrl, type BrainEvent, type Settings } from '@cora/shared';
import { jiraSite } from './jira';
import { useWeb } from './web';
import { familiar } from './openTab';
import { useBrain } from './store';
import { webIdleFor } from '../lib/webInput';

/**
 * What sessions change on the web (a Jira comment, a moved ticket, a merge request's note: shared/webChange), as it
 * happens: loaded in the session's browser at the change (the site highlights it), in the background or shown
 * (Settings › Cora's browser › What sessions change on the web). In the background, unless you're looking at that
 * session's browser and haven't used it for QUIET_MS: then it's shown (you're watching it work); otherwise its tab
 * says "new" until you look. Only on the user's own sites (their Jira, GitLab,
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

/** Left alone this long, a session's browser in front of you shows what it changed (you aren't reading something else in it). */
export const QUIET_MS = 30_000;

/** Is what a session changed shown (switched to), or loaded behind the tab you're on? */
export function showsChange(mode: 'tab' | 'show', o: { front: boolean; idleMs: number }): boolean {
  return mode === 'show' || (o.front && o.idleMs >= QUIET_MS);
}

/** Is this session's browser in front of you: its session open, its browser showing, Cora's window up? */
export function browserInFront(sid: string): boolean {
  const b = useBrain.getState();
  if (b.focus !== sid || b.overview) return false;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  const s = useWeb.getState().sessions[sid];
  return !!s?.shown && !!s.active;
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
    const show = showsChange(mode, { front: browserInFront(e.sessionId), idleMs: webIdleFor(e.sessionId, now) });
    useWeb.getState().open(e.sessionId, url, { reload: true, background: !show });
    if (mode === 'show') useWeb.getState().setShown(e.sessionId, true);
  }
}
