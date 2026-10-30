import { MAX_REPLAY, type AgentInfo, type BrainEvent, type CiMsg, type ClientMsg, type DebriefsMsg, type WorktreesMsg, type SecretsMsg, type DeploysMsg, type ExplainDataMsg, type InboxMsg, type NotesMsg, type JiraMsg, type OrchMsg, type PendingRequest, type SecurityMsg, type ServerMsg, type SessionInfo, type SlackMsg, type TerminalInfo, type UiCommandMsg } from '@cora/shared';
import type { Store } from './store';
import { lookForGuest } from './synced';

type Sock = { send(data: string): void; on(ev: 'message' | 'close', fn: (d?: any) => void): void; readyState: number; close?(): void };

const OPEN = 1;
const RECENT_PER_SESSION = 40;

/**
 * Where a pointer is: a spot in Cora's area (shares of it), and the thing under it when every screen has that thing (a
 * session's row, a panel, a tab), so it lands on the same thing on every screen in a share.
 */
const unit = (n: unknown) => Math.max(0, Math.min(1, Number(n) || 0));
function placed(m: { x?: unknown; y?: unknown; anchor?: unknown; ax?: unknown; ay?: unknown }) {
  const on = typeof m.anchor === 'string' && /^[\w:.-]{1,120}$/.test(m.anchor) ? { anchor: m.anchor, ax: unit(m.ax), ay: unit(m.ay) } : {};
  return { x: unit(m.x), y: unit(m.y), ...on };
}

/** WebSocket fan-out with 50 ms batching and lastSeq-based replay. */
export class Hub {
  private socks = new Set<Sock>();
  /** each screen's device: 'pc', a paired device ('dev:<id>'), or 'view' (a view-only sign-in, always fed) */
  private seats = new Map<Sock, string>();
  /**
   * Go live: guests' screens ('guest:<id>') are fed while the share lasts and the guest is in it, only what they may see
   * (private areas closed); the host's view and everyone's pointers go to the others.
   */
  guests?: { live(id: string): boolean; on(): boolean; allows(t: string): boolean; name(seat: string): string };
  private lastView: import('@cora/shared').LiveView | null = null;
  /** the device Cora is in use on now, and its name */
  activeSeat = 'pc';
  activeName = 'your PC';
  private evQ: BrainEvent[] = [];
  private sessQ = new Map<string, SessionInfo>();
  private agentQ = new Map<string, AgentInfo>();
  private timer?: NodeJS.Timeout;
  /** GitLab pipelines: what a newly connected client starts from */
  ciSnapshot?: () => CiMsg;
  deploysSnapshot?: () => DeploysMsg;
  /** your repos' worktrees */
  worktreesSnapshot?: () => WorktreesMsg;
  videosSnapshot?: () => import('@cora/shared').VideosMsg;
  /** your projects */
  projectsSnapshot?: () => import('@cora/shared').ProjectsMsg;
  /** your secrets (names and notes, never values) */
  secretsSnapshot?: () => SecretsMsg;
  notesSnapshot?: () => NotesMsg;
  /** Slack: connected or not, and the drafts waiting for you */
  slackSnapshot?: () => SlackMsg;
  /** watching Jira: the watcher's status and the recent events */
  jiraSnapshot?: () => JiraMsg;
  /** Cora's Inbox: everything it told you */
  inboxSnapshot?: () => InboxMsg;
  /** emails sessions asked to send, waiting for you */
  mailOutboxSnapshot?: () => import('@cora/shared').MailOutboxMsg;
  calendarSnapshot?: () => import('@cora/shared').CalendarMsg;
  /** the security check's last report */
  securitySnapshot?: () => SecurityMsg;
  /** the Cora Orchestrator: on or off, running, its approvals */
  orchestratorSnapshot?: () => OrchMsg;

  constructor(private store: Store, private getPending: () => PendingRequest[], private batchMs = 50, private getTerminals: () => TerminalInfo[] = () => []) {}

  clientCount(): number {
    return [...this.socks].filter((s) => s.readyState === OPEN).length;
  }

  add(sock: Sock, seat = 'pc'): void {
    this.socks.add(sock);
    this.seats.set(sock, seat);
    sock.on('close', () => (this.socks.delete(sock), this.seats.delete(sock)));
    sock.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'hello') this.hello(sock, msg.lastSeq);
      else if (msg.t === 'view' || msg.t === 'cursor' || msg.t === 'cursor-gone' || msg.t === 'ping') this.fromScreen(sock, msg);
    });
  }

  /** Does this screen get Cora (its device is the one in use, or it's a view-only sign-in)? */
  private fed(sock: Sock): boolean {
    const s = this.seats.get(sock) ?? 'pc';
    if (s.startsWith('guest:')) return !!this.guests?.live(s.slice(6));
    return s === 'view' || s === this.activeSeat;
  }
  /** May this screen have this message (a guest: not the private areas')? */
  private may(sock: Sock, t: string): boolean {
    const s = this.seats.get(sock) ?? 'pc';
    return !s.startsWith('guest:') || !!this.guests?.allows(t);
  }
  private isGuest(sock: Sock): boolean {
    return (this.seats.get(sock) ?? '').startsWith('guest:');
  }

  /** Go live's state: the host's screens get it whole (the link), each guest its own (who they are), none: not live. */
  publishLive(host: import('@cora/shared').LiveState | null, forGuest: (id: string) => import('@cora/shared').LiveState | null): void {
    if (!host) this.lastView = null;
    for (const s of this.socks) {
      const seat = this.seats.get(s) ?? 'pc';
      if (seat.startsWith('guest:')) this.send(s, { t: 'live', live: forGuest(seat.slice(6)) }, true);
      else if (this.fed(s)) this.send(s, { t: 'live', live: host });
    }
  }
  /** Go live: the guests' asks, to the host's screens. */
  publishAsks(asks: import('@cora/shared').LiveAsk[]): void {
    for (const s of this.socks) if (!this.isGuest(s) && this.fed(s)) this.send(s, { t: 'live-asks', asks });
  }
  /** Go live: the guests' screens start afresh (an area you opened: what's there now). */
  refreshGuests(): void {
    for (const s of this.socks) if (this.isGuest(s)) this.hello(s, 0);
  }
  /** Go live: a guest's screens close (removed, or the share ended). */
  closeGuest(id?: string): void {
    for (const s of [...this.socks]) {
      const seat = this.seats.get(s) ?? '';
      if (seat.startsWith('guest:') && (!id || seat === `guest:${id}`)) s.close?.();
    }
  }
  private fromScreen(sock: Sock, msg: ClientMsg): void {
    const seat = this.seats.get(sock) ?? 'pc';
    if (!this.fed(sock) || seat === 'view') return;
    if (msg.t === 'view' && !seat.startsWith('guest:')) {
      // the host's view: guests following them go there
      this.lastView = msg.view;
      for (const s of this.socks) if (this.isGuest(s) && this.fed(s)) this.send(s, { t: 'live-view', view: msg.view });
    } else if (msg.t === 'ping') {
      // someone pointing at something: a pulse there, on everyone else's screen in the share
      if (!this.guests?.on()) return;
      const out = { t: 'ping' as const, id: seat, name: this.guests.name(seat), ...placed(msg) };
      for (const s of this.socks) if (s !== sock && this.fed(s) && (this.isGuest(s) || this.seats.get(s) === this.activeSeat)) this.send(s, out);
    } else if (msg.t === 'cursor' || msg.t === 'cursor-gone') {
      // a pointer: to everyone else in the share (the host and the guests)
      if (!this.guests?.on()) return;
      const out = msg.t === 'cursor' ? { t: 'cursor' as const, id: seat, name: this.guests.name(seat), ...placed(msg) } : { t: 'cursor' as const, id: seat, name: '', x: 0, y: 0, gone: true };
      for (const s of this.socks) if (s !== sock && this.fed(s) && (this.isGuest(s) || this.seats.get(s) === this.activeSeat)) this.send(s, out);
    }
  }

  /** Cora in use on another device: its screens get everything afresh; every other screen hears only where it is. */
  setActive(seat: string, name: string): void {
    const was = this.activeSeat;
    this.activeSeat = seat;
    this.activeName = name;
    if (was === seat) return;
    for (const s of this.socks) {
      const mine = this.seats.get(s) ?? 'pc';
      if (mine === 'view') continue;
      if (mine === seat) this.hello(s, 0);
      else this.send(s, { t: 'elsewhere', name });
    }
  }

  /** End the screens of some devices (disconnecting remote devices). */
  closeSeats(which: (seat: string) => boolean): void {
    for (const s of [...this.socks]) if (which(this.seats.get(s) ?? 'pc')) s.close?.();
  }

  private hello(sock: Sock, lastSeq: number): void {
    if (!this.fed(sock)) return void this.send(sock, { t: 'elsewhere', name: this.activeName });
    const sessions = this.store.listSessions().slice(0, 100);
    const recent: Record<string, BrainEvent[]> = {};
    for (const s of sessions.slice(0, 40)) recent[s.id] = this.store.eventsForSession(s.id, { limit: RECENT_PER_SESSION });
    const current = this.store.lastSeq();
    this.send(sock, { t: 'snapshot', sessions, agents: this.store.listAgents().filter((a) => sessions.some((s) => s.id === a.sessionId)), pending: this.getPending(), terminals: this.getTerminals(), lastSeq: current, recent } as ServerMsg);
    if (this.ciSnapshot) this.send(sock, this.ciSnapshot());
    if (this.deploysSnapshot) this.send(sock, this.deploysSnapshot());
    if (this.worktreesSnapshot) this.send(sock, this.worktreesSnapshot());
    if (this.videosSnapshot) this.send(sock, this.videosSnapshot());
    if (this.secretsSnapshot) this.send(sock, this.secretsSnapshot());
    if (this.projectsSnapshot) this.send(sock, this.projectsSnapshot());
    if (this.rbrowseSnapshot) this.send(sock, this.rbrowseSnapshot());
    if (this.notesSnapshot) this.send(sock, this.notesSnapshot());
    if (this.slackSnapshot) this.send(sock, this.slackSnapshot());
    if (this.jiraSnapshot) this.send(sock, this.jiraSnapshot());
    if (this.inboxSnapshot) this.send(sock, this.inboxSnapshot());
    if (this.mailOutboxSnapshot) this.send(sock, this.mailOutboxSnapshot());
    if (this.calendarSnapshot) this.send(sock, this.calendarSnapshot());
    if (this.securitySnapshot) this.send(sock, this.securitySnapshot());
    if (this.orchestratorSnapshot) this.send(sock, this.orchestratorSnapshot());
    for (const m of this.simShown.values()) this.send(sock, m);
    if (this.isGuest(sock) && this.lastView) this.send(sock, { t: 'live-view', view: this.lastView });
    if (lastSeq > 0 && current - lastSeq <= MAX_REPLAY && lastSeq <= current) {
      const events = this.store.eventsSince(lastSeq, MAX_REPLAY);
      if (events.length) this.send(sock, { t: 'events', events });
    }
  }

  publish(e: BrainEvent): void {
    this.evQ.push(e);
    this.schedule();
  }

  publishSession(s: SessionInfo): void {
    this.sessQ.set(s.id, s);
    this.schedule();
  }

  publishAgent(a: AgentInfo): void {
    this.agentQ.set(`${a.sessionId}/${a.agentId}`, a);
    this.schedule();
  }

  publishPending(pending: PendingRequest[]): void {
    this.broadcast({ t: 'pending', pending });
  }

  publishCi(m: CiMsg): void {
    this.broadcast(m);
  }

  publishNotes(m: NotesMsg): void {
    this.broadcast(m);
  }

  publishDeploys(m: DeploysMsg): void {
    this.broadcast(m);
  }

  publishSlack(m: SlackMsg): void {
    this.broadcast(m);
  }

  publishJira(m: JiraMsg): void {
    this.broadcast(m);
  }

  publishInbox(m: InboxMsg): void {
    this.broadcast(m);
  }

  publishMailOutbox(m: import('@cora/shared').MailOutboxMsg): void {
    this.broadcast(m);
  }
  publishCalendar(m: import('@cora/shared').CalendarMsg): void {
    this.broadcast(m);
  }
  publishCalendarDue(m: import('@cora/shared').CalendarDueMsg): void {
    this.broadcast(m);
  }

  publishSecurity(m: SecurityMsg): void {
    this.broadcast(m);
  }

  publishOrchestrator(m: OrchMsg): void {
    this.broadcast(m);
  }

  /** A live explain's new data: the open pages redraw. */
  /** a session posted to its Meme panel: the open panels look again */
  /** Cora locked: every page hears it (and goes to the lock screen), then its stream is closed. */
  lockAll(): void {
    this.broadcast({ t: 'lock' });
    const socks = [...this.socks];
    this.socks.clear();
    setTimeout(() => socks.forEach((s) => s.close?.()), 100);
  }
  /** your Cora's look changed on one of your screens: your other screens keep it */
  publishSynced(key: string, value: string | null): void {
    this.broadcast({ t: 'synced', key, value });
    // guests in a share: the visual part of it, as they see your look
    const g = lookForGuest(key, value);
    if (g === undefined) return;
    const data = JSON.stringify({ t: 'synced', key, value: g });
    for (const s of this.socks) if (s.readyState === OPEN && this.isGuest(s) && this.fed(s)) s.send(data);
  }
  publishMeme(sessionId: string): void {
    this.broadcast({ t: 'meme', sessionId });
  }

  publishExplainData(m: ExplainDataMsg): void {
    this.broadcast(m);
  }

  /** The orchestrator driving the dashboard (every open dashboard follows). */
  publishUi(m: UiCommandMsg): void {
    this.broadcast(m);
  }

  publishSecrets(m: SecretsMsg): void {
    this.broadcast(m);
  }

  /** a session's browser on your other devices: its tabs (and whether the desktop app can render them) */
  rbrowseSnapshot?: () => ServerMsg;
  publishRbrowse(m: ServerMsg): void {
    this.broadcast(m);
  }

  publishProjects(m: import('@cora/shared').ProjectsMsg): void {
    this.broadcast(m);
  }

  /** debrief videos: their progress, ffmpeg */
  publishVideos(m: import('@cora/shared').VideosMsg): void {
    this.broadcast(m);
  }

  publishWorktrees(m: WorktreesMsg): void {
    this.broadcast(m);
  }

  /** a session's debriefs changed (one was made) */
  publishDebriefs(m: DebriefsMsg): void {
    this.broadcast(m);
  }

  publishTerminals(terminals: TerminalInfo[]): void {
    this.broadcast({ t: 'terminals', terminals });
  }

  flush(): void {
    this.timer = undefined;
    for (const session of this.sessQ.values()) this.broadcast({ t: 'session', session });
    for (const agent of this.agentQ.values()) this.broadcast({ t: 'agent', agent });
    if (this.evQ.length) this.broadcast({ t: 'events', events: this.evQ });
    this.sessQ.clear();
    this.agentQ.clear();
    this.evQ = [];
  }

  private schedule(): void {
    if (!this.timer) this.timer = setTimeout(() => this.flush(), this.batchMs);
  }

  /**
   * The simulator's stand-ins for integrations (simShow.ts): sent to every dashboard, now and as it connects, and
   * the real ones of those kinds (never connected in a simulation) kept from replacing them.
   */
  private simShown = new Map<string, ServerMsg>();
  showSim(msg: ServerMsg): void {
    this.simShown.set(msg.t, msg);
    this.broadcast(msg, true);
  }

  private broadcast(msg: ServerMsg, sim = false): void {
    if (!sim && this.simShown.has(msg.t)) return;
    if (!this.socks.size) return;
    const data = JSON.stringify(msg);
    for (const s of this.socks) if (s.readyState === OPEN && this.fed(s) && this.may(s, msg.t)) s.send(data);
  }

  private send(sock: Sock, msg: ServerMsg, always = false): void {
    if (sock.readyState === OPEN && (always || this.may(sock, msg.t))) sock.send(JSON.stringify(msg));
  }
}
