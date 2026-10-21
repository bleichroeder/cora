import { useEffect, useState } from 'react';
import { FAM, shortToolName } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { agentColor, dur } from '../lib/format';
import { Icon } from './Icon';
import { ReadAloudToggle } from './ReadAloudToggle';

/** At most this many agents' lines; the rest as "+N more". */
const MAX_ROWS = 3;

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/**
 * What each agent is doing *right now*, pinned under the transcript. Transcripts only receive finished blocks,
 * so without this the transcript looks frozen while Claude thinks or writes. For sessions hosted here we show
 * Claude Code's own on-screen indicator (spinner word, elapsed, tokens).
 */
export function LiveActivity({ sessionId }: { sessionId: string }) {
  useTick(1000);
  const version = useBrain((s) => s.versions[sessionId]);
  const session = useBrain((s) => s.sessions[sessionId]);
  const agents = useBrain((s) => s.agents);
  const status = useBrain((s) => s.terminals.find((t) => t.sessionId === sessionId && t.alive)?.status ?? null);
  const pending = useBrain((s) => s.pending);
  void version;
  if (!session || session.state === 'ended') return null;

  const events = sessionEvents(sessionId);
  const lastTs = new Map<string, number>();
  const open = new Map<string, (typeof events)[number]>();
  for (const e of events) {
    lastTs.set(e.agentId, e.ts);
    if (e.kind === 'tool' && e.toolUseId) {
      if (e.phase === 'start') open.set(e.toolUseId, e);
      else open.delete(e.toolUseId);
    }
  }
  const now = Date.now();
  const active = Object.values(agents)
    .filter((a) => a.sessionId === sessionId && (a.state === 'working' || a.state === 'thinking'))
    .sort((a, b) => (a.agentId === 'main' ? -1 : b.agentId === 'main' ? 1 : a.startedAt - b.startedAt));
  const mainActive = active.some((a) => a.agentId === 'main');

  const rows: Array<{ key: string; color: string; name: string; icon: string; tint?: string; text: string; live: boolean; glyph?: string; time?: string; wait?: boolean }> = [];
  if (session.state === 'needs-you') {
    const p = pending.find((x) => x.sessionId === sessionId);
    const input = (p?.toolInput ?? {}) as { command?: unknown; file_path?: unknown };
    const what = p ? `${p.toolName}${typeof input.command === 'string' ? ` ${input.command}` : typeof input.file_path === 'string' ? ` ${input.file_path}` : ''}` : '';
    rows.push({ key: 'needs', color: 'var(--need)', name: 'main', icon: 'ShieldAlert', tint: 'var(--need)', text: what ? `waiting for you: ${what}` : 'waiting for your decision', live: false, wait: true, time: p ? dur(now - p.createdAt) : undefined });
  }
  else if (status) {
    // Claude's spinner glyph (✢ ✳ ✶ ✻ ✽ · *) comes from fallback fonts of different heights: give it its own fixed box
    const m = status.match(/^(\S)\s+(.*)$/u);
    rows.push({ key: 'status', color: agentColor({ agentId: 'main', colorIdx: -1, sessionId }), name: 'main', icon: 'Sparkle', glyph: m?.[1], text: m ? m[2] : status, live: true });
  }
  for (const a of active) {
    if (a.agentId === 'main' && (status || session.state === 'needs-you')) continue;
    const running = [...open.values()].filter((e) => e.agentId === a.agentId && now - e.ts < 30 * 60_000).pop();
    const since = lastTs.get(a.agentId) ?? a.startedAt;
    const name = a.agentId === 'main' ? 'main' : a.label;
    if (running?.tool) {
      rows.push({ key: a.agentId, color: agentColor(a), name, icon: running.icon.name, tint: FAM[running.icon.family].c, text: `${shortToolName(running.tool.name)} ${running.tool.summary}`, time: dur(now - running.ts), live: true });
    } else {
      rows.push({ key: a.agentId, color: agentColor(a), name, icon: 'Brain', text: 'thinking', time: dur(Math.max(0, now - since)), live: true });
    }
  }
  // Stay put between turns (a quiet idle row) so the terminal below doesn't jump each time work starts or stops.
  if (!rows.length && !mainActive) rows.push({ key: 'idle', color: '#475569', name: 'main', icon: 'Moon', text: 'idle', live: false });

  const shown = rows.slice(0, MAX_ROWS);
  return (
    <div className="activity">
      {shown.map((r, i) => (
        <div key={r.key} className={`act-row${r.wait ? ' wait' : ''}${r.key === 'idle' ? ' idle' : ''}`}>
          <span className={`act-dot${r.live ? ' live' : ''}`} style={{ ['--c' as any]: r.color }} />
          <b className="act-n">{r.name}</b>
          {r.glyph ? <span className="act-glyph">{r.glyph}</span> : <Icon name={r.icon} size={12} className="act-i" />}
          <span className="act-t">{r.text}</span>
          <span className="act-time">{r.time ?? ''}</span>
          {/* automatic reading on or off: by the replies, next to where you write */}
          <span className="act-side">{i === 0 ? <ReadAloudToggle /> : null}</span>
        </div>
      ))}
      {rows.length > MAX_ROWS ? <div className="act-more">+{rows.length - MAX_ROWS} more</div> : null}
    </div>
  );
}
