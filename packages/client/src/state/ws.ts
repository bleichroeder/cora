import { applyJira } from './jiraWatch';
import { useMailOutbox } from '../components/MailOutbox';
import { onWebChanges } from './webChanges';
import { memePosted } from '../components/board/memeNews';
import { applyInbox } from './inbox';
import { create } from 'zustand';
import { MAX_REPLAY, type LaunchOptions, type BrainEvent, type HistoryItem, type PendingDecision, type ServerMsg, type TerminalInfo, type ClaudeMode } from '@cora/shared';
import { mergeFetched, sessionEvents, useBrain } from './store';
import { useCi } from './ci';
import { useDeploys } from './deploys';
import { useNotes } from './notes';
import { applySlack } from './slack';
import { applySecurity } from './security';
import { applyOrch, runUi } from './orchestrator';
import { applyExplainData } from './liveExplains';
import { toLockScreen } from './lock';

let ws: WebSocket | null = null;
let delay = 500;

export async function connect(): Promise<void> {
  const me = await fetch('/api/me').catch(() => null);
  // Cora is locked: the lock screen
  if (me?.status === 423) return toLockScreen();
  if (!me || me.status === 401) {
    useBrain.getState().setConn('unauthorized');
    return;
  }
  open();
}

function open() {
  const st = useBrain.getState();
  st.setConn('connecting');
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  ws = new WebSocket(url);
  ws.onopen = () => {
    delay = 500;
    useBrain.getState().setConn('open');
    ws!.send(JSON.stringify({ t: 'hello', lastSeq: useBrain.getState().lastSeq }));
  };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data) as ServerMsg;
    const s = useBrain.getState();
    switch (msg.t) {
      case 'snapshot': {
        // away longer than the server replays: what's loaded has a hole, so sessions fetch again when shown
        const gap = s.lastSeq > 0 && msg.lastSeq - s.lastSeq > MAX_REPLAY;
        s.applySnapshot(msg);
        if (gap) {
          useBrain.setState({ loaded: {} });
          const f = useBrain.getState().focus;
          if (f) void loadSession(f);
        }
        break;
      }
      case 'events':
        s.applyEvents(msg.events);
        onWebChanges(msg.events);
        break;
      case 'session':
        s.upsertSession(msg.session);
        break;
      case 'agent':
        s.upsertAgent(msg.agent);
        break;
      case 'pending':
        s.setPending(msg.pending);
        break;
      case 'terminals':
        s.setTerminals(msg.terminals);
        break;
      case 'ci':
        useCi.getState().apply(msg);
        break;
      case 'deploys':
        useDeploys.getState().apply(msg);
        break;
      case 'mailOutbox':
        useMailOutbox.getState().apply(msg);
        break;
      case 'notes':
        useNotes.getState().apply(msg);
        break;
      case 'slack':
        applySlack(msg);
        break;
      case 'jira':
        applyJira(msg);
        break;
      case 'inbox':
        applyInbox(msg);
        break;
      case 'security':
        applySecurity(msg);
        break;
      case 'orchestrator':
        applyOrch(msg);
        break;
      case 'ui':
        runUi(msg.cmd);
        break;
      case 'explain-data':
        applyExplainData(msg);
        break;
      case 'meme':
        memePosted(msg.sessionId);
        break;
      case 'lock':
        toLockScreen();
        break;
    }
  };
  ws.onclose = () => {
    useBrain.getState().setConn('closed');
    // locked while away (the stream is refused): the lock screen, not retries
    void fetch('/api/me')
      .then((r) => r.status === 423 && toLockScreen())
      .catch(() => {});
    setTimeout(open, delay);
    delay = Math.min(delay * 2, 8000);
  };
}

/** How many of a session's events a fetch brings: the newest, then as many again each time you ask for earlier. */
const PAGE = 8000;
/** Sessions with events older than what's loaded (a long one: the timeline's "earlier"). */
export const useOlder = create<Record<string, boolean>>(() => ({}));

export async function loadSession(sid: string): Promise<void> {
  if (useBrain.getState().loaded[sid]) return;
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/events?limit=${PAGE}`);
  if (!r.ok) return;
  const { events } = (await r.json()) as { events: BrainEvent[] };
  mergeFetched(sid, events);
  useOlder.setState({ [sid]: events.length >= PAGE });
}

/** The next page back, before the oldest loaded (same-moment events come again; they're merged by id). */
export async function loadOlder(sid: string): Promise<void> {
  const oldest = sessionEvents(sid)[0];
  if (!oldest) return;
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/events?before=${oldest.ts + 1}&limit=${PAGE}`);
  if (!r.ok) return;
  const { events } = (await r.json()) as { events: BrainEvent[] };
  mergeFetched(sid, events);
  useOlder.setState({ [sid]: events.length >= PAGE });
}

export async function fetchToolDetail(sid: string, toolUseId: string): Promise<{ input: unknown; result: string; isError?: boolean } | null> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/tool/${encodeURIComponent(toolUseId)}`);
  return r.ok ? r.json() : null;
}

/** Close a needs-you card without deciding: the terminal's own prompt (already showing there) decides. */
export async function releasePending(id: string): Promise<void> {
  await fetch(`/api/pending/${encodeURIComponent(id)}/release`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
}

export async function decide(id: string, d: PendingDecision): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`/api/pending/${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) });
  return r.json();
}

export async function jump(sid: string): Promise<{ ok: boolean; fallback?: string; reason?: string }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/jump`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  return r.json();
}

const post = (url: string, body: unknown) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Start / resume / fork a Claude session hosted by Cora, then focus it. `prompt`: a new session's first prompt ("/jira ACME-5206"). */
export async function launchTerminal(body: { mode: ClaudeMode; cwd?: string; sessionId?: string; options?: LaunchOptions; prompt?: string; brief?: string }): Promise<{ ok: true; terminal: TerminalInfo } | { ok: false; error: string }> {
  const r = await post('/api/terminals', body);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) return { ok: false, error: j.error ?? `HTTP ${r.status}` };
  const t = j as TerminalInfo;
  const st = useBrain.getState();
  st.setTerminals([...st.terminals.filter((x) => x.terminalId !== t.terminalId), t, ...st.shells]);
  const now = Date.now();
  const had = st.sessions[t.sessionId];
  if (!had) {
    const project = t.cwd.split(/[\\/]/).filter(Boolean).pop() ?? '';
    st.upsertSession({ id: t.sessionId, cwd: t.cwd, project, title: '', state: 'thinking', startedAt: now, lastTs: now, cliVersion: '', transcriptPath: '', needsYou: 0 });
  } else {
    // resumed: live from now, before the server's copy says so (a dismissed session would otherwise stay hidden
    // for a moment, and focus would be moved off it)
    st.upsertSession({ ...had, state: had.state === 'ended' ? 'idle' : had.state, lastTs: Math.max(had.lastTs, now), exitReason: null });
  }
  st.setBang(t.sessionId);
  st.setFocus(t.sessionId);
  st.setModal(null);
  return { ok: true, terminal: t };
}

export async function checkRunning(sid: string): Promise<{ hosted: boolean; elsewhere: boolean; pids?: number[] }> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/running`);
  return r.ok ? r.json() : { hosted: false, elsewhere: false };
}

export async function fetchHistory(): Promise<HistoryItem[]> {
  const r = await fetch('/api/history?limit=500');
  return r.ok ? (await r.json()).sessions : [];
}

export async function fetchDirs(path: string): Promise<{ path: string; parent: string | null; dirs: string[]; error?: string }> {
  const r = await fetch(`/api/fs/dirs?path=${encodeURIComponent(path)}`);
  return r.json();
}
