import { create } from 'zustand';
import { openRemote } from '../components/RemoteBrowser';
import { isTablet, useTabletUi } from '../lib/tablet';
import { composerInbox } from './composer';
import type { OrchMsg, OrchestratorStatus, PendingRequest, SessionInfo, UiCommand } from '@cora/shared';
import { openTab } from './openTab';
import { useDebrief } from './debrief';
import { sessionEvents, setHiddenSession, useBrain } from './store';
import { useWeb } from './web';
import { sessionName } from '../lib/format';
import { slackAppLink } from './slack';
import { useTools } from './tools';
import { attentive, desktop } from '../lib/desktop';
import { setCoraSend, setCoraSession, speak, useVoice } from '../lib/voice';
import { explainFrom } from '../components/Viewer';

/** The Cora Orchestrator in the dashboard: its status (from the server), and whether its console is open. */
export const useOrch = create<{ status: OrchestratorStatus | null; open: boolean; command: boolean; cmdDraft: string; composeGoal: boolean; /** text for the console's box (Ask Cora from the Inbox) */ prefill: string | null }>(() => ({ status: null, open: false, command: false, cmdDraft: '', composeGoal: false, prefill: null }));

export const agentId = () => useOrch.getState().status?.sessionId ?? null;
export const isAgent = (id: string | null | undefined) => !!id && id === agentId();
// Cora's own session speaks with Cora's voice
setCoraSession((sid) => isAgent(sid));
export const setConsoleOpen = (open: boolean) => useOrch.setState({ open });
/** Open Cora's console with text in its box, for you to finish and send (Ask Cora). */
export const askCora = (text: string) => useOrch.setState({ open: true, prefill: text });
/** Command mode: Cora, full screen. */
export const setCommandOpen = (command: boolean) => useOrch.setState({ command });

/** The server's update: its session kept out of the lists; a new approval while you're elsewhere is a notification. */
export function applyOrch(m: OrchMsg): void {
  const before = new Set(useOrch.getState().status?.approvals.map((a) => a.id) ?? []);
  const wasAsking = !!useOrch.getState().status?.asking?.length;
  useOrch.setState({ status: m.status });
  if (!wasAsking && m.status.asking?.length && !attentive()) desktop?.notify('Cora is asking you', m.status.asking.filter((l) => l.trim()).slice(0, 2).join(' · '), '');
  setHiddenSession(m.status.enabled ? m.status.sessionId : null);
  for (const a of m.status.approvals) {
    if (before.has(a.id) || attentive()) continue;
    desktop?.notify('Cora asks', a.title, '');
  }
}

/** What the eye shows. */
export type CoraState = 'off' | 'starting' | 'error' | 'idle' | 'listening' | 'thinking' | 'needs-you' | 'autopilot';

/** A goal Cora is on (running or waiting for you; blocked is shown as needing you). */
export const goalLive = (s: OrchestratorStatus | null) => !!s?.goal && (s.goal.state === 'running' || s.goal.state === 'waiting' || s.goal.state === 'blocked');

export function coraState(status: OrchestratorStatus | null, agent: SessionInfo | null, o: { listening: boolean; pending: number }): CoraState {
  if (!status?.enabled) return 'off';
  if (status.error) return 'error';
  if (!status.running) return 'starting';
  if (status.approvals.length || status.asking?.length || o.pending || status.goal?.state === 'blocked') return 'needs-you';
  if (o.listening) return 'listening';
  if (goalLive(status)) return 'autopilot';
  if (agent && (agent.state === 'working' || agent.state === 'thinking')) return 'thinking';
  return 'idle';
}

/** The eye's state, live. */
export function useCoraState(): CoraState {
  const status = useOrch((s) => s.status);
  const agent = useBrain((s) => s.agentSession);
  const listening = useVoice((v) => (v.ptt.phase === 'listening' || v.ptt.phase === 'finishing') && !!v.ptt.sessionId && v.ptt.sessionId === status?.sessionId);
  const pending = useBrain((s) => s.pending.filter((p: PendingRequest) => p.sessionId === status?.sessionId).length);
  return coraState(status, agent, { listening, pending });
}

const post = async (url: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return r.ok ? null : ((j as { error?: string }).error ?? `HTTP ${r.status}`);
};

/** You, in the console (or by voice). */
/**
 * What Cora's told with your spoken words: which session is in front (so "this one" means something), and what its
 * quick voice already said to you (so it carries on rather than saying it again).
 */
function spokenContext(said?: string): string {
  const b = useBrain.getState();
  const s = b.focus ? b.sessions[b.focus] : null;
  const where = s ? `looking at: ${sessionName(s)} (${s.id})` : 'looking at the Overview';
  return `[Spoken; ${where}${said ? `; you already said aloud: "${said.replace(/["\]\[]/g, '')}"` : ''}]`;
}
export const sayToCora = (text: string) => post('/api/orchestrator/say', { text });
// what you say to Cora by voice goes the same way as what you type in its console
setCoraSend((text, said) => sayToCora(`${spokenContext(said)}\n${text}`));
export const decideApproval = (id: string, ok: boolean, text?: string, cwd?: string) => post(`/api/orchestrator/approvals/${encodeURIComponent(id)}`, { ok, ...(text !== undefined ? { text } : {}), ...(cwd ? { cwd } : {}) });
export const restartCora = () => post('/api/orchestrator/restart', {});
export const forgetCora = () => post('/api/orchestrator/forget', {});
/** A new conversation with Cora (its memory, your instructions, goals and Slack watches are kept). */
export const newCora = () => post('/api/orchestrator/new', {});
export const coraKey = (key: string) => post('/api/orchestrator/key', { key });
export const startGoal = (text: string, budget?: number) => post('/api/orchestrator/goals', { text, ...(budget ? { budget } : {}) });
export const stopGoal = () => post('/api/orchestrator/goals/stop', {});
export const setControl = (on: boolean) => post('/api/orchestrator/control', { on });
export const standDown = () => post('/api/orchestrator/stand-down', {});
/** Ask Cora for a brief now, or to wrap up the day. */
export const briefMe = (kind: 'now' | 'wrap') => post('/api/orchestrator/brief', { kind });

/**
 * Tell the server you're here (a key or a click, at most once a minute while Cora is on): back after a few hours away,
 * Cora catches you up.
 */
export function watchPresence(): () => void {
  let last = 0;
  const seen = () => {
    const now = Date.now();
    if (now - last < 60_000 || !useOrch.getState().status?.enabled) return;
    last = now;
    void post('/api/orchestrator/presence', {});
  };
  // opening Cora (or coming back to its window) counts as being here, not only clicking or typing: the morning's
  // catch-up comes when you sit down, without having to touch anything first
  const looking = () => document.visibilityState === 'visible' && document.hasFocus() && seen();
  window.addEventListener('keydown', seen, true);
  window.addEventListener('pointerdown', seen, true);
  window.addEventListener('focus', looking);
  document.addEventListener('visibilitychange', looking);
  // and once Cora's status is known (at start it isn't yet)
  const off = useOrch.subscribe((st, prev) => st.status?.enabled && !prev.status?.enabled && looking());
  looking();
  return () => {
    window.removeEventListener('keydown', seen, true);
    window.removeEventListener('pointerdown', seen, true);
    window.removeEventListener('focus', looking);
    document.removeEventListener('visibilitychange', looking);
    off();
  };
}

/** End Cora's conversation with a session: its next message to it needs your OK again. */
export const endTalk = (sessionId: string) => post('/api/orchestrator/talk/end', { sessionId });
/** Cora is in charge of something (a goal, or your sessions' prompts): the window says so. */
export const useInControl = () => useOrch((s) => !!s.status?.enabled && (!!s.status.control || goalLive(s.status)));

/** The agent driving the dashboard. */
export function runUi(cmd: UiCommand): void {
  const st = useBrain.getState();
  switch (cmd.action) {
    case 'focus':
      if (st.sessions[cmd.sessionId]) st.setFocus(cmd.sessionId);
      return;
    case 'overview':
      st.toggleOverview(true);
      return;
    case 'open_url': {
      const sid = cmd.sessionId && st.sessions[cmd.sessionId] ? cmd.sessionId : st.focus;
      if (desktop?.browser && sid) {
        useWeb.getState().open(sid, cmd.url, { reload: true });
        useWeb.getState().setShown(sid, true);
      } else if (sid && isTablet()) {
        // on the iPad: the session's browser, rendered on your PC (and on show, when you're looking at that session)
        void openRemote(sid, cmd.url);
        if (st.focus === sid) useTabletUi.setState({ pane: 'browser' });
      } else window.open(cmd.url, '_blank', 'noopener');
      return;
    }
    case 'open_tool': {
      const name = cmd.tool.toLowerCase();
      const t = st.prefs.tools.find((x) => x.id.toLowerCase() === name || x.name.toLowerCase() === name);
      if (!t) return;
      // a Slack message link opens at its conversation in the Slack tool (the web app)
      if (desktop?.browser) useTools.getState().show(t.id, cmd.url && /app\.slack\.com/.test(t.url) ? slackAppLink(cmd.url) : cmd.url);
      else window.open(cmd.url ?? t.url, '_blank', 'noopener');
      return;
    }
    case 'show_explain': {
      const e = sessionEvents(cmd.sessionId).find((x) => x.toolUseId === cmd.id && x.kind === 'tool' && x.phase === 'start');
      const p = e ? explainFrom(e) : null;
      if (!p) return;
      if (st.sessions[cmd.sessionId]) {
        st.setFocus(cmd.sessionId);
        useBrain.getState().setViewer(p);
      } else {
        st.toggleOverview(false);
        st.setViewer({ ...p, pinned: true });
      }
      return;
    }
    case 'open_tab':
      openTab(cmd);
      return;
    case 'notify':
      if (!attentive()) desktop?.notify('Cora', cmd.text, '');
      if (st.prefs && useVoice.getState().settings.enabled && !useVoice.getState().settings.muted) void speak(`cora-notify-${Date.now()}`, cmd.text, 600, true);
      return;
    case 'debrief': {
      // a session made one (it starts), or its bubble in the IDE was used
      const db = useDebrief.getState();
      if (cmd.act === 'start') return void (cmd.id && db.start(cmd.sessionId, cmd.id));
      if (db.on?.sessionId !== cmd.sessionId) return;
      if (cmd.act === 'ask') return void (cmd.text && db.ask(cmd.text));
      if (cmd.act === 'close') return db.end();
      if (cmd.act === 'speak') return db.toggleSpeak();
      return db[cmd.act]();
    }
    case 'compose': {
      // what you selected in the IDE: the session in front, the code in its prompt box (you ask the question)
      if (!st.sessions[cmd.sessionId]) return;
      st.setFocus(cmd.sessionId);
      let tries = 0;
      const put = () => {
        const take = composerInbox.get(cmd.sessionId);
        if (take) return take(cmd.text);
        if (++tries < 20) return void setTimeout(put, 100);
        // no prompt box (it isn't hosted in Cora): on the clipboard instead
        void navigator.clipboard?.writeText(cmd.text).catch(() => {});
        desktop?.notify('Cora', 'Copied your selection: this session takes prompts in its own terminal.', '');
      };
      put();
      return;
    }
  }
}
