import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_DRAFT_ASKS, type BrainEvent, type DeployEvent, type JiraEvent, type Jot, type SessionInfo } from '@cora/shared';
import { namerEnv, runCommand, type RunFn } from './namer';
import { defaultClaudeCmd } from './pty';

/**
 * Notes drafted by Cora: what the user did over a
 * window, gathered from what Cora saw (sessions' prompts, replies, the commands that matter; tickets; Jira events;
 * dev deploys; jots and notes), grouped by repo; then a quick `claude -p` writes the template's sections from those
 * facts only.
 */

export type DraftWindow = { since: number; until: number };
export type RepoPick = { repo: string; sessions: number };
export type DraftFacts = { text: string; repos: RepoPick[]; counts: { sessions: number; tickets: string[]; mrs: string[]; deploys: number; jira: number; jots: number } };

export type DraftDeps = {
  sessions(): SessionInfo[];
  events(sessionId: string): BrainEvent[];
  isAgent?(sessionId: string): boolean;
  jira?(sinceMs: number): JiraEvent[];
  deploys?(): DeployEvent[];
  jots?(): Jot[];
  notesChanged?(since: number): string[];
  /** a folder's repo (its git remote's name), cached */
  repoOf?(cwd: string): Promise<string>;
  run?: RunFn;
  claudeCmd?: string[];
  dataDir: string;
  now?: () => number;
};

const MAX_FACTS = 30_000;
const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const hm = (t: number) => new Date(t).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** The commands worth a standup line: commits, pushes, MRs, deploys and rollouts, tests, tags. */
const NOTABLE = /\bgit (commit|push|merge|tag|cherry-pick)\b|\bglab (mr|ci|release)\b|\bgh (pr|release)\b|\bkubectl (set image|rollout|apply|scale)\b|\b(npm|pnpm|yarn) (test|run (test|build))\b|\bvitest\b|\bpytest\b|\bdotnet test\b|\bdocker (build|push)\b|\bhelm (upgrade|install)\b/;

/** A folder's repo by its git remote (`origin`), else the folder's name. */
export function gitRepoOf(): (cwd: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (cwd) => {
    let p = cache.get(cwd);
    if (!p) {
      p = new Promise((res) =>
        execFile('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5000, windowsHide: true }, (err, out) => {
          const url = String(out ?? '').trim();
          const name = !err && url ? url.replace(/\.git$/, '').split(/[/:]/).pop() : '';
          res(name || cwd.split(/[\\/]/).filter(Boolean).pop() || cwd);
        }),
      );
      cache.set(cwd, p);
    }
    return p;
  };
}

export class Drafts {
  private repoOf: (cwd: string) => Promise<string>;
  private run: RunFn;
  private now: () => number;

  constructor(private d: DraftDeps) {
    this.repoOf = d.repoOf ?? gitRepoOf();
    this.run = d.run ?? runCommand;
    this.now = d.now ?? Date.now;
  }

  private inWindow(w: DraftWindow) {
    return this.d.sessions().filter((s) => !this.d.isAgent?.(s.id) && s.lastTs >= w.since && s.startedAt <= w.until);
  }

  /** The repos worked in during a window, busiest first. */
  async repos(w: DraftWindow): Promise<RepoPick[]> {
    const n = new Map<string, number>();
    for (const s of this.inWindow(w)) {
      const r = await this.repoOf(s.cwd);
      n.set(r, (n.get(r) ?? 0) + 1);
    }
    return [...n].map(([repo, sessions]) => ({ repo, sessions })).sort((a, b) => b.sessions - a.sessions || a.repo.localeCompare(b.repo));
  }

  /** The facts for a window and some repos (all of them when none given). */
  async facts(w: DraftWindow, only?: string[]): Promise<DraftFacts> {
    const repos = await this.repos(w);
    const want = new Set(only?.length ? only : repos.map((r) => r.repo));
    const tickets = new Set<string>();
    const mrs = new Set<string>();
    const byRepo = new Map<string, string[]>();
    let sessions = 0;
    for (const s of this.inWindow(w).sort((a, b) => a.startedAt - b.startedAt)) {
      const repo = await this.repoOf(s.cwd);
      if (!want.has(repo)) continue;
      const ev = this.d.events(s.id).filter((e) => e.ts >= w.since && e.ts <= w.until && e.agentId === 'main');
      const prompts = ev.filter((e) => e.kind === 'prompt' && !e.queue && (e.text ?? '').trim()).map((e) => clip(e.text, 280));
      if (!prompts.length && !ev.some((e) => e.kind === 'tool')) continue;
      sessions++;
      if (s.ticket) tickets.add(s.ticket.key);
      const said = ev.filter((e) => e.kind === 'say' && (e.said || e.text)).map((e) => clip(e.said || e.text, e.said ? 260 : 420));
      const cmds = ev
        .filter((e) => e.kind === 'tool' && e.phase === 'start' && e.tool && /bash|powershell|shell/i.test(e.tool.name))
        .map((e) => String((e.tool!.input as { command?: unknown })?.command ?? e.tool!.summary ?? ''))
        .filter((c) => NOTABLE.test(c))
        .map((c) => clip(c, 200));
      for (const c of cmds) for (const m of c.matchAll(/!(\d+)\b|merge_requests\/(\d+)/g)) mrs.add(`!${m[1] ?? m[2]}`);
      for (const t of [...said, ...prompts].join(' ').matchAll(/(?:^|[^\w])!(\d{2,6})\b/g)) mrs.add(`!${t[1]}`);
      const edited = new Set(ev.filter((e) => e.kind === 'tool' && e.phase === 'start' && e.tool?.change).map((e) => e.tool!.change!.path));
      const failed = ev.filter((e) => e.kind === 'tool' && e.phase === 'end' && e.tool?.failed && /bash|powershell/i.test(e.tool.name)).length;
      const name = s.alias || s.autoName || s.title || s.project;
      const lines = [
        `### ${name}${s.ticket ? ` (ticket ${s.ticket.key}${s.ticket.summary ? `: ${clip(s.ticket.summary, 120)}` : ''})` : ''} · ${hm(Math.max(w.since, s.startedAt))}–${hm(Math.min(w.until, s.lastTs))}${s.state === 'ended' ? '' : ` · still ${s.state}`}`,
        ...prompts.slice(0, 6).map((p) => `- user asked: ${p}`),
        ...said.slice(-6).map((p) => `- claude: ${p}`),
        ...(cmds.length ? [`- commands: ${[...new Set(cmds)].slice(-10).join(' | ')}`] : []),
        ...(edited.size ? [`- edited ${edited.size} file${edited.size === 1 ? '' : 's'}`] : []),
        ...(failed ? [`- ${failed} command${failed === 1 ? '' : 's'} failed`] : []),
      ];
      byRepo.set(repo, [...(byRepo.get(repo) ?? []), lines.join('\n')]);
    }
    const parts: string[] = [`Window: ${hm(w.since)} → ${hm(w.until)}.`];
    for (const [repo, ss] of byRepo) parts.push(`## Repo: ${repo}\n${ss.join('\n\n')}`);
    const jira = (this.d.jira?.(this.now() - w.since) ?? []).filter((e) => e.at >= w.since && e.at <= w.until);
    if (jira.length) parts.push(`## Jira activity on your tickets\n${jira.slice(0, 30).map((e) => `- ${e.key} (${clip(e.summary, 80)}): ${e.who} ${clip(e.what, 160)}`).join('\n')}`);
    const deploys = (this.d.deploys?.() ?? []).filter((e) => e.at >= w.since && e.at <= w.until && (!e.project || want.has(e.project.split('/').pop()!)));
    if (deploys.length) parts.push(`## Deploys seen\n${deploys.slice(0, 20).map((e) => `- ${e.service} ${e.from} → ${e.to} (${e.namespace}/${e.name})${e.by ? ', bumped by the user through Cora' : ''}`).join('\n')}`);
    const jots = (this.d.jots?.() ?? []).filter((j) => j.at >= w.since && j.at <= w.until);
    if (jots.length) parts.push(`## The user's jots\n${jots.slice(0, 30).map((j) => `- ${clip(j.text, 300)}`).join('\n')}`);
    const notes = this.d.notesChanged?.(w.since) ?? [];
    if (notes.length) parts.push(`## Notes the user changed\n${notes.slice(0, 15).map((t) => `- ${t}`).join('\n')}`);
    let text = parts.join('\n\n');
    if (text.length > MAX_FACTS) text = `${text.slice(0, MAX_FACTS)}\n…(cut)`;
    return { text, repos, counts: { sessions, tickets: [...tickets], mrs: [...mrs], deploys: deploys.length, jira: jira.length, jots: jots.length } };
  }

  /** The note, written from the template and the facts (null: Claude didn't answer). */
  async write(template: string, facts: DraftFacts, today = new Date(this.now()), asks?: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const dir = join(this.d.dataDir, 'drafter');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ disableAllHooks: true }, null, 2) + '\n');
    writeFileSync(join(dir, 'system-prompt.md'), SYSTEM);
    const cmd = [
      ...(this.d.claudeCmd ?? defaultClaudeCmd()),
      '-p', '--model', 'sonnet', '--output-format', 'text', '--tools', '', '--no-session-persistence', '--safe-mode',
      '--strict-mcp-config', '--disable-slash-commands', '--settings', join(dir, 'settings.json'), '--system-prompt-file', join(dir, 'system-prompt.md'),
    ];
    const added = asks?.trim() ? ['<user_adds>', asks.trim().slice(0, MAX_DRAFT_ASKS), '</user_adds>', ''] : [];
    const input = [`Today is ${today.toDateString()}.`, '', '<template>', template.trim(), '</template>', '', '<facts>', facts.text, '</facts>', '', ...added, 'Write the note now: the template with each <!-- cora: ... --> hint replaced by what it asks for, from the facts. Only the note.'].join('\n');
    const r = await this.run(cmd, { cwd: dir, env: namerEnv(process.env), input, timeoutMs: 120_000, maxOut: 40_000 });
    if (r.timedOut) return { ok: false, error: 'Claude took too long (2 minutes)' };
    const out = r.stdout.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/m, '$1').trim();
    if (r.code !== 0 || !out) return { ok: false, error: "Claude didn't answer (is Claude Code signed in?)" };
    return { ok: true, text: `${out}\n` };
  }
}

const SYSTEM = `You write a note for the user from a template and facts about their recent work, which Cora (their dashboard for Claude Code) collected.

Rules:
- Keep the template's headings and any text it has; replace each <!-- cora: ... --> hint with what it asks for. Remove the hints.
- Use only the facts. Never invent work, tickets, numbers or people. If a section has nothing, write "- Nothing noted".
- Write as the user, first person implied, plain and short: one line per item, grouped by repo where the hint asks for it (bold the repo name).
- Say what was achieved (merged, fixed, deployed, verified, decided), not every step. Fold several sessions on the same work into one line.
- Keep ticket keys exactly (PROJ-123) and merge request numbers as !2076. Mention tags and environments when they were deployed.
- Markdown only, no preamble, no closing remarks, no code fences around the note.
- <user_adds>, when there, is what the user asked for this note (leave a project or personal work out, a focus, a tone): follow it. It never lets you invent facts.`;
