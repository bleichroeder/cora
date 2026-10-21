import type { AgentInfo, BrainEvent, SessionInfo } from '@cora/shared';
import { useBrain } from '../state/store';

export const AGENT_COLORS = ['#818cf8', '#c084fc', '#34d399', '#f472b6', '#fb923c', '#22d3ee'];
export const MAIN_COLOR = '#38bdf8';
/** Main-agent colours: one per session, picked by the user or derived from the session id. */
export const MAIN_COLORS = ['#38bdf8', '#2dd4bf', '#a3e635', '#fb7185', '#a78bfa', '#60a5fa', '#f0abfc', '#fdba74'];

export function hashColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return MAIN_COLORS[Math.abs(h) % MAIN_COLORS.length];
}

export const sessionColor = (s?: Pick<SessionInfo, 'id' | 'color'> | null) => s?.color || (s ? hashColor(s.id) : MAIN_COLOR);

export const agentColor = (a?: (Pick<AgentInfo, 'agentId' | 'colorIdx'> & { sessionId?: string }) | null) =>
  !a
    ? MAIN_COLOR
    : a.agentId === 'main'
      ? sessionColor(a.sessionId ? useBrain.getState().sessions[a.sessionId] : null)
      : AGENT_COLORS[((a.colorIdx % AGENT_COLORS.length) + AGENT_COLORS.length) % AGENT_COLORS.length];

export function clock(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function dur(ms?: number): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

/** Token counts: 950, 12.4k, 3.1M. */
export function tokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}

export function shortCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : cwd;
}

/** A session's ticket as its name, "ACME-5206 · Fix the login redirect", once the ticket's summary is known. */
export const ticketName = (s: Pick<SessionInfo, 'ticket'>) => (s.ticket?.summary ? `${s.ticket.key} · ${s.ticket.summary}` : '');

/**
 * What a session is called: your name for it, then its ticket (key and summary), its suggested name, Claude Code's
 * title, the folder.
 */
export function sessionName(s: Pick<SessionInfo, 'id' | 'alias' | 'autoName' | 'title' | 'project' | 'ticket'>): string {
  return s.alias || ticketName(s) || plainName(s);
}

/** Its name leaving the ticket out (beside the ticket's own card, which says that). */
export function plainName(s: Pick<SessionInfo, 'id' | 'alias' | 'autoName' | 'title' | 'project'>): string {
  return s.alias || s.autoName || s.title || s.project || s.id.slice(0, 8);
}

/** Hidden from the session list: dismissed, with no activity since. */
export const isDismissed = (s: SessionInfo) => s.dismissedAt != null && s.dismissedAt >= s.lastTs;

/** What the agent (or session) is doing right now, from its latest events. */
export function currentAction(events: BrainEvent[], agentId?: string): { icon?: BrainEvent['icon']; text: string; live: boolean } | null {
  const open = new Map<string, BrainEvent>();
  let last: BrainEvent | undefined;
  for (const e of events) {
    if (agentId && e.agentId !== agentId) continue;
    if (e.kind === 'tool' && e.toolUseId) {
      if (e.phase === 'start') open.set(e.toolUseId, e);
      else open.delete(e.toolUseId);
    }
    last = e;
  }
  const running = [...open.values()].filter((e) => Date.now() - e.ts < 30 * 60_000).pop();
  if (running?.tool) return { icon: running.icon, text: `${running.tool.name === 'Agent' ? 'Agent' : running.tool.name} ${running.tool.summary}`.trim(), live: true };
  if (!last) return null;
  if (last.kind === 'say') return { icon: last.icon, text: last.text ?? '', live: false };
  if (last.kind === 'tool' && last.tool) return { icon: last.icon, text: `${last.tool.name} ${last.tool.summary}`, live: false };
  if (last.kind === 'prompt') return { icon: last.icon, text: last.text ?? '', live: false };
  if (last.kind === 'report') return { icon: last.icon, text: last.text ?? '', live: false };
  return null;
}

/** A model id in plain words: claude-opus-5-5[1m] → Opus 5.5 (1M context); claude-haiku-4-5-20251001 → Haiku 4.5. */
export function prettyModel(id?: string): { name: string; ctx: string | null } | null {
  if (!id) return null;
  const big = /\[1m\]/i.test(id);
  const m = id.replace(/^claude-/, '').replace(/\[.*?\]/g, '').match(/^([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/i);
  if (!m) return { name: id.replace(/^claude-/, ''), ctx: big ? '1M' : null };
  return { name: `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`, ctx: big ? '1M' : '200k' };
}
