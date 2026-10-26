import { startWake } from './lib/wake/controller';
import { IdeHost } from './components/board/IdeHost';
import { MailOutbox } from './components/MailOutbox';
import { useEffect, useMemo, useRef, useState } from 'react';
import { OpMenu } from './components/OpMenu';
import { onField, openOpMenu, useOp } from './state/onepassword';
import { CoraFloat } from './components/CoraFloat';
import type { SessionInfo } from '@cora/shared';
import { useBrain } from './state/store';
import { connect, loadSession } from './state/ws';
import { SessionRail, sortedSessions } from './components/SessionRail';
import { Transcript } from './components/Transcript';
import { Strip } from './components/Strip';
import { NeedsYou, Toasts, JumpButton } from './components/NeedsYou';
import { GridOverview } from './components/GridOverview';
import { InboxView } from './components/Inbox';
import { SetupView } from './components/Setup';
import { EmptyMain } from './components/EmptyMain';
import { BootScreen } from './components/BootScreen';
import { SessionSwitcher } from './components/SessionSwitcher';
import { LockSetup } from './components/LockSettings';
import { SessionCard } from './components/SessionCard';
import { ThawCard, loadThaw } from './components/Thaw';
import { lockNow } from './state/lock';
import { RecapBar } from './components/Recap';
import { IssueChip } from './components/IssuePicker';
import { loadSetup, useSetup } from './state/setup';
import { isShell, setupFirstRun } from '@cora/shared';
import { Galaxy } from './galaxy/Galaxy';
import { UsageStrip } from './components/UsageStrip';
import { Scene } from './scene/Scene';
import { LiveBoard } from './components/LiveBoard';
import { ago, isDismissed, plainName, prettyModel, sessionColor, sessionName, tokens } from './lib/format';
import { contextMax } from './scene/derive';
import { Icon } from './components/Icon';
import { PlanUsage, UsageView } from './components/AccountUsage';
import { openUsage, useAccountUsage, useWatchUsage } from './state/accountUsage';
import { TerminalPane } from './components/TerminalPane';
import { useTermView } from './state/shells';
import { Composer } from './components/Composer';
import { HistoryModal, NewSessionModal } from './components/Launchers';
import { SettingsModal } from './components/SettingsModal';
import { ExplainsList } from './components/ExplainsList';
import { attentive, desktop } from './lib/desktop';
import { applyCoraColor } from './lib/coraColor';
import { Viewer, explainFrom } from './components/Viewer';
import { sessionEvents } from './state/store';
import { PushToTalk } from './components/PushToTalk';
import { useVoiceAutomation } from './lib/voiceAuto';
import { Boundary } from './components/Boundary';
import { DiffView } from './components/DiffView';
import { ChangesPane } from './components/ChangesPane';
import { WebPane, openFind, stepTab, tabOfPage } from './components/WebPane';
import { openInBrowser } from './state/browser';
import { useWeb } from './state/web';
import { useBoardDock } from './state/boardDock';
import { JiraText } from './components/JiraChip';
import { backgroundTasks } from './lib/background';
import { PaletteHost } from './components/Palette';
import { CiHeader, useFollowed } from './components/CiStrip';
import { DeployHeader, DeploysView } from './components/Deploys';
import { MailWatchChip } from './components/MailWatchChip';
import { changeTurns } from './lib/changes';
import { isPresentTool } from '@cora/shared';
import './components/right.css';
import { HEADER_MS } from './lib/ci';
import './components/header.css';
import { useCiAlerts } from './lib/ciAlerts';
import { TicketCard, TicketSlack } from './components/TicketCard';
import { useTicketSync } from './state/tickets';
import { ToolDrawer, openToolFind, toolOfPage, useToolKeys } from './components/Tools';
import { SlackOutbox } from './components/SlackOutbox';
import { CoraConsole } from './components/CoraConsole';
import { CoraCommand } from './components/CoraCommand';
import { useInControl, watchPresence } from './state/orchestrator';
import { useTools } from './state/tools';

/** Drag handle: reports pointer deltas (px) while dragging. */
function DragHandle({ dir, onDrag, onEnd }: { dir: 'col' | 'row'; onDrag(dx: number, dy: number): void; onEnd?(): void }) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      className={`drag-${dir}`}
      onPointerDown={(e) => {
        start.current = { x: e.clientX, y: e.clientY };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.classList.add('ui-dragging'); // pages in the browser would swallow the moves
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onDrag(e.clientX - start.current.x, e.clientY - start.current.y);
      }}
      onPointerUp={() => {
        start.current = null;
        document.body.classList.remove('ui-dragging');
        onEnd?.();
      }}
      onLostPointerCapture={() => document.body.classList.remove('ui-dragging')}
    />
  );
}

function RightColumn({ sessionId }: { sessionId: string }) {
  const ratio = useBrain((s) => s.termRatio);
  const view = useTermView(sessionId);
  const tab = useBrain((s) => s.rightTab);
  const setTab = useBrain((s) => s.setRightTab);
  const hasTerminal = useBrain((s) => s.terminals.some((t) => t.sessionId === sessionId));
  // the tabs' counts: its explains, and the files it changed
  const version = useBrain((s) => s.versions[sessionId]);
  const cwd = useBrain((s) => s.sessions[sessionId]?.cwd);
  const counts = useMemo(() => {
    const evs = sessionEvents(sessionId);
    const explains = evs.filter((e) => e.kind === 'tool' && e.phase === 'start' && isPresentTool(e.tool?.name)).length;
    const files = new Set(changeTurns(evs, cwd).flatMap((t) => t.files.map((f) => f.path))).size;
    return { explains, files };
  }, [sessionId, version, cwd]);
  const col = useRef<HTMLDivElement>(null);
  const base = useRef(ratio);
  // the transcript (or explains) lifts in when the session changes; the card, the tabs and the terminal stay put
  useEffect(() => {
    (col.current?.children[2] as HTMLElement | undefined)?.animate(LIFT, { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' });
  }, [sessionId]);
  // a hidden or input-only Claude terminal and not-hosted panes size to their content; otherwise a draggable split
  // (a shell tab on show always gets the split). The composer takes the last row, at its own height.
  const auto = !view.onShell && (!view.claudeShown || view.claudeCompact || !hasTerminal);
  return (
    <div className="rightcol" ref={col} style={{ gridTemplateRows: auto ? 'auto auto minmax(0, 1fr) auto auto' : `auto auto minmax(0, ${1 - ratio}fr) 6px minmax(0, ${ratio}fr) auto` }}>
      {/* the session's own card at the top (the window's top strip: it drags the window, its buttons sit over its corner):
          its orb (hold it to talk to it), what it is, what it's waiting on; its tabs under it */}
      <Boundary quiet name="session card">
        <SessionCard sessionId={sessionId} />
      </Boundary>
      <div className="rtabs">
        <button className={`rtab${tab === 'transcript' ? ' on' : ''}`} onClick={() => setTab('transcript')}>Transcript</button>
        <button className={`rtab${tab === 'explains' ? ' on' : ''}`} onClick={() => setTab('explains')}>Explains{counts.explains ? <span className="rt-n">{counts.explains}</span> : null}</button>
        <button className={`rtab${tab === 'changes' ? ' on' : ''}`} onClick={() => setTab('changes')}>Changes{counts.files ? <span className="rt-n">{counts.files}</span> : null}</button>
      </div>
      {/* the transcript (or explains, changes), with Claude Code's latest recap resting on its lower edge, just above
          the terminal and composer */}
      <div className="rc-pane">
        {tab === 'explains' ? <ExplainsList sessionId={sessionId} /> : tab === 'changes' ? <ChangesPane sessionId={sessionId} /> : <Transcript sessionId={sessionId} />}
        {tab === 'explains' || tab === 'changes' ? null : (
          <Boundary quiet name="recap">
            <RecapBar sessionId={sessionId} />
          </Boundary>
        )}
      </div>
      {auto ? null : (
        <DragHandle
          dir="row"
          onDrag={(_dx, dy) => {
            const h = col.current?.clientHeight || 1;
            useBrain.getState().setTermRatio(base.current - dy / h);
          }}
          onEnd={() => (base.current = useBrain.getState().termRatio)}
        />
      )}
      <TerminalPane sessionId={sessionId} />
      <Boundary quiet name="composer">
        <Composer sessionId={sessionId} />
      </Boundary>
    </div>
  );
}

/** Play a one-off entrance on an element (Web Animations, so nothing remounts: the 3D scene and terminals stay). */
function useEntrance(ref: React.RefObject<HTMLElement | null>, frames: Keyframe[], ms: number, dep: unknown) {
  useEffect(() => {
    ref.current?.animate(frames, { duration: ms, easing: 'cubic-bezier(.2,.7,.2,1)' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dep]);
}
const RACK_FOCUS: Keyframe[] = [
  { opacity: 0, filter: 'blur(10px) brightness(1.7)', transform: 'scale(1.04)' },
  { opacity: 1, filter: 'blur(0px) brightness(1)', transform: 'scale(1)' },
];
const LIFT: Keyframe[] = [
  { opacity: 0.2, transform: 'translateY(8px)' },
  { opacity: 1, transform: 'translateY(0)' },
];

function Focus({ sessionId }: { sessionId: string }) {
  const view = useRef<HTMLDivElement>(null);
  useEntrance(view, RACK_FOCUS, 560, sessionId);
  const rightWidth = useBrain((s) => s.rightWidth);
  const expanded = useBrain((s) => s.expanded);
  const hosted = useBrain((s) => s.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const viewer = useBrain((s) => s.viewer);
  const viewerWide = useBrain((s) => s.viewerWide);
  const diffOpen = useBrain((s) => s.diff?.sessionId === sessionId);
  const diffWide = useBrain((s) => s.diffWide);
  // a docked browser takes the right of the scene area: the 3D scene fits itself into the rest; the Board stays as it
  // is, the browser sliding over it like a drawer
  const scene3d = useBrain((s) => s.prefs.scene3d !== false);
  const needsDocked = useBoardDock((d) => d.needs.includes(sessionId));
  const sceneInset = useWeb((w) => {
    const s = w.sessions[sessionId];
    return scene3d && desktop?.browser && s?.shown && s.active && !w.wide && w.split < 1 ? `${Math.round(w.split * 1000) / 10}%` : 0;
  });
  const box = useRef<HTMLDivElement>(null);
  const startW = useRef(0);
  // a saved pixel width must never squeeze the left side on a smaller window
  const width = expanded ? '72%' : `min(${rightWidth ?? (hosted ? 580 : 420)}px, 60%)`;
  return (
    <div className="focus" ref={box} style={{ gridTemplateColumns: `minmax(0, 1fr) 6px ${width}` }}>
      <div className="vizcol">
        <FocusHeader sessionId={sessionId} />
        <div className="view" ref={view}>
          {diffOpen && !diffWide ? (
            <Boundary name="diff">
              <DiffView sessionId={sessionId} />
            </Boundary>
          ) : viewer && (viewer.sessionId === sessionId || viewer.pinned) && !viewerWide ? (
            <Viewer p={viewer} />
          ) : (
            <div className="scene-box" style={{ right: sceneInset }}>
              {scene3d ? <Scene sessionId={sessionId} /> : <LiveBoard sessionId={sessionId} />}
              {/* switching sessions: the new one fades in (keyed: it plays once per switch; the scene itself isn't rebuilt) */}
              <div key={sessionId} className="scene-veil" aria-hidden />
            </div>
          )}
          {needsDocked ? null : <NeedsYou sessionId={sessionId} />}
          <Boundary quiet name="push-to-talk">
            <PushToTalk sessionId={sessionId} />
          </Boundary>
        </div>
        <Timeline sessionId={sessionId} />
      </div>
      <DragHandle
        dir="col"
        onDrag={(dx) => {
          // the column itself (not the last child: the browser and wide viewers sit after it)
          if (!startW.current) startW.current = (box.current?.querySelector(':scope > .rightcol') as HTMLElement | null)?.clientWidth ?? 420;
          const max = (box.current?.clientWidth ?? 1200) - 320;
          useBrain.getState().setRightWidth(Math.round(Math.min(max, Math.max(320, startW.current - dx))));
          if (useBrain.getState().expanded) useBrain.getState().toggleExpanded();
        }}
        onEnd={() => (startW.current = 0)}
      />
      <RightColumn sessionId={sessionId} />
      {diffOpen && diffWide ? (
        <div className="viewer-wide">
          <Boundary name="diff">
            <DiffView sessionId={sessionId} />
          </Boundary>
        </div>
      ) : null}
      {viewer && (viewer.sessionId === sessionId || viewer.pinned) && viewerWide ? (
        <div className="viewer-wide">
          <Viewer p={viewer} />
        </div>
      ) : null}
      {desktop?.browser ? (
        <Boundary name="browser">
          <WebPane view={view} sessionId={sessionId} />
        </Boundary>
      ) : null}
    </div>
  );
}

/**
 * The timeline under the scene, or nothing when it's off (Settings › Scene › Timeline; its own fold button turns it off).
 * With the 3D scene it starts on, with the live board off (it rewinds the scene, not the board); each as you left it.
 */
function Timeline({ sessionId }: { sessionId: string }) {
  const scene3d = useBrain((s) => s.prefs.scene3d !== false);
  const pref = useBrain((s) => s.prefs.timeline);
  const shown = scene3d ? (pref?.scene ?? true) : (pref?.board ?? false);
  const set = (on: boolean) => {
    const st = useBrain.getState();
    if (!on) st.setCursor(null);
    st.setPrefs({ timeline: { ...st.prefs.timeline, [scene3d ? 'scene' : 'board']: on } });
  };
  // off: nothing at all (no tab to bring it back: that's Settings › Scene › Timeline)
  return shown ? (
    <div className="tl-dock">
      <button className="tl-fold" onClick={() => set(false)} title="Turn the timeline off (Settings › Scene › Timeline brings it back)">
        <Icon name="ChevronDown" size={12} />
      </button>
      <Strip sessionId={sessionId} />
    </div>
  ) : null;
}

const STATE_LABEL: Record<string, string> = { 'needs-you': 'needs you', working: 'working', thinking: 'thinking', idle: 'idle', ended: 'ended' };

/** A session's state as a word and as a tile class. */
const TILE_STATE: Record<string, string> = { 'needs-you': 'need', working: 'work', thinking: 'think' };

/**
 * Above the scene, in the design language: who (the nav's tile, the name), what it's doing (one word in its colour),
 * then facts as quiet text with one glyph each (its ticket, its pipeline); on the right its context, then actions.
 */
function FocusHeader({ sessionId }: { sessionId: string }) {
  const s = useBrain((st) => st.sessions[sessionId]);
  const hosted = useBrain((st) => st.terminals.some((t) => t.sessionId === sessionId && t.alive));
  const [copied, setCopied] = useState(false);
  // commands still running in the background (the agent may be idle meanwhile)
  const version = useBrain((st) => st.versions[sessionId]);
  const inBackground = useMemo(() => backgroundTasks(sessionEvents(sessionId)).filter((t) => t.endedAt == null).length, [sessionId, version]);
  const followed = !!useFollowed(sessionId, HEADER_MS);
  if (!s) return null;
  // about a ticket: its card says so (key, summary, status…); the name beside it is the rest of the session's name
  const name = s.ticket ? plainName(s) : sessionName(s);
  const copyFolder = () => {
    if (desktop?.writeClipboard) desktop.writeClipboard(s.cwd);
    else void navigator.clipboard?.writeText(s.cwd).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const initial = (name.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase();
  return (
    <div className={`focus-h st-${s.state}`}>
      <span className="fh-id">
        <span className={`dl-tile fh-tile ${TILE_STATE[s.state] ?? ''}`} style={{ ['--sc' as any]: sessionColor(s) }}>
          {initial}
          <i />
        </span>
        <span className="fh-name" onClick={copyFolder}>
          <span className="fh-nt">{name}</span>
          <span className="fh-card fh-namecard">
            <span className="r"><span className="k">folder</span><span>{s.cwd || '?'}</span></span>
            {s.project && name !== s.project ? <span className="r"><span className="k">project</span><span>{s.project}</span></span> : null}
            <span className="r"><span className="k">session</span><span>{s.id.slice(0, 8)}…</span></span>
            <span className="r hint">{copied ? 'folder copied' : 'click to copy the folder'}</span>
          </span>
        </span>
      </span>
      <span className={`fh-state st-${s.state}`}>
        {STATE_LABEL[s.state] ?? s.state}
        {inBackground ? <span className="fh-bg" title="Commands Claude left running in the background"> · {inBackground}<span className="fh-bgt"> in background</span></span> : null}
      </span>
      {s.ticket || s.issue || followed ? <span className="fh-dv" /> : null}
      {s.ticket ? <TicketCard s={s} /> : s.issue ? <IssueChip s={s} header /> : null}
      {s.ticket ? <TicketSlack ticketKey={s.ticket.key} /> : null}
      <CiHeader sessionId={sessionId} />
      <DeployHeader sessionId={sessionId} />
      <MailWatchChip sessionId={sessionId} />
      <span className="spacer" />
      <SessionMeter s={s} />
      {desktop?.browser ? <BrowserButton sessionId={s.id} /> : null}
      {s.state !== 'ended' && !hosted ? <JumpButton sessionId={s.id} short /> : null}
    </div>
  );
}

/** Show or hide this session's browser (its tabs stay loaded while hidden). */
function BrowserButton({ sessionId }: { sessionId: string }) {
  const shown = useWeb((w) => !!w.sessions[sessionId]?.shown);
  const n = useWeb((w) => w.sessions[sessionId]?.tabs.length ?? 0);
  return (
    <button
      className={`dl-btn web-toggle${shown ? ' on' : ''}`}
      title={shown ? 'Hide the browser (tabs stay loaded)' : "This session's browser: GitLab, Jira, docs… (links you click open here)"}
      onClick={() => useWeb.getState().setShown(sessionId, !shown)}
    >
      <Icon name="Globe" size={13} /><span className="bt-l"> Browser</span>{n ? <span className="web-n">{n}</span> : null}
    </button>
  );
}

export function App() {
  useVoiceAutomation();
  useCiAlerts();
  useTicketSync();
  useToolKeys();
  // Cora is in charge (a goal, or your sessions' prompts): a glow round the window says so
  const inControl = useInControl();
  const conn = useBrain((s) => s.conn);
  const ready = useBrain((s) => s.ready);
  // deep freeze: what was open before the PC restarted, offered once Cora is up
  useEffect(() => {
    if (ready) void loadThaw(true);
  }, [ready]);
  const focus = useBrain((s) => s.focus);
  const sessions = useBrain((s) => s.sessions);
  const overview = useBrain((s) => s.overview);
  const modal = useBrain((s) => s.modal);
  // setting Cora up: the first run shows instead of the app while something required is missing (or on a fresh install)
  const setupState = useSetup((s) => s.state);
  const setupDismissed = useSetup((s) => s.dismissed);
  const setupChecked = useSetup((s) => s.checked);
  useEffect(() => {
    if (conn === 'open' && !useSetup.getState().state) void loadSetup();
  }, [conn]);
  // until we know whether this is a first run, show nothing (not the app, then the setup over it): a few seconds once the
  // server answers, longer while it's still starting (a cold first launch), then the app regardless
  const [setupWaited, setSetupWaited] = useState(false);
  useEffect(() => {
    if (setupWaited) return;
    const t = setTimeout(() => setSetupWaited(true), conn === 'open' ? 4000 : 20_000);
    return () => clearTimeout(t);
  }, [conn, setupWaited]);

  useEffect(() => watchPresence(), []);
  // "Hey Cora": the wake word, when it's on
  useEffect(() => startWake(), []);
  // Cora's colour: the UI's and the app icon's
  const coraColor = useBrain((s) => s.prefs.coraColor);
  useEffect(() => void applyCoraColor(coraColor), [coraColor]);
  useEffect(() => {
    void connect();
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return;
      if (e.key === 'g' || e.key === 'G') useBrain.getState().toggleOverview();
      if (e.key === 'Escape') (useBrain.getState().toggleOverview(false), useBrain.getState().setInbox(false));
    };
    window.addEventListener('keydown', onKey);
    // The mouse's back/forward buttons would navigate the app itself (a full reload). Cancel that; with the browser
    // on show they step its active tab instead (over a page, the page handles them itself).
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      const focus = useBrain.getState().focus;
      const s = focus ? useWeb.getState().sessions[focus] : undefined;
      if (s?.shown) stepTab(s.active, e.button === 3 ? -1 : 1);
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // Desktop app: badge count, notifications → focus, tray commands, and "Claude finished" for hosted sessions.
  useEffect(() => {
    desktop?.setNeedsYou(Object.values(sessions).reduce((n, s) => n + (s.needsYou || 0), 0));
  }, [sessions]);
  useEffect(() => {
    if (!desktop) return;
    const offFocus = desktop.onFocusSession((sid) => useBrain.getState().setFocus(sid));
    // the tray: a new session; Lock Cora with no PIN yet (choose one, then it locks)
    const offCmd = desktop.onCommand((c) => (c === 'new-session' ? useBrain.getState().setModal('new-session') : c === 'lock' ? void lockNow() : undefined));
    // links clicked anywhere in the app open in the built-in browser: the session's, or with no session open, Cora's Browser
    const offWeb = desktop.onOpenWeb?.((url) => {
      const st = useBrain.getState();
      if (st.focus && !st.overview) useWeb.getState().open(st.focus, url);
      else openInBrowser(url);
    });
    // a page asking for a new tab (a target=_blank link) or a tab shortcut: it belongs to whichever session owns the page
    // the key in a page's login field: a session's tab, or a Tool in the drawer when 1Password is on there
    const offField = desktop.onOpField?.((m) => onField(m, tabOfPage.has(m.from) || (toolOfPage.has(m.from) && useOp.getState().settings.tools)));
    const offTab = desktop.onWebTab?.(({ from, url, background, key }) => {
      // Esc in a page: its find bar closes (the page still gets the key)
      if (key === 'esc') return void window.dispatchEvent(new CustomEvent('cora:find-esc', { detail: from }));
      // Ctrl+\ in a page (a session's tab, or a Tool in the drawer when it's allowed there): 1Password's menu
      if (key === 'fill') return void ((tabOfPage.has(from) || (toolOfPage.has(from) && useOp.getState().settings.tools)) && openOpMenu(from));
      const w = useWeb.getState();
      const t = w.tabs[tabOfPage.get(from) ?? ''];
      if (!t) {
        // a tool's page (Slack): its links open in the session you're looking at (else Cora's Browser); Ctrl+W closes the drawer
        if (!toolOfPage.has(from)) return;
        const focus = useBrain.getState().focus;
        if (url) focus && !useBrain.getState().overview ? w.open(focus, url, { background }) : openInBrowser(url, { background });
        else if (key === 'w') useTools.getState().close();
        else if (key === 'f') openToolFind();
        return;
      }
      if (url) w.newTab(t.sessionId, url, { after: t.id, background });
      else if (key === 't') w.newTab(t.sessionId);
      else if (key === 'w') w.closeTab(t.id);
      else if (key === 'next' || key === 'prev') w.cycle(t.sessionId, key === 'next' ? 1 : -1);
      else if (key === 'l') (document.querySelector(`.web-addr[data-group="${CSS.escape(t.sessionId)}"] input`) as HTMLInputElement | null)?.focus();
      else if (key === 'f') openFind(t.sessionId);
    });
    let prev = useBrain.getState().sessions;
    const unsub = useBrain.subscribe((st) => {
      if (st.sessions === prev) return;
      for (const s of Object.values(st.sessions)) {
        const was = prev[s.id]?.state;
        const hosted = st.terminals.some((t) => t.sessionId === s.id && t.alive);
        if (st.prefs.notifyFinished && hosted && (was === 'working' || was === 'thinking') && s.state === 'idle' && !attentive()) {
          const said = [...sessionEvents(s.id)].reverse().find((e) => e.kind === 'say' && e.agentId === 'main' && e.text?.trim())?.text?.trim();
          desktop!.notify(`${sessionName(s)} is done`, said ? `Last said: “${said.slice(0, 180)}${said.length > 180 ? '…' : ''}”` : 'Claude finished its turn and is waiting for you.', s.id);
        }
      }
      prev = st.sessions;
    });
    return () => {
      offFocus();
      offCmd();
      offWeb?.();
      offTab?.();
      offField?.();
      unsub();
    };
  }, []);

  // Auto-open explains Claude creates in the focused session (only new ones, not history on load).
  useEffect(() => {
    const since = Date.now() - 5000;
    const seen = new Set<string>();
    let prev = useBrain.getState().versions;
    return useBrain.subscribe((st) => {
      if (st.versions === prev || !st.focus) return;
      const changed = st.versions[st.focus] !== prev[st.focus];
      prev = st.versions;
      if (!changed) return;
      const evs = sessionEvents(st.focus);
      for (let i = evs.length - 1; i >= 0 && i > evs.length - 40; i--) {
        const e = evs[i];
        if (e.ts < since || e.kind !== 'tool' || e.phase !== 'start' || !e.toolUseId || seen.has(e.toolUseId)) continue;
        const p = explainFrom(e);
        if (!p) continue;
        seen.add(e.toolUseId);
        // a title written again is a new version: on screen it replaces the one shown (in place, no focus change),
        // unless you stepped back to an older one; it never opens on its own
        const again = evs.some((x) => x !== e && x.ts <= e.ts && x.kind === 'tool' && x.phase === 'start' && explainFrom(x)?.title.trim().toLowerCase() === p.title.trim().toLowerCase());
        if (again) {
          const v = useBrain.getState().viewer;
          if (v && v.sessionId === p.sessionId && v.title.trim().toLowerCase() === p.title.trim().toLowerCase() && !v.held && v.toolUseId !== p.toolUseId) useBrain.getState().setViewer({ ...p, pinned: v.pinned });
          continue;
        }
        // let the scene show the card rising out of main before the viewer covers it
        const sid = st.focus;
        setTimeout(() => {
          const now = useBrain.getState();
          // not over the browser (you're looking at something there), nor over a game of golf (it stays on the shelf),
          // nor over the live board when its Spotlight is up (the explain shows there)
          if (now.focus === sid && now.viewer?.toolUseId !== p.toolUseId && !useWeb.getState().sessions[sid]?.shown && !document.querySelector('.golfing') && !useBoardDock.getState().spotlight.includes(sid)) now.setViewer(p);
        }, 2200);
        if (st.prefs.notifyExplains && !attentive()) desktop?.notify(`${st.sessions[st.focus] ? sessionName(st.sessions[st.focus]) : 'Claude'} wrote an explain`, p.title, st.focus);
        break;
      }
    });
  }, []);

  // Keep focus on a session that's visible in the list. When the focused one is dismissed, or ends while you watch it
  // (you ended it), move on to a live one; with none live, show the empty state instead of a stale scene. An ended
  // session you click on stays (you went to read it).
  // the focused session's Claude still running here (not a shell beside it: that outlives Claude); looked at again when it ends
  const focusRunning = useBrain((s) => !!s.focus && s.terminals.some((t) => t.sessionId === s.focus && t.alive && !isShell(t)));
  const watching = useRef<{ id: string | null; live: boolean; ended: boolean }>({ id: null, live: false, ended: false });
  useEffect(() => {
    const cur = focus ? sessions[focus] : undefined;
    const live = !!cur && cur.state !== 'ended';
    const w = watching.current;
    watching.current = w.id !== focus ? { id: focus, live, ended: false } : { id: focus, live, ended: live ? false : w.ended || w.live };
    const visible = sortedSessions(sessions).filter((s) => !isDismissed(s));
    if (focus && !watching.current.ended && visible.some((s) => s.id === focus)) return;
    // never move off a session running in a terminal here (one just resumed may still look dismissed for a moment)
    if (focus && sessions[focus] && focusRunning) return;
    const next = visible.find((s) => s.id !== focus && s.state !== 'ended')?.id ?? null;
    if (next === focus) return;
    // a session going away doesn't take you out of the Overview
    const ov = useBrain.getState().overview;
    useBrain.getState().setFocus(next);
    if (ov) useBrain.setState({ overview: true });
  }, [sessions, focus, focusRunning]);

  useEffect(() => {
    if (focus) void loadSession(focus);
  }, [focus]);

  if (conn === 'unauthorized') {
    return (
      <div className="splash">
        <h2>Cora</h2>
        <p>Open the link printed by <code>cora start</code> (it contains your access key).</p>
      </div>
    );
  }

  if (!setupChecked && !setupWaited) return <BootScreen connected={conn === 'open'} />;

  if (setupState && !setupDismissed && setupFirstRun(setupState))
    return (
      <>
        <SetupView />
        {modal === 'settings' ? <SettingsModal /> : null}
      </>
    );

  return (
    <div className={`app${inControl ? ' cora-in-control' : ''}`}>
      <div className="shell-body">
        <SessionRail />
        <main className="main">
          {overview ? (
            <Overview />
          ) : focus ? (
            <Focus sessionId={focus} />
          ) : !ready ? null : (
            <EmptyMain />
          )}
          <ToolDrawer />
          <IdeHost />
          <SlackOutbox />
          <MailOutbox />
          <CoraConsole />
          <InboxView />
          <CoraCommand />
        </main>
      </div>
      <Toasts />
      <OpMenu />
      <CoraFloat />
      <PaletteHost />
      <SessionSwitcher />
      <LockSetup />
      <ThawCard />
      <UsageView />
      {modal === 'new-session' ? <NewSessionModal /> : modal === 'history' ? <HistoryModal /> : modal === 'settings' ? <SettingsModal /> : null}
    </div>
  );
}

/** The overview (G): the card grid or the galaxy, switchable and remembered. */
function Overview() {
  const style = useBrain((s) => s.prefs.overviewStyle);
  const scene3d = useBrain((s) => s.prefs.scene3d !== false);
  const setPrefs = useBrain((s) => s.setPrefs);
  return (
    <div className="overview">
      <div className="ov-head">
        <div className="ov-switch seg">
          <button className={`seg-b${style === 'grid' || (style === 'galaxy' && !scene3d) ? ' on' : ''}`} onClick={() => setPrefs({ overviewStyle: 'grid' })}>
            <Icon name="LayoutGrid" size={13} /> Grid
          </button>
          {scene3d ? (
            <button className={`seg-b${style === 'galaxy' ? ' on' : ''}`} onClick={() => setPrefs({ overviewStyle: 'galaxy' })}>
              <Icon name="Orbit" size={13} /> Galaxy
            </button>
          ) : null}
          <button className={`seg-b${style === 'deploys' ? ' on' : ''}`} onClick={() => setPrefs({ overviewStyle: 'deploys' })}>
            <Icon name="Rocket" size={13} /> Deploys
          </button>
        </div>
        <UsageStrip />
      </div>
      <div className="ov-body">{style === 'galaxy' && scene3d ? <Galaxy /> : style === 'deploys' ? <DeploysView /> : <GridOverview />}</div>
    </div>
  );
}

/** Context use and output so far for the focused session (from its loaded events). */
/** Context, model and output in one pill: a ring of main's context use; hover for the detail. */
function SessionMeter({ s }: { s: SessionInfo }) {
  const version = useBrain((st) => st.versions[s.id]);
  const u = useMemo(() => {
    let out = 0, ctx = 0, peak = 0, compactions = 0;
    let compactedAt: number | null = null;
    for (const e of sessionEvents(s.id)) {
      if (e.tokens) {
        out += e.tokens.out;
        if (e.agentId === 'main') {
          ctx = e.tokens.in + e.tokens.out;
          peak = Math.max(peak, ctx);
          compactedAt = null;
        }
      }
      if (e.kind === 'compact' && e.agentId === 'main') {
        compactedAt = e.ts;
        compactions++;
      }
    }
    const max = contextMax(s.model, peak);
    return { out, ctx, max, compactions, compactedAt, pct: ctx && compactedAt == null ? ctx / max : null };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id, version, s.model]);
  const m = prettyModel(s.model);
  const drift = s.totalLines && s.unknownLines ? s.unknownLines / s.totalLines : 0;
  // your plan's usage under the session's: read while you look at the card (about once a minute at most)
  const [hover, setHover] = useState(false);
  useWatchUsage(hover);
  const plan = useAccountUsage((a) => a.u);
  if (!u.out && u.pct == null && !m) return null;
  const pct = u.pct ?? 0;
  const col = u.pct == null ? 'var(--ink4)' : pct < 0.6 ? 'var(--work)' : pct < 0.8 ? 'var(--think)' : 'var(--need)';
  return (
    <span className="fh-meter clickable" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} onClick={() => openUsage()} title="">
      <span className="fh-bar"><i style={{ width: `${Math.min(100, pct * 100)}%`, background: col }} /></span>
      <span>{u.compactedAt != null ? 'fresh' : u.pct != null ? `${Math.round(pct * 100)}%` : '–'}</span>
      {m ? <span className="fh-model">{m.name}</span> : null}
      {drift > 0.05 ? <span className="fh-flag" /> : null}
      <span className="fh-card">
        <span className="r">
          <span className="k">context (main)</span>
          <span>{u.compactedAt != null ? `compacted ${ago(u.compactedAt)}` : u.pct != null ? `${tokens(u.ctx)} / ${tokens(u.max)} · ${Math.round(pct * 100)}%` : 'not yet'}</span>
        </span>
        <span className="fh-big"><i style={{ width: `${Math.min(100, pct * 100)}%`, background: col }} /></span>
        {m ? <span className="r"><span className="k">model</span><span>{m.name}{m.ctx ? ` · ${m.ctx} context` : ''}</span></span> : null}
        <span className="r"><span className="k">output this session</span><span>{tokens(u.out)} tokens</span></span>
        <span className="r"><span className="k">compactions</span><span>{u.compactions || 'none'}</span></span>
        <button className="au-sec" onClick={(e) => (e.stopPropagation(), openUsage())}>
          <span className="k">
            Your plan<span>All usage ›</span>
          </span>
          <PlanUsage u={plan} compact />
        </button>
        {drift > 0.05 ? (
          <span className="w">
            ⚠ {Math.round(drift * 100)}% of transcript lines weren't recognised: Claude Code's transcript format may have changed, so the scene may miss some steps.
          </span>
        ) : null}
      </span>
    </span>
  );
}
