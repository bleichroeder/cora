import { EVENT_ICON, PRESENT_TOOL, iconFor, isShell, summarizeTool, SLACK_SEND_TOOL, TODO_PINGS, todoWhy, type JiraMsg, type OrchestratorStatus } from '@cora/shared';
import { IdeBridge } from './ideBridge';
import { Ide } from './ide';
import { MailOutbox } from './mailOutbox';
import { GitlabIssues } from './gitlabIssues';
import { Memes } from './memes';
import { SessionNames } from './sessionNames';
import { Lock } from './lock';
import { Freeze } from './freeze';
import { Journal, gitBranch, journalDir } from './journal';
import { Calendar, withWhom } from './calendar';
import { draftPrep, journalTrail, trailLines } from './calendarPrep';
import { displayName, findRefs, mergeRefs, recapText, DEFAULT_VIDEO, DEFAULT_VOICE, type JournalRefs, type JournalTag, type VideosMsg, CALENDAR_SCOPE, type CalEvent, headline, firstSentence, CALL_STATUS } from '@cora/shared';
import { LiveExplains } from './liveExplains';
import { Debriefs } from './debriefs';
import { Worktrees } from './worktrees';
import { Vault } from './vault';
import { Devices } from './devices';
import { Remote } from './remote';
import { Shares } from './shares';
import { Synced } from './synced';
import { Projects } from './projects';
import { Door } from './door';
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
import { Namer, isNamerCwd, wantsAutoName, type RunFn } from './namer';
import { Registry } from './registry';
import { Store } from './store';
import { Banners, bannerFor } from './banner';
import { Videos } from './videos';
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
  sim: { name(sessionId: string, name: string): void; cora(status: OrchestratorStatus): void; show(msg: import('@cora/shared').ServerMsg): void };
  /** Cora's Slack banners (the desktop app makes them) */
  banners: Banners;
  /** stop; terminals in the terminal host keep running unless `endTerminals` */
  close(o?: { endTerminals?: boolean }): Promise<void>;
};

/** Compose and start the whole server. */
export async function startServer(config: Config, opts: { tail?: boolean; listen?: boolean; spawn?: SpawnFn; ptyBackend?: PtyBackend; onShutdown?: (o: { endTerminals: boolean }) => void; voiceFetch?: Fetch; namerRun?: RunFn; /** Cora's note drafts' `claude -p` (a fake in tests) */ draftRun?: RunFn; /** GitLab pipelines (off in tests) */ ci?: boolean; /** the security check (off in tests and simulations) */ security?: boolean; /** Tailscale's command line (a fake in tests) */ remoteRun?: import('./remote').Run; /** Go live's public door (a fake in tests) */ door?: Pick<Door, 'start' | 'stop' | 'open' | 'port'>; /** Slack's Web API and Socket Mode (fakes in tests) */ slackApi?: (token: string) => SlackApi; slackSocket?: (url: string) => WsLike; /** environments: where kubeconfigs are, and how reachability is checked (fakes in tests) */ kubeDir?: string; envProbe?: (url: string) => Promise<boolean>; /** setting Cora up: a scratch Claude settings file, and checks to fake (tests) */ claudeSettingsFile?: string; setupChecks?: Partial<import('./setup').SetupDeps> } = {}): Promise<Running> {
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
      if ((was === 'working' || was === 'thinking') && s.state === 'idle' && !orch?.isAgent(s.id)) bot?.alert({ kind: 'finished', text: `${nameOf(s)} finished`, sessionId: s.id });
    }
    if (c.agent) hub?.publishAgent(c.agent);
  }, {
    // a live terminal in Cora, and when it started: its process exiting ends the session, so silence doesn't (ptys
    // exists by the first tick)
    hosted: (sid) => {
      try {
        const live = ptys.list().filter((t) => t.sessionId === sid && t.alive && !isShell(t));
        return live.length ? Math.max(...live.map((t) => t.startedAt)) : null;
      } catch {
        return null;
      }
    },
    // it really ended (you ended it, Ctrl+C, Claude Code said so): its shells go with it, as nothing else uses them.
    // Not when it only went quiet, and not while its Claude is still running here
    ended: (sid) => {
      try {
        if (ptys.forSession(sid)) return;
        const shells = ptys.shellsFor(sid);
        for (const t of shells) ptys.closeShell(t.terminalId);
        if (shells.length) console.log(`  closed ${shells.length} shell${shells.length === 1 ? '' : 's'} of ended session ${sid.slice(0, 8)}`);
      } catch {
        /* the terminals aren't up yet (restoring): its shells stay */
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
  // deep freeze: the terminals open, kept current, so they can be brought back after the PC restarts
  const freeze = new Freeze(config.dbPath === ':memory:' ? null : config.dataDir);
  // each session's journal (Documents\\Cora\\Journal): its milestones, its wrap-up, recaps
  const journal = new Journal({ dir: journalDir, dataDir: config.dbPath === ':memory:' ? null : config.dataDir, projects: () => tickets.knownProjects() });
  // an entry with what it points at (Journal 2): its session's ticket and issue, the explains it wrote since its last
  // entry, what its text names, and what the session said about it; its repo and branch
  const journalAdd = (sid: string, kind: 'entry' | 'wrapup' | 'recap', text: string, at?: number, more: { refs?: JournalRefs; tag?: JournalTag } = {}) => {
    const s = store.getSession(sid);
    const since = journal.lastAt(sid);
    const explains = store
      .eventsForSession(sid, { limit: 2000 })
      .filter((e) => e.kind === 'tool' && e.phase === 'start' && e.tool?.name === PRESENT_TOOL && e.ts > since)
      .map((e) => ({ id: e.toolUseId ?? e.id, title: String((e.tool!.input as { title?: unknown })?.title ?? 'an explain').slice(0, 120) }));
    const own: JournalRefs = { ...(s?.ticket ? { tickets: [s.ticket.key] } : {}), ...(s?.issue ? { issues: [`#${s.issue.iid}`] } : {}), ...(explains.length ? { explains } : {}) };
    const refs = mergeRefs(own, findRefs(text, { projects: tickets.knownProjects() }), more.refs ?? {});
    const cwd = s?.wd || s?.cwd || '';
    return journal.add({ id: sid, name: s ? displayName(s) : sid.slice(0, 8), cwd: s?.cwd ?? '', startedAt: s?.startedAt ?? Date.now(), ...(s?.ticket ? { ticket: `${s.ticket.key}${s.ticket.summary ? ` · ${s.ticket.summary}` : ''}` } : {}) }, kind, text, at, { refs, ...(more.tag ? { tag: more.tag } : {}), ...(cwd ? { branch: gitBranch(cwd) ?? undefined } : {}) });
  };
  const ptys = new PtyManager({
    audit,
    spawn: opts.spawn,
    backend: opts.ptyBackend,
    extraArgs: (sid) => hostedArgs(config, prefs.get(), sid),
    onChange: (list) => {
      hub?.publishTerminals(list);
      orch?.changed();
      freeze.update(list, !!opts.ptyBackend?.lost);
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
  const slack: Slack = new Slack({ dataDir: config.dataDir, ...(opts.slackApi ? { api: opts.slackApi } : {}), onChange: () => hub?.publishSlack(slackMsg()), log: (m) => console.log(`  ${m}`) });
  // Cora's banner on top of a message you send (the desktop app makes it)
  const banners = new Banners();
  // who wrote a message Cora sends for you: Cora herself (her agent, her own folder, or no session), or a session; its
  // banner says so
  const corasOwn = (sid: string | null) => {
    if (!sid || orch?.isAgent(sid)) return true;
    const cwd = store.getSession(sid)?.cwd?.replace(/\\/g, '/').toLowerCase() ?? '';
    return !!cwd && cwd.startsWith(config.dataDir.replace(/\\/g, '/').toLowerCase());
  };
  const bannerOf = async (d: { sessionId: string | null; text: string; to: import('@cora/shared').SlackTarget; reviewed: boolean }) => {
    const cora = corasOwn(d.sessionId);
    return bannerFor({ name: await slack.firstName().catch(() => ''), session: d.sessionId ? store.getSession(d.sessionId) : null, cora, text: d.text, privateDir: config.dataDir, outside: cora ? false : await slack.outside(d.to), reviewed: d.reviewed });
  };
  const outbox: Outbox = new Outbox({ slack, sign: () => prefs.get().slack.sign, banner: async (d) => banners.render(await bannerOf(d)), bannerPreview: (d) => bannerOf(d), bySession: (sid) => !corasOwn(sid), file: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'slack-grants.json'), draftsFile: config.dbPath === ':memory:' ? undefined : join(config.dataDir, 'slack-drafts.json'), onChange: () => (hub?.publishSlack(slackMsg()), void bot?.draftsChanged()), onUndo: (s) => orch?.feed.note(`The user took back the Slack message you just sent to ${s.to.label}; it's deleted.`) });
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
    // your reply in the thread of a session's message in the Cora DM: typed into that session, as your words
    toSession: (sid, text) => typeIntoSession(sid, `(The user, replying in Slack to your message:) ${text}`) != null,
    // the digest's line for a session: what its journal says since you left (each entry's headline), else its last reply
    didWhat: (sid, since) => {
      const entries = journal.query({ sessionId: sid, since, limit: 4 }).reverse();
      if (entries.length) return { journal: true, text: entries.map((e) => headline(e.text)).filter(Boolean).join('; ') };
      const said = store.eventsForSession(sid, { limit: 600 }).filter((e) => e.agentId === 'main' && e.kind === 'say' && e.ts >= since && (e.said || e.text)).at(-1);
      const first = said ? firstSentence(said.said || said.text || '') : '';
      return first ? { journal: false, text: first.length > 200 ? `${first.slice(0, 199)}…` : first } : null;
    },
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
      for (const e of store.tokenEvents([...set], since)) if (set.has(e.sessionId) && e.tokens) n += e.tokens.out + Math.max(0, e.tokens.in - (e.tokens.cached ?? 0));
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
    // its name, and its icon when it has none yet (one you chose, or one picked before, is kept)
    onName: (sid, autoName, icon) => {
      const s = store.getSession(sid);
      if (s) registry.updateSessionMeta(sid, { autoName, ...(icon && s.icon === undefined ? { icon } : {}) });
    },
    iconsInUse: () => store.listSessions().filter((s) => s.state !== 'ended' && s.icon).map((s) => s.icon!),
    // a session named before icons were picked: its icon, unless it got one meanwhile (or you chose None)
    onIcon: (sid, icon) => {
      if (store.getSession(sid)?.icon === undefined) registry.updateSessionMeta(sid, { icon });
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
    // a fresh recap (one written now, not an old one read from a transcript at start) goes in the session's journal
    onRecap: (sid, r) => {
      if (o.isAgent(sid) || prefs.get().journal?.on === false || r.at < Date.now() - 15 * 60_000) return;
      const text = recapText(r.text);
      if (text) journalAdd(sid, 'recap', text, r.at);
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
  // your Google calendar, through the same Google sign-in (made below, once notes and drafts are there)
  let calendar: Calendar | undefined;
  const gmail = config.dbPath !== ':memory:' ? new Gmail({
    dataDir: config.dataDir,
    // connected, reconnected (the calendar permission may be new) or disconnected: read the calendar again
    onChange: () => void calendar?.refresh(),
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
  // the IDE panel's VS Code: started when a panel asks, stopped with Cora
  const ideBridge = new IdeBridge();
  const ide = new Ide({ dataDir: config.dataDir, log: (m) => console.log(`  ide: ${m}`), bridge: { url: `http://127.0.0.1:${config.port}`, token: ideBridge.token } });
  // emails sessions asked to send, each waiting for your Send (a draft in Gmail meanwhile)
  const mailOutbox = gmail ? new MailOutbox({ drafts: gmail, file: join(config.dataDir, 'mail-outbox.json'), onChange: () => hub?.publishMailOutbox({ t: 'mailOutbox', drafts: mailOutbox!.list() }) }) : undefined;
  if (mailOutbox) hub.mailOutboxSnapshot = () => ({ t: 'mailOutbox', drafts: mailOutbox.list() });
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
    journal: (w) => journal.query({ since: w.since, until: w.until, limit: 400 }),
    dataDir: config.dataDir,
    ...(opts.draftRun ? { run: opts.draftRun } : {}),
  });
  if (config.dbPath !== ':memory:' && opts.ci) deploys.start();
  // your Google calendar: Today on Cora's board, and before
  // each call an Inbox item, Cora's brief, a standup's notes drafted
  const prepDeps = { notes, drafts, journal, projects: () => tickets.knownProjects() };
  const defuse = (t: string) => t.replace(/\[/g, '(').replace(/\]/g, ')');
  const callComing = async (e: CalEvent, minutes: number) => {
    const c = prefs.get().calendar;
    const at = new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const who = withWhom(e);
    const coraOn = !!orch?.status().enabled;
    if (c.inbox)
      inbox.add({
        source: 'cora',
        key: `cal:${e.id}`,
        title: `${e.title} · ${at}`,
        why: `a call in ${minutes} min${who ? `, with ${who}` : ''}`,
        ...(e.link || e.url ? { link: e.link ?? e.url } : {}),
        entry: { id: `${e.id}@${e.start}`, who: 'Calendar', text: [`${e.standup ? 'Standup' : 'Call'} at ${at}${who ? ` with ${who}` : ''}.`, ...(e.about ? [e.about.slice(0, 600)] : [])].join('\n'), at: Date.now() },
      });
    // a desktop notification when you asked for one, or when Cora's agent is off (nothing else would tell you)
    hub?.publishCalendarDue({ t: 'calendarDue', event: e, minutes, notify: c.notify || (c.brief !== 'off' && !coraOn) });
    if (c.brief !== 'off' && coraOn) {
      const trail = e.standup ? [] : journalTrail(e, journal, tickets.knownProjects(), 6);
      orch!.feed.note(
        [
          `[Calendar] ${e.standup ? 'Standup' : 'A call'}: "${defuse(e.title)}" at ${at} (in ${minutes} min)${who ? ` with ${defuse(who)}` : ''}${e.link ? ' · has a video link' : ''} · id ${e.id} · brief: ${c.brief === 'spoken' ? 'spoken' : 'written only (do not speak it)'}${e.standup && c.standupDraft ? ' · its Standup notes are being drafted' : ''}`,
          ...(e.about ? [`The invite says: ${defuse(e.about.replace(/\s+/g, ' ').slice(0, 800))}`] : []),
          ...(trail.length ? ['Journal entries about what the invite names:', ...trailLines(trail).map(defuse)] : []),
        ].join('\n'),
        { others: true },
      );
    }
    if (e.standup && c.standupDraft && !calendar?.get(e.id)?.prep) {
      const r = await draftPrep(e, prepDeps).catch((x) => ({ ok: false as const, error: (x as Error).message }));
      if (r.ok) calendar?.setPrep(e.id, r.id);
      else console.log(`  calendar: standup notes not drafted: ${r.error}`);
    }
  };
  // a call starting now (the heads-up came minutes ago, and minutes are easy to lose): a notification that joins it,
  // Cora's one line, the Inbox item, and your phone when you're away
  const callStarting = (e: CalEvent) => {
    const c = prefs.get().calendar;
    if (!c.startAlert) return;
    const who = withWhom(e);
    hub?.publishCalendarDue({ t: 'calendarDue', event: e, minutes: 0, notify: true });
    if (c.inbox) {
      const at = new Date(e.start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      inbox.add({ source: 'cora', key: `cal:${e.id}`, title: `${e.title} · ${at}`, why: `starting now${who ? `, with ${who}` : ''}`, ...(e.link || e.url ? { link: e.link ?? e.url } : {}), entry: { id: `start:${e.id}@${e.start}`, who: 'Calendar', text: 'Starting now.', at: Date.now() } });
    }
    if (c.brief !== 'off' && orch?.status().enabled)
      orch.feed.note(`[Calendar] Starting now: "${defuse(e.title)}"${who ? ` with ${defuse(who)}` : ''}${e.link ? ' · has a video link' : ''} · ${c.brief === 'spoken' ? 'say one short line that it is starting now (no brief)' : 'written only: one short line in your console, not spoken'}`, { others: true });
    if (bot?.away()) void bot.dm(`📞 *${e.title}* is starting now${e.link ? `: <${e.link}|join it>` : ''}`);
  };
  calendar = gmail
    ? new Calendar({
        connected: () => gmail.connected(),
        token: () => gmail.accessToken(),
        granted: () => gmail.granted(CALENDAR_SCOPE),
        lead: () => prefs.get().calendar.lead,
        file: join(config.dataDir, 'calendar.json'),
        onChange: (m) => hub?.publishCalendar(m),
        due: (e, minutes) => void callComing(e, minutes).catch((x) => console.log(`  calendar: ${(x as Error).message}`)),
        starting: (e) => callStarting(e),
      })
    : undefined;
  if (opts.listen !== false) calendar?.start();
  // your Slack status during a call (one with others or a video link): "In a call" until it ends (Slack clears it), only
  // when you haven't a status of your own
  const statusFor = new Set<string>();
  const callStatus = async () => {
    if (!calendar || !prefs.get().calendar.slackStatus || !slack.status().connected) return;
    const now = Date.now();
    const live = calendar.msg().events.find((e) => e.start <= now && e.end > now && (e.link || e.attendees.some((a) => !a.self)));
    if (!live || statusFor.has(`${live.id}@${live.start}`)) return;
    statusFor.add(`${live.id}@${live.start}`);
    const cur = await slack.myStatus().catch(() => null);
    if (!cur || (cur.text && cur.text !== CALL_STATUS)) return;
    await slack.setStatus(CALL_STATUS, ':spiral_calendar_pad:', Math.round(live.end / 1000)).catch((e) => console.log(`  calendar: Slack status not set: ${(e as Error).message}`));
  };
  if (opts.listen !== false && calendar) setInterval(() => void callStatus(), 60_000).unref();
  if (calendar) hub.calendarSnapshot = () => calendar!.msg();
  const calendarApi = calendar
    ? {
        msg: () => calendar!.msg(),
        refresh: () => calendar!.refresh(),
        markStandup: (id: string, on: boolean) => calendar!.markStandup(id, on),
        prep: async (id: string) => {
          const e = calendar!.get(id);
          if (!e) return { ok: false as const, error: "That call isn't on your calendar today or tomorrow." };
          if (e.prep && notes.list().some((n) => n.id === e.prep)) return { ok: true as const, id: e.prep };
          const r = await draftPrep(e, prepDeps);
          if (r.ok) calendar!.setPrep(id, r.id);
          return r;
        },
        // Cora's brief, kept with the call's Inbox item
        brief: (id: string, text: string) => {
          const e = calendar!.get(id);
          if (!e) return false;
          return !!inbox.add({ source: 'cora', key: `cal:${e.id}`, title: inbox.list().find((i) => i.key === `cal:${e.id}`)?.title ?? e.title, why: 'your call', entry: { id: `brief:${e.id}@${e.start}`, who: 'Cora', text: text.slice(0, 6000), at: Date.now() } });
        },
      }
    : undefined;
  // your repos' worktrees (Cora's board, its agent's tools): your repos and those sessions worked in lately
  const worktrees = new Worktrees({
    mine: () => prefs.get().orchestrator.mandate.repos,
    sessions: () => store.listSessions().filter((s) => s.state !== 'ended' && s.cwd).map((s) => ({ id: s.id, cwd: s.wd || s.cwd, live: true })),
    recentFolders: () => [...new Set(store.listSessions().filter((s) => s.cwd && s.lastTs > Date.now() - 14 * 86400_000).flatMap((s) => [s.cwd, ...(s.wd ? [s.wd] : [])]))],
    onChange: (repos) => hub.publishWorktrees({ t: 'worktrees', repos }),
    // a background fetch that can't sign in: one line in the Inbox (never a sign-in window), gone when it can again
    onSignIn: (host, repos) => {
      // it can sign in: only worth saying when there's a note saying it couldn't (from before a restart, too)
      if (!repos.length && inbox.list().find((i) => i.key === `git-sign-in:${host}`)?.state !== 'failed') return;
      const names = repos.map((r) => basename(r));
      inbox.add({
        source: /gitlab/i.test(host) ? 'gitlab' : 'cora',
        key: `git-sign-in:${host}`,
        title: `Git sign-in needed · ${host}`,
        why: "Cora's background fetch couldn't sign in",
        state: repos.length ? 'failed' : 'ok',
        replace: true,
        // fixed: nothing to read
        ...(repos.length ? {} : { read: true }),
        entry: {
          id: `${host}:${repos.length ? names.join(',') : 'ok'}:${Date.now()}`,
          text: repos.length
            ? `Git's saved sign-in for ${host} has run out, so Cora can't fetch ${names.join(', ')} to see merged branches. Sign in below (Git's sign-in window opens), or run git fetch in one of them.`
            : `Signed in again: fetching from ${host} works.`,
          at: Date.now(),
        },
      });
    },
  });
  hub.worktreesSnapshot = () => ({ t: 'worktrees', repos: worktrees.list() });
  // Cora Secrets: kept sealed in its data folder; sessions use them by name (secret_run), never see a value
  const vault = new Vault({ file: join(config.dataDir, 'secrets.json'), onChange: (list) => hub.publishSecrets({ t: 'secrets', list }) });
  hub.secretsSnapshot = () => ({ t: 'secrets', list: vault.list() });
  // your devices (the iPad) and Cora on your tailnet
  const devices = new Devices({ file: join(config.dataDir, 'devices.json') });
  // Go live: sharing your Cora with a teammate (one share at a time, kept in memory only)
  const shares = new Shares();
  // your Cora's look on every device
  // your projects: sessions grouped by hand
  const projects = new Projects(config.dbPath === ':memory:' ? null : join(config.dataDir, 'projects.json'));
  const synced = new Synced(config.dbPath === ':memory:' ? null : join(config.dataDir, 'synced.json'));
  // its public door (a port of its own, guests only), opened while a share's link is public
  const door = opts.door ?? new Door({ target: config.port, port: config.port + 11 });
  const remote = new Remote({ port: config.port, ...(opts.remoteRun ? { run: opts.remoteRun } : {}) });
  if (opts.listen !== false) worktrees.start();
  // sessions' debriefs (~/.cora/debriefs): made by their tool, played from the dashboard
  const debriefs = new Debriefs({ dir: join(config.dataDir, 'debriefs'), onChange: (sessionId) => hub.publishDebriefs({ t: 'debriefs', sessionId, list: debriefs.list(sessionId) }) });
  // debrief videos: drawn by the desktop app, voiced with Cora's ElevenLabs key, put together by ffmpeg
  const videos: Videos | undefined =
    config.dbPath === ':memory:'
      ? undefined
      : new Videos({
          dir: join(config.dataDir, 'videos'),
          toolsDir: join(config.dataDir, 'tools'),
          debrief: (sid, id) => debriefs.get(sid, id),
          settings: () => {
            const p = prefs.get();
            return { ...DEFAULT_VIDEO, ...p.debrief?.video, coraVoice: p.voice?.coraVoiceId || p.voice?.voiceId || DEFAULT_VOICE.voiceId };
          },
          voice: (text, o) => voice.synthesize(text, o),
          draw: (slides, color) => banners.slides(slides, color),
          onChange: () => hub.publishVideos(videosMsg()),
        });
  const videosMsg = (): VideosMsg => ({ t: 'videos', jobs: videos?.list() ?? [], ffmpeg: videos?.ffmpeg() ?? { state: 'missing', canDownload: false } });
  hub.videosSnapshot = videosMsg;
  const app = await buildApp({ config, store, hub, pipeline, pending, ptys, live: liveExplains, registry, prefs, voice, voiceFront, gmail, mailWatches, mailOutbox, ide, ideBridge, namer, tickets, jira, environments, deploys, notes, drafts, bot, inbox, ...(calendarApi ? { calendar: calendarApi } : {}), ...(opts.claudeSettingsFile ? { claudeSettingsFile: opts.claudeSettingsFile } : {}), ...(opts.setupChecks ? { setupChecks: opts.setupChecks } : {}), onShutdown: opts.onShutdown, ci: () => ci, slack: {
      slack,
      outbox,
      live,
      cwdOf: (sid) => store.getSession(sid)?.cwd,
      // a session's (or Cora's) message to you: through Cora's own bot, under its banner, so it pings you
      toYou: async (d) => {
        if (!bot?.connected()) return null;
        const me = slack.status();
        const banner = d.banner === false ? null : await banners.render(await bannerOf({ sessionId: d.sessionId, text: d.text, to: { kind: 'person', id: me.connected ? me.userId : '', label: 'you' }, reviewed: true })).catch(() => null);
        return bot.fromSession(d.sessionId, d.text, banner, { plain: d.banner === false });
      },
    }, security: security ?? undefined, orchestrator: o, gitlabIssues, memes, sessionNames, lock, freeze, journal: { add: (sid, kind, text, more) => journalAdd(sid, kind, text, undefined, more), read: (sid) => journal.read(sid), query: (q) => journal.query(q) }, debriefs, worktrees, vault, devices, remote, shares, door, synced, projects, banners, videos });

  let tailer: Tailer | undefined;
  if (opts.tail !== false) {
    tailer = new Tailer(config.projectsDir, (file, objs, info) => {
      try {
        pipeline.ingestTranscript(file, objs, info);
      } catch (e) {
        console.error('[cora] transcript ingest failed', file, (e as Error).message);
      }
    }, { sinceMs: config.backfillMs, onProgress: (done, total) => stage('tx', 'progress', { done, total }), reads: { get: (f) => store.readOffset(f), set: (f, n) => store.setReadOffset(f, n) } });
    stage('tx', 'start');
    await tailer.start();
  } else stage('tx', 'skip');

  const ticker = setInterval(() => registry.tick(Date.now()), 15_000);
  const phantoms = store.purgePhantomAgents();
  if (phantoms) console.log(`  removed ${phantoms} phantom agent(s) left by hidden helper stops`);
  const prune = () => {
    // their names first: a session leaving the list keeps its name in Resume
    sessionNames.remember(store.listSessions());
    store.prune(Date.now() - prefs.get().retentionDays * 86400_000, (dead) => (registry.forget(dead), pipeline.forget(dead)));
    pruneAttachments(config.dataDir);
    liveExplains.prune(Date.now() - prefs.get().retentionDays * 86400_000);
    memes.prune(Date.now() - prefs.get().retentionDays * 86400_000);
  };
  const pruner = setInterval(prune, 3600_000);
  prune();
  // sessions named before they picked icons (open, and active in the last two weeks): an icon each, once, a while
  // after Cora starts (a Haiku call apiece, one at a time; when the automatic names are on)
  const iconPass = setTimeout(() => {
    if (!prefs.get().autoName || config.dbPath === ':memory:') return;
    const recent = Date.now() - 14 * 86_400_000;
    for (const s of store.listSessions().filter((x) => x.state !== 'ended' && x.icon === undefined && x.lastTs > recent && !isNamerCwd(x.cwd, namer.dir)).slice(0, 30)) {
      const first = store.firstPrompt(s.id)?.text?.trim();
      if (first || s.alias || s.autoName) namer.iconFor(s.id, `${displayName(s)}${first ? `\n\n${first}` : ''}`);
    }
  }, 45_000);
  iconPass.unref?.();
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
    // right after Windows starts, its port can be held for a moment (its networking reserving ranges as it comes up):
    // try again for a while rather than give up on the first no
    await listenRetry(() => app.listen({ port: config.port, host: config.host }), { log: (m) => console.log(`  ${m}`) });
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
    banners,
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
      show(msg) {
        hub?.showSim(msg);
      },
    },
    async close(o) {
      freeze.flush();
      await ptys.disposeAll(o?.endTerminals ?? false);
      clearInterval(ticker);
      liveExplains.stop();
      worktrees.stop();
      ci?.stop();
      deploys.stop();
      bot?.stop();
      voiceFront?.stop();
      gmail?.stop();
      ide.stop();
      todos.stop();
      orch?.dispose();
      live.stop();
      security?.stop();
      clearInterval(pruner);
      clearTimeout(iconPass);
      await tailer?.stop();
      videos?.close();
      await app.close();
      store.close();
    },
  };
}

/**
 * Listening, again if the port is briefly not ours (EACCES / EADDRINUSE: right after Windows starts, its networking can
 * hold a port a moment), for up to a minute; any other failure at once.
 */
export async function listenRetry(listen: () => Promise<unknown>, o: { tries?: number; waitMs?: (n: number) => number; log?: (m: string) => void } = {}): Promise<void> {
  const tries = o.tries ?? 20;
  for (let n = 1; ; n++) {
    try {
      await listen();
      if (n > 1) o.log?.(`port free now (try ${n})`);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if ((code !== 'EACCES' && code !== 'EADDRINUSE') || n >= tries) throw e;
      if (n === 1) o.log?.(`port not free yet (${code}): trying again for a while`);
      await new Promise((r) => setTimeout(r, o.waitMs?.(n) ?? Math.min(5000, 500 * n)));
    }
  }
}
