import { create } from 'zustand';
import type { UiCommand } from '@cora/shared';
import { useBrain } from './store';
import { useWeb } from './web';

/**
 * A session's open_tab, once the server's checks passed (the tool is what opens a page, never the call showing up in a
 * transcript: docs/audit-2026-10-20.md S15). A site the user plainly uses opens in that session's tabs; any other
 * waits for their Open or Not now.
 */
export type OpenAsk = { id: string; sessionId: string; url: string; host: string };

export const useOpenAsks = create<{ asks: OpenAsk[] }>(() => ({ asks: [] }));

/** Sites the user said Open to before (this browser only). */
const KEY = 'cora.openTab.hosts';
function said(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function remember(host: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...new Set([...said(), host])].slice(-200)));
  } catch {
    /* asked again next time */
  }
}

const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};

/** Sites the user plainly uses: their Tools', what's open in a tab now, and ones they said Open to before. */
function familiar(host: string): boolean {
  const tools = (useBrain.getState().prefs?.tools ?? []).map((t) => hostOf(t.url));
  const open = Object.values(useWeb.getState().tabs).map((t) => hostOf(t.url));
  return [...tools, ...open, ...said()].some((h) => h && (host === h || host.endsWith(`.${h}`)));
}

export function openTab(cmd: Extract<UiCommand, { action: 'open_tab' }>): void {
  const st = useBrain.getState();
  const sid = cmd.sessionId && st.sessions[cmd.sessionId] ? cmd.sessionId : st.focus;
  const host = hostOf(cmd.url);
  if (!sid || !host || !/^https?:\/\//i.test(cmd.url)) return;
  if (cmd.known || familiar(host)) return void useWeb.getState().open(sid, cmd.url, { reload: true });
  const asks = useOpenAsks.getState().asks;
  if (asks.some((a) => a.sessionId === sid && a.url === cmd.url)) return;
  useOpenAsks.setState({ asks: [...asks, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, sessionId: sid, url: cmd.url, host }].slice(-5) });
}

/** Open (and remember the site) or Not now. */
export function answerOpen(id: string, open: boolean): void {
  const a = useOpenAsks.getState().asks.find((x) => x.id === id);
  useOpenAsks.setState({ asks: useOpenAsks.getState().asks.filter((x) => x.id !== id) });
  if (!a || !open) return;
  remember(a.host);
  useWeb.getState().open(a.sessionId, a.url, { reload: true });
  useWeb.getState().setShown(a.sessionId, true);
}
