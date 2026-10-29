import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BOARD_TOOL, EVENT_ICON, PRESENT_TOOL, type OrchestratorStatus } from '@cora/shared';
import type { PendingManager } from './pending';
import type { Pipeline } from './pipeline';
import { loadDashboard } from './simLoad';
import { startSimShow } from './simShow';

// Simulated sessions for UI development (`cora start --sim`). Feeds hook-shaped payloads through the
// real pipeline (plus narration/thinking events that normally come from transcripts).

/**
 * CORA_SIM_LITE=1: a light simulation for checking how something looks (two sessions, at a third of the pace, resting
 * between turns), so it doesn't load the PC like the full one.
 */
const LITE = process.env.CORA_SIM_LITE === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, LITE ? ms * 3 : ms));
const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];
let n = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

type Call = { tool: string; input: Record<string, unknown>; response: Record<string, unknown>; fail?: string };

const CWD: Record<string, string> = { api: 'C:\\code\\orion-api', web: 'C:\\code\\aurora-web', cli: 'C:\\code\\nimbus-cli' };

/** What one simulated session is working on: its name, your prompt, the explain it writes, how it wraps up. */
type Topic = { name: string; prompt: string; /** none: it keeps a live one instead (the load test) */ explain?: { title: string; content: string }; done: string; /** Claude's task list: [subject, while doing it] */ plan: Array<[string, string]>; /** the Board's page for its work (the board tool) */ board?: [string, string] };
const TOPICS: Record<string, Topic> = {
  audit: {
    board: ['investigating', 'Checking the hooks brief'],
    name: 'Hook payload audit',
    prompt: 'Review the hooks design and verify the claims in the brief.',
    plan: [['Read the design brief', 'Reading the design brief'], ['Verify each claim with explorers', 'Verifying the claims'], ['Write up what holds', 'Writing it up']],
    done: 'Summary written. Two claims in the brief were wrong.',
    explain: {
      title: 'Hook payload fields',
      content: `# Hook payload fields

Which fields each hook carries, checked against the CLI rather than the brief.

| Field | On | Notes |
|---|---|---|
| \`session_id\` | every hook | stable for the whole session |
| \`agent_id\` | hooks inside a subagent | absent on main's own hooks |
| \`tool_use_id\` | Pre/PostToolUse | pairs a call with its result exactly |

## Two claims in the brief were wrong

1. **SubagentStop carries the report.** It carries \`last_assistant_message\`, which *is* the report, but only when the subagent ends cleanly.
2. **Transcripts flush per tool call.** They flush per message, so a long tool run shows up all at once.

\`\`\`ts
const payload = { session_id, agent_id, agent_type, tool_use_id };
\`\`\`
`,
    },
  },
  release: {
    board: ['shipping', 'Release 2.4 to staging'],
    name: 'Ship release 2.4',
    prompt: 'Cut the 2.4 release: bump the version, build the image and push it.',
    plan: [['Bump the version and changelog', 'Bumping the version'], ['Build and check the image', 'Building the image'], ['Push the image and tag', 'Pushing the release']],
    done: 'Release 2.4 is built and pushed. Changelog updated.',
    explain: {
      title: 'Release 2.4 checklist',
      content: `# Release 2.4 checklist

- [x] Version bumped to **2.4.0** in \`package.json\` and the Helm chart
- [x] Changelog: 6 fixes, 2 features, 1 breaking change (the \`/v1/export\` route is gone)
- [x] Image built: \`ghcr.io/acme/aurora-web:2.4.0\` (212 MB, down from 260)
- [ ] Image pushed (**waiting for your OK**)
- [ ] Tag \`v2.4.0\` and open the release MR

## What changed since 2.3

| Area | Change |
|---|---|
| Search | Results page streams, so the first rows show in ~200 ms |
| Exports | CSV export moved to the jobs queue |
| Auth | Sessions expire after 12 h idle (was 24 h) |
`,
    },
  },
  scheduler: {
    board: ['reviewing', 'Reviewing the schedule change'],
    name: 'Thermostat scheduler',
    prompt: 'Why does the scheduler skip the 6 am setpoint on Mondays?',
    plan: [['Reproduce the Monday skip', 'Reproducing it'], ['Find where the day is computed', 'Tracing the day boundary'], ['Fix it and test both DST changes', 'Fixing and testing']],
    done: 'Fixed. The week boundary was computed in UTC.',
    explain: {
      title: 'Monday 6 am setpoint',
      content: `# Why Monday's 6 am setpoint was skipped

The weekly schedule is keyed by day, and the day was taken from the **UTC** time. At 6 am local (UTC−5) it's 11 am UTC, still the right day, but the *week* started at Sunday 00:00 UTC, which is Saturday evening here.

## The fix

\`\`\`ts
const day = zonedDay(now, settings.timeZone); // not now.getUTCDay()
\`\`\`

Added a test for each DST change, both directions. All 41 scheduler tests pass.
`,
    },
  },
  loadtest: {
    board: ['investigating', 'Load testing search'],
    name: 'Load test the search API',
    prompt: 'Load test search up to 400 users and find out why p99 jumps.',
    plan: [['Ramp to 400 users', 'Ramping up the load'], ['Watch the tail latency', 'Watching p99'], ['Find the cause', 'Finding the cause']],
    done: "Found it: the indexer's GC pauses every 30 s. The dashboard has the details.",
  },
  sink: {
    board: ['coding', 'Wiring the sink'],
    name: 'Wire the HTTP sink',
    prompt: 'Wire the HTTP sink into the server and test it end to end.',
    plan: [['Read how sinks register', 'Reading the sink registry'], ['Wire the HTTP sink in', 'Wiring the sink'], ['Test it end to end', 'Testing end to end']],
    done: 'Done: the sink is wired and tests pass.',
    explain: {
      title: 'Sink wiring plan',
      content: `# Sink wiring plan

1. **Registry**: \`sinks/http.ts\` registers on start, like the file sink.
2. **Batching**: up to 50 events or 500 ms, whichever comes first.
3. **Back-pressure**: when the endpoint is slow, batches queue (max 2,000), then the oldest drop with a warning.
4. **Retries**: three, with jittered backoff; a 4xx is never retried.

> The endpoint's URL and token come from settings, never the environment, so tests can't post anywhere real.
`,
    },
  },
};
/** The command a release session asks to run (it's what its permission card shows). */
const PUSH: Call = { tool: 'Bash', input: { command: 'docker push ghcr.io/acme/aurora-web:2.4.0', description: 'Push the release image' }, response: { stdout: '2.4.0: digest: sha256:9f1c…e2a7 size: 2417', stderr: '' } };

function calls(cwd: string): Call[] {
  return [
    { tool: 'Read', input: { file_path: `${cwd}\\src\\hooks\\registry.ts` }, response: { type: 'text', file: { filePath: `${cwd}\\src\\hooks\\registry.ts`, numLines: 212, content: 'export function buildPayload(evt) {\n  return { session_id: evt.sessionId, agent_id: evt.agentId }\n}' } } },
    { tool: 'Read', input: { file_path: `${cwd}\\docs\\hooks.md` }, response: { type: 'text', file: { filePath: `${cwd}\\docs\\hooks.md`, numLines: 88, content: '# Hooks\n\nPreToolUse, PostToolUse, SubagentStart…' } } },
    { tool: 'Grep', input: { pattern: 'agent_id', path: 'src' }, response: { mode: 'content', numFiles: 3, numLines: 9, content: 'src/hooks/payload.ts:44:  agent_id: evt.agentId,' } },
    { tool: 'Glob', input: { pattern: '**/*.ts' }, response: { numFiles: 42, filenames: ['src/a.ts', 'src/b.ts'] } },
    { tool: 'Edit', input: { file_path: `${cwd}\\src\\hooks\\payload.ts`, old_string: 'a', new_string: 'b' }, response: { filePath: `${cwd}\\src\\hooks\\payload.ts`, structuredPatch: [{ oldStart: 12, oldLines: 4, newStart: 12, newLines: 5, lines: [' export function payloadFor(e: HookEvent) {', '-  const payload = { session_id }', '+  const payload = { session_id, agent_id, agent_type }', '+  if (e.tool_use_id) payload.tool_use_id = e.tool_use_id;', '   return post(payload);', ' }'] }] } },
    { tool: 'Write', input: { file_path: `${cwd}\\src\\hooks\\http-sink.ts`, content: 'export async function sink() {}\n' }, response: { type: 'create', filePath: `${cwd}\\src\\hooks\\http-sink.ts` } },
    { tool: 'Bash', input: { command: 'git status --short' }, response: { stdout: ' M src/hooks/payload.ts\n?? src/hooks/http-sink.ts\n', stderr: '' } },
    { tool: 'Bash', input: { command: 'npm test -- --run' }, response: { stdout: 'Tests  86 passed (86)\n', stderr: '' } },
    { tool: 'Bash', input: { command: 'ls ~/.claude/hooks' }, response: {}, fail: "Exit code 2\nls: cannot access '~/.claude/hooks': No such file or directory" },
    { tool: 'WebFetch', input: { url: 'https://code.claude.com/docs/en/hooks', prompt: 'which events carry agent_id?' }, response: { bytes: 23512, code: 200, result: 'agent_id and agent_type are present when the hook fires inside a subagent.' } },
    { tool: 'WebSearch', input: { query: 'claude code SubagentStart payload' }, response: { results: [{}, {}, {}, {}, {}] } },
    { tool: 'mcp__playwright__browser_snapshot', input: { url: 'http://localhost:5173' }, response: { nodes: 214 } },
  ];
}

const LINES = [
  'Found the hook registry. Tracing where payloads get built.',
  'agent_id is on every payload inside a subagent. Nice.',
  'Checking whether transcripts flush per message.',
  'Nothing in docs/ about this, so falling back to source.',
  'Two candidates. Reading both before I decide.',
  "It's the matcher, not the event.",
  'Tests are green. Moving on to the sink.',
];
const TASKS = [
  ['Verify hook facts', 'Explore'], ['Scan transcripts', 'Explore'], ['Map tool payloads', 'general-purpose'],
  ['Audit settings.json', 'Explore'], ['Read prior art', 'general-purpose'], ['Trace SubagentStart', 'Explore'],
] as const;
/** CORA_SIM_WILD=1: sessions fan out wide and deep (screenshots of a busy scene); off, the simulation is as usual */
const WILD = process.env.CORA_SIM_WILD === '1';
const HELPERS = ['Dig into the parser', 'Check the hook payloads', 'Trace the sink', 'Read the call sites', ...(WILD ? ['Diff the schemas', 'Probe the retry path', 'Grep the fixtures', 'Replay the failing run'] : [])];
const REPORTS = [
  'SubagentStart/Stop exist in the CLI; agent_id + agent_type ride on every hook fired inside a subagent.',
  'Subagent transcripts live at <session>/subagents/agent-<id>.jsonl; thinking blocks are present but empty.',
  'tool_use_id pairs Pre/PostToolUse exactly; http hooks can POST straight to a local server.',
];

class SimSession {
  /** main's context size; grows each turn and drops on compaction */
  private ctx = rnd(60_000, 140_000);
  private taskSeq = 0;
  /** helpers' names in use (no two at once share one) */
  private helpers = new Set<string>();
  constructor(private sid: string, private cwd: string, private p: Pipeline, private pending: PendingManager | undefined, private permProb: number, private topic: Topic, private opening?: Call) {}

  private base(agentId: string) {
    return { session_id: this.sid, cwd: this.cwd, transcript_path: `C:\\Users\\dev\\.claude\\projects\\sim\\${this.sid}.jsonl`, ...(agentId !== 'main' ? { agent_id: agentId, agent_type: 'Explore' } : {}) };
  }
  private hook(event: string, agentId: string, extra: object) {
    this.p.ingestHook(event, { ...this.base(agentId), hook_event_name: event, ...extra });
  }
  private narrate(agentId: string, text: string) {
    this.p.ingestEvents([{ id: uid('say'), sessionId: this.sid, agentId, ts: Date.now(), kind: 'say', icon: EVENT_ICON.say, text, source: 'transcript' }]);
  }
  private async think(agentId: string, ms: number) {
    await sleep(ms);
    this.p.ingestEvents([{
      id: uid('think'), sessionId: this.sid, agentId, ts: Date.now(), kind: 'think', phase: 'end', icon: EVENT_ICON.think, durationMs: Math.round(ms),
      tokens: { in: Math.round(agentId === 'main' ? (this.ctx += rnd(2000, 7000)) : rnd(20000, 90000)), out: Math.round(ms / 6), thinking: Math.round(ms / 9) }, source: 'transcript',
    }]);
  }

  private async tool(agentId: string, call: Call, ms: number): Promise<string> {
    const id = uid('toolu_sim');
    // a session that asks: the command it asks about is the one it runs (the card and the transcript agree)
    const asks = !!this.pending && agentId === 'main' && call.tool === 'Bash' && !call.input.run_in_background && Math.random() < this.permProb;
    const c = asks ? PUSH : call;
    this.hook('PreToolUse', agentId, { tool_name: c.tool, tool_input: c.input, tool_use_id: id });
    if (asks && this.pending) {
      const out: any = await this.pending.request('permission', { ...this.base(agentId), tool_name: c.tool, tool_input: c.input, tool_use_id: id });
      if (out?.hookSpecificOutput?.decision?.behavior === 'deny') {
        this.hook('PostToolUseFailure', agentId, { tool_name: c.tool, tool_input: c.input, tool_use_id: id, error: 'Permission denied by user', duration_ms: 0 });
        return id;
      }
    }
    await sleep(ms);
    if (c.fail) this.hook('PostToolUseFailure', agentId, { tool_name: c.tool, tool_input: c.input, tool_use_id: id, error: c.fail, duration_ms: Math.round(ms) });
    else this.hook('PostToolUse', agentId, { tool_name: c.tool, tool_input: c.input, tool_response: c.response, tool_use_id: id, duration_ms: Math.round(ms) });
    return id;
  }

  /**
   * A command sent to the background (a pipeline watcher): returns at once, writes output for half a minute or so,
   * then Claude Code's task-notification says how it ended.
   */
  private async background() {
    const taskId = `b${Math.random().toString(36).slice(2, 10)}`;
    const dir = join(tmpdir(), 'cora-sim');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${taskId}.output`);
    writeFileSync(file, '');
    const command = 'glab ci status --live --branch fix/hooks';
    const input = { command, description: 'Watch the MR pipeline until it finishes', run_in_background: true };
    const id = await this.tool('main', { tool: 'Bash', input, response: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: taskId } }, 250);
    this.p.ingestEvents([{ id: `tool:${id}:end`, sessionId: this.sid, agentId: 'main', ts: Date.now(), kind: 'tool', phase: 'end', toolUseId: id, icon: EVENT_ICON.task, source: 'transcript', tool: { name: 'Bash', input, summary: command, resultSummary: 'running in background', resource: 'shell', background: { taskId, outputFile: file } } }]);
    const fail = Math.random() < 0.25;
    for (const stage of ['build', 'lint', 'test', 'deploy']) {
      appendFileSync(file, `stage ${stage}: running\n`);
      await sleep(rnd(5000, 9000));
      if (fail && stage === 'test') {
        appendFileSync(file, `stage ${stage}: failed (2 tests)\n`);
        break;
      }
      appendFileSync(file, `stage ${stage}: passed\n`);
    }
    const summary = fail ? `Background command "Watch the MR pipeline until it finishes" failed with exit code 1` : `Background command "Watch the MR pipeline until it finishes" completed (exit code 0)`;
    this.p.ingestEvents([{ id: `task:${taskId}`, sessionId: this.sid, agentId: 'main', ts: Date.now(), kind: 'task', toolUseId: id, icon: EVENT_ICON.task, source: 'transcript', text: summary, task: { id: taskId, status: fail ? 'failed' : 'completed', exit: fail ? 1 : 0, outputFile: file } }]);
  }

  /** `parent` starts a subagent (main, or a subagent starting one of its own) and waits for its report. */
  private async spawn(parent: string, description: string, type: string, steps: number, depth: number) {
    const toolUseId = uid('toolu_agent');
    const agentId = `a${uid('')}`;
    const prompt = `${description}: investigate and report back.`;
    const input = { description, prompt, subagent_type: type, run_in_background: parent === 'main' };
    this.hook('PreToolUse', parent, { tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId });
    this.hook('SubagentStart', agentId, { agent_id: agentId, agent_type: type });
    this.hook('PostToolUse', parent, { tool_name: 'Agent', tool_input: input, tool_use_id: toolUseId, duration_ms: 8, tool_response: { isAsync: true, status: 'async_launched', agentId, description, prompt } });
    this.p.ingestEvents([{ id: uid('p'), sessionId: this.sid, agentId, ts: Date.now(), kind: 'prompt', icon: EVENT_ICON.prompt, text: prompt, source: 'transcript' }]);
    await this.sub(agentId, steps, depth);
  }

  private async sub(agentId: string, steps: number, depth = 1) {
    for (let i = 0; i < steps; i++) {
      await this.think(agentId, rnd(500, 2200));
      if (Math.random() < 0.4) this.narrate(agentId, pick(LINES));
      // now and then a subagent hands part of its job to one of its own
      if ((i === 1 || (WILD && i === 2)) && depth < 3 && Math.random() < (WILD ? (depth === 1 ? 0.9 : 0.6) : depth === 1 ? 0.5 : 0.3)) {
        const name = HELPERS.find((n) => !this.helpers.has(n));
        if (name) {
          this.helpers.add(name);
          this.narrate(agentId, 'Handing part of this to a helper.');
          await this.spawn(agentId, name, 'Explore', (WILD ? 4 : 2) + Math.floor(Math.random() * 3), depth + 1);
          this.helpers.delete(name);
        }
      }
      await this.tool(agentId, pick(calls(this.cwd)), rnd(500, 2600));
    }
    this.narrate(agentId, 'Done. Reporting back.');
    await sleep(500);
    this.hook('SubagentStop', agentId, { last_assistant_message: pick(REPORTS), agent_transcript_path: '' });
  }

  async run(stopped: () => boolean) {
    if (this.opening) await this.tool('main', this.opening, 600);
    while (!stopped()) {
      const promptId = uid('prompt');
      this.hook('UserPromptSubmit', 'main', { prompt: this.topic.prompt, prompt_id: promptId });
      // Claude's task list is the session's: a plan on the first turn only (later turns just work)
      const planning = this.taskSeq === 0;
      await this.think('main', rnd(800, 1600));
      // a task list, like Claude's TaskCreate / TaskUpdate (ids are per session and sequential)
      const plan = this.topic.plan;
      const ids: string[] = [];
      for (const [subject, activeForm] of planning ? plan : []) {
        const id = String(++this.taskSeq);
        ids.push(id);
        await this.tool('main', { tool: 'TaskCreate', input: { subject, description: subject, activeForm }, response: { task: { id, subject } } }, rnd(150, 300));
      }
      const task = async (i: number, status: string) => void (ids[i] && (await this.tool('main', { tool: 'TaskUpdate', input: { taskId: ids[i], status }, response: { success: true } }, rnd(80, 160))));
      await task(0, 'in_progress');
      // the Board laid out for its work, as a session does with the board tool
      if (this.topic.board) await this.tool('main', { tool: BOARD_TOOL, input: { layout: this.topic.board[0], reason: this.topic.board[1] }, response: { content: [{ type: 'text', text: 'Asked Cora to lay out the Board.' }] } }, rnd(150, 300));
      if (Math.random() < 0.5) void this.background();
      this.narrate('main', `${this.topic.plan[0][1]} before I fan out.`);
      await this.tool('main', calls(this.cwd)[1], rnd(600, 1200));
      await task(0, 'completed');
      await task(1, 'in_progress');
      // now and then a helper left working in the background, past the end of the turn (as Claude Code's agents can be)
      if (Math.random() < (process.env.CORA_SIM_BACKGROUND === '1' ? 1 : 0.25)) void this.spawn('main', 'Watch the pipeline', 'general-purpose', 10 + Math.floor(Math.random() * 6), 1);
      if (WILD || Math.random() < 0.8) {
        const k = WILD ? 5 + Math.floor(Math.random() * 2) : Math.random() < 0.5 ? 2 : 3;
        this.narrate('main', k === 3 ? 'Splitting this three ways. Explorers, go.' : 'Two explorers out. Waiting on both.');
        const picked = [...TASKS].sort(() => Math.random() - 0.5).slice(0, k);
        const runs = picked.map(async ([description, type], i) => {
          await sleep(i * 250);
          await this.spawn('main', description, type, (WILD ? 6 : 3) + Math.floor(Math.random() * 4), 1);
        });
        await Promise.all(runs);
        this.narrate('main', 'All reports in. Synthesizing.');
      }
      await task(1, 'completed');
      await task(2, 'in_progress');
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
        await this.think('main', rnd(600, 1500));
        await this.tool('main', pick(calls(this.cwd)), rnd(500, 1800));
      }
      if (this.topic.explain && Math.random() < 0.6) {
        const input = { title: this.topic.explain.title, format: 'markdown', content: this.topic.explain.content };
        await this.tool('main', { tool: PRESENT_TOOL, input, response: { content: [{ type: 'text', text: `Shown to the user as "${input.title}".` }] } }, rnd(500, 900));
      }
      this.narrate('main', this.topic.done);
      if (this.ctx > 170_000) {
        await sleep(1500);
        this.p.ingestEvents([{ id: uid('compact'), sessionId: this.sid, agentId: 'main', ts: Date.now(), kind: 'compact', icon: EVENT_ICON.compact, source: 'transcript' }]);
        this.ctx = rnd(30_000, 50_000);
      }
      await task(2, 'completed');
      this.hook('Stop', 'main', { last_assistant_message: 'done', stop_hook_active: false });
      // the transcript's note that the turn ended (what the overview counts turns by)
      this.p.ingestEvents([{ id: uid('turn'), sessionId: this.sid, agentId: 'main', ts: Date.now(), kind: 'turn_end', icon: EVENT_ICON.turn_end, durationMs: Math.round(rnd(40_000, 160_000)), source: 'transcript' }]);
      await sleep(rnd(6000, 14000) + (LITE ? 30_000 : 0));
    }
  }
}

/**
 * A live explain, as a session keeps one: the release
 * session writes its dashboard once, then rewrites the data at each step, round and round.
 */
const RELEASE_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Release 2.4</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
  body { margin: 0; padding: 22px; background: var(--bg); color: var(--ink); font: 14px/1.5 system-ui, sans-serif; }
  h1 { margin: 0 0 4px; font-size: 20px; } .sub { color: var(--ink3); font-size: 12.5px; margin-bottom: 18px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 12px; margin-bottom: 14px; }
  .card { background: var(--panel); border: 1px solid var(--hair); border-radius: 12px; padding: 14px 16px; }
  .k { color: var(--ink3); font-size: 11.5px; text-transform: uppercase; letter-spacing: .08em; }
  .v { font-size: 28px; font-weight: 650; margin-top: 4px; } .v small { font-size: 13px; color: var(--ink3); font-weight: 400; }
  .stages { display: flex; flex-direction: column; gap: 8px; }
  .st { display: grid; grid-template-columns: 18px 1fr auto; gap: 10px; align-items: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--hair); justify-self: center; }
  .st.done .dot { background: var(--ok); } .st.run .dot { background: var(--cora); box-shadow: 0 0 0 4px color-mix(in srgb, var(--cora) 25%, transparent); }
  .st.wait .dot { background: var(--warn); } .st .t { color: var(--ink3); font-size: 12px; } .st.todo { color: var(--ink3); }
  .bar { height: 6px; border-radius: 3px; background: var(--panel2); overflow: hidden; margin-top: 10px; } .bar i { display: block; height: 100%; background: var(--cora); transition: width .4s; }
</style></head><body>
<h1>Release 2.4</h1><div class="sub" id="sub">aurora-web · starting…</div>
<div class="grid">
  <div class="card"><div class="k">Tests</div><div class="v" id="tests">–</div><div class="bar"><i id="tbar" style="width:0"></i></div></div>
  <div class="card"><div class="k">Image</div><div class="v" id="image">–</div></div>
  <div class="card"><div class="k">Elapsed</div><div class="v" id="elapsed">–</div></div>
</div>
<div class="grid" style="grid-template-columns: minmax(240px, 1fr) minmax(240px, 1.4fr)">
  <div class="card"><div class="k" style="margin-bottom:10px">Stages</div><div class="stages" id="stages"></div></div>
  <div class="card"><div class="k" style="margin-bottom:10px">Image size by release (MB)</div><canvas id="chart" height="160"></canvas></div>
</div>
<script>
  var css = getComputedStyle(document.documentElement), c = (n) => css.getPropertyValue(n).trim();
  var chart = window.Chart ? new Chart(document.getElementById('chart'), {
    type: 'bar',
    data: { labels: ['2.1', '2.2', '2.3', '2.4'], datasets: [{ data: [271, 266, 260, 0], backgroundColor: [c('--panel2'), c('--panel2'), c('--panel2'), c('--cora')], borderRadius: 6 }] },
    options: { animation: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: c('--ink3') }, grid: { display: false } }, y: { ticks: { color: c('--ink3') }, grid: { color: c('--hair') } } } }
  }) : null;
  cora.onData(function (d) {
    document.getElementById('sub').textContent = 'aurora-web · ' + d.status;
    document.getElementById('tests').innerHTML = d.tests.passed + ' <small>/ ' + d.tests.total + '</small>';
    document.getElementById('tbar').style.width = (100 * d.tests.passed / d.tests.total) + '%';
    document.getElementById('image').innerHTML = d.image ? d.image + ' <small>MB</small>' : '–';
    document.getElementById('elapsed').textContent = d.elapsed;
    document.getElementById('stages').innerHTML = d.stages.map(function (s) {
      return '<div class="st ' + s.state + '"><span class="dot"></span><span>' + s.name + '</span><span class="t">' + (s.note || '') + '</span></div>';
    }).join('');
    if (chart) { chart.data.datasets[0].data[3] = d.image || 0; chart.update('none'); }
  });
</script></body></html>
`;
type Stage = { name: string; state: 'done' | 'run' | 'wait' | 'todo'; note?: string };
function releaseSteps(): Array<{ status: string; tests: { passed: number; total: number }; image: number | null; stages: Stage[] }> {
  const names = ['Bump version and changelog', 'Run the tests', 'Build the image', 'Push the image', 'Deploy to staging'];
  const at = (i: number, notes: Record<number, string> = {}, wait = -1): Stage[] => names.map((name, n) => ({ name, state: n < i ? 'done' : n === wait ? 'wait' : n === i ? 'run' : 'todo', ...(notes[n] ? { note: notes[n] } : {}) }));
  const out: ReturnType<typeof releaseSteps> = [{ status: 'bumping the version', tests: { passed: 0, total: 412 }, image: null, stages: at(0) }];
  for (const passed of [96, 188, 251, 330, 412]) out.push({ status: 'running the tests', tests: { passed, total: 412 }, image: null, stages: at(1, { 0: '2.4.0' }) });
  out.push({ status: 'building the image', tests: { passed: 412, total: 412 }, image: null, stages: at(2, { 0: '2.4.0', 1: '412 passed' }) });
  out.push({ status: 'waiting for your OK to push', tests: { passed: 412, total: 412 }, image: 212, stages: at(3, { 0: '2.4.0', 1: '412 passed', 2: '212 MB' }, 3) });
  out.push({ status: 'deploying to staging', tests: { passed: 412, total: 412 }, image: 212, stages: at(4, { 0: '2.4.0', 1: '412 passed', 2: '212 MB', 3: 'pushed' }) });
  out.push({ status: 'live on staging', tests: { passed: 412, total: 412 }, image: 212, stages: at(5, { 0: '2.4.0', 1: '412 passed', 2: '212 MB', 3: 'pushed', 4: '3/3 pods ready' }) });
  return out;
}
async function releaseDashboard(live: { start(sid: string, title: string): { page: string; data: string } }, sid: string, stopped: () => boolean): Promise<void> {
  await sleep(4000);
  const f = live.start(sid, 'Release 2.4');
  writeFileSync(f.page, RELEASE_PAGE);
  const began = Date.now();
  while (!stopped()) {
    for (const step of releaseSteps()) {
      if (stopped()) return;
      const s = Math.round((Date.now() - began) / 1000);
      writeFileSync(f.data, JSON.stringify({ ...step, elapsed: `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` }));
      await sleep(2600);
    }
    await sleep(6000);
  }
}

/**
 * Cora's agent in a simulation (no real agent is started): on, with a goal under way and a short conversation in its
 * console, so it can be seen and shown. Its session is hidden from the list, as the real one is.
 */
const CORA_SID = 'sim-cora-0000';
function simCora(p: Pipeline, show: (st: OrchestratorStatus) => void, stopped: () => boolean): void {
  const now = Date.now();
  const status: OrchestratorStatus = {
    enabled: true,
    speak: false,
    model: 'opus',
    sessionId: CORA_SID,
    terminalId: null,
    running: true,
    approvals: [],
    control: false,
    goal: { id: 'g1', text: 'Get release 2.4 green and out to staging', state: 'running', createdAt: now - 40 * 60_000, updatedAt: now, budget: 2_000_000, spent: 640_000, workers: ['sim-web-0002'], progress: 0.7, note: 'Image built; waiting on your OK to push it.' },
  };
  show(status);
  const at = now - 30 * 60_000;
  p.ingestHook('SessionStart', { session_id: CORA_SID, cwd: 'C:\\Users\\you\\.cora\\orchestrator', transcript_path: '', hook_event_name: 'SessionStart', source: 'startup' });
  const lines: Array<['prompt' | 'say', string]> = [
    ['prompt', 'Morning. What needs me?'],
    ['say', "Morning. Three things:\n\n- **Ship release 2.4** is waiting for your OK to push the image. Everything before it passed.\n- **Wire the HTTP sink** finished overnight. Tests are green, and it wrote up the plan as an explain.\n- **Kira** asked in Slack whether 2.10 is on staging yet. QA wants to start today."],
    ['prompt', "Tell Kira it'll be there after lunch."],
    ['say', "Drafted for you to check: \"It'll be on staging after lunch, I'll ping you when it's up.\" It's waiting in Slack's outbox."],
    ['prompt', 'And keep an eye on the release for me.'],
    ['say', "On it. I'll tell you when the image is pushed and the staging deploy is green, or the moment anything fails."],
  ];
  lines.forEach(([kind, text], i) =>
    p.ingestEvents([{ id: `sim-cora-${i}`, sessionId: CORA_SID, agentId: 'main', ts: at + i * 90_000, kind, icon: kind === 'prompt' ? EVENT_ICON.prompt : EVENT_ICON.say, text, source: 'transcript' }]),
  );
  // it stays on (a real one would), told again now and then
  const again = setInterval(() => (stopped() ? clearInterval(again) : show({ ...status, goal: status.goal && { ...status.goal, updatedAt: Date.now() } })), 30_000);
}

/**
 * `repo`: a real git checkout one session works in (its GitLab pipelines are read for real, read-only); it opens by
 * looking at the default branch's pipeline, as `glab ci status --branch main` would. `name`: gives the sessions their
 * names (as you'd rename one); `cora`: shows Cora's agent as on, with a goal and a conversation.
 */
export function startSim(pipeline: Pipeline, pending?: PendingManager, o: { repo?: string; name?: (sessionId: string, name: string) => void; cora?: (st: OrchestratorStatus) => void; live?: { start(sid: string, title: string): { page: string; data: string } }; /** shows the simulated integrations (simShow.ts) */ show?: (m: import('@cora/shared').ServerMsg) => void } = {}): () => void {
  let stopped = false;
  const look: Call = { tool: 'Bash', input: { command: 'glab ci status --branch main' }, response: { stdout: '', stderr: '' } };
  const sessions: Array<[string, SimSession, Topic]> = [
    ['sim-api-0001', new SimSession('sim-api-0001', CWD.api, pipeline, pending, 0, TOPICS.audit), TOPICS.audit],
    ['sim-web-0002', new SimSession('sim-web-0002', CWD.web, pipeline, pending, 0.6, TOPICS.release), TOPICS.release],
    ['sim-cli-0003', new SimSession('sim-cli-0003', o.repo ?? CWD.cli, pipeline, pending, 0, TOPICS.scheduler, o.repo ? look : undefined), TOPICS.scheduler],
    // a second session in the same folder (the galaxy overview clusters by directory)
    ['sim-api-0004', new SimSession('sim-api-0004', CWD.api, pipeline, pending, 0, TOPICS.sink), TOPICS.sink],
    // the Spotlight's showpiece: a live load test (simLoad.ts)
    ['sim-api-0005', new SimSession('sim-api-0005', CWD.api, pipeline, pending, 0, TOPICS.loadtest), TOPICS.loadtest],
  ];
  (LITE ? sessions.slice(0, 2) : sessions).forEach(([id, s, t], i) =>
    setTimeout(() => {
      void s.run(() => stopped);
      // named once it exists (its first hook made it)
      setTimeout(() => o.name?.(id, t.name), 1500);
    }, i * 1500),
  );
  if (o.cora) simCora(pipeline, o.cora, () => stopped);
  // the release session keeps a live dashboard
  if (o.live) void releaseDashboard(o.live, 'sim-web-0002', () => stopped);
  if (o.show) startSimShow(o.show, () => stopped);
  if (o.live && !LITE) void loadDashboard(o.live, 'sim-api-0005', () => stopped, (ms) => new Promise((r) => setTimeout(r, ms)));
  return () => {
    stopped = true;
  };
}

/** Cora's Inbox in a simulation: one of each source, some read (for screenshots). */
export function seedInbox(inbox: import('./inbox').Inbox): void {
  const now = Date.now();
  const at = (minAgo: number) => now - minAgo * 60_000;
  inbox.add({ source: 'cora', key: 'cora:start:ACME-5301', title: 'Started ACME-5301 in orion-services', why: 'assigned to you, and Cora starts these', read: true, entry: { id: 's1', text: 'On its own: it reads ACME-5301, then stops at a plan', at: at(60 * 20) } });
  inbox.add({ source: 'gitlab', key: 'ci:acme/orion-services@main', title: 'orion-services · main', why: 'a pipeline orion-services follows', state: 'ok', replace: true, read: true, link: 'https://gitlab.com', entry: { id: 'p1:success', text: 'Pipeline #48112 passed', at: at(80) } });
  inbox.add({ source: 'mail', key: 'mail:t-qa', title: 'QA team · Re: staging login', why: 'a watch: QA on the login bug', did: 'Started a session in C:/code/orion-services', link: 'https://mail.google.com', entry: { id: 'm-qa', who: 'QA team', text: 'Confirmed on staging: the login bug is back after the 2.10 deploy.', at: at(64) } });
  for (const [id, who, what, ago] of [['j1', 'Dana Ruiz', 'moved it to QA review', 50], ['j2', 'Dana Ruiz', 'commented: @Ana this is available on dev', 42]] as const)
    inbox.add({ source: 'jira', key: 'jira:ACME-4922', title: 'ACME-4922 · Saved search dedupe fails on reload', why: 'a comment on your ticket', link: 'https://example.atlassian.net/browse/ACME-4922', entry: { id, who, text: what, at: at(ago) } });
  inbox.add({ source: 'slack', key: 'slack:CCAPOPS:1760890000.1', title: '#platform-ops · mentioned you', why: 'you were mentioned', link: 'https://example.slack.com/archives/CCAPOPS/p17608900001', entry: { id: '1760890000.1', who: 'Sam Ito', text: '@alex the nightly export job failed again on node 3', at: at(38) } });
  for (const [id, text, ago] of [['1760890100.1', 'Is the 2.10 build on staging yet? QA wants to start today.', 12], ['1760890200.1', "No rush if it's not, just let me know when.", 10]] as const)
    inbox.add({ source: 'slack', key: 'slack:DKIRA', title: 'Kira (DM)', why: 'a DM to you', link: 'https://example.slack.com/archives/DKIRA/p17608901001', entry: { id, who: 'Kira', text, at: at(ago) } });
  inbox.add({ source: 'mail', key: 'mail:t-inv', title: 'Billing · Invoice 2291 is ready', why: 'your rule: invoices', link: 'https://mail.google.com', entry: { id: 'm-inv', who: 'Billing', text: 'Your invoice for October is attached.', at: at(30) } });
}
