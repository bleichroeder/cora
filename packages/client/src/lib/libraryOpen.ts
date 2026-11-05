import type { BrainEvent, LibraryEntry } from '@cora/shared';
import { useBrain } from '../state/store';
import { useDebrief } from '../state/debrief';
import { useVideos } from '../state/videos';
import { explainFrom } from '../components/Viewer';
import { showSession } from '../components/SessionMenu';
import { desktop } from './desktop';

/** Is its session one Cora still lists (so it can be gone to, ended ones too)? Older ones are in Resume. */
export const knownSession = (sid: string) => !!useBrain.getState().sessions[sid];

/** Go to a session, at a moment of it when there is one (its transcript scrolled there). */
export function goToSession(sid: string, ts?: number): boolean {
  if (!knownSession(sid)) return false;
  showSession(sid);
  if (ts != null) {
    const st = useBrain.getState();
    st.setRightTab('transcript');
    st.setCursor({ sessionId: sid, ts });
  }
  return true;
}

/**
 * Open what an entry is, in the place Cora shows it: an explain in the viewer, a debrief played in its panel, a video
 * in the player, a link in your browser, a recap or brief at its moment in its session. A file on this PC can't be
 * opened from here: its path is copied. What to tell you, when there's something (null: it opened).
 */
export async function openEntry(e: LibraryEntry): Promise<string | null> {
  const o = e.open;
  if (o.how === 'explain') {
    const r = await fetch(`/api/explains?sessionId=${encodeURIComponent(o.sessionId)}&limit=1000`).catch(() => null);
    const list = r?.ok ? ((await r.json()) as { explains: BrainEvent[] }).explains : [];
    const ev = list.find((x) => x.toolUseId === o.toolUseId);
    const p = ev ? explainFrom(ev) : null;
    if (!p) return "That explain isn't kept any more.";
    const st = useBrain.getState();
    if (knownSession(o.sessionId)) {
      showSession(o.sessionId);
      useBrain.getState().setViewer(p);
    } else {
      // its session is gone from the list: over whatever is open, as the Explains tab does
      st.toggleOverview(false);
      st.setViewer({ ...p, pinned: true });
    }
    return null;
  }
  if (o.how === 'debrief') {
    if (knownSession(o.sessionId)) showSession(o.sessionId);
    await useDebrief.getState().start(o.sessionId, o.debriefId);
    return null;
  }
  if (o.how === 'video') {
    useVideos.getState().show(o.videoId);
    return null;
  }
  if (o.how === 'url') {
    if (desktop?.openExternal) desktop.openExternal(o.url);
    else window.open(o.url, '_blank', 'noopener');
    return null;
  }
  if (o.how === 'file') {
    if (desktop?.writeClipboard) desktop.writeClipboard(o.path);
    else await navigator.clipboard?.writeText(o.path).catch(() => {});
    return `It's a file on this PC: its path is copied (${o.path}).`;
  }
  return goToSession(o.sessionId, o.ts) ? null : 'Its session is older than the list: Resume has it.';
}
