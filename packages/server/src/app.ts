import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { envLine, signature, type EnvLabel, type Environments } from './environments';
import type { Deploys } from './deploys';
import { NoteError, type Notes } from './notes';
import type { Drafts } from './drafts';
import type { CoraBot } from './slackBot';
import { basename, dirname } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { INBOX_SOURCES, MAX_DRAFT_ASKS, ticketInPrompt, type TicketFacts, type PendingDecision, type SessionInfo, type SessionTicket, JIRA_EVENT_KINDS, type JiraEvent, type JiraEventKind, type JiraWatchStatus, HELLO_PREFIX } from '@cora/shared';
import { checkOptions, checkPrompt, launchArgs } from './launch';
import { checkSummary, checkTicket, type Tickets } from './tickets';
import { summarizeUsage } from './usage';
import { hookToken, sameSecret, type Config } from './config';
import type { Hub } from './hub';
import type { PendingManager } from './pending';
import type { Pipeline } from './pipeline';
import type { Store } from './store';
import { findSessionProcess, jumpToTerminal, type JumpResult } from './terminal';
import { readToolDetail, transcriptFor } from './toolDetail';
import { findClaude, type PtyManager, type TerminalMode } from './pty';
import { resolveTicketStart } from './ticketStart';
import { setGitlabHost } from './gitlabHost';
import type { Registry } from './registry';
import { listDirs, listHistory } from './history';
import { registerMcp, type McpSlack } from './mcp';
import { SlackError, slackManifest } from './slack';
import { KEEP_MS, type JiraBatch, type JiraFeed } from './jiraFeed';
import type { SecurityWatch } from './security';
import type { OrchestratorManager } from './orchestrator/manager';
import type { OrchToolDeps } from './orchestrator/tools';
import { deliverWhenReady } from './orchestrator/deliver';
import { OTHERS_REFUSAL, nameOf } from './orchestrator/tools';
import { repoOf } from './orchestrator/mandate';
import { Prefs } from './prefs';
import { Readable } from 'node:stream';
import { Voice, spokenText } from './voice';
import type { VoiceFront } from './voiceFront';
import { GmailError, type Gmail } from './gmail';
import type { MailWatches } from './mailWatches';
import { imageType } from './slackFiles';
import { isNamerCwd, isNamerSlug, namerDir, type Namer, type RunFn } from './namer';
import { HistoryIndex, askForSession } from './historySearch';
import { ChromeData } from './chromeData';
import { gitChanges, gitDiff, netChange, normPath, snapshots } from './changes';
import { tailOutput, taskOutputFile } from './tasks';
import { terminalInput } from './input';
import { choiceOpen } from './screen';
import { listCommands } from './commands';
import { MAX_ATTACHMENT, saveAttachment } from './attachments';
import type { CiWatcher } from './ci';
import type { Inbox } from './inbox';
import { checkSetup, glabAuthed, refreshPath, runInWindow, setupCommand, whichCmd, type SetupDeps, onePasswordStatus } from './setup';
import { computeHooksBlock, diffText, isOurs, mergeHooks, readSettings, settingsPath, writeSettings, hooksAimed } from './settings';
import { connectedMcp } from './mcpServers';
import { homedir } from 'node:os';
import { join as joinPath } from 'node:path';

/** How long the agent's start_session waits for the new session to take its prompt (its tool call times out at a minute). */
const LAUNCH_ANSWER_MS = 40_000;

export type AppDeps = {
  /** live explains: a session's page and data files */
  live?: import('./liveExplains').LiveExplains;
  /** your Chrome / Edge bookmarks and history (tests: a fake) */
  chrome?: ChromeData;
  /** runs `claude -p` (tests: a fake) for Resume's Ask Claude */
  claudeRun?: RunFn;
  config: Config;
  store: Store;
  hub: Hub;
  pipeline: Pipeline;
  pending: PendingManager;
  ptys?: PtyManager;
  registry?: Registry;
  jump?: typeof jumpToTerminal;
  findProcess?: typeof findSessionProcess;
  prefs?: Prefs;
  /** the optional voice feature's ElevenLabs side */
  voice?: Voice;
  /** the voice front: a quick spoken line while the real answer comes (warm Haiku) */
  voiceFront?: VoiceFront;
  /** Gmail, through the user's own Google app */
  gmail?: Gmail;
  /** emails the user waits for, and what to do when each comes */
  mailWatches?: MailWatches;
  /** session names from a quick Haiku call (auto-names, "Suggest a name") */
  namer?: Namer;
  /** GitLab pipelines (failed jobs' logs) */
  ci?: () => CiWatcher | undefined;
  /** which Jira ticket a session is about (the site's project keys come from the UI) */
  tickets?: Tickets;
  /** graceful shutdown (closes hosted terminals); exposed to the desktop app via POST /api/shutdown */
  onShutdown?: (o: { endTerminals: boolean }) => void;
  /** Slack as you, and the drafts sessions want sent */
  slack?: McpSlack;
  /** watching Jira (its record keeper) */
  jira?: JiraFeed;
  /** which environments (VPNs) are reachable */
  environments?: Environments;
  /** what each environment runs; the dev bump */
  deploys?: Deploys;
  /** your notes */
  notes?: Notes;
  /** Cora's own Slack bot */
  bot?: CoraBot;
  /** notes Cora drafts from templates */
  drafts?: Drafts;
  /** is what Cora runs on still getting security fixes */
  security?: SecurityWatch;
  /** the Cora Orchestrator */
  orchestrator?: OrchestratorManager;
  /** Cora's Inbox */
  inbox?: Inbox;
  /** setting Cora up: Claude Code's settings file (tests: a scratch one), and checks to fake */
  claudeSettingsFile?: string;
  setupChecks?: Partial<SetupDeps>;
};

const COOKIE = 'ab_session';
/** a view-only sign-in: it reads (the dashboard, its live stream), never acts (audit S2) */
const VIEW_COOKIE = 'ab_view';
const BLOCKING = new Set(['PermissionRequest', 'Elicitation']);

/** A second interrupt to the same terminal this soon is let go (twice could quit Claude Code). */
const STOP_GAP_MS = 1500;

export async function buildApp(d: AppDeps): Promise<FastifyInstance> {
  const { config, store, hub, pipeline, pending } = d;
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024, logger: false });
  await app.register(cookie);
  await app.register(websocket);

  const allowedOrigins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`, ...(config.devOrigin ? [config.devOrigin] : [])]);
  const authed = (req: FastifyRequest) => sameSecret(req.cookies[COOKIE], config.uiToken);
  const viewer = (req: FastifyRequest) => !!config.viewToken && sameSecret(req.cookies[VIEW_COOKIE], config.viewToken);
  // reading: you, or a view-only sign-in; acting (requireAction, /pty) is yours alone
  const requireUi = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authed(req) && !viewer(req)) return reply.code(401).send({ error: 'open the link printed by `cora start`' });
  };
  const requireAction = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'bad origin' });
  };

  // --- hooks from Claude Code -------------------------------------------------
  /**
   * A prompt about a ticket (`/jira ACME-5206`, its link, or a session already about it): where it comes up in Slack,
   * once per session and ticket, as context for that prompt. Never holds the prompt up more than two seconds.
   */
  const toldSlack = new Set<string>();
  // what each session last heard about the network: it hears again (one line) when that changes
  const toldEnv = new Map<string, string>();
  function envForPrompt(body: any): string | null {
    const sid = typeof body?.session_id === 'string' ? body.session_id : '';
    const env = d.environments;
    if (!env || !sid) return null;
    const states = env.list().filter((s) => s.on);
    if (!states.length || states.every((s) => s.reachable == null)) return null;
    const sig = signature(states);
    if (toldEnv.get(sid) === sig) return null;
    const first = !toldEnv.has(sid);
    toldEnv.set(sid, sig);
    const up = states.filter((s) => s.reachable && s.kubeconfig);
    const kube = up.length ? ` For kubectl: ${up.map((s) => `${s.label}: KUBECONFIG=${s.kubeconfig}`).join('; ')}.` : '';
    return `From Cora: ${first ? 'network' : 'the network changed'}: ${envLine(states)}${kube} (Cora checks this every 30 s; the environment tool has details. Only the user changes the VPN.)`;
  }

  async function slackForPrompt(body: any): Promise<string | null> {
    const s = d.slack;
    const sid = typeof body?.session_id === 'string' ? body.session_id : '';
    if (!s || !sid || d.orchestrator?.isAgent(sid)) return null;
    const st = s.slack.status();
    if (!st.connected || st.search === false) return null;
    const key = ticketInPrompt(String(body?.prompt ?? ''))?.key ?? store.getSession(sid)?.ticket?.key;
    if (!key || toldSlack.has(`${sid}:${key}`)) return null;
    toldSlack.add(`${sid}:${key}`);
    const talk = await Promise.race([s.slack.ticketTalk(key), new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
    if (!talk?.length) return null;
    return `From Cora: ${key} comes up in Slack: ${talk
      .slice(0, 6)
      .map((g) => `${g.where} (${g.count === 1 ? 'once' : `${g.count} messages`}, latest: ${g.link})`)
      .join('; ')}. Read the ones that matter for this work with slack_read (pass the link); slack_search finds more.`;
  }
  /** A prompt about a ticket: what the user's notes say about it, once per session and ticket. */
  const toldNotes = new Set<string>();
  function notesForPrompt(body: any): string | null {
    const sid = typeof body?.session_id === 'string' ? body.session_id : '';
    if (!d.notes || !sid || d.orchestrator?.isAgent(sid)) return null;
    const key = ticketInPrompt(String(body?.prompt ?? ''))?.key ?? store.getSession(sid)?.ticket?.key;
    if (!key || toldNotes.has(`${sid}:${key}`)) return null;
    toldNotes.add(`${sid}:${key}`);
    const about = d.notes.aboutTicket(key);
    return about ? `From Cora: the user's notes mention ${key}:\n${about}\n(notes_read gives a whole note; notes_add adds to one when they ask.)` : null;
  }
  // Cora's agent's gate (its own settings): on a turn someone else's words started, it may not fetch or browse (audit S8)
  app.post('/agent-gate', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    const sid = (req.body as { session_id?: unknown } | null)?.session_id;
    const o = d.orchestrator;
    if (o && typeof sid === 'string' && o.isAgent(sid) && o.othersTurn()) return reply.send({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: OTHERS_REFUSAL } });
    return reply.send({});
  });

  app.post<{ Params: { event: string } }>('/hook/:event', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    const event = req.params.event;
    const body = (req.body ?? {}) as any;
    if (BLOCKING.has(event)) {
      // Cora's own `claude -p` (naming) has no tools and isn't a session: no decision from here
      if (isNamerCwd(body.cwd, namerDir(config.dataDir))) return reply.code(200).send({});
      const out = await pending.request(event === 'Elicitation' ? 'elicitation' : 'permission', body);
      return reply.code(200).send(out);
    }
    try {
      pipeline.ingestHook(event, body);
    } catch (e) {
      req.log.warn(e);
    }
    if (event === 'UserPromptSubmit') {
      const parts = [envForPrompt(body), notesForPrompt(body), await slackForPrompt(body).catch(() => null)].filter(Boolean);
      if (parts.length) return reply.code(200).send({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: parts.join('\n\n') } });
    }
    return reply.code(204).send();
  });

  // Local control: the desktop app stops the server it started. Hook token, not the UI cookie.
  app.post('/api/shutdown', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    if (!d.onShutdown) return reply.code(501).send({ error: 'not supported' });
    // hosted terminals keep running in the terminal host (a restart picks them back up) unless asked to end them
    const endTerminals = Boolean((req.body as { endTerminals?: boolean } | undefined)?.endTerminals);
    setTimeout(() => d.onShutdown!({ endTerminals }), 50);
    return { ok: true, endTerminals };
  });
  // Local control: how many hosted terminals are live (the desktop app asks before quitting). `live` counts shells
  // too (they end, or keep running, with the sessions); `shells` says how many of them are shells.
  // watching Jira: the desktop app (where your Jira login is) asks what to watch, and reports what it found
  app.get('/api/local/jira-watch', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    return d.jira ? d.jira.watchInfo() : { on: false, kinds: {}, since: null };
  });
  app.post<{ Body: unknown }>('/api/local/jira-events', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    if (!d.jira) return reply.code(501).send({ error: 'not supported' });
    const b = jiraBatch(req.body);
    if (!b) return reply.code(400).send({ error: 'bad batch' });
    return { ok: true, fresh: d.jira.ingest(b).events.length };
  });

  // the desktop app: how long you've been idle and whether the screen is locked (Cora's bot: are you away?)
  app.post<{ Body: { idle?: unknown; locked?: unknown } }>('/api/local/presence', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    const idle = Number(req.body?.idle);
    if (!Number.isFinite(idle)) return reply.code(400).send({ error: 'idle seconds, please' });
    d.bot?.report({ idle, locked: req.body?.locked === true });
    return { away: d.bot?.away() ?? false };
  });
  app.get('/api/local/terminals', async (req, reply) => {
    if (!sameSecret(hookToken(req), config.hookToken)) return reply.code(401).send({ error: 'bad token' });
    return { live: ptys?.liveCount() ?? 0, shells: ptys?.liveShells() ?? 0, persistent: ptys?.persistent ?? false };
  });

  // --- MCP (the `present` tool for hosted sessions) ---------------------------------
  const prefs = d.prefs ?? new Prefs(null);
  // the orchestrator's tools act through the same code as the dashboard's routes (helpers further down)
  const orchDeps = (): OrchToolDeps => {
    const o = d.orchestrator!;
    return {
      approvals: o.approvals,
      jiraInbox: (ms, kinds) => (d.jira && prefs.get().jira.watch.on ? d.jira.recent(ms, kinds) : null),
      jiraStart: (p) => o.jiraStarts.start(p),
      othersTurn: () => o.othersTurn(),
      coraDm: (t) => (d.bot ? d.bot.dm(t) : Promise.resolve({ ok: false, error: "Cora's own Slack bot isn't set up (Settings → Slack)." })),
      isAgent: (sid) => o.isAgent(sid),
      ui: (cmd) => o.ui(cmd),
      remember: (note) => o.remember(note),
      sessions: () => store.listSessions(),
      session: (id) => (id ? (store.getSession(id) ?? undefined) : undefined),
      events: (id, limit) => store.eventsForSession(id, { limit }),
      explains: (sid) => store.listExplains(sid, 50),
      pending: () => pending.list(),
      terminals: () => ptys?.list() ?? [],
      pipelines: () => d.ci?.()?.snapshot() ?? null,
      security: () => d.security?.report ?? null,
      launch: async ({ cwd, prompt, model, trust, plan }) => {
        const options = { ...(model ? { model } : {}), ...(plan ? { permissionMode: 'plan' as const } : {}) };
        const terminal = launchClaude({ mode: 'new', cwd, options: Object.keys(options).length ? options : undefined });
        const job = deliverWhenReady(
          {
            screen: () => ptys?.screenLines(terminal.terminalId) ?? null,
            alive: () => !!ptys?.list().some((t) => t.terminalId === terminal.terminalId && t.alive),
            type: (text) => typeInto(terminal.terminalId, text),
            key: (data) => void ptys?.write(terminal.terminalId, data),
          },
          prompt,
          3 * 60_000,
          500,
          { trust },
        );
        // the agent's tool call can't wait that long (Claude Code gives up on it after a minute): it hears later
        const first = await Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), LAUNCH_ANSWER_MS))]);
        if (first) return { terminal, ...first };
        void job.then((late) => {
          const s = store.getSession(terminal.sessionId);
          const name = s ? nameOf(s) : terminal.sessionId.slice(0, 8);
          o.feed.note(late.sent ? `"${name}" (${terminal.sessionId}) is ready and got its first prompt.` : `"${name}" (${terminal.sessionId}) never got its first prompt: ${late.why}.`);
        });
        return { terminal, sent: false, pending: true };
      },
      resume: (id) => launchClaude({ mode: 'resume', cwd: store.getSession(id)?.cwd ?? '', sessionId: id }),
      input: (terminalId, text) => {
        const lines = ptys?.screenLines(terminalId);
        if (lines && choiceOpen(lines)) throw new Error("it's waiting on a choice in its terminal: the user has to answer that first");
        typeInto(terminalId, text);
      },
      end: (id) => endSession(id),
      rename: (id, name) => {
        const next = store.upsertSession({ id, alias: name });
        hub.publishSession(next);
      },
      goal: () => o.goals.active(),
      goalUpdate: (p) => o.goalUpdate(p),
      addWorker: (sid) => o.goals.addWorker(sid),
      escalate: (q, opts) => o.escalate(q, opts),
      judge: (sid, req) => o.judge(sid, req),
      inRepos: (cwd) => !!repoOf(cwd, prefs.get().orchestrator.mandate.repos),
      decidePending: (id, allow, rule, message) => pending.resolve(id, allow ? { decision: 'allow' } : { decision: 'deny', ...(message ? { message } : {}) }, { via: 'orchestrator', rule }).ok,
      answerPending: (id, answers, rule) => pending.resolve(id, { decision: 'allow', answers }, { via: 'orchestrator', rule }),
      talk: o.talk,
      askCopy: (p) => o.copies.ask(p),
    };
  };
  // Cora's cards from before a restart: their actions, done again from what was kept, checking what's still there
  // (docs/audit-2026-10-20.md U3)
  d.orchestrator?.approvals.setRedo(async (r, text, chosen) => {
    const o = d.orchestrator!;
    const deps = orchDeps();
    const hosted = (sid: string) => (ptys?.list() ?? []).find((t) => t.sessionId === sid && t.alive);
    const start = async (cwd: string, model?: string) => {
      if (!existsSync(cwd)) throw new Error(`${cwd} isn't there any more`);
      const res = await deps.launch({ cwd, prompt: text ?? '', trust: true, ...(model ? { model } : {}) });
      return `Started a session in ${cwd} (id ${res.terminal.sessionId}).`;
    };
    const send = (sid: string) => {
      const t = hosted(sid);
      if (!t) throw new Error("that session isn't running in Cora any more: say no to clear the card");
      deps.input(t.terminalId, text ?? '');
      return `Sent to ${sid}.`;
    };
    switch (r.do) {
      case 'start':
        return start(chosen ?? r.cwd, r.model);
      case 'send':
        return send(r.sessionId);
      case 'end':
        return `Ending ${r.sessionId}: ${await deps.end(r.sessionId)}.`;
      case 'ask': {
        const a = (text ?? '').trim() || '(no answer)';
        o.feed.note(`The user answered your question "${r.question.slice(0, 120)}" (from before a restart): ${a}`);
        return `The user answered: ${a}`;
      }
      case 'jira':
        return o.jiraStarts.startFromCard(r.event, chosen ?? r.cwd);
      case 'mail':
        if (r.sessionId) return send(r.sessionId);
        if (r.cwd) return start(r.cwd);
        throw new Error('nothing to do');
    }
  });
  registerMcp(app, config.hookToken, () => prefs.get(), d.slack, d.orchestrator ? { isAgent: (sid) => d.orchestrator!.isAgent(sid), deps: orchDeps, userTurn: () => d.orchestrator!.userTurn() } : undefined, d.environments, d.deploys, d.notes ? { notes: d.notes, nameOf: (sid) => { const s = store.getSession(sid); return s ? nameOf(s) : 'a session'; } } : undefined, d.gmail ? { gmail: d.gmail, ...(d.mailWatches ? { watches: d.mailWatches } : {}), nameOf: (sid) => { const s = store.getSession(sid); return s ? nameOf(s) : 'a session'; } } : undefined, config.agentToken, (cmd) => hub.publishUi({ t: 'ui', cmd }), d.live);
  // starting work from Jira launches the way the agent's start_session does
  d.orchestrator?.setLauncher((x) => orchDeps().launch(x));

  // --- environments: which are reachable; the user's labels -----------------------------------------------------
  app.get('/api/environments', { preHandler: requireUi }, async (_req, reply) => (d.environments ? { environments: await d.environments.current(60_000) } : reply.code(501).send({ error: 'not supported' })));
  app.post<{ Params: { id: string }; Body: { label?: unknown; name?: unknown; on?: unknown } }>('/api/environments/:id', { preHandler: requireAction }, async (req, reply) => {
    if (!d.environments) return reply.code(501).send({ error: 'not supported' });
    const b = req.body ?? {};
    const p = { ...(typeof b.label === 'string' ? { label: b.label as EnvLabel } : {}), ...(typeof b.name === 'string' ? { name: b.name } : {}), ...(typeof b.on === 'boolean' ? { on: b.on } : {}) };
    return d.environments.update(req.params.id, p) ? { environments: d.environments.list() } : reply.code(400).send({ error: 'bad change' });
  });
  app.post('/api/environments/check', { preHandler: requireAction }, async (_req, reply) => {
    if (!d.environments) return reply.code(501).send({ error: 'not supported' });
    d.environments.refresh();
    await d.environments.check();
    return { environments: d.environments.list() };
  });

  // --- deploys: what each environment runs; the dev bump (dev only, the server checks); cards dismissed ------------
  app.get('/api/deploys', { preHandler: requireUi }, async (_req, reply) => (d.deploys ? d.deploys.state() : reply.code(501).send({ error: 'not supported' })));
  app.post<{ Body: { env?: unknown; tag?: unknown; key?: unknown; targets?: unknown } }>('/api/deploys/bump', { preHandler: requireAction }, async (req, reply) => {
    if (!d.deploys) return reply.code(501).send({ error: 'not supported' });
    const b = req.body ?? {};
    const targets = Array.isArray(b.targets)
      ? b.targets.filter((t: any) => t && ['deployment', 'statefulset', 'cronjob'].includes(t.kind) && [t.namespace, t.name, t.container].every((x) => typeof x === 'string' && /^[\w.-]{1,253}$/.test(x))).map((t: any) => ({ kind: t.kind, namespace: t.namespace, name: t.name, container: t.container }))
      : [];
    if (typeof b.env !== 'string' || typeof b.tag !== 'string' || !targets.length || targets.length !== (b.targets as unknown[]).length) return reply.code(400).send({ error: 'bad bump' });
    const r = await d.deploys.bump({ env: b.env, tag: b.tag, targets, ...(typeof b.key === 'string' && /^[A-Z][A-Z0-9]+-\d+$/.test(b.key) ? { key: b.key } : {}) });
    return r.ok ? { bump: r.bump } : reply.code(409).send({ error: r.error });
  });
  app.post<{ Body: { id?: unknown } }>('/api/deploys/dismiss', { preHandler: requireAction }, async (req, reply) => {
    if (!d.deploys) return reply.code(501).send({ error: 'not supported' });
    return typeof req.body?.id === 'string' && d.deploys.dismiss(req.body.id) ? { ok: true } : reply.code(400).send({ error: 'bad id' });
  });

  // --- notes: Scratch and named notes (you edit; sessions only add, through their tools) --------------------------
  const noteFail = (reply: FastifyReply, e: unknown) => reply.code(e instanceof NoteError ? (/no such/.test(e.message) ? 404 : 400) : 500).send({ error: (e as Error).message });
  const str = (x: unknown, max: number) => (typeof x === 'string' && x.length <= max ? x : undefined);
  app.get('/api/notes', { preHandler: requireUi }, async (_req, reply) => (d.notes ? { list: d.notes.list() } : reply.code(501).send({ error: 'not supported' })));
  // templates: a note from one; a new one; what a draft would read; the draft itself
  const windowOf = (tpl: string, w: unknown, note?: string): { since: number; until: number } => {
    const now = Date.now();
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    if (w === 'today') return { since: day.getTime(), until: now };
    if (w === 'week') return { since: now - 7 * 86400_000, until: now };
    if (w === '24h') return { since: now - 86400_000, until: now };
    return { since: d.notes!.lastFrom(tpl, note) ?? now - 86400_000, until: now };
  };
  app.post<{ Body: { template?: unknown; keepHints?: unknown } }>('/api/notes/from-template', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return { id: d.notes.fromTemplate(String(req.body?.template ?? ''), { keepHints: req.body?.keepHints === true }) };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.post('/api/notes/templates/restore', { preHandler: requireAction }, async (_req, reply) => (d.notes ? { added: d.notes.restoreTemplates() } : reply.code(501).send({ error: 'not supported' })));
  app.post<{ Body: { name?: unknown } }>('/api/notes/templates', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    return { id: d.notes.createTemplate(str(req.body?.name, 80) ?? 'Template') };
  });
  app.post<{ Body: { template?: unknown; window?: unknown; note?: unknown } }>('/api/notes/draft/preview', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes || !d.drafts) return reply.code(501).send({ error: 'not supported' });
    try {
      const tpl = d.notes.template(String(req.body?.template ?? ''));
      const w = windowOf(tpl.id, req.body?.window || tpl.window, str(req.body?.note, 64));
      const f = await d.drafts.facts(w);
      return { ...w, window: req.body?.window || tpl.window, repos: f.repos, counts: f.counts, last: d.notes.lastFrom(tpl.id, str(req.body?.note, 64)) };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.post<{ Body: { note?: unknown; template?: unknown; since?: unknown; until?: unknown; repos?: unknown; asks?: unknown } }>('/api/notes/draft', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes || !d.drafts) return reply.code(501).send({ error: 'not supported' });
    const b = req.body ?? {};
    if (typeof b.since !== 'number' || typeof b.until !== 'number' || b.until < b.since) return reply.code(400).send({ error: 'bad window' });
    const repos = Array.isArray(b.repos) ? b.repos.filter((r): r is string => typeof r === 'string').slice(0, 50) : [];
    // what you added for this draft ("leave out project X")
    const asks = typeof b.asks === 'string' && b.asks.trim() ? b.asks.trim().slice(0, MAX_DRAFT_ASKS) : undefined;
    try {
      const tpl = d.notes.template(String(b.template ?? ''));
      const id = str(b.note, 64) ?? d.notes.fromTemplate(tpl.id, { keepHints: true });
      const f = await d.drafts.facts({ since: b.since, until: b.until }, repos);
      if (!f.counts.sessions && !f.counts.jots && !f.counts.jira && !f.counts.deploys) return reply.code(409).send({ error: 'Cora saw nothing in that window', id });
      const r = await d.drafts.write(tpl.body, f, undefined, asks);
      if (!r.ok) return reply.code(502).send({ error: r.error, id });
      const read = [`${f.counts.sessions} session${f.counts.sessions === 1 ? '' : 's'}`, f.counts.tickets.join(' '), f.counts.mrs.join(' '), f.counts.deploys ? `${f.counts.deploys} deploys` : '', f.counts.jira ? `${f.counts.jira} Jira events` : '', f.counts.jots ? `${f.counts.jots} jots` : ''].filter(Boolean).join(' · ');
      const v = d.notes.setDraft(id, r.text, { template: tpl.id, since: b.since, until: b.until, repos: repos.length ? repos : f.repos.map((x) => x.repo), read, at: Date.now(), ...(asks ? { asks } : {}) });
      return { id, ...v };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.get<{ Querystring: { q?: string } }>('/api/notes/search', { preHandler: requireUi }, async (req, reply) => (d.notes ? { hits: d.notes.search(String(req.query.q ?? '').slice(0, 200)) } : reply.code(501).send({ error: 'not supported' })));
  app.post<{ Body: { jot?: any } }>('/api/notes/jots/restore', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return (d.notes.restoreJot(req.body?.jot ?? {}), { ok: true });
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.post<{ Body: { text?: unknown; src?: unknown; to?: { id?: unknown; title?: unknown } } }>('/api/notes/jots', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    const text = str(req.body?.text, 20_000);
    if (!text?.trim()) return reply.code(400).send({ error: 'nothing to jot' });
    try {
      const to = req.body?.to;
      const id = str(to?.id, 64);
      const title = str(to?.title, 120);
      if (id) return (d.notes.append(id, text), { id });
      if (title?.trim()) return { id: d.notes.create(title, `${text.trim()}\n`) };
      return { jot: d.notes.jot(text, undefined, str(req.body?.src, 120)) };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.delete<{ Params: { jot: string } }>('/api/notes/jots/:jot', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return (d.notes.deleteJot(req.params.jot), { ok: true });
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.post<{ Params: { jot: string }; Body: { id?: unknown; title?: unknown } }>('/api/notes/jots/:jot/move', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return { id: d.notes.moveJot(req.params.jot, { id: str(req.body?.id, 64), title: str(req.body?.title, 120) }) };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.get<{ Params: { id: string } }>('/api/notes/:id', { preHandler: requireUi }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return d.notes.read(req.params.id, { seen: true });
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.post<{ Body: { title?: unknown; text?: unknown } }>('/api/notes', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return { id: d.notes.create(str(req.body?.title, 120) ?? 'Untitled', str(req.body?.text, 1_000_000) ?? '') };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.put<{ Params: { id: string }; Body: { text?: unknown; base?: unknown } }>('/api/notes/:id', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    const text = str(req.body?.text, 1_000_000);
    if (text == null || typeof req.body?.base !== 'number') return reply.code(400).send({ error: 'bad note' });
    try {
      return d.notes.save(req.params.id, text, req.body.base);
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.post<{ Params: { id: string }; Body: { title?: unknown; pinned?: unknown } }>('/api/notes/:id/meta', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      const title = str(req.body?.title, 120);
      if (title != null) d.notes.rename(req.params.id, title);
      if (typeof req.body?.pinned === 'boolean') d.notes.pin(req.params.id, req.body.pinned);
      return { ok: true };
    } catch (e) {
      return noteFail(reply, e);
    }
  });
  app.delete<{ Params: { id: string } }>('/api/notes/:id', { preHandler: requireAction }, async (req, reply) => {
    if (!d.notes) return reply.code(501).send({ error: 'not supported' });
    try {
      return (d.notes.remove(req.params.id), { ok: true });
    } catch (e) {
      return noteFail(reply, e);
    }
  });

  // --- the security check: its last report; check again now ---------------------------------------------------
  // off in the installed app: its fixes come with Cora's updates
  app.get('/api/security', { preHandler: requireUi }, async () => ({ report: d.security?.report ?? null, off: !d.security }));
  app.post('/api/security/check', { preHandler: requireAction }, async (_req, reply) => {
    if (!d.security) return reply.code(501).send({ error: 'the security check is off' });
    return { report: await d.security.check() };
  });

  // --- Slack: connect (your app's user token), look people up, answer drafts ------------------------------------
  const sl = d.slack;
  const slackErr = (e: unknown) => (e instanceof SlackError ? e.code : (e as Error).message);
  // the connection, with live events' state when it's connected
  const slackStatus = () => {
    const st = sl!.slack.status();
    return st.connected && sl!.live ? { ...st, ...sl!.live.state() } : st;
  };
  app.get<{ Querystring: { check?: string } }>('/api/slack', { preHandler: requireUi }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    // whether it can search: once, or when you ask to check again (after adding the permission)
    const st = sl.slack.status();
    if (st.connected && (st.search == null || req.query.check)) await sl.slack.checkSearch();
    return { status: slackStatus(), drafts: sl.outbox.list(), sent: sl.outbox.sent(), grants: sl.outbox.grants(), manifest: slackManifest(), ...(d.bot ? { bot: d.bot.status() } : {}) };
  });
  app.post<{ Body: { token?: string; clientId?: string; clientSecret?: string } }>('/api/slack/token', { preHandler: requireAction }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    try {
      const b = req.body ?? {};
      await sl.slack.connect(String(b.token ?? ''), b.clientId || b.clientSecret ? { clientId: String(b.clientId ?? ''), clientSecret: String(b.clientSecret ?? '') } : undefined);
      sl.live?.start();
      return { status: slackStatus() };
    } catch (e) {
      return reply.code(400).send({ error: slackErr(e) });
    }
  });
  // stop watching a thread (Settings › Slack): the session isn't told of replies there any more
  app.post<{ Body: { id?: unknown } }>('/api/slack/unwatch', { preHandler: requireAction }, async (req, reply) => {
    if (!sl?.live) return reply.code(501).send({ error: 'not supported' });
    if (typeof req.body?.id !== 'string' || !sl.live.unwatch(req.body.id)) return reply.code(404).send({ error: 'not watched' });
    return { status: slackStatus() };
  });
  app.delete('/api/slack/token', { preHandler: requireAction }, async (_req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    sl.slack.disconnect();
    sl.live?.stop();
    return { status: slackStatus() };
  });
  // a file on a draft or a just-sent message: its preview (images only, and only files a message carries)
  app.get<{ Params: { kind: string; id: string; i: string } }>('/api/slack/files/:kind/:id/:i', { preHandler: requireUi }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    const kind = req.params.kind === 'sent' ? 'sent' : req.params.kind === 'draft' ? 'draft' : null;
    const f = kind ? sl.outbox.attachment(kind, req.params.id, Number(req.params.i)) : undefined;
    const type = f ? imageType(f.name) : null;
    if (!f || !type || !existsSync(f.path)) return reply.code(404).send({ error: 'not found' });
    return reply.type(type).header('cache-control', 'no-store').send(readFileSync(f.path));
  });
  // stop Cora carrying on a conversation by itself (one, or all); Cora hears it
  app.post<{ Body: { channel?: string } }>('/api/slack/grants/stop', { preHandler: requireAction }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    const gone = sl.outbox.stop(req.body?.channel || undefined);
    if (gone.length) d.orchestrator?.feed.note(`The user stopped you carrying on the Slack conversation with ${gone.map((g) => g.label).join(', ')} by yourself: messages there go to them to confirm again.`);
    return { grants: sl.outbox.grants() };
  });
  // live events: the app-level token (xapp-…) for Socket Mode; empty takes it away
  app.post<{ Body: { token?: string; clientId?: string; clientSecret?: string } }>('/api/slack/app-token', { preHandler: requireAction }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    try {
      const b = req.body ?? {};
      await sl.slack.setAppToken(String(b.token ?? '').trim() || null, b.clientId || b.clientSecret ? { clientId: String(b.clientId ?? ''), clientSecret: String(b.clientSecret ?? '') } : undefined);
    } catch (e) {
      return reply.code(400).send({ error: slackErr(e) });
    }
    sl.live?.start();
    return { status: slackStatus() };
  });
  // Cora's own bot: its token (xoxb-), and a test message
  app.post<{ Body: { token?: string } }>('/api/slack/bot-token', { preHandler: requireAction }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    try {
      const r = await sl.slack.setBotToken(String(req.body?.token ?? '').trim() || null);
      return { ok: true, name: r.name, bot: d.bot?.status() };
    } catch (e) {
      return reply.code(400).send({ error: slackErr(e) });
    }
  });
  app.post('/api/slack/bot/test', { preHandler: requireAction }, async (_req, reply) => {
    if (!d.bot) return reply.code(501).send({ error: 'not supported' });
    const r = await d.bot.test();
    return r.ok ? r : reply.code(400).send(r);
  });
  // where a ticket comes up in Slack (for its card)
  app.get<{ Params: { key: string } }>('/api/slack/ticket/:key', { preHandler: requireUi }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    const st = sl.slack.status();
    if (!st.connected || st.search === false || !/^[A-Z][A-Z0-9]{0,15}-\d{1,7}$/i.test(req.params.key)) return { talk: [] };
    try {
      return { talk: await sl.slack.ticketTalk(req.params.key) };
    } catch (e) {
      return reply.code(400).send({ error: slackErr(e), talk: [] });
    }
  });
  app.get<{ Querystring: { q?: string } }>('/api/slack/find', { preHandler: requireUi }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    try {
      return { results: await sl.slack.find(String(req.query.q ?? ''), 8) };
    } catch (e) {
      return reply.code(400).send({ error: slackErr(e) });
    }
  });
  app.post<{ Params: { id: string }; Body: { action?: string; text?: string; to?: unknown } }>('/api/slack/drafts/:id', { preHandler: requireAction }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    const b = req.body ?? {};
    if (!['send', 'discard', 'opened'].includes(String(b.action))) return reply.code(400).send({ error: 'action must be send|discard|opened' });
    const to = b.to && typeof b.to === 'object' && typeof (b.to as any).id === 'string' && typeof (b.to as any).label === 'string' ? (b.to as any) : undefined;
    const r = await sl.outbox.decide(req.params.id, { action: b.action as 'send' | 'discard' | 'opened', ...(typeof b.text === 'string' ? { text: b.text } : {}), ...(to ? { to } : {}) });
    return r.ok ? r : reply.code(r.error?.startsWith('not found') ? 404 : 400).send(r);
  });

  // a message Cora sent straight away (you asked for it): Undo deletes it, for a few seconds
  app.post<{ Params: { id: string } }>('/api/slack/sent/:id/undo', { preHandler: requireAction }, async (req, reply) => {
    if (!sl) return reply.code(501).send({ error: 'not supported' });
    const r = await sl.outbox.undo(req.params.id);
    return r.ok ? r : reply.code(409).send(r);
  });

  // --- settings & session meta ---------------------------------------------------------
  app.get('/api/settings', { preHandler: requireUi }, async () => prefs.get());
  app.get<{ Querystring: { days?: string } }>('/api/usage', { preHandler: requireUi }, async (req) => {
    const days = Math.min(Math.max(Number(req.query.days ?? 7) || 7, 1), 31);
    const now = Date.now();
    return summarizeUsage(store.usageEvents(now - days * 86_400_000), days, now);
  });
  app.post<{ Body: any }>('/api/settings', { preHandler: requireAction }, async (req, reply) => {
    try {
      const before = prefs.get().orchestrator;
      const next = prefs.update(req.body ?? {});
      setGitlabHost(next.gitlab.host);
      d.jira?.settingsChanged();
      // the orchestrator follows its settings: on, off, or a new model, voice or instructions (it starts again with them)
      const o = next.orchestrator;
      if (d.orchestrator) {
        if (o.enabled && before.enabled && (o.model !== before.model || o.speak !== before.speak || (o.instructions ?? '') !== (before.instructions ?? ''))) d.orchestrator.restart();
        else d.orchestrator.apply();
      }
      return next;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // --- the Cora Orchestrator: its state, what you say to it, your answers to its approvals, its memory ------------
  const orch = d.orchestrator;
  const noOrch = (reply: FastifyReply) => reply.code(501).send({ error: 'the orchestrator is not available' });
  app.get('/api/orchestrator', { preHandler: requireUi }, async (_req, reply) => (orch ? orch.status() : noOrch(reply)));
  app.post<{ Body: { text?: string } }>('/api/orchestrator/say', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const r = orch.sayFromUser(String(req.body?.text ?? ''));
    return r.ok ? r : reply.code(409).send(r);
  });
  // autopilot: a goal for it; stop it; control of your sessions' prompts; stand down
  app.post<{ Body: { text?: string; budget?: number } }>('/api/orchestrator/goals', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const b = req.body?.budget;
    if (b !== undefined && (!Number.isFinite(Number(b)) || Number(b) < 100_000 || Number(b) > 100_000_000)) return reply.code(400).send({ error: 'budget must be from 100,000 to 100,000,000 tokens' });
    const r = orch.startGoal(String(req.body?.text ?? '').slice(0, 4000), b === undefined ? undefined : Number(b));
    return r.ok ? orch.status() : reply.code(409).send(r);
  });
  app.post('/api/orchestrator/goals/stop', { preHandler: requireAction }, async (_req, reply) => (orch ? (orch.stopGoal(), orch.status()) : noOrch(reply)));
  app.post<{ Body: { on?: boolean } }>('/api/orchestrator/control', { preHandler: requireAction }, async (req, reply) => (orch ? (orch.setControl(Boolean(req.body?.on)), orch.status()) : noOrch(reply)));
  app.post('/api/orchestrator/presence', { preHandler: requireAction }, async (_req, reply) => (orch ? orch.presence() : noOrch(reply)));
  app.post<{ Body: { kind?: string } }>('/api/orchestrator/brief', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const kind = req.body?.kind === 'wrap' ? 'wrap' : 'now';
    const r = orch.brief(kind);
    return r.ok ? orch.status() : reply.code(409).send({ error: r.error });
  });
  app.post<{ Body: { sessionId?: string } }>('/api/orchestrator/talk/end', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const sid = String(req.body?.sessionId ?? '');
    if (!sid) return reply.code(400).send({ error: 'which session?' });
    orch.talk.end(sid);
    return orch.status();
  });
  app.post('/api/orchestrator/stand-down', { preHandler: requireAction }, async (_req, reply) => (orch ? (orch.standDown(), orch.status()) : noOrch(reply)));
  app.post<{ Params: { id: string }; Body: { ok?: boolean; text?: string; cwd?: string } }>('/api/orchestrator/approvals/:id', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const r = await orch.approvals.decide(req.params.id, { ok: Boolean(req.body?.ok), ...(typeof req.body?.text === 'string' ? { text: req.body.text } : {}), ...(typeof req.body?.cwd === 'string' ? { cwd: req.body.cwd } : {}) });
    return r.ok ? r : reply.code(r.error?.startsWith('not found') ? 404 : 400).send(r);
  });
  app.post<{ Body: { key?: string } }>('/api/orchestrator/key', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const r = orch.key(String(req.body?.key ?? ''));
    return r.ok ? r : reply.code(400).send(r);
  });
  app.post('/api/orchestrator/restart', { preHandler: requireAction }, async (_req, reply) => (orch ? (orch.restart(), orch.status()) : noOrch(reply)));
  app.post('/api/orchestrator/forget', { preHandler: requireAction }, async (_req, reply) => (orch ? (orch.forget(), orch.status()) : noOrch(reply)));
  app.post('/api/orchestrator/new', { preHandler: requireAction }, async (_req, reply) => (orch ? (orch.newConversation(), orch.status()) : noOrch(reply)));
  app.get('/api/orchestrator/memory', { preHandler: requireUi }, async (_req, reply) => (orch ? { text: orch.readMemory() } : noOrch(reply)));
  app.post<{ Body: { text?: string } }>('/api/orchestrator/memory', { preHandler: requireAction }, async (req, reply) => {
    if (!orch) return noOrch(reply);
    const text = String(req.body?.text ?? '');
    if (text.length > 200_000) return reply.code(400).send({ error: 'too long' });
    orch.writeMemory(text);
    return { ok: true };
  });
  // --- changes: what the session did to files (Claude Code's snapshots), and what git says is uncommitted ---
  const fileAllowed = (sid: string, cwd: string, transcript: string | null | undefined, p: string) => {
    const key = normPath(p);
    if (cwd && key.startsWith(normPath(cwd) + '/')) return true;
    return !!transcript && snapshots.read(transcript).some((s) => s.files.has(key));
  };
  app.get<{ Params: { id: string }; Querystring: { path?: string; from?: string; to?: string } }>('/api/sessions/:id/changes/net', { preHandler: requireUi }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    const p = String(req.query.path ?? '');
    if (!s?.transcriptPath) return reply.code(404).send({ error: 'unknown session' });
    if (!p || !fileAllowed(s.id, s.cwd, s.transcriptPath, p)) return reply.code(403).send({ error: 'not a file this session works on' });
    const from = Number(req.query.from);
    if (!Number.isFinite(from)) return reply.code(400).send({ error: 'from must be a timestamp' });
    const to = req.query.to ? Number(req.query.to) : null;
    return netChange({ transcript: s.transcriptPath, sessionId: s.id, path: p, from, to: to != null && Number.isFinite(to) ? to : null });
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/changes/git', { preHandler: requireUi }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    return gitChanges(s.cwd);
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>('/api/sessions/:id/changes/git-diff', { preHandler: requireUi }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    const r = await gitDiff(s.cwd, String(req.query.path ?? ''));
    return 'error' in r ? reply.code(400).send(r) : r;
  });

  // The latest lines a background command has written (from the output file the transcript names for it).
  app.get<{ Params: { id: string; task: string } }>('/api/sessions/:id/tasks/:task/tail', { preHandler: requireUi }, async (req, reply) => {
    const file = taskOutputFile(store, req.params.id, req.params.task);
    if (!file) return reply.code(404).send({ error: 'unknown task' });
    return tailOutput(file) ?? { lines: [], bytes: 0 };
  });

  // The end of a job's log (a failed job, clicked in the pipeline): only jobs of pipelines Cora follows.
  app.get<{ Querystring: { project?: string; job?: string } }>('/api/ci/log', { preHandler: requireUi }, async (req, reply) => {
    const ci = d.ci?.();
    const job = Number(req.query.job);
    if (!ci) return reply.code(501).send({ error: 'pipelines are off' });
    if (!req.query.project || !Number.isSafeInteger(job)) return reply.code(400).send({ error: 'project and job are required' });
    const r = await ci.jobLog(String(req.query.project), job);
    return 'error' in r ? reply.code(404).send(r) : r;
  });

  // --- voice (optional): the ElevenLabs key stays here; the page gets tickets and tokens ---
  const voice = d.voice ?? new Voice(null);
  app.get('/api/voice', { preHandler: requireUi }, async () => voice.info());
  app.post<{ Body: { key?: string | null } }>('/api/voice/key', { preHandler: requireAction }, async (req, reply) => {
    try {
      return await voice.setKey(req.body?.key ?? null);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  app.get('/api/voice/voices', { preHandler: requireUi }, async () => voice.voices());
  // speech: POST the text (origin-checked: it spends credits), then the audio element streams GET /api/voice/speech/<ticket>
  app.post<{ Body: { text?: string; voiceId?: string; cora?: boolean } }>('/api/voice/speech', { preHandler: requireAction }, async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'nothing to say' });
    if (text.length > 5000) return reply.code(400).send({ error: 'text too long (5000 characters at most)' });
    if (!voice.info().set) return reply.code(400).send({ error: 'add an ElevenLabs key in Settings → Voice' });
    const v = prefs.get().voice;
    const voiceId = req.body?.voiceId && /^[A-Za-z0-9]{8,40}$/.test(req.body.voiceId) ? req.body.voiceId : v.voiceId;
    // how it's said: your pronunciations and direction (Cora's own for its lines)
    return { url: `/api/voice/speech/${voice.ticket(spokenText(text, v, req.body?.cora === true), { ...v, voiceId })}` };
  });
  // --- Gmail (optional): the user's own Google app; Cora reads mail and writes drafts, never sends ---
  const noGmail = { client: false, connected: false, watch: false };
  const gmailFail = (reply: FastifyReply, e: unknown) => reply.code(e instanceof GmailError && ['bad_client', 'no_client', 'bad_state'].includes(e.code) ? 400 : 502).send({ error: (e as Error).message });
  app.get('/api/gmail', { preHandler: requireUi }, async () => d.gmail?.status() ?? noGmail);
  app.post<{ Body: { json?: unknown } }>('/api/gmail/client', { preHandler: requireAction }, async (req, reply) => {
    if (!d.gmail) return reply.code(501).send({ error: 'not supported' });
    try {
      d.gmail.setClient(String(req.body?.json ?? '').slice(0, 20_000));
      return d.gmail.status();
    } catch (e) {
      return gmailFail(reply, e);
    }
  });
  // sign-in: Google's page in your browser, back to Cora's own address (below)
  app.post('/api/gmail/connect', { preHandler: requireAction }, async (_req, reply) => {
    if (!d.gmail) return reply.code(501).send({ error: 'not supported' });
    try {
      return { url: d.gmail.authUrl(`http://127.0.0.1:${config.port}/api/gmail/callback`) };
    } catch (e) {
      return gmailFail(reply, e);
    }
  });
  // where Google sends your browser back: no Cora cookie there (it's your browser, not Cora's window), so the one-use
  // state from the sign-in Cora started is what lets it in
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/api/gmail/callback', async (req, reply) => {
    const page = (title: string, text: string) =>
      reply.type('text/html').send(`<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#0b0f16;color:#e6ebf2;font:15px system-ui"><div style="max-width:420px;text-align:center"><h2 style="font-weight:600">${title}</h2><p style="color:#a4afbf;line-height:1.5">${text}</p></div></body>`);
    const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);
    if (!d.gmail) return page('Not supported', 'This Cora has no Gmail.');
    const { code, state, error } = req.query;
    if (error || !code || !state) return page("Gmail isn't connected", esc(error === 'access_denied' ? "You cancelled the sign-in. Connect again from Cora's Settings → Gmail when you like." : `Google said: ${error ?? 'no code came back'}.`));
    try {
      const email = await d.gmail.finish(String(state), String(code));
      d.gmail.start();
      return page('Gmail is connected', `Cora can now read ${esc(email)}'s mail and write drafts (it never sends on its own). You can close this tab.`);
    } catch (e) {
      return page("Gmail isn't connected", esc((e as Error).message));
    }
  });
  app.post('/api/gmail/disconnect', { preHandler: requireAction }, async (_req, reply) => {
    if (!d.gmail) return reply.code(501).send({ error: 'not supported' });
    await d.gmail.disconnect();
    return d.gmail.status();
  });
  // what Cora watches for (your rules, Gmail's important), and who its drafts may go to
  app.post<{ Body: { rules?: any; important?: unknown; drafts?: unknown; draftTo?: any } }>('/api/gmail/config', { preHandler: requireAction }, async (req, reply) => {
    if (!d.gmail) return reply.code(501).send({ error: 'not supported' });
    const b = req.body ?? {};
    try {
      d.gmail.setConfig({ ...(b.rules !== undefined ? { rules: b.rules } : {}), ...(b.important !== undefined ? { important: b.important === true } : {}), ...(b.drafts !== undefined ? { drafts: b.drafts === true } : {}), ...(b.draftTo !== undefined ? { draftTo: b.draftTo } : {}) });
      return d.gmail.status();
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // stop waiting for an email (Settings → Gmail, or the session's "waiting for email" button)
  app.post<{ Params: { id: string } }>('/api/gmail/watches/:id/stop', { preHandler: requireAction }, async (req, reply) => {
    if (!d.gmail || !d.mailWatches) return reply.code(501).send({ error: 'not supported' });
    if (!d.mailWatches.remove(req.params.id)) return reply.code(404).send({ error: 'no such watch (it may have ended)' });
    return d.gmail.status();
  });
  app.post<{ Body: { watch?: unknown } }>('/api/gmail/watch', { preHandler: requireAction }, async (req, reply) => {
    if (!d.gmail) return reply.code(501).send({ error: 'not supported' });
    if (typeof req.body?.watch !== 'boolean') return reply.code(400).send({ error: 'watch must be true or false' });
    d.gmail.setWatch(req.body.watch);
    return d.gmail.status();
  });

  // the voice front: one quick line for what you just said, while the real answer comes (null: none in time)
  app.post<{ Body: { text?: string; toCora?: boolean; looking?: string } }>('/api/voice/front', { preHandler: requireAction }, async (req, reply) => {
    const text = String(req.body?.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'nothing was said' });
    const v = prefs.get().voice;
    if (!d.voiceFront || !v.enabled || v.front === false) return { line: null };
    const working = store
      .listSessions()
      .filter((s) => (s.state === 'working' || s.state === 'thinking') && !d.orchestrator?.isAgent(s.id))
      .map((s) => s.alias || s.autoName || basename(s.cwd ?? '') || 'a session');
    const looking = typeof req.body?.looking === 'string' ? req.body.looking.slice(0, 120) : undefined;
    return { line: await d.voiceFront.line(text, { toCora: req.body?.toCora === true, working, ...(looking ? { looking } : {}) }) };
  });
  app.get<{ Params: { ticket: string } }>('/api/voice/speech/:ticket', { preHandler: requireUi }, async (req, reply) => {
    let r: Response | null;
    try {
      r = await voice.speech(req.params.ticket);
    } catch (e) {
      return reply.code(502).send({ error: `couldn't reach ElevenLabs (${(e as Error).message})` });
    }
    if (!r) return reply.code(404).send({ error: 'unknown or used ticket' });
    if (!r.ok || !r.body) return reply.code(r.status === 401 ? 403 : 502).send({ error: `ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}` });
    reply.header('content-type', 'audio/mpeg').header('cache-control', 'no-store');
    return reply.send(Readable.fromWeb(r.body as any));
  });
  app.post('/api/voice/stt-token', { preHandler: requireAction }, async (_req, reply) => {
    try {
      return { token: await voice.sttToken() };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  /**
   * A session's name, colour, ticket. `ticket`: a key (or {key, site, summary}) sets it, null clears it for good.
   * `ticketSummary`: the UI looked the ticket up; kept only while the session's ticket is still that key.
   */
  type MetaBody = { alias?: string | null; color?: string | null; ticket?: string | { key?: unknown; site?: unknown; summary?: unknown } | null; ticketSummary?: { key?: unknown; summary?: unknown } };
  app.post<{ Params: { id: string }; Body: MetaBody }>('/api/sessions/:id/meta', { preHandler: requireAction }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    const { alias, color, ticket, ticketSummary } = req.body ?? {};
    if (alias !== undefined && alias !== null && (typeof alias !== 'string' || alias.length > 60)) return reply.code(400).send({ error: 'alias must be a string of at most 60 characters' });
    if (color !== undefined && color !== null && !/^#[0-9a-f]{6}$/i.test(String(color))) return reply.code(400).send({ error: 'color must be #rrggbb' });
    let tk: SessionTicket | null | undefined;
    try {
      if (ticket === null) tk = null;
      else if (ticket !== undefined) tk = checkTicket(typeof ticket === 'string' ? { key: ticket } : ticket);
      if (ticketSummary !== undefined) {
        const cur = tk ?? s.ticket;
        if (!cur || cur.key !== ticketSummary?.key) return s; // the ticket changed meanwhile: nothing to do
        tk = { ...cur, summary: checkSummary(ticketSummary.summary) };
      }
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const next = store.upsertSession({
      id: s.id,
      ...(alias !== undefined ? { alias: alias === null || !alias.trim() ? null : alias.trim() } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(tk !== undefined ? { ticket: tk } : {}),
    });
    hub.publishSession(next);
    return next;
  });
  // The Jira site's project keys, from the UI (signed in to Jira): bare keys of these in a first prompt are tickets.
  app.get('/api/jira/watch', { preHandler: requireUi }, async () => ({ status: d.jira?.status() ?? { state: 'off' }, recent: d.jira?.recent(KEEP_MS).slice(0, 50) ?? [] }));
  app.get('/api/jira/projects', { preHandler: requireUi }, async () => ({ projects: d.tickets?.knownProjects() ?? [] }));

  // --- setting Cora up: the first-run checklist and Settings › Setup -------------------------------------------------
  const claudeFile = () => d.claudeSettingsFile ?? settingsPath();
  /** in and aimed here (true), not in (false), or what's wrong: the settings file, or hooks aimed at another Cora */
  const hooksIn = (): boolean | string => {
    try {
      const a = hooksAimed(readSettings(claudeFile()).json, { port: config.port, token: config.hookToken });
      if (a.state === 'elsewhere')
        return `Cora's hooks there point at ${a.port ? `another Cora (port ${a.port})` : 'this Cora with an old key'}, so Claude Code's events are turned away. Install puts in this Cora's (your settings are backed up first).`;
      return a.state === 'here';
    } catch (e) {
      return (e as Error).message;
    }
  };
  const claudeAccount = () => {
    const found = findClaude();
    let email: string | undefined;
    try {
      email = JSON.parse(readFileSync(joinPath(homedir(), '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress;
    } catch {
      /* not signed in this way */
    }
    const key = !!process.env.ANTHROPIC_API_KEY || existsSync(joinPath(homedir(), '.claude', '.credentials.json'));
    const path = found.how === 'shim' ? 'claude.cmd on PATH' : found.cmd[0];
    return { found: found.how !== 'missing', ...(found.how !== 'missing' ? { path } : {}), signedIn: !!email || key, ...(email ? { email } : {}) };
  };
  const setupDeps = (): SetupDeps => ({
    claude: claudeAccount,
    hooks: hooksIn,
    which: whichCmd,
    glabAuthed,
    kubeconfigs: () => d.environments?.list().length ?? 0,
    voiceKey: () => !!d.voice?.info().set,
    slack: () => !!d.slack?.slack.status().connected,
    gmail: () => !!d.gmail?.connected(),
    jira: () => ({ on: prefs.get().jira.watch.on, ...(prefs.get().jira.watch.site ? { site: prefs.get().jira.watch.site } : {}) }),
    agent: () => prefs.get().orchestrator.enabled,
    mcp: () => connectedMcp(),
    gitlabHost: () => prefs.get().gitlab.host,
    skipped: () => prefs.get().setup.skipped,
    onePassword: () => onePasswordStatus(),
    ...d.setupChecks,
  });
  app.get('/api/setup', { preHandler: requireUi }, async () => {
    await refreshPath().catch(() => {});
    return { items: await checkSetup(setupDeps()), seen: prefs.get().setup.seen, fresh: store.listSessions().length === 0 };
  });
  // the hooks as they'd be written (the token shortened)
  app.get('/api/setup/hooks', { preHandler: requireUi }, async (_req, reply) => {
    let raw: string, json: Record<string, any>;
    try {
      ({ raw, json } = readSettings(claudeFile()));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    const after = JSON.stringify(mergeHooks(json, computeHooksBlock({ port: config.port, token: config.hookToken })), null, 2);
    return { file: claudeFile(), diff: diffText(raw.trim() ? JSON.stringify(json, null, 2) : '', after).replace(/\b[0-9a-f]{64}\b/g, (t) => `${t.slice(0, 6)}…`) };
  });
  app.post<{ Body: { item?: unknown; need?: unknown } }>('/api/setup/run', { preHandler: requireAction }, async (req, reply) => {
    const item = String(req.body?.item ?? '');
    const need = String(req.body?.need ?? '');
    // the hooks: written here, the same way `cora install` does (backed up first)
    if (item === 'hooks') {
      let json: Record<string, any>;
      try {
        json = readSettings(claudeFile()).json;
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
      const backup = writeSettings(mergeHooks(json, computeHooksBlock({ port: config.port, token: config.hookToken })), claudeFile());
      return { ok: true, ...(backup ? { backup } : {}) };
    }
    const found = findClaude();
    const command = setupCommand(item, need, { host: prefs.get().gitlab.host, claude: found.how !== 'missing' ? found.cmd : ['claude'] });
    if (!command) return reply.code(400).send({ error: 'nothing to run for that' });
    runInWindow(`${item} › ${need}`, command);
    return { ok: true, window: true };
  });
  app.post<{ Body: { item?: unknown; skip?: unknown } }>('/api/setup/skip', { preHandler: requireAction }, async (req, reply) => {
    const item = String(req.body?.item ?? '');
    if (!/^[\w-]{1,40}$/.test(item) || typeof req.body?.skip !== 'boolean') return reply.code(400).send({ error: 'say which feature, and skip true or false' });
    const now = prefs.get().setup.skipped.filter((x) => x !== item);
    prefs.update({ setup: { skipped: req.body.skip ? [...now, item] : now } });
    return { ok: true };
  });
  app.post('/api/setup/seen', { preHandler: requireAction }, async () => (prefs.update({ setup: { seen: true } }), { ok: true }));

  // --- Cora's Inbox: everything it told you (14 days) ---------------------------------------------------------------
  app.get('/api/inbox', { preHandler: requireUi }, async (_req, reply) => (d.inbox ? { items: d.inbox.list() } : reply.code(501).send({ error: 'not supported' })));
  app.post<{ Body: { ids?: unknown; source?: unknown; all?: unknown } }>('/api/inbox/read', { preHandler: requireAction }, async (req, reply) => {
    if (!d.inbox) return reply.code(501).send({ error: 'not supported' });
    const b = req.body ?? {};
    const ids = Array.isArray(b.ids) && b.ids.length <= 3000 && b.ids.every((x) => typeof x === 'string') ? (b.ids as string[]) : undefined;
    const source = (INBOX_SOURCES as readonly unknown[]).includes(b.source) ? (b.source as (typeof INBOX_SOURCES)[number]) : undefined;
    if (!ids && !source && b.all !== true) return reply.code(400).send({ error: 'say which: ids, a source, or all' });
    return { ok: true, n: d.inbox.read({ ...(ids ? { ids } : {}), ...(source ? { source } : {}), ...(b.all === true ? { all: true } : {}) }) };
  });
  // your reply to an item: Slack, sent as you in its thread or DM (you wrote it); email, a Gmail draft reply to check and send
  app.post<{ Params: { id: string }; Body: { text?: unknown } }>('/api/inbox/:id/reply', { preHandler: requireAction }, async (req, reply) => {
    const it = d.inbox?.get(req.params.id);
    if (!it) return reply.code(404).send({ error: 'not found' });
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 8000) return reply.code(400).send({ error: 'write the reply (8,000 characters at most)' });
    try {
      if (it.source === 'slack') {
        if (!d.slack) return reply.code(501).send({ error: 'not supported' });
        const [, channel, thread] = it.key.split(':');
        const to = { kind: (channel.startsWith('D') ? 'person' : channel.startsWith('C') ? 'channel' : 'group') as 'person' | 'channel' | 'group', id: channel, label: it.title };
        const sent = await d.slack.outbox.sendNow({ to, text, typed: true, ...(thread ? { threadTs: thread } : {}) });
        d.inbox!.read({ ids: [it.id] });
        return { ok: true, link: sent.link };
      }
      if (it.source === 'mail' && it.mailId) {
        if (!d.gmail?.connected()) return reply.code(409).send({ error: 'Gmail is not connected' });
        const draft = await d.gmail.draft({ replyTo: it.mailId, body: text, byUser: true });
        d.inbox!.read({ ids: [it.id] });
        return { ok: true, link: draft.link, draft: true };
      }
      return reply.code(400).send({ error: `no reply from the Inbox for ${it.source} yet` });
    } catch (e) {
      return reply.code(400).send({ error: e instanceof SlackError ? slackErr(e) : (e as Error).message });
    }
  });
  // a Slack item's whole thread (or the DM's latest), as lines of text
  app.get<{ Params: { id: string } }>('/api/inbox/:id/thread', { preHandler: requireUi }, async (req, reply) => {
    const it = d.inbox?.get(req.params.id);
    if (it?.source !== 'slack' || !it.link) return reply.code(404).send({ error: 'no thread' });
    if (!d.slack) return reply.code(501).send({ error: 'not supported' });
    try {
      return { lines: (await d.slack.slack.read({ link: it.link, limit: 40 })).lines };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // an email item read whole (its text, as text)
  app.get<{ Params: { id: string } }>('/api/inbox/:id/mail', { preHandler: requireUi }, async (req, reply) => {
    const it = d.inbox?.get(req.params.id);
    if (!it?.mailId) return reply.code(404).send({ error: 'no email' });
    if (!d.gmail?.connected()) return reply.code(409).send({ error: 'Gmail is not connected' });
    try {
      const m = await d.gmail.read(it.mailId);
      return { from: m.from, to: m.to, cc: m.cc, subject: m.subject, at: m.at, body: m.body.slice(0, 20000) };
    } catch (e) {
      return reply.code(e instanceof GmailError ? 400 : 500).send({ error: (e as Error).message });
    }
  });
  app.post<{ Body: { projects?: unknown } }>('/api/jira/projects', { preHandler: requireAction }, async (req, reply) => {
    const p = req.body?.projects;
    if (!Array.isArray(p) || p.length > 2000 || !p.every((k) => typeof k === 'string' && k.length <= 20)) return reply.code(400).send({ error: 'projects must be a list of project keys' });
    return { ok: true, tagged: d.tickets?.setProjects(p as string[]) ?? 0 };
  });
  // "Suggest a name": the namer reads the session's first prompt; the result replaces any alias (you asked for a name)
  app.post<{ Params: { id: string } }>('/api/sessions/:id/autoname', { preHandler: requireAction }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    if (!d.namer) return reply.code(501).send({ error: 'naming is not available' });
    const text = store.firstPrompt(s.id)?.text?.trim();
    if (!text) return reply.code(409).send({ error: 'no prompt to name it from yet' });
    const name = await d.namer.suggest(s.id, text);
    if (!name) return reply.code(502).send({ error: "couldn't get a name from Claude Code" });
    const next = store.upsertSession({ id: s.id, autoName: name, alias: null });
    hub.publishSession(next);
    return next;
  });
  // The session list's order, as you arranged it: ids top to bottom (unknown ids are skipped).
  app.post<{ Body: { ids?: unknown } }>('/api/sessions/order', { preHandler: requireAction }, async (req, reply) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length > 1000 || !ids.every((x) => typeof x === 'string')) return reply.code(400).send({ error: 'ids must be a list of session ids' });
    const out: SessionInfo[] = [];
    ids.forEach((id, i) => {
      if (!store.getSession(id)) return;
      const next = store.upsertSession({ id, order: i });
      hub.publishSession(next);
      out.push(next);
    });
    return { ordered: out.length };
  });
  const dismiss = (id: string) => {
    const s = store.getSession(id);
    if (!s) return null;
    const next = store.upsertSession({ id, dismissedAt: Math.max(Date.now(), s.lastTs) });
    hub.publishSession(next);
    return next;
  };
  app.post<{ Params: { id: string }; Body: { undo?: boolean } }>('/api/sessions/:id/dismiss', { preHandler: requireAction }, async (req, reply) => {
    if (req.body?.undo) {
      const s = store.getSession(req.params.id);
      if (!s) return reply.code(404).send({ error: 'unknown session' });
      const next = store.upsertSession({ id: s.id, dismissedAt: null });
      hub.publishSession(next);
      return next;
    }
    if (ptys?.forSession(req.params.id)) return reply.code(409).send({ error: 'session is running in Cora; exit it first' });
    // hidden, its shells would run on out of sight
    if (ptys?.shellsFor(req.params.id).length) return reply.code(409).send({ error: 'it has shells open in Cora; close them first' });
    return dismiss(req.params.id) ?? reply.code(404).send({ error: 'unknown session' });
  });
  app.post('/api/sessions/dismiss-ended', { preHandler: requireAction }, async () => {
    const ids = store.listSessions().filter((s) => s.state === 'ended' && !s.dismissedAt && !ptys?.shellsFor(s.id).length).map((s) => s.id);
    ids.forEach(dismiss);
    return { dismissed: ids.length };
  });
  // a live explain's newest data (the viewer asks when it opens one; after that it comes over the WebSocket)
  app.get<{ Params: { sid: string; slug: string } }>('/api/explains/live/:sid/:slug/data', { preHandler: requireUi }, async (req, reply) => {
    if (!d.live) return reply.code(501).send({ error: 'not supported' });
    if (!/^[\w-]{8,80}$/.test(req.params.sid) || !/^[\w-]{1,60}$/.test(req.params.slug)) return reply.code(400).send({ error: 'bad explain' });
    return { data: d.live.latestData(req.params.sid, req.params.slug) ?? null };
  });
  app.get<{ Querystring: { sessionId?: string; limit?: string } }>('/api/explains', { preHandler: requireUi }, async (req) => ({
    explains: store.listExplains(req.query.sessionId, Math.min(Number(req.query.limit ?? 200), 1000)),
  }));

  // --- auth ---------------------------------------------------------------------
  // who's on this port: only Cora (holding its hook key) answers rightly; the desktop app asks before it hands over any
  // key, so whatever else squats the port gets nothing (docs/audit-2026-10-20.md S17)
  app.get<{ Querystring: { n?: string } }>('/api/hello', async (req, reply) => {
    const n = String(req.query.n ?? '');
    if (!/^[0-9a-f]{32,128}$/.test(n)) return reply.code(400).send({ error: 'bad nonce' });
    return { cora: true, mac: createHmac('sha256', config.hookToken).update(`${HELLO_PREFIX}${n}`).digest('hex') };
  });

  app.get<{ Querystring: { key?: string; view?: string } }>('/auth', async (req, reply) => {
    // view-only (Cora's agent, for screenshots): it can look, never act
    if (req.query.view != null) {
      if (!config.viewToken || !sameSecret(req.query.view, config.viewToken)) return reply.code(401).type('text/plain').send('Invalid key.');
      reply.setCookie(VIEW_COOKIE, config.viewToken, { httpOnly: true, sameSite: 'strict', path: '/' });
      return reply.redirect('/');
    }
    if (!sameSecret(req.query.key, config.uiToken)) return reply.code(401).type('text/plain').send('Invalid key. Use the link printed by `cora start`.');
    reply.setCookie(COOKIE, config.uiToken, { httpOnly: true, sameSite: 'strict', path: '/' });
    return reply.redirect('/');
  });

  // --- api ----------------------------------------------------------------------
  app.get('/api/me', { preHandler: requireUi }, async () => ({ ok: true }));
  app.get('/api/sessions', { preHandler: requireUi }, async () => ({ sessions: store.listSessions(), agents: store.listAgents() }));
  app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string } }>('/api/sessions/:id/events', { preHandler: requireUi }, async (req) => ({
    events: store.eventsForSession(req.params.id, {
      before: req.query.before ? Number(req.query.before) : undefined,
      limit: Math.min(Number(req.query.limit ?? 5000), 20000),
    }),
  }));
  app.get<{ Params: { id: string; toolUseId: string } }>('/api/sessions/:id/tool/:toolUseId', { preHandler: requireUi }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    const ev = store.getEvent(`tool:${req.params.toolUseId}:start`) ?? store.getEvent(`tool:${req.params.toolUseId}:end`);
    if (!s?.transcriptPath || !ev) return reply.code(404).send({ error: 'not found' });
    const detail = await readToolDetail(transcriptFor(s.transcriptPath, s.id, ev.agentId), req.params.toolUseId);
    return detail ?? reply.code(404).send({ error: 'not in transcript yet' });
  });
  app.post<{ Params: { id: string }; Body: PendingDecision }>('/api/pending/:id', { preHandler: requireAction }, async (req, reply) => {
    const r = pending.resolve(req.params.id, req.body);
    return r.ok ? r : reply.code(409).send(r);
  });
  // closed from the dashboard without deciding: the terminal's own prompt decides
  app.post<{ Params: { id: string } }>('/api/pending/:id/release', { preHandler: requireAction }, async (req, reply) => {
    const r = pending.release(req.params.id);
    return r.ok ? r : reply.code(409).send(r);
  });
  app.post<{ Params: { id: string } }>('/api/sessions/:id/jump', { preHandler: requireAction }, async (req, reply): Promise<JumpResult | void> => {
    const s = store.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    return (d.jump ?? jumpToTerminal)(s);
  });

  // --- terminals ------------------------------------------------------------------
  const { ptys } = d;
  app.get('/api/terminals', { preHandler: requireUi }, async () => ({ terminals: ptys?.list() ?? [] }));
  // a prompt from the composer or push-to-talk: typed into a hosted session's input as if you'd typed (several
  // lines as one paste), then Enter when sending
  app.post<{ Params: { id: string }; Body: { text?: string; submit?: boolean; force?: boolean } }>('/api/terminals/:id/input', { preHandler: requireAction }, async (req, reply) => {
    const t = ptys?.list().find((x) => x.terminalId === req.params.id && x.alive);
    if (!t || !ptys) return reply.code(404).send({ error: 'no running terminal with that id' });
    const input = terminalInput(String(req.body?.text ?? ''));
    if ('error' in input) return reply.code(400).send(input);
    // a permission prompt or a question open in Claude Code: the text would pick its options and Enter confirm one
    const lines = req.body?.force ? null : ptys.screenLines(t.terminalId);
    if (lines && choiceOpen(lines)) return reply.code(409).send({ error: 'Claude Code is showing a choice in the terminal: answer it there first', choice: true });
    ptys.write(t.terminalId, input.data);
    // Enter separately, a beat later, so Claude Code sees the text (or the whole paste) and then a submit
    if (req.body?.submit) setTimeout(() => ptys.write(t.terminalId, '\r'), input.paste ? 150 : 80);
    // your words to Cora (push-to-talk types them into its terminal): what it does now is something you asked
    if (req.body?.submit && d.orchestrator?.agentTerminal() === t.terminalId) d.orchestrator.noteUserInput();
    return { ok: true, paste: input.paste };
  });
  /**
   * Stop a hosted session's work from the composer: Esc (Claude Code's interrupt) or Ctrl+C, typed into its terminal.
   * Only while it's working (or showing a prompt): at an idle prompt Esc twice opens Claude Code's rewind and Ctrl+C
   * twice quits it. A second press within a moment is let go for the same reason.
   */
  const lastStop = new Map<string, number>();
  app.post<{ Params: { id: string }; Body: { key?: string } }>('/api/terminals/:id/interrupt', { preHandler: requireAction }, async (req, reply) => {
    const t = ptys?.list().find((x) => x.terminalId === req.params.id && x.alive);
    if (!t || !ptys) return reply.code(404).send({ error: 'no running terminal with that id' });
    if (t.mode === 'shell') return reply.code(400).send({ error: 'not a Claude terminal' });
    const key = req.body?.key === 'esc' ? '\x1b' : req.body?.key === 'ctrl-c' ? '\x03' : null;
    if (!key) return reply.code(400).send({ error: 'key must be esc or ctrl-c' });
    const state = t.sessionId ? store.getSession(t.sessionId)?.state : undefined;
    if (state !== 'working' && state !== 'thinking' && state !== 'needs-you') return { sent: false, why: 'Nothing is running to stop.' };
    const now = Date.now();
    if (now - (lastStop.get(t.terminalId) ?? 0) < STOP_GAP_MS) return { sent: false, why: 'Already stopping it.' };
    lastStop.set(t.terminalId, now);
    ptys.write(t.terminalId, key);
    return { sent: true };
  });
  /** Type a prompt into a hosted terminal and submit it (several lines as one paste). */
  function typeInto(terminalId: string, text: string): void {
    const input = terminalInput(text);
    if ('error' in input) throw new Error(input.error);
    ptys!.write(terminalId, input.data);
    setTimeout(() => ptys!.write(terminalId, '\r'), input.paste ? 150 : 80);
  }
  // the composer's `/` menu: the session's project skills and commands, yours and your plugins'
  app.get<{ Params: { id: string } }>('/api/sessions/:id/commands', { preHandler: requireUi }, async (req) => ({
    commands: await listCommands({ claudeDir: dirname(config.projectsDir), cwd: store.getSession(req.params.id)?.cwd }),
  }));
  // a screenshot pasted or a file dropped into the composer: saved where Claude can read it, its path goes in the prompt
  app.post<{ Params: { id: string }; Body: { name?: string; data?: string } }>('/api/sessions/:id/attachments', { preHandler: requireAction }, async (req, reply) => {
    const s = store.getSession(req.params.id);
    if (!s) return reply.code(404).send({ error: 'unknown session' });
    const data = Buffer.from(String(req.body?.data ?? ''), 'base64');
    if (!data.length || data.length > MAX_ATTACHMENT) return reply.code(400).send({ error: `a file of 1 byte to ${MAX_ATTACHMENT / 1024 / 1024} MB` });
    try {
      return { path: saveAttachment(config.dataDir, s.id, String(req.body?.name ?? 'file').slice(0, 200), data) };
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  // the shells a shell tab can be (PowerShell, Command Prompt, Git Bash, WSL distros…); ?fresh looks again
  // how a ticket session starts (Settings › Jira): the user's own command (their /jira), or Cora's ticket prompt
  app.get('/api/ticket-start', { preHandler: requireUi }, async () => resolveTicketStart(prefs.get().jira.ticket, dirname(config.projectsDir)));
  // which Claude Code Cora runs (Settings › Sessions): its path, and which install it is
  app.get('/api/claude', { preHandler: requireUi }, async () => {
    const f = findClaude();
    return { how: f.how, path: f.how === 'shim' || f.how === 'missing' ? null : f.cmd[0] };
  });
  app.get<{ Querystring: { fresh?: string } }>('/api/shells', { preHandler: requireUi }, async (req, reply) => {
    if (!ptys) return reply.code(501).send({ error: 'not supported' });
    return { shells: ptys.shells(req.query.fresh === '1').map(({ id, name, wsl }) => ({ id, name, ...(wsl ? { wsl } : {}) })) };
  });
  app.post<{ Body: { mode: TerminalMode; cwd?: string; sessionId?: string; cols?: number; rows?: number; options?: unknown; prompt?: unknown; brief?: unknown; shell?: unknown } }>('/api/terminals', { preHandler: requireAction }, async (req, reply) => {
    if (!ptys) return reply.code(501).send({ error: 'terminals disabled' });
    const { mode, sessionId } = req.body ?? ({} as any);
    if (!['new', 'resume', 'fork', 'shell'].includes(mode)) return reply.code(400).send({ error: 'mode must be new|resume|fork|shell' });
    const src = sessionId ? store.getSession(sessionId) : undefined;
    const cwd = req.body.cwd || src?.cwd;
    if (!cwd) return reply.code(400).send({ error: 'cwd is required' });
    if (mode === 'shell') {
      // a plain shell beside a session's Claude: it belongs to that session, which it leaves alone
      if (!src) return reply.code(400).send({ error: 'a shell needs a known session' });
      try {
        return ptys.launch({ mode, cwd, sessionId, cols: req.body.cols, rows: req.body.rows, ...(typeof req.body.shell === 'string' ? { shell: req.body.shell } : {}) });
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    // a brief: a first message of any length, typed in once Claude is ready (a prompt has to be a short plain line,
    // since it becomes a claude argument)
    const brief = req.body.brief;
    if (brief != null) {
      if (typeof brief !== 'string' || !brief.trim()) return reply.code(400).send({ error: 'brief must be text' });
      const input = terminalInput(brief.trim());
      if ('error' in input) return reply.code(400).send({ error: input.error });
    }
    try {
      // model / effort / permission mode, and a first prompt (validated: they become claude arguments)
      const t = launchClaude({ mode, cwd, sessionId, cols: req.body.cols, rows: req.body.rows, options: req.body.options, prompt: req.body.prompt });
      if (typeof brief === 'string') {
        void deliverWhenReady(
          {
            screen: () => ptys.screenLines(t.terminalId),
            alive: () => ptys.list().some((x) => x.terminalId === t.terminalId && x.alive),
            type: (text) => typeInto(t.terminalId, text),
            key: (data) => void ptys.write(t.terminalId, data),
          },
          brief.trim(),
          3 * 60_000,
          500,
          { trust: true },
        ).then((r) => !r.sent && app.log.warn(`a new session's brief wasn't sent: ${r.why}`));
      }
      return t;
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
  /** Start Claude Code here (new, resume or fork), and make the session known at once. Throws on bad input. */
  function launchClaude(o: { mode: 'new' | 'resume' | 'fork'; cwd: string; sessionId?: string; cols?: number; rows?: number; options?: unknown; prompt?: unknown }) {
    if (!ptys) throw new Error('terminals disabled');
    if (!o.cwd) throw new Error('cwd is required');
    const src = o.sessionId ? store.getSession(o.sessionId) : undefined;
    const prompt = checkPrompt(o.prompt);
    const t = ptys.launch({ mode: o.mode, cwd: o.cwd, sessionId: o.sessionId, cols: o.cols, rows: o.rows, args: launchArgs(checkOptions(o.options)), prompt });
    const now = Date.now();
    const title = o.mode === 'fork' && src?.title ? `${src.title} (fork)` : o.mode === 'resume' ? src?.title : undefined;
    // started from a ticket ("/jira KEY"): it's about that ticket from the start
    const tk = prompt ? ticketInPrompt(prompt) : null;
    const ticket: SessionTicket | null = tk ? { key: tk.key, site: tk.site ?? null, summary: null } : null;
    const s = store.upsertSession({ id: t.sessionId, cwd: o.cwd, startedAt: now, lastTs: now, ...(title ? { title } : {}), ...(ticket ? { ticket } : {}) });
    d.registry?.updateSessionMeta(s.id, { cwd: o.cwd });
    d.registry?.sessionLaunched(s.id, now);
    hub.publishSession(store.getSession(s.id) ?? s);
    return t;
  }
  // close a shell tab: its process (and whatever runs in it) ends; a shell that already exited is forgotten
  app.post<{ Params: { id: string } }>('/api/terminals/:id/close', { preHandler: requireAction }, async (req, reply) => {
    return ptys?.closeShell(req.params.id) ? { ok: true } : reply.code(404).send({ error: 'no shell with that id' });
  });
  /**
   * End a session from the list. Hosted here: Ctrl+C twice, the way you'd quit Claude Code by hand (the first
   * interrupts a turn, the second exits), and its terminal is stopped if it's still up a few seconds later. Running
   * in another terminal: its claude process is ended. Either way the session is over now.
   */
  app.post<{ Params: { id: string } }>('/api/sessions/:id/end', { preHandler: requireAction }, async (req, reply) => {
    const id = req.params.id;
    if (!store.getSession(id)) return reply.code(404).send({ error: 'unknown session' });
    return endHow(id);
  });
  /** End a session: hosted here, as you would by hand; elsewhere, its process. */
  async function endHow(id: string): Promise<{ how: 'hosted' | 'none' | 'process'; pids?: number }> {
    const hosted = ptys?.forSession(id);
    if (hosted?.alive && ptys?.end(hosted.terminalId)) return { how: 'hosted' };
    const pids = await (d.findProcess ?? findSessionProcess)(id);
    if (!pids.length) return { how: 'none' };
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        /* gone already */
      }
    }
    d.registry?.sessionExited(id, Date.now());
    return { how: 'process', pids: pids.length };
  }
  const endSession = async (id: string) => {
    const r = await endHow(id);
    return r.how === 'hosted' ? 'it was asked to exit' : r.how === 'process' ? 'its process was stopped' : "it wasn't running";
  };
  app.get<{ Params: { id: string } }>('/api/sessions/:id/running', { preHandler: requireUi }, async (req) => {
    const hosted = ptys?.forSession(req.params.id);
    if (hosted) return { hosted: true, elsewhere: false, terminalId: hosted.terminalId };
    const pids = await (d.findProcess ?? findSessionProcess)(req.params.id);
    return { hosted: false, elsewhere: pids.length > 0, pids };
  });
  app.get<{ Querystring: { limit?: string } }>('/api/history', { preHandler: requireUi }, async (req) => ({
    sessions: await listHistory(config.projectsDir, Math.min(Number(req.query.limit ?? 300), 2000), (slug) => isNamerSlug(slug, namerDir(config.dataDir))),
  }));
  // finding an old session by what was said in it (Resume): an index of prompts and replies, read in the background
  // a while after Cora starts and then kept fresh; or Claude picks it from what you remember of it
  const skipSlug = (slug: string) => isNamerSlug(slug, namerDir(config.dataDir));
  const historyIndex = new HistoryIndex({ projectsDir: config.projectsDir, skip: skipSlug });
  let indexed = false;
  if (config.dbPath !== ':memory:') setTimeout(() => void historyIndex.refresh().then(() => (indexed = true)).catch(() => {}), 20_000).unref?.();
  app.get<{ Querystring: { q?: string } }>('/api/history/search', { preHandler: requireUi }, async (req) => {
    const q = String(req.query.q ?? '').slice(0, 200);
    if (!indexed) {
      await historyIndex.refresh();
      indexed = true;
    } else void historyIndex.refresh();
    return { sessions: await historyIndex.search(q) };
  });
  app.post<{ Body: { text?: unknown } }>('/api/history/ask', { preHandler: requireAction }, async (req, reply) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || text.length > 500) return reply.code(400).send({ error: 'Say what you remember of it (500 characters at most).' });
    try {
      return { sessions: await askForSession({ description: text, items: await listHistory(config.projectsDir, 300, skipSlug), dataDir: config.dataDir, ...(d.claudeRun ? { run: d.claudeRun } : {}) }) };
    } catch (e) {
      return reply.code(502).send({ error: (e as Error).message });
    }
  });
  // Cora's browser: your Chrome / Edge bookmarks and history (this PC's profiles), when you let it
  const chrome = d.chrome ?? new ChromeData();
  app.get<{ Querystring: { q?: string } }>('/api/browser/suggest', { preHandler: requireUi }, async (req) => ({
    suggestions: prefs.get().browser?.chrome === false ? [] : chrome.suggest(String(req.query.q ?? '').slice(0, 200)),
  }));
  app.get('/api/browser/bar', { preHandler: requireUi }, async () => ({ bookmarks: prefs.get().browser?.chrome === false ? [] : chrome.bar() }));
  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', { preHandler: requireUi }, async (req) => listDirs(req.query.path || (process.env.USERPROFILE ?? process.env.HOME ?? '/')));

  app.get<{ Params: { id: string } }>('/pty/:id', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!authed(req)) return reply.code(401).send({ error: 'unauthorized' });
      if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) return reply.code(403).send({ error: 'bad origin' });
    },
  }, (socket, req) => {
    const send = (m: object) => socket.readyState === 1 && socket.send(JSON.stringify(m));
    let detach: (() => void) | undefined;
    try {
      detach = ptys?.attach(req.params.id, { data: (d) => send({ t: 'out', d }), exit: (code) => send({ t: 'exit', code }) });
    } catch {
      send({ t: 'exit', code: -1 });
      socket.close();
      return;
    }
    socket.on('message', (raw: Buffer) => {
      let m: any;
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.t === 'in' && typeof m.d === 'string') ptys?.write(req.params.id, m.d);
      else if (m.t === 'resize') ptys?.resize(req.params.id, Number(m.cols), Number(m.rows));
    });
    socket.on('close', () => detach?.());
  });

  // --- live stream --------------------------------------------------------------
  // the live stream carries everything (sessions, prompts, Slack, email): only Cora's own pages may open it, like /pty
  // (the cookie alone isn't enough: a page on any other localhost port gets it too) (docs/audit-2026-10-20.md S4)
  app.get('/ws', {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!authed(req) && !viewer(req)) return reply.code(401).send({ error: 'unauthorized' });
      if (!req.headers.origin || !allowedOrigins.has(req.headers.origin)) return reply.code(403).send({ error: 'bad origin' });
    },
  }, (socket) => {
    hub.add(socket as any);
  });

  // --- client -------------------------------------------------------------------
  if (existsSync(config.clientDir)) {
    // wildcard (the default) serves files built after startup too
    await app.register(fastifyStatic, { root: config.clientDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/hook')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('Cora server running. Client not built: run `npm run build`.'));
  }

  return app;
}

/** The watcher's report, checked: events of known kinds with their fields, a status, at most 500. */
function jiraBatch(raw: unknown): JiraBatch | null {
  const b = raw as Record<string, unknown> | null;
  if (!b || !Array.isArray(b.events)) return null;
  const st = b.status as Record<string, unknown> | undefined;
  if (!st || !['ok', 'paused', 'error'].includes(String(st.state))) return null;
  const str = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
  // one odd event is left out, never the whole batch (the watcher would send the same, growing window again and
  // again); over 500, the newest 500 (audit B11)
  const clip = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const events: JiraEvent[] = [];
  for (const e of (b.events as Array<Record<string, unknown> | null>).slice(-500)) {
    if (!e || !JIRA_EVENT_KINDS.includes(e.kind as JiraEventKind) || !str(e.id, 200) || !str(e.key, 40) || !/^[A-Z][A-Z0-9_]+-\d+$/.test(e.key as string) || typeof e.at !== 'number' || !Number.isFinite(e.at) || !str(e.link, 1000) || !/^https:\/\//.test(String(e.link))) continue;
    events.push({ id: e.id as string, kind: e.kind as JiraEventKind, key: e.key as string, summary: clip(e.summary, 500), who: clip(e.who, 200), what: clip(e.what, 400), at: e.at, link: e.link as string });
  }
  const status: JiraWatchStatus = { state: st.state as JiraWatchStatus['state'], ...(str(st.message, 300) ? { message: st.message as string } : {}), ...(st.mentionFallback === true ? { mentionFallback: true } : {}) };
  // the offered tickets still yours
  if (b.still !== undefined && (!Array.isArray(b.still) || b.still.length > 50 || !b.still.every((k) => typeof k === 'string' && /^[A-Z][A-Z0-9_]+-\d+$/.test(k)))) return null;
  // what the watcher read of each ticket (for Cora's ticket prompt): dropped when malformed, never fatal
  const tickets: TicketFacts[] = [];
  if (Array.isArray(b.tickets))
    for (const t of (b.tickets as Array<Record<string, unknown>>).slice(0, 100)) {
      if (!t || typeof t.key !== 'string' || !/^[A-Z][A-Z0-9_]+-\d+$/.test(t.key)) continue;
      const s = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
      const url = s(t.url, 1000);
      tickets.push({ key: t.key, summary: s(t.summary, 500), status: s(t.status, 80), ...(/^https:\/\//.test(url) ? { url } : {}), ...(s(t.description, 4000) ? { description: s(t.description, 4000) } : {}) });
    }
  return { ...(typeof b.checkedAt === 'number' ? { checkedAt: b.checkedAt } : {}), events, status, ...(b.still ? { still: b.still as string[] } : {}), ...(tickets.length ? { tickets } : {}) };
}
