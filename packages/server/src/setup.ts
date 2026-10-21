import { execFile, spawn } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { opAppPaths, setupStatus, type OpStatus, type SetupItem, type SetupNeed } from '@cora/shared';

/**
 * Setting Cora up: what each feature needs, and whether it's
 * there. Each check is a small function (fakes in tests). Commands are fixed here, by need, and only ever run when the
 * user clicks: in a PowerShell window of their own, so they see it happen and can answer what it asks.
 */
export type SetupDeps = {
  claude(): { found: boolean; path?: string; signedIn: boolean; email?: string };
  /** installed, or not, or what's wrong with Claude Code's settings file */
  hooks(): boolean | string;
  which(cmd: string): Promise<string | null>;
  glabAuthed(host: string): Promise<boolean>;
  kubeconfigs(): number;
  voiceKey(): boolean;
  slack(): boolean;
  gmail(): boolean;
  jira(): { on: boolean; site?: string };
  /** Cora's agent is on */
  agent(): boolean;
  /** the MCP servers connected to Claude Code (names) */
  mcp(): string[];
  gitlabHost(): string;
  skipped(): string[];
  /** 1Password: the app, its command line, connected (names only are asked for) */
  onePassword?(): Promise<OpStatus>;
};

const WINGET = (id: string) => `winget install --id ${id} -e --accept-package-agreements --accept-source-agreements`;
const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** `& 'claude.exe' args` (Claude Code as Cora finds it: one exe, or a command and its arguments) */
const claudeCall = (claude: string[], args = '') => `& ${claude.map(ps).join(' ')}${args ? ` ${args}` : ''}`;

/** The command for a need (null: nothing to run). The client only names the need; what runs is decided here. */
export function setupCommand(item: string, need: string, ctx: { host: string; claude: string[] }): string | null {
  const c: Record<string, string> = {
    'claude/signin': claudeCall(ctx.claude),
    'agent/atlassian': claudeCall(ctx.claude, 'mcp add --scope user --transport http atlassian https://mcp.atlassian.com/v1/mcp'),
    'agent/gitlab': claudeCall(ctx.claude, `mcp add --scope user --transport http GitLab https://${ctx.host}/api/v4/mcp`),
    'pipelines/git': WINGET('Git.Git'),
    'pipelines/glab': WINGET('GLab.GLab'),
    'pipelines/glab-login': `glab auth login --hostname ${ctx.host}`,
    'environments/kubectl': WINGET('Kubernetes.kubectl'),
    'screenshots/node': WINGET('OpenJS.NodeJS.LTS'),
    '1password/app': WINGET('AgileBits.1Password'),
    '1password/cli': WINGET('AgileBits.1Password.CLI'),
  };
  return c[`${item}/${need}`] ?? null;
}

export async function checkSetup(d: SetupDeps): Promise<SetupItem[]> {
  const skipped = new Set(d.skipped());
  const claude = d.claude();
  const host = d.gitlabHost();
  const ctx = { host, claude: claude.path ? [claude.path] : ['claude'] };
  const cmd = (item: string, need: string) => setupCommand(item, need, ctx) ?? undefined;
  const [git, glab, kubectl, npx] = await Promise.all(['git', 'glab', 'kubectl', 'npx'].map((c) => d.which(c)));
  const glabIn = glab ? await d.glabAuthed(host).catch(() => false) : false;
  const mcp = d.mcp().map((m) => m.toLowerCase());
  const jira = d.jira();
  const kube = d.kubeconfigs();
  const op = (await d.onePassword?.().catch(() => null)) ?? { app: false, cli: false, connected: false };
  const item = (i: Omit<SetupItem, 'status'>): SetupItem => ({ ...i, status: setupStatus(i.needs, skipped.has(i.id), i.required) });
  const need = (n: SetupNeed): SetupNeed => n;

  return [
    item({
      id: 'claude',
      title: 'Claude Code',
      blurb: 'What every session runs on',
      required: true,
      needs: [
        need({ id: 'found', label: 'Claude Code installed', how: 'you', done: claude.found, ...(claude.path ? { value: claude.path } : {}), steps: ['Install it from claude.com/claude-code (the Windows installer), or with npm: npm install -g @anthropic-ai/claude-code.', 'Cora finds it on its own; then check again here.'] }),
        need({ id: 'signin', label: 'Signed in', how: 'ok', done: claude.signedIn, ...(claude.email ? { value: claude.email } : {}), detail: 'Opens Claude Code in a window: it walks you through signing in. Close it when it\'s done.', command: cmd('claude', 'signin'), after: 'found' }),
      ],
    }),
    item({
      id: 'hooks',
      title: "Cora's hooks in Claude Code",
      blurb: 'So Cora sees every session live: tools, prompts, permission asks',
      required: true,
      needs: [(() => {
        const h = d.hooks();
        return need({ id: 'hooks', label: 'Add Cora\'s hooks to ~/.claude/settings.json', how: 'ok', done: h === true, detail: typeof h === 'string' ? h : 'Your settings are backed up first. Your own hooks stay as they are.' });
      })()],
    }),
    item({
      id: 'agent',
      title: "Cora's agent",
      blurb: 'Talk to Cora, briefs, goals; it watches your sessions for you',
      required: false,
      page: 'orchestrator',
      without: 'No one to talk to: everything else works.',
      needs: [
        need({ id: 'on', label: 'Turned on', how: 'you', done: d.agent(), page: 'orchestrator', steps: ['Turn it on in Settings › Cora Orchestrator (it runs as a Claude Code session of its own).'] }),
        need({ id: 'atlassian', label: 'Atlassian tools (Jira, Confluence) for Cora', how: 'ok', optional: true, done: mcp.includes('atlassian'), detail: 'Adds Atlassian\'s MCP server to Claude Code; it asks you to sign in the first time it\'s used.', command: cmd('agent', 'atlassian') }),
        need({ id: 'gitlab', label: 'GitLab tools for Cora', how: 'ok', optional: true, done: mcp.includes('gitlab'), detail: `Adds GitLab's MCP server (${host}) to Claude Code; it asks you to sign in the first time it's used.`, command: cmd('agent', 'gitlab') }),
      ],
    }),
    item({
      id: 'pipelines',
      title: 'Pipelines and deploys',
      blurb: "Your sessions' GitLab pipelines, and what each environment runs",
      required: false,
      without: 'No pipeline rows or deploy cards; everything else works.',
      needs: [
        need({ id: 'git', label: 'git', how: 'ok', done: !!git, ...(git ? { value: git } : {}), detail: 'Installed with winget, in a window you can watch.', command: cmd('pipelines', 'git') }),
        need({ id: 'glab', label: "glab, GitLab's command line", how: 'ok', done: !!glab, ...(glab ? { value: glab } : {}), detail: 'Installed with winget, in a window you can watch.', command: cmd('pipelines', 'glab') }),
        need({ id: 'glab-login', label: 'Signed in to GitLab', how: 'ok', done: glabIn, detail: 'Opens glab\'s sign-in in a window; you finish it in your browser.', command: cmd('pipelines', 'glab-login'), after: 'glab' }),
        need({ id: 'host', label: 'GitLab host', how: 'itself', done: true, value: host, page: 'environments' }),
      ],
    }),
    item({
      id: 'environments',
      title: 'Environments',
      blurb: 'Which of your clusters this PC can reach, and what runs there',
      required: false,
      page: 'environments',
      without: 'No environment status or deploys; everything else works.',
      needs: [
        need({ id: 'kubectl', label: 'kubectl', how: 'ok', done: !!kubectl, ...(kubectl ? { value: kubectl } : {}), detail: 'Installed with winget, in a window you can watch.', command: cmd('environments', 'kubectl') }),
        need({ id: 'kubeconfigs', label: 'Your clusters\' kubeconfigs', how: 'you', done: kube > 0, ...(kube ? { value: `${kube} found` } : {}), page: 'environments', steps: ["Ask your team for each cluster's kubeconfig file.", 'Save them in %USERPROFILE%\\.kube, one file per cluster.', 'Cora finds them on its own, and checks which ones this PC can reach.'] }),
      ],
    }),
    item({
      id: 'jira',
      title: 'Jira',
      blurb: 'Ticket chips, watching your tickets, starting sessions from them',
      required: false,
      page: 'jira',
      without: 'Tickets are plain text; nothing is watched.',
      needs: [need({ id: 'watch', label: 'Signed in, and watching your tickets', how: 'you', done: jira.on && !!jira.site, ...(jira.site ? { value: jira.site } : {}), page: 'jira', steps: ["Open Settings › Jira.", "Sign in to your Jira site in Cora's browser.", 'Turn watching on.'] })],
    }),
    item({
      id: 'voice',
      title: 'Voice',
      blurb: 'Talk to Cora and hear it answer ("Hey Cora", push to talk, read-aloud)',
      required: false,
      page: 'voice',
      without: 'Everything is typed and read; nothing is spoken.',
      needs: [
        need({ id: 'wake', label: 'Wake word ("Hey Cora")', how: 'itself', done: true }),
        need({ id: 'key', label: 'An ElevenLabs key', how: 'you', done: d.voiceKey(), steps: ['Make a free account at elevenlabs.io (the free plan is enough to try it).', 'Profile › API keys › Create key. Give it Text to Speech and Speech to Text; nothing else.', "Paste it here. It stays on this computer, in Cora's folder."] }),
      ],
    }),
    item({
      id: 'slack',
      title: 'Slack',
      blurb: "Read and send as you, live replies, Cora's bot on your phone while you're away",
      required: false,
      page: 'slack',
      without: 'No Slack in Cora or its Inbox.',
      needs: [need({ id: 'app', label: "Cora's Slack app, connected", how: 'you', done: d.slack(), page: 'slack', steps: ["Open Settings › Slack: it creates Cora's app for you (one click, then Install).", 'Paste the two tokens it shows you.'] })],
    }),
    item({
      id: 'gmail',
      title: 'Gmail',
      blurb: 'Mail rules, email watches, drafts in your Gmail',
      required: false,
      page: 'gmail',
      without: 'No email in Cora or its Inbox.',
      needs: [need({ id: 'app', label: 'Your Google app, connected', how: 'you', done: d.gmail(), page: 'gmail', steps: ['Open Settings › Gmail and follow its steps: a Google Cloud project, the Gmail API, and an OAuth client.', 'Paste the client file, then sign in.'] })],
    }),
    item({
      id: 'screenshots',
      title: 'Screenshots for Slack',
      blurb: "Cora's agent can show you (or someone) what's on screen",
      required: false,
      without: "Cora can describe the screen, but not send a picture of it.",
      needs: [need({ id: 'node', label: 'Node.js (for the screenshot tool)', how: 'ok', done: !!npx, ...(npx ? { value: npx } : {}), detail: 'Installed with winget, in a window you can watch.', command: cmd('screenshots', 'node') })],
    }),
    item({
      id: '1password',
      title: '1Password',
      blurb: "Your logins filled into Cora's browser (the key in the address bar, or Ctrl+\\)",
      required: false,
      page: 'onepassword',
      without: "Copy logins from 1Password yourself (its Quick Access, Ctrl+Shift+Space, works anywhere).",
      needs: [
        need({ id: 'app', label: 'The 1Password app', how: 'ok', done: op.app, detail: 'Installed with winget, in a window you can watch. Then sign in to it.', command: cmd('1password', 'app') }),
        need({ id: 'cli', label: "1Password's command line (op)", how: 'ok', done: op.cli, detail: 'Installed with winget, in a window you can watch.', command: cmd('1password', 'cli') }),
        need({ id: 'connect', label: 'Connected to the app', how: 'you', done: op.connected, after: 'cli', steps: ['Open the 1Password app › Settings › Developer.', 'Turn on "Integrate with 1Password CLI" (and Windows Hello, so it unlocks with your face, finger or PIN).', 'Cora checks again here.'] }),
      ],
    }),
    item({ id: 'basics', title: 'Notes, shell tabs, explains', blurb: 'Nothing to set up', required: false, needs: [need({ id: 'none', label: 'Built in', how: 'itself', done: true })] }),
  ];
}

/** Windows' saved PATH (machine, then user) merged into this one: new entries added, none repeated (any case, trailing slash). */
export function mergePath(current: string, saved: string): string {
  const key = (p: string) => p.trim().replace(/[\\/]+$/, '').toLowerCase();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [...current.split(';'), ...saved.split(';')]) {
    const k = key(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p.trim().replace(/[\\/]+$/, ''));
  }
  return out.join(';');
}

const run = (file: string, args: string[], timeout = 8000) =>
  new Promise<{ ok: boolean; out: string }>((res) => execFile(file, args, { windowsHide: true, timeout, env: process.env }, (err, out) => res({ ok: !err, out: String(out ?? '') })));

/** What Windows has saved as PATH now (a tool installed after Cora started is on it), merged into this process's. */
export async function refreshPath(): Promise<void> {
  // (scripts/try-fresh.ps1 -Bare: a machine with nothing installed keeps its bare PATH)
  if (process.platform !== 'win32' || process.env.CORA_SETUP_FIXED_PATH === '1') return;
  const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"]);
  if (r.ok && r.out.trim()) process.env.PATH = mergePath(process.env.PATH ?? '', r.out.trim());
}

/** 1Password for Setup: the app on disk, op there, and op connected to it (it lists account names, nothing secret). */
/** There, links included: Windows' app aliases (WindowsApps) can't be followed (existsSync says no), only seen. */
const isThere = (p: string) => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

export async function onePasswordStatus(env: NodeJS.ProcessEnv = process.env): Promise<OpStatus> {
  const app = opAppPaths(env).some(isThere);
  if (!(await run('op', ['--version'])).ok) return { app, cli: false, connected: false };
  const r = await run('op', ['account', 'list', '--format', 'json'], 15_000);
  let connected = false;
  try {
    connected = r.ok && (JSON.parse(r.out) as unknown[]).length > 0;
  } catch {
    /* not connected */
  }
  return { app, cli: true, connected };
}

export const whichCmd = async (cmd: string): Promise<string | null> => {
  const r = await run(process.platform === 'win32' ? 'where.exe' : 'which', [cmd]);
  return r.ok ? (r.out.split(/\r?\n/).find((l) => l.trim()) ?? '').trim() || null : null;
};
export const glabAuthed = async (host: string): Promise<boolean> => (await run('glab', ['auth', 'status', '--hostname', host], 10_000)).ok;

/** The PowerShell that runs a setup command, shown first in its window (exported for its test). */
export function windowScript(label: string, command: string): string {
  const say = (s: string) => `Write-Host ${ps(s)} -ForegroundColor Cyan`;
  return [`$Host.UI.RawUI.WindowTitle = ${ps(`Cora: ${label}`)}`, say(`Cora: ${label}`), say(`> ${command}`), command, "Write-Host ''", say('Done. You can close this window: Cora checks again on its own.')].join('; ');
}

/**
 * Run a setup command in a PowerShell window of its own (the user watches it, and answers what it asks). Started by
 * `start`, which gives it a console: a detached PowerShell has none, and quit before running anything. The script
 * goes encoded, so nothing in it (an &, quotes) is read by cmd on the way.
 */
export function runInWindow(label: string, command: string): void {
  const enc = Buffer.from(windowScript(label, command), 'utf16le').toString('base64');
  const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', 'powershell.exe', '-NoExit', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { detached: true, stdio: 'ignore', windowsHide: true, env: process.env });
  child.unref();
}
