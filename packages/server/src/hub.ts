import { MAX_REPLAY, type AgentInfo, type BrainEvent, type CiMsg, type ClientMsg, type DeploysMsg, type ExplainDataMsg, type InboxMsg, type NotesMsg, type JiraMsg, type OrchMsg, type PendingRequest, type SecurityMsg, type ServerMsg, type SessionInfo, type SlackMsg, type TerminalInfo, type UiCommandMsg } from '@cora/shared';
import type { Store } from './store';

type Sock = { send(data: string): void; on(ev: 'message' | 'close', fn: (d?: any) => void): void; readyState: number };

const OPEN = 1;
const RECENT_PER_SESSION = 40;

/** WebSocket fan-out with 50 ms batching and lastSeq-based replay. */
export class Hub {
  private socks = new Set<Sock>();
  private evQ: BrainEvent[] = [];
  private sessQ = new Map<string, SessionInfo>();
  private agentQ = new Map<string, AgentInfo>();
  private timer?: NodeJS.Timeout;
  /** GitLab pipelines: what a newly connected client starts from */
  ciSnapshot?: () => CiMsg;
  deploysSnapshot?: () => DeploysMsg;
  notesSnapshot?: () => NotesMsg;
  /** Slack: connected or not, and the drafts waiting for you */
  slackSnapshot?: () => SlackMsg;
  /** watching Jira: the watcher's status and the recent events */
  jiraSnapshot?: () => JiraMsg;
  /** Cora's Inbox: everything it told you */
  inboxSnapshot?: () => InboxMsg;
  /** the security check's last report */
  securitySnapshot?: () => SecurityMsg;
  /** the Cora Orchestrator: on or off, running, its approvals */
  orchestratorSnapshot?: () => OrchMsg;

  constructor(private store: Store, private getPending: () => PendingRequest[], private batchMs = 50, private getTerminals: () => TerminalInfo[] = () => []) {}

  clientCount(): number {
    return [...this.socks].filter((s) => s.readyState === OPEN).length;
  }

  add(sock: Sock): void {
    this.socks.add(sock);
    sock.on('close', () => this.socks.delete(sock));
    sock.on('message', (raw) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.t === 'hello') this.hello(sock, msg.lastSeq);
    });
  }

  private hello(sock: Sock, lastSeq: number): void {
    const sessions = this.store.listSessions().slice(0, 100);
    const recent: Record<string, BrainEvent[]> = {};
    for (const s of sessions.slice(0, 40)) recent[s.id] = this.store.eventsForSession(s.id, { limit: RECENT_PER_SESSION });
    const current = this.store.lastSeq();
    this.send(sock, { t: 'snapshot', sessions, agents: this.store.listAgents().filter((a) => sessions.some((s) => s.id === a.sessionId)), pending: this.getPending(), terminals: this.getTerminals(), lastSeq: current, recent } as ServerMsg);
    if (this.ciSnapshot) this.send(sock, this.ciSnapshot());
    if (this.deploysSnapshot) this.send(sock, this.deploysSnapshot());
    if (this.notesSnapshot) this.send(sock, this.notesSnapshot());
    if (this.slackSnapshot) this.send(sock, this.slackSnapshot());
    if (this.jiraSnapshot) this.send(sock, this.jiraSnapshot());
    if (this.inboxSnapshot) this.send(sock, this.inboxSnapshot());
    if (this.securitySnapshot) this.send(sock, this.securitySnapshot());
    if (this.orchestratorSnapshot) this.send(sock, this.orchestratorSnapshot());
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

  publishSecurity(m: SecurityMsg): void {
    this.broadcast(m);
  }

  publishOrchestrator(m: OrchMsg): void {
    this.broadcast(m);
  }

  /** A live explain's new data: the open pages redraw. */
  /** a session posted to its Meme panel: the open panels look again */
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

  private broadcast(msg: ServerMsg): void {
    if (!this.socks.size) return;
    const data = JSON.stringify(msg);
    for (const s of this.socks) if (s.readyState === OPEN) s.send(data);
  }

  private send(sock: Sock, msg: ServerMsg): void {
    if (sock.readyState === OPEN) sock.send(JSON.stringify(msg));
  }
}
