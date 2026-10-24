import { EVENT_ICON, PRESENT_TOOL, iconFor, isShell, summarizeTool, SLACK_SEND_TOOL, TODO_PINGS, todoWhy, type JiraMsg, type OrchestratorStatus } from '@cora/shared';
import { GitlabIssues } from './gitlabIssues';
import { Memes } from './memes';
import { SessionNames } from './sessionNames';
import { Lock } from './lock';
import { LiveExplains } from './liveExplains';
import { Environments, envLine } from './environments';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app';
import { Audit } from './audit';
import type { Config } from './config';
import { stage } from './stages';
import { Voice, type Fetch } from './voice';
import { VoiceFront } from './voiceFront';
import { Gmail } from './gmail';
import { connectedMcp } from './mcpServers';
import { gitlabHost, setGitlabHost } from './gitlabHost';
import { resolveTicketStart, ticketFirstPrompt } from './ticketStart';
import { MailWatches } from './mailWatches';
import { runWatch, type WatchRunDeps } from './mailWatchRun';
import { Hub } from './hub';
import { PendingManager } from './pending';
import { createPipeline, type Pipeline } from './pipeline';
import { Namer, wantsAutoName, type RunFn } from './namer';
import { Registry } from './registry';
import { Store } from './store';
import { PtyManager, type SpawnFn } from './pty';
import type { PtyBackend } from './ptyhost/backend';
import { hostedArgs } from './hosted';
import { JiraFeed, KEEP_MS, type JiraFresh } from './jiraFeed';
import { Outbox, Slack, filesLine, filesOf, slackPlain, type SlackApi } from './slack';
import { MyThreads, slackKey, slackWhy, type SlackSeen } from './slackInbox';
import { SlackLive, replyLine, type SlackReply, type SlackWatch, type WsLike } from './slackLive';
import { deliverWhenReady } from './orchestrator/deliver';
import { terminalInput } from './input';
import { SecurityWatch } from './security';
import { OrchestratorManager } from './orchestrator/manager';
import { setWorkServers } from './orchestrator/files';
import { nameOf } from './orchestrator/tools';
import { pruneAttachments } from './attachments';
import { Prefs } from './prefs';
import { Tailer } from './transcript/tailer';
import { CiWatcher } from './ci';
import { Deploys } from './deploys';
import { Notes } from './notes';
import { Drafts } from './drafts';
import { CoraBot } from './slackBot';
import { ciRef, ciRepoName } from '@cora/shared';
import { Tickets } from './tickets';
import { Inbox } from './inbox';
import { fromBump, fromCora, fromGitlabTodo, fromJira, fromMail, fromPipeline, fromWatch } from './inboxFeeds';
import { GitlabTodos } from './gitlabTodos';

export type Running = {
  app: FastifyInstance;
  store: Store;
  pipeline: Pipeline;
  pending: PendingManager;
  ptys: PtyManager;
  tailer?: Tailer;
  /** Cora's Inbox */
  inbox: Inbox;
  /** live explains (the simulator keeps one, as a session would) */
  live: LiveExplains;
  /** for the simulator (--sim): name a session as you would; show a stand-in Cora (no real agent starts) */
  sim: { name(sessionId: string, name: string): void; cora(status: OrchestratorStatus): void };
  /** stop; terminals in the terminal host keep running unless `endTerminals` */
  close(o?: { endTerminals?: boolean }): Promise<void>;
};

/** Compose and start the whole server. */
export async function startServer(config: Config, opts: { tail?: boolean; listen?: boolean; spawn?: SpawnFn; ptyBackend?: PtyBackend; onShutdown?: (o: { endTerminals: boolean }) => void; voiceFetch?: Fetch; namerRun?: RunFn; /** Cora's note drafts' `claude -p` (a fake in tests) */ draftRun?: RunFn; /** GitLab pipelines (off in tests) */ ci?: boolean; /** the security check (off in tests and simulations) */ security?: boolean; /** Slack's Web API and Socket Mode (fakes in tests) */ slackApi?: (token: string) => SlackApi; slackSocket?: (url: string) => WsLike; /** environments: where kubeconfigs are, and how reachability is checked (fakes in tests) */ kubeDir?: string; envProbe?: (url: string) => Promise<boolean>; /** setting Cora up: a scratch Claude settings file, and checks to fake (tests) */ claudeSettingsFile?: string; setupChecks?: Partial<import('./setup').SetupDeps> } = {}): Promise<Running> {
  const store = new Store(config.dbPath);
  let hub: Hub | undefined;
  let ci: CiWatcher | undefined;
  let pending!: PendingManager;
  // Cora's own Slack bot (made with Slack, below): what needs you while you're away
  let bot: CoraBot | undefined;
  /** each session's last state (a session that was working and now isn't has finished) */
  const lastState = new Map<string, string>();
  // `hub?` throughout: restoring terminals from the host can end sessions (or change pending state) while
  // the PtyManager is constructed, before the hub exists; clients get those in their snapshot instead
  const registry = new Registry(store, (c) => {
    if (c.session) hub?.publishSession(c.session), ci?.sessionChanged(c.session);
    if (c.session) {
      const s = c.session;
      const was = lastState.get(s.id);
      lastState.set(s.id, s.state);
      if ((was === 'working' || was === 'thinking') && s.state === 'idle' && !orch?.isAgent(s.id)) bot?.alert({ kind: 'finished', text: `${nameOf(s)} finished` });
    }
    if (c.agent) hub?.publishAgent(c.agent);
  }, {
    // a live terminal in Cora: its process exiting ends the session, so silence doesn't (ptys exists by the first tick)
    hosted: (sid) => {
      try {
        return ptys.list().some((t) => t.sessionId === sid && t.alive && !isShell(t));
      } catch {
        return false;
      }
    },
  });
  const audit = new Audit(join(config.dataDir, 'audit.log'));
  pending = new PendingManager({
    holdMs: config.holdMs,
    hasClients: () => (hub?.clientCount() ?? 0) > 0,
    audit,
    askAnswering: config.askAnswering,
    onChange: (list) => {
      hub?.publishPending(list);
      orch?.pendingChanged(list);
      void bot?.pendingChanged(list).catch((e) => console.error('[cora] slack bot', (e as Error).message));
      // Cora on a turn someone else's Slack words started: nothing it asks to do on this machine is allowed
      if (orch?.othersTurn()) for (const p of list) if (orch.isAgent(p.sessionId)) pending.resolve(p.id, { decision: 'deny', message: "Denied: this turn started from someone else's Slack message, and only the user can make Cora act." });
      const sids = new Set([...list.map((p) => p.sessionId), ...store.listSessions().filter((s) => s.needsYou > 0).map((s) => s.id)]);
      for (const sid of sids) if (sid) registry.setPendingCount(sid, pending.countFor(sid));
    },
  });
  const prefs = new Prefs(config.dbPath === ':memory:' ? null : join(config.dataDir, 'config.json'));
  // your own work MCP servers, for Cora's agent (Settings › Cora › Work tools)
  setWorkServers(() => prefs.get().orchestrator.workServers);
  // the Cora Orchestrator (made once the terminals are): its agent is a hosted session of its own
  let orch: OrchestratorManager | undefined;
  /** a simulation's stand-in for Cora's agent (see Running.sim) */
  let simCora: OrchestratorStatus | null = null;
  const ptys = new PtyManager({
    audit,
    spawn: opts.spawn,
    backend: opts.ptyBackend,
    extraArgs: (sid) => hostedArgs(config, prefs.get(), sid),
    onChange: (list) => {
      hub?.publishTerminals(list);
      orch?.changed();
    },
    onExit: (t) => {
      registry.sessionExited(t.sessionId, Date.now());
      orch?.exited(t);
    },
  });
  hub = new Hub(store, () => pending.list(), 50, () => ptys.list());
  // Cora's Inbox: everything it tells you, kept 14 days
  const inbox = new Inbox({ file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'inbox.json'), onChange: (items, gone) => hub?.publishInbox({ t: 'inbox', items, ...(gone.length ? { gone } : {}) }) });
  hub.inboxSnapshot = () => ({ t: 'inbox', full: true, items: inbox.list() });
  // Slack as you: sessions' messages wait in the outbox for your OK
  const slackStatus = () => {
    const st = slack.status();
    return st.connected ? { ...st, ...live.state() } : st;
  };
  const slackMsg = () => ({ t: 'slack' as const, status: slackStatus(), drafts: outbox.list(), sent: outbox.sent(), grants: outbox.grants(), ...(bot ? { bot: bot.status() } : {}) });
  const slack: Slack = new Slack({ dataDir: config.dataDir, ...(opts.slackApi ? { api: opts.slackApi } : {}), onChange: () => hub?.publishSlack(slackMsg()) });
  const outbox: Outbox = new Outbox({ slack, sign: () => prefs.get().slack.sign, file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'slack-grants.json'), draftsFile: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'slack-drafts.json'), onChange: () => (hub?.publishSlack(slackMsg()), void bot?.draftsChanged()), onUndo: (s) => orch?.feed.note(`The user took back the Slack message you just sent to ${s.to.label}; it's deleted.`) });
  hub.slackSnapshot = slackMsg;
  // live events: threads sessions watch. A reply goes to the session (typed in when it's hosted here and free;
  // to Cora through what it hears), and to you (its row, a notification)
  /** Type text into a session hosted here once it's free (null: it isn't running here). */
  const typeIntoSession = (sessionId: string, text: string) => {
    const t = ptys.list().find((x) => x.sessionId === sessionId && x.alive && x.mode !== 'shell');
    if (!t) return null;
    const type = (s: string) => {
      const input = terminalInput(s);
      if ('error' in input) return;
      ptys.write(t.terminalId, input.data);
      setTimeout(() => ptys.write(t.terminalId, '\r'), input.paste ? 150 : 80);
    };
    return deliverWhenReady(
      { screen: () => ptys.screenLines(t.terminalId), alive: () => ptys.list().some((x) => x.terminalId === t.terminalId && x.alive), type, key: (d) => void ptys.write(t.terminalId, d) },
      text,
      30 * 60_000,
    );
  };
  const tellReply = (w: SlackWatch, r: SlackReply) => {
    const text = replyLine(w, r, outbox.allowed(w.channel));
    if (orch?.isAgent(w.sessionId)) orch.feed.note(text, { others: true });
    else void typeIntoSession(w.sessionId, text)?.then((d) => !d.sent && console.log(`  slack: couldn't give ${w.sessionId.slice(0, 8)} its reply: ${d.why}`));
    hub?.publishSlack({ ...slackMsg(), notice: { sessionId: w.sessionId, text: `${r.who} replied in ${w.where}`, detail: r.text.slice(0, 200) } });
    const dm = w.channel.startsWith('D');
    const s = store.getSession(w.sessionId);
    const waiter = orch?.isAgent(w.sessionId) ? 'Cora' : s ? nameOf(s) : 'a session';
    void addSlack({ channel: w.channel, ts: r.ts, ...(r.link.includes('thread_ts=') ? { threadTs: w.threadTs } : {}), user: r.user, text: r.text, dm, group: false }, `a thread ${waiter} was waiting on${w.about ? ` (${w.about})` : ''}`, 'watched', w.sessionId).catch(() => {});
  };
  // Slack in Cora's Inbox: DMs, mentions, and in channels you follow only what touches you (slackInbox.ts)
  const myThreads = new MyThreads(config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'slack-threads.json'));
  const COMMON = new Set(['code', 'src', 'app', 'apps', 'web', 'api', 'server', 'client', 'main', 'test', 'tests', 'docs', 'repo', 'repos', 'work', 'temp', 'scratch', 'desktop', 'projects', 'github', 'gitlab', 'home', 'users']);
  /** Your work, as words to look for: live sessions' tickets, the tickets Jira tells you about, the sessions' repos. */
  const workTerms = (): string[] => {
    const out = new Set<string>();
    for (const s of store.listSessions()) {
      if (s.state === 'ended' || orch?.isAgent(s.id)) continue;
      if (s.ticket?.key) out.add(s.ticket.key);
      const repo = ci?.repoOf(s.id)?.project;
      for (const n of [repo ? ciRepoName(repo) : '', s.cwd ? basename(s.cwd.replace(/[\\/]+$/, '')) : '']) if (n.length >= 4 && !COMMON.has(n.toLowerCase())) out.add(n);
    }
    for (const e of jira.recent(KEEP_MS, ['assigned', 'watched'])) out.add(e.key);
    return [...out];
  };
  /** One Slack message into the Inbox: who, where, their words as text, a link to it. */
  const addSlack = async (m: SlackSeen, why: string, short: string, sessionId?: string, files = '') => {
    const me = slack.status();
    if (!me.connected) return;
    const dir = await slack.directory().catch(() => null);
    const nameOf = (id: string) => dir?.people.find((p) => p.id === id)?.real || dir?.people.find((p) => p.id === id)?.name || id;
    const who = nameOf(m.user);
    const where = m.dm ? `${who} (DM)` : await slack.where(m.channel).catch(() => m.channel);
    const thread = m.threadTs && m.threadTs !== m.ts ? m.threadTs : undefined;
    const link = `${me.url.replace(/\/$/, '')}/archives/${m.channel}/p${m.ts.replace('.', '')}${thread ? `?thread_ts=${thread}&cid=${m.channel}` : ''}`;
    const text = `${slackPlain(m.text, nameOf).replace(/\s+/g, ' ').trim()}${files}`.slice(0, 1500);
    // an app's card with no words (a calendar reminder and the like): nothing to read
    if (!text.trim()) return;
    inbox.add({ source: 'slack', key: slackKey(m), title: m.dm || m.group ? where : `${where} · ${short}`, why, link, ...(sessionId ? { sessionId } : {}), entry: { id: m.ts, who, text, at: Math.round(Number(m.ts) * 1000) } });
  };
  const slackToInbox = (ev: any) => {
    const me = slack.status();
    if (!me.connected || !ev?.channel || !ev?.ts) return;
    myThreads.hear();
    const m: SlackSeen = { channel: String(ev.channel), ts: String(ev.ts), ...(ev.thread_ts ? { threadTs: String(ev.thread_ts) } : {}), user: String(ev.user ?? ''), text: String(ev.text ?? ''), dm: ev.channel_type === 'im' || String(ev.channel).startsWith('D'), group: ev.channel_type === 'mpim' };
    // your own: the thread is one you're in now, and if it's in the Inbox you've answered it (in Slack itself)
    if (m.user === me.userId) {
      inbox.read({ keys: [slackKey(m)] });
      return myThreads.posted(m.channel, m.threadTs ?? m.ts);
    }
    // apps and bots (their cards and reminders) aren't people telling you something
    if (ev.bot_id || ev.subtype === 'bot_message') return;
    const bot = slack.botInfo();
    const w = slackWhy(m, { me: me.userId, ...(bot ? { bot: { userId: bot.userId } } : {}), follow: prefs.get().slack.follow, mine: (c, t) => myThreads.has(c, t), work: workTerms() });
    if (w) void addSlack(m, w.why, w.short, undefined, filesLine(filesOf(ev))).catch((e) => console.log(`  slack inbox: ${(e as Error).message}`));
  };
  /** Back after a while (a restart, a dropped connection): the DMs and mentions it missed (3 days at most). */
  const slackCatchUp = async () => {
    const me = slack.status();
    if (!me.connected || me.search === false) return;
    const since = Math.max(myThreads.heard() ?? Date.now() - 86_400_000, Date.now() - 3 * 86_400_000);
    myThreads.hear();
    if (Date.now() - since < 60_000) return;
    const after = new Date(since - 86_400_000).toISOString().slice(0, 10);
    for (const q of ['to:me', `<@${me.userId}>`]) {
      for (const h of await slack.search(`${q} after:${after}`, 30, 'timestamp').catch(() => [])) {
        if (Number(h.ts) * 1000 < since || h.user === me.userId || !h.channel) continue;
        const dm = h.channel.startsWith('D');
        const group = h.where.startsWith('group DM');
        const threadTs = /[?&]thread_ts=([\d.]+)/.exec(h.link)?.[1];
        await addSlack({ channel: h.channel, ts: h.ts, ...(threadTs ? { threadTs } : {}), user: h.user, text: h.text, dm, group }, dm ? 'a DM to you' : group ? "a group DM you're in" : 'you were mentioned', dm ? 'DM' : group ? 'group DM' : 'mentioned you');
      }
    }
  };
  const live: SlackLive = new SlackLive({ slack, dataDir: config.dataDir, onReply: tellReply, onMessage: slackToInbox, onLive: () => void slackCatchUp().catch((e) => console.log(`  slack inbox catch-up: ${(e as Error).message}`)), onChange: () => hub?.publishSlack(slackMsg()), ...(opts.slackApi ? { api: opts.slackApi } : {}), ...(opts.slackSocket ? { socket: opts.slackSocket } : {}), log: (m) => console.log(`  ${m}`) });
  bot = new CoraBot({
    slack,
    settings: () => prefs.get().slackBot,
    pending: { list: () => pending.list(), resolve: (id, d) => pending.resolve(id, d), extend: (id, ms) => pending.extend(id, ms) },
    // what waits for your OK, answered from your phone while you're away: Cora's cards (Yes / No, or an option you
    // picked), and the Slack messages sessions drafted (Send / Discard)
    approve: (id, ok, text) => (orch ? orch.approvals.decide(id, { ok, ...(text !== undefined ? { text } : {}) }) : Promise.resolve({ ok: false, error: 'Cora is off' })),
    cards: () => (orch?.status().enabled ? orch.approvals.list() : []),
    drafts: () => outbox.list(),
    draft: (id, send) => outbox.decide(id, { action: send ? 'send' : 'discard' }),
    // handing Cora control (Away in its console) counts as away
    handedOff: () => !!orch?.inControl(),
    nameOf: (sid) => {
      const s = store.getSession(sid);
      return s ? nameOf(s) : sid.slice(0, 8);
    },
    say: (text) => (orch?.status().enabled ? orch.sayFromUser(text) : null),
    onChange: () => hub?.publishSlack(slackMsg()),
    log: (m) => console.log(`  ${m}`),
  });
  live.setBot(bot);
  // the Meme panel's memes and GIFs (a session's own)
  // sessions' names, kept past history (Resume names them as the nav did)
  const sessionNames = new SessionNames(config.dbPath === ':memory:' ? null : config.dataDir);
  // lockdown: your PIN (hashed), and locked or not, kept over a restart
  const lock = new Lock(config.dbPath === ':memory:' ? null : config.dataDir);
  const memes = new Memes({ dataDir: config.dbPath === ':memory:' ? null : config.dataDir, onPost: (sessionId) => hub.publishMeme(sessionId) });
  // GitLab issues (to start sessions from them): read with glab
  const gitlabIssues = new GitlabIssues();
  const o = (orch = new OrchestratorManager({
    dataDir: config.dataDir,
    rehome: (from, to) => live.rehome(from, to),
    slackConnected: () => slack.status().connected,
    jiraWatching: () => prefs.get().jira.watch.on,
    mailConnected: () => !!gmail?.connected(),
    // the user's own MCP servers (names only): Cora's agent reads from the ones it knows, and names only what's there
    ...(config.dbPath === ':memory:' ? {} : { mcpServers: () => connectedMcp() }),
    // ticket sessions start with the user's /jira (when they have one) or Cora's own prompt, from what Jira said
    ticketPrompt: async (e) => {
      const use = await resolveTicketStart(prefs.get().jira.ticket, dirname(config.projectsDir));
      return ticketFirstPrompt(use, { key: e.key, summary: e.summary, url: e.link, ...jira.ticket(e.key) }, true);
    },
    jiraAssigned: (key) => jira.recent(KEEP_MS, ['assigned']).find((e) => e.key === key),
    issueFolder: (project, folders) => gitlabIssues.folderFor(project, folders),
    gitlabIssue: async (project, iid) => {
      const r = await gitlabIssues.one(project, iid);
      return r.ok ? r.issue : null;
    },
    told: (t) => void inbox.add(fromCora(t)),
    prompts: (sid) => store.promptCount(sid),
    projectsDir: config.projectsDir,
    port: config.port,
    hookToken: config.hookToken,
    viewToken: config.viewToken,
    agentToken: config.agentToken,
    ptys,
    settings: () => prefs.get(),
    // a simulation's Cora (Running.sim.cora) stands in for the real one, which stays off
    publish: (status) => {
      hub?.publishOrchestrator({ t: 'orchestrator', status: simCora ?? status });
      // away may have changed (control), and a card may have come or gone: your phone hears
      bot?.refresh();
      void bot?.cardsChanged();
    },
    publishUi: (cmd) => hub?.publishUi({ t: 'ui', cmd }),
    log: (m) => console.log(`  ${m}`),
    pending: { list: () => pending.list(), resolve: (id, d, by) => pending.resolve(id, d, by) },
    cwdOf: (sid) => (sid ? store.getSession(sid)?.cwd : undefined),
    branchOf: (sid) => {
      const repo = ci?.snapshot().links?.find((l) => l.sessionId === sid)?.repo;
      return repo ? { current: repo.branch, defaultBranch: repo.defaultBranch } : undefined;
    },
    nameOf: (sid) => {
      const s = sid ? store.getSession(sid) : null;
      return s ? nameOf(s) : sid.slice(0, 8);
    },
    usage: (sids, since) => {
      const set = new Set(sids);
      let n = 0;
      for (const e of store.usageEvents(since)) if (set.has(e.sessionId) && e.tokens) n += e.tokens.out + Math.max(0, e.tokens.in - (e.tokens.cached ?? 0));
      return n;
    },
    sessions: () => store.listSessions(),
    eventsSince: (sid, since) => store.eventsForSession(sid, { limit: 600 }).filter((e) => e.ts >= since),
    agentWorking: () => {
      const id = orch?.sessionId();
      const s = id ? store.getSession(id) : null;
      return s?.state === 'working' || s?.state === 'thinking';
    },
  }));
  hub.orchestratorSnapshot = () => ({ t: 'orchestrator', status: simCora ?? o.status() });
  // is what Cora runs on still getting security fixes? (not for simulations and tests)
  const security = opts.security ? new SecurityWatch({ repo: config.repoDir, dataDir: config.dataDir, publish: (report) => hub?.publishSecurity({ t: 'security', report }), log: (m) => console.log(`  ${m}`) }) : null;
  hub.securitySnapshot = () => ({ t: 'security', report: security?.report ?? null });
  // optional auto-names: set once (never over an alias), published like any session change
  const namer = new Namer({
    dataDir: config.dataDir,
    run: opts.namerRun,
    onName: (sid, autoName) => {
      if (store.getSession(sid)) registry.updateSessionMeta(sid, { autoName });
    },
  });
  // which Jira ticket each session is about (from how it was started, or its first prompt)
  const tickets = new Tickets({
    path: config.dbPath === ':memory:' ? null : join(config.dataDir, 'jira-projects.json'),
    store,
    set: (sid, ticket) => registry.updateSessionMeta(sid, { ticket }),
    setIssue: (sid, issue) => registry.updateSessionMeta(sid, { issue }),
    gitlabHost,
  });
  const pipeline = createPipeline(store, registry, hub, pending, {
    ignoreDir: namer.dir,
    onEvent: (e) => {
      ci?.event(e);
      try {
        o.event(e);
      } catch (err) {
        console.error('[cora] orchestrator feed', (err as Error).message);
      }
      if (e.kind === 'tool' && e.phase === 'start' && e.tool?.name === SLACK_SEND_TOOL) outbox.noteCall(e.sessionId, e.tool.input);
      // Cora's reply to what you wrote it in Slack goes back there
      if (o.isAgent(e.sessionId)) bot?.agentEvent(e);
    },
    // the orchestrator's own session isn't about a ticket and keeps its name
    onCommand: (sid, c) => void (!o.isAgent(sid) && tickets.consider(sid, c.text, c.ts, c.id)),
    onPrompt: (e) => {
      if (o.isAgent(e.sessionId)) return;
      tickets.consider(e.sessionId, e.text, e.ts, e.id);
      const first = store.firstPrompt(e.sessionId);
      const earlier = !!first && first.id !== e.id && first.ts <= e.ts;
      if (wantsAutoName(e, store.getSession(e.sessionId), prefs.get(), earlier)) namer.auto(e.sessionId, e.text ?? '');
    },
  });
  const voice = new Voice(config.dbPath === ':memory:' ? null : join(config.dataDir, 'elevenlabs.json'), opts.voiceFetch);
  // the voice front (a quick line when you speak): Haiku started ahead when voice is on, so the first line is quick too
  const voiceFront = opts.listen !== false && config.dbPath !== ':memory:' ? new VoiceFront({ dataDir: config.dataDir, log: (m) => console.log(`  ${m}`) }) : undefined;
  if (voiceFront && prefs.get().voice.enabled && prefs.get().voice.front !== false) setTimeout(() => voiceFront.warm(), 5000);
  // Gmail (the user's own Google app): important new mail goes to Cora (held, like Jira) and to your phone while away
  // email watches: emails the user waits for, and what to do when each comes (mailWatchRun.ts)
  const mailWatches = new MailWatches({ file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'mail-watches.json') });
  const watchDeps: WatchRunDeps = {
    typeInto: (sid, text) => typeIntoSession(sid, text),
    launch: (o) => (orch ? orch.launchSession(o) : Promise.reject(new Error("Cora's agent is off, so it can't start a session"))),
    ask: (a, run) => {
      if (!orch?.status().enabled) return null;
      void orch.approvals.request(a, (text) => run(text), { do: 'mail', ...(a.sessionId ? { sessionId: a.sessionId } : {}), ...(a.cwd ? { cwd: a.cwd } : {}) });
      return orch.approvals.list().at(-1)?.id ?? null;
    },
    // (every line about a watched email is about someone else's words)
    tell: (line) => void orch?.feed.note(line, { others: true }),
    away: () => !!bot?.away(),
    phone: (text, ask) => (ask ? void bot?.askOnPhone(ask.id, text) : bot?.alert({ kind: 'mail', key: `watch:${Date.now()}`, text })),
    bind: (id, sid) => mailWatches.bind(id, sid),
    sessionName: (sid) => {
      const s = store.getSession(sid);
      return s ? nameOf(s) : 'its session';
    },
    log: (m) => console.log(`  ${m}`),
  };
  const gmail = config.dbPath !== ':memory:' ? new Gmail({
    dataDir: config.dataDir,
    watches: mailWatches,
    onWatch: (w, m, trust) =>
      void runWatch(watchDeps, w, m, trust)
        .then((did) => inbox.add(fromWatch(w, m, did, w.sessionId)))
        .catch((e) => console.log(`  gmail watch: ${(e as Error).message}`)),
    log: (m) => console.log(`  ${m}`),
    onMail: (hits) => {
      orch?.mailNotes(hits);
      for (const h of hits) {
        inbox.add(fromMail(h));
        bot?.alert({ kind: 'mail', key: `mail:${h.id}`, text: `Email${h.why && h.why !== 'important' ? ` (${h.why})` : ''} from ${h.from.replace(/\s*<[^>]+>/, '')}: ${h.subject}` });
      }
    },
  }) : undefined;
  if (opts.listen !== false) gmail?.start();
  // watching Jira: what the desktop app finds is told to the dashboard (and, held, to Cora)
  const jiraMsg = (f?: JiraFresh): JiraMsg => ({ t: 'jira', status: jira.status(), ...(f ? { events: f.events, ...(f.summary ? { summary: f.summary } : {}) } : {}) });
  const jira: JiraFeed = new JiraFeed({
    file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'jira-watch.json'),
    settings: () => prefs.get().jira.watch,
    onFresh: (f) => {
      for (const e of f.events) inbox.add(fromJira(e));
      for (const e of f.events) if (e.kind === 'assigned') bot?.alert({ kind: 'ticket', key: `jira:${e.id}`, text: `${e.who} assigned you ${e.key}: ${e.summary} ${e.link}` });
      // assigned to you, and Cora offers or starts it: its card and voice are Cora's
      const g = { ...f, events: f.events.map((e) => (orch?.jiraStarts.handoff(e) ? { ...e, handoff: true } : e)) };
      hub?.publishJira(jiraMsg(g));
      orch?.jiraNotes(g);
    },
    onChange: () => hub?.publishJira(jiraMsg()),
    offered: () => orch?.jiraStarts.offered() ?? [],
    onStill: (keys) => orch?.jiraStarts.still(keys),
  });
  hub.jiraSnapshot = () => ({ ...jiraMsg(), recent: jira.recent(KEEP_MS).slice(0, 50) });
  // the Inbox's first start: what the Jira watch already kept (14 days) comes in, as read
  if (inbox.fresh) for (const e of jira.recent(KEEP_MS).reverse()) inbox.add({ ...fromJira(e), read: true });
  // your GitLab to-dos (assigned, review requested, mentions…), read-only: the Inbox, Cora, and your phone while away.
  // Only the real app reads them (never a simulation)
  const todos = new GitlabTodos({
    file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'gitlab-todos.json'),
    on: () => prefs.get().gitlab.todos !== false,
    onFirst: (list) => list.forEach((t) => inbox.add({ ...fromGitlabTodo(t), read: true })),
    onFresh: (list) => {
      for (const t of list) inbox.add(fromGitlabTodo(t));
      for (const t of list) if (TODO_PINGS.has(t.action)) bot?.alert({ kind: 'ticket', key: `gl:${t.id}`, text: `${t.who}: ${todoWhy(t.action)} · ${ciRepoName(t.project)} ${t.ref} ${t.title} ${t.link}` });
      orch?.gitlabNotes(list);
      orch?.issueTodos(list);
    },
    log: (m) => console.log(`  gitlab to-dos: ${m}`),
  });
  if (opts.listen !== false && config.dbPath !== ':memory:') todos.start();
  // which environments (VPNs) are reachable: checked every 30 s; Cora hears changes, held for its next turn
  // where GitLab is
  const kubeDir = opts.kubeDir ?? join(homedir(), '.kube');
  setGitlabHost(prefs.get().gitlab.host);
  // live explains: a session's page and data files (its new page is a version of the explain; its data goes to the open page)
  const liveExplains = new LiveExplains({
    root: join(config.dataDir, 'explains'),
    onVersion: (v) => {
      const id = `live-${v.slug}-${Date.now().toString(36)}`;
      const input = { title: v.title, format: 'html', content: v.html, live: v.slug };
      const s = summarizeTool(PRESENT_TOOL, input);
      const tool = { name: PRESENT_TOOL, input, summary: s.summary, resource: s.resource };
      const base = { sessionId: v.sessionId, agentId: 'main', ts: Date.now(), icon: iconFor(PRESENT_TOOL, input), source: 'transcript' as const };
      pipeline.ingestEvents([
        { ...base, id: `tool:${id}:start`, kind: 'tool', phase: 'start', toolUseId: id, tool },
        { ...base, id: `tool:${id}:end`, kind: 'tool', phase: 'end', toolUseId: id, durationMs: 0, tool: { ...tool, resultSummary: 'shown in Cora' } },
      ]);
    },
    onData: (d) => hub?.publishExplainData({ t: 'explain-data', ...d }),
    log: (m) => console.log(`  ${m}`),
  });
  // watched in real runs and simulations (not tests, which don't listen)
  if (opts.listen !== false) liveExplains.watch();
  const environments = new Environments({
    kubeDir,
    ...(opts.envProbe ? { probe: opts.envProbe } : {}),
    file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'environments.json'),
    onChange: (states) => orch?.feed.hold(`[Network] ${envLine(states)}`),
  });
  // 0.1.0 named one workplace's clusters itself (a "workplace preset", gone now): the labels it showed stay, as the
  // user's own, once (remove this after 0.2)
  if (prefs.hadPreset === 'acme') {
    environments.keepLabels((e) => (/orion/i.test(e.name) && !/staging/i.test(e.name) ? 'dev' : /acme-prod/i.test(e.name) ? 'prod' : null));
    prefs.update({});
  }
  if (config.dbPath !== ':memory:') environments.start();
  // what each environment runs, the sessions' tickets' journeys, and the dev bump (read-only otherwise; real runs only)
  const deploys = new Deploys({
    envs: () => environments.list(),
    sessions: () => store.listSessions().filter((s) => s.state !== 'ended' && !o.isAgent(s.id)).map((s) => ({ id: s.id, ticket: s.ticket?.key ?? null, repo: ci?.repoOf(s.id) ?? null })),
    publish: (m) => hub?.publishDeploys(m),
    hasClients: () => (hub?.clientCount() ?? 0) > 0,
    onBump: (b, line) => {
      inbox.add(fromBump(b, line));
      orch?.feed.hold(line);
      bot?.alert({ kind: b.state === 'failed' ? 'failure' : 'finished', key: `bump:${b.id}`, text: line.replace(/^\[Deploys\] /, '') });
    },
    file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'deploys.json'),
    log: (m) => console.log(`  ${m}`),
  });
  hub.deploysSnapshot = () => deploys.snapshot();
  // your notes (Scratch and named notes); every dashboard hears the list when it changes
  const notes = new Notes({ dir: join(config.dataDir, 'notes'), onChange: () => hub?.publishNotes({ t: 'notes', list: notes.list() }) });
  hub.notesSnapshot = () => ({ t: 'notes', list: notes.list() });
  // notes Cora drafts from templates: what it saw you do over a window, written up by a quick claude -p
  const drafts = new Drafts({
    sessions: () => store.listSessions(),
    events: (sid) => store.eventsForSession(sid, { limit: 4000 }),
    isAgent: (sid) => o.isAgent(sid),
    jira: (ms) => jira.recent(ms),
    deploys: () => deploys.state().events,
    jots: () => notes.read('scratch').jots ?? [],
    notesChanged: (since) => notes.changedSince(since),
    dataDir: config.dataDir,
    ...(opts.draftRun ? { run: opts.draftRun } : {}),
  });
  if (config.dbPath !== ':memory:' && opts.ci) deploys.start();
  const app = await buildApp({ config, store, hub, pipeline, pending, ptys, live: liveExplains, registry, prefs, voice, voiceFront, gmail, mailWatches, namer, tickets, jira, environments, deploys, notes, drafts, bot, inbox, ...(opts.claudeSettingsFile ? { claudeSettingsFile: opts.claudeSettingsFile } : {}), ...(opts.setupChecks ? { setupChecks: opts.setupChecks } : {}), onShutdown: opts.onShutdown, ci: () => ci, slack: { slack, outbox, live, cwdOf: (sid) => store.getSession(sid)?.cwd }, security: security ?? undefined, orchestrator: o, gitlabIssues, memes, sessionNames, lock });

  let tailer: Tailer | undefined;
  if (opts.tail !== false) {
    tailer = new Tailer(config.projectsDir, (file, objs, info) => {
      try {
        pipeline.ingestTranscript(file, objs, info);
      } catch (e) {
        console.error('[cora] transcript ingest failed', file, (e as Error).message);
      }
    }, { sinceMs: config.backfillMs, onProgress: (done, total) => stage('tx', 'progress', { done, total }) });
    stage('tx', 'start');
    await tailer.start();
  } else stage('tx', 'skip');

  const ticker = setInterval(() => registry.tick(Date.now()), 15_000);
  const phantoms = store.purgePhantomAgents();
  if (phantoms) console.log(`  removed ${phantoms} phantom agent(s) left by hidden helper stops`);
  const prune = () => {
    // their names first: a session leaving the list keeps its name in Resume
    sessionNames.remember(store.listSessions());
    store.prune(Date.now() - prefs.get().retentionDays * 86400_000);
    pruneAttachments(config.dataDir);
    liveExplains.prune(Date.now() - prefs.get().retentionDays * 86400_000);
    memes.prune(Date.now() - prefs.get().retentionDays * 86400_000);
  };
  const pruner = setInterval(prune, 3600_000);
  prune();
  try {
    if (store.compact()) console.log('  compacted brain.db');
  } catch (e) {
    console.log(`  couldn't compact brain.db: ${(e as Error).message}`);
  }
  registry.tick(Date.now());
  // read, and the stale ones ended: how many sessions, how many live (Cora's own isn't one)
  if (tailer) {
    const all = store.listSessions().filter((s) => !o.isAgent(s.id));
    stage('tx', 'done', { sessions: all.length, live: all.filter((s) => s.state !== 'ended').length });
  }
  // pipelines for the sessions still live once the transcripts are read and stale ones have ended
  if (opts.ci) {
    const h = hub;
    ci = new CiWatcher({ publish: (m) => {
      h.publishCi(m);
      o.ciChanged(m);
      // a pipeline a session follows failed just now: worth a ping while you're away
      for (const p of m.pipelines ?? []) {
        if (p.finishedAt && Date.now() - p.finishedAt < 15 * 60_000) {
          const sid = ci?.snapshot().links?.find((l) => l.pipelines.some((x) => x.key === p.key))?.sessionId;
          const s = sid ? store.getSession(sid) : null;
          const a = fromPipeline(p, s ? { id: s.id, name: nameOf(s) } : undefined);
          if (a) inbox.add(a);
        }
        if (p.status === 'failed' && p.finishedAt && Date.now() - p.finishedAt < 15 * 60_000) bot?.alert({ kind: 'failure', key: `ci:${p.key}`, text: `Pipeline failed: ${ciRepoName(p.project)} ${ciRef(p.ref)} (#${p.id}) ${p.url}` });
      }
    }, hasClients: () => h.clientCount() > 0, sessions: () => store.listSessions().filter((s) => !o.isAgent(s.id)), recent: (sid, since) => store.eventsForSession(sid, { limit: 400 }).filter((e) => e.ts >= since), gitWork: (sid) => store.gitWork(sid), log: (m) => console.log(`  ${m}`) });
    h.ciSnapshot = () => ci!.snapshot();
    ci.start();
  }
  if (security) {
    security.start();
  }

  if (opts.listen !== false) {
    await app.listen({ port: config.port, host: config.host });
    stage('listen', 'done');
  }
  // the orchestrator, when it's on (its session may already be running in the terminal host)
  const before = o.status();
  o.apply();
  const after = o.status();
  if (after.enabled) stage('cora', 'done', { how: after.error ? 'error' : before.running ? 'kept' : 'started' });
  // live Slack events once Cora is set up (replies that came while it was down are caught up on at once)
  live.start();

  return {
    app,
    store,
    pipeline,
    pending,
    ptys,
    tailer,
    inbox,
    live: liveExplains,
    sim: {
      name(sessionId, name) {
        if (store.getSession(sessionId)) hub?.publishSession(store.upsertSession({ id: sessionId, alias: name }));
      },
      cora(status) {
        simCora = status;
        hub?.publishOrchestrator({ t: 'orchestrator', status });
      },
    },
    async close(o) {
      await ptys.disposeAll(o?.endTerminals ?? false);
      clearInterval(ticker);
      liveExplains.stop();
      ci?.stop();
      deploys.stop();
      bot?.stop();
      voiceFront?.stop();
      gmail?.stop();
      todos.stop();
      orch?.dispose();
      live.stop();
      security?.stop();
      clearInterval(pruner);
      await tailer?.stop();
      await app.close();
      store.close();
    },
  };
}
