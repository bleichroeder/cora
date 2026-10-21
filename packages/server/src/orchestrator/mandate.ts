import { isAbsolute, resolve } from 'node:path';
import type { Mandate } from '@cora/shared';

/**
 * The mandate engine: what Cora may approve on its own, decided by rules, never by the model. A trusted engineer:
 * reads, edits inside the repo, tests, builds, commits and pushes to feature branches. Merges, deploys, publishing,
 * sending data out, and anything it doesn't recognise go to you. The hard limits (force-pushing, the default branch,
 * deleting branches or data) are refused outright, in every mode.
 *
 * Code in the repo is trusted the way a teammate's is: the project's scripts (npm run, make, pytest) run on their own.
 * What isn't: a command that hides another one ($( ), backticks, bash -c, inline code), or anything that writes outside
 * the repo (a redirect, a copy, sed -i, a container mount); those go to you (docs/audit-2026-10-20.md S7).
 */

export type MandateRequest = { tool: string; input: unknown; cwd: string; kind: 'permission' | 'question' | 'elicitation' };
export type MandateContext = { mandate: Mandate; branch?: { current?: string; defaultBranch?: string } };
export type Verdict = { verdict: 'allow' | 'ask' | 'refuse'; rule: string; why: string };

const allow = (rule: string, why: string): Verdict => ({ verdict: 'allow', rule, why });
const ask = (rule: string, why: string): Verdict => ({ verdict: 'ask', rule, why });
const refuse = (rule: string, why: string): Verdict => ({ verdict: 'refuse', rule, why });
const RANK = { allow: 0, ask: 1, refuse: 2 } as const;
/** The worst verdict of several (the first of equals, so an all-allowed line keeps its own rule). */
const worst = (vs: Verdict[]): Verdict => (vs.length ? vs.reduce((a, b) => (RANK[b.verdict] > RANK[a.verdict] ? b : a)) : allow('nothing', 'nothing to do'));

// resolved first, so `repo/../elsewhere` is elsewhere
const norm = (p: string) => resolve(p).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
const inside = (p: string, root: string) => {
  const a = norm(p);
  const b = norm(root);
  return a === b || a.startsWith(`${b}/`);
};
/** A path as the command sees it (relative to its folder). */
const at = (p: string, cwd: string) => (isAbsolute(p) ? p : resolve(cwd, p));
/** The mandate repo a folder is in. */
export const repoOf = (cwd: string, repos: string[]) => repos.find((r) => inside(cwd, r)) ?? null;

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Agent', 'NotebookRead', 'BashOutput', 'KillShell', 'KillBash', 'ExitPlanMode', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Which shell reads the line: in PowerShell a backtick only escapes; in bash it runs a command. */
type Dialect = 'bash' | 'powershell';

/** A command line in its parts: split on &&, ||, &, ;, | and newlines, outside quotes (not the & of 2>&1 or &>). */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'") {
      q = c;
      cur += c;
      continue;
    }
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||') {
      out.push(cur);
      cur = '';
      i++;
      continue;
    }
    // a lone & runs what's before it in the background and carries on: two commands (a redirect's & isn't one)
    if (c === '&' && cmd[i - 1] !== '>' && cmd[i - 1] !== '<' && cmd[i + 1] !== '>') {
      out.push(cur);
      cur = '';
      continue;
    }
    if (c === ';' || c === '|' || c === '\n') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

/**
 * The commands a line runs without showing them plainly ($( ), backticks in bash, <( ), outside single quotes), or
 * null when it has none.
 */
function hiddenCommands(cmd: string, dialect: Dialect): string[] | null {
  const found: string[] = [];
  let q: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q === "'") {
      if (c === "'") q = null;
      continue;
    }
    if (c === "'" && q == null) {
      q = c;
      continue;
    }
    if (c === '"') q = q === '"' ? null : '"';
    const two = cmd.slice(i, i + 2);
    if (two === '$(' || (dialect === 'bash' && q == null && (two === '<(' || two === '>('))) {
      // up to its matching )
      let depth = 0;
      let j = i + 1;
      for (; j < cmd.length; j++) {
        if (cmd[j] === '(') depth++;
        else if (cmd[j] === ')' && --depth === 0) break;
      }
      found.push(cmd.slice(i + 2, j));
      i = j;
      continue;
    }
    if (dialect === 'bash' && c === '`') {
      const j = cmd.indexOf('`', i + 1);
      found.push(cmd.slice(i + 1, j < 0 ? undefined : j));
      i = j < 0 ? cmd.length : j;
    }
  }
  return found.length ? found : null;
}

/** A segment's raw tokens (quotes kept), for redirects. */
const tokens = (seg: string) => seg.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
const unquote = (t: string) => t.replace(/^(["'])(.*)\1$/, '$2');
const NOWHERE = /^(\/dev\/null|nul|\$null|\/dev\/stdout|\/dev\/stderr)$/i;

/** Where its redirects (> file, >> file, 2> file) write. */
function redirectTargets(seg: string): string[] {
  const ts = tokens(seg);
  const out: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (/^["']/.test(t) || !t.includes('>')) continue;
    let target = t.slice(t.lastIndexOf('>') + 1);
    if (!target) target = ts[i + 1] ?? '';
    target = unquote(target);
    if (!target || target.startsWith('&') || NOWHERE.test(target)) continue;
    out.push(target);
  }
  return out;
}

/** A command's words, quotes taken off (and redirects: they're judged on their own). */
function words(seg: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  let skipNext = false;
  while ((m = re.exec(seg))) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    const w = m[1] ?? m[2] ?? m[3];
    if (m[3] && /^(\d*|&)>>?/.test(m[3])) {
      // `> file` (its target next) or `>file` / `2>&1` (all in one)
      if (/^(\d*|&)>>?$/.test(m[3])) skipNext = true;
      continue;
    }
    out.push(w);
  }
  // leading VAR=value assignments, and wrappers that just run the rest
  while (out.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(out[0])) out.shift();
  while (out.length && ['sudo', 'time', '&', 'call', 'start'].includes(out[0].toLowerCase())) out.shift();
  return out;
}

const base = (w: string) =>
  w
    .split(/[\\/]/)
    .pop()!
    .toLowerCase()
    .replace(/\.(exe|cmd|bat|ps1)$/, '');

const ROOTISH = /^(\/|\/\*|~|~\/|~\\|\*|\.\.|[a-z]:[\\/]?\*?|\$home|\$env:userprofile|%userprofile%|\$env:systemroot|c:\\windows.*)$/i;

/** Recursive deletes: at a root, or outside the repo, never; inside it, ask. */
function deleting(w: string[], cwd: string, root: string): Verdict {
  const recursive = w.some((a) => /^-(r|rf|fr|R|Rf|fR|-recursive)$/.test(a) || /^-recurse$/i.test(a) || /^\/s$/i.test(a));
  const targets = w.slice(1).filter((a) => !a.startsWith('-') && !/^\/[a-z]$/i.test(a));
  for (const t of targets) {
    if (ROOTISH.test(t.trim())) return refuse('delete-root', `deleting ${t} would wipe far more than a project`);
    if (!inside(at(t, cwd), root)) return recursive ? refuse('delete-outside', `deleting ${t}: outside the repo`) : ask('delete-outside', `deleting ${t}: outside the repo`);
  }
  return recursive ? ask('recursive-delete', 'a recursive delete (even inside the repo) is yours to OK') : allow('delete-file', 'deleting files in the repo');
}

const DEFAULTS = (b?: MandateContext['branch']) => new Set(['main', 'master', ...(b?.defaultBranch ? [b.defaultBranch] : [])]);

function gitPush(args: string[], ctx: MandateContext): Verdict {
  if (args.some((a) => /^(-f|--force|--force-with-lease(=.*)?|--force-if-includes|--mirror)$/.test(a))) return refuse('force-push', 'force-pushing rewrites history: never');
  if (args.some((a) => a === '--delete' || a === '-d')) return refuse('delete-branch', 'deleting a branch: never');
  if (args.some((a) => a === '--all' || a === '--tags')) return ask('push-all', 'pushing every branch or tag is yours to OK');
  const pos = args.filter((a) => !a.startsWith('-'));
  const refspecs = pos.slice(1);
  const defaults = DEFAULTS(ctx.branch);
  const targets: Array<string | undefined> = refspecs.length
    ? refspecs.map((r) => {
        if (r.startsWith('+')) return '+force';
        if (r.startsWith(':')) return ':delete';
        const dst = (r.includes(':') ? r.split(':')[1] : r).replace(/^refs\/heads\//, '');
        return dst === 'HEAD' ? ctx.branch?.current : dst;
      })
    : [ctx.branch?.current];
  for (const t of targets) {
    if (t === '+force') return refuse('force-push', 'a + refspec force-pushes: never');
    if (t === ':delete') return refuse('delete-branch', 'pushing an empty source deletes the branch: never');
    if (!t) return ask('push-unknown-branch', "which branch this pushes to isn't known");
    if (defaults.has(t)) return refuse('push-default', `pushing to ${t} (the default branch): never`);
  }
  return allow('push-feature', 'pushing a feature branch');
}

/** git settings that run a program (or change where git talks to): setting them is yours to OK. */
const GIT_RUNS = /^(core\.(sshcommand|pager|editor|fsmonitor|hookspath|askpass|gitproxy)|alias\.|credential\.|filter\.|diff\.external|diff\..+\.(textconv|command)|merge\..+\.driver|protocol\.|uploadpack\.|receivepack\.|gpg\.|sequence\.editor|url\.|include)/i;

function git(w: string[], cwd: string, root: string, ctx: MandateContext): Verdict {
  let i = 1;
  // global options before the subcommand
  while (i < w.length && w[i].startsWith('-')) {
    if (w[i] === '-C' && w[i + 1] && !inside(at(w[i + 1], cwd), root)) return ask('outside-repos', `git -C ${w[i + 1]}: outside the repo`);
    if (w[i] === '-c' && GIT_RUNS.test(w[i + 1] ?? '')) return ask('git-config', `git -c ${(w[i + 1] ?? '').split('=')[0]} can run a program`);
    i += w[i] === '-C' || w[i] === '-c' ? 2 : 1;
  }
  const sub = w[i]?.toLowerCase();
  const args = w.slice(i + 1);
  switch (sub) {
    case 'push':
      return gitPush(args, ctx);
    case 'branch':
      return args.some((a) => /^(-d|-D|--delete)$/.test(a)) ? refuse('delete-branch', 'deleting a branch: never') : allow('git-branch', 'listing or making a branch');
    case 'merge':
      return ask('merge', 'merging is yours to OK');
    case 'reset':
      return args.includes('--hard') ? ask('discard-changes', 'a hard reset throws work away') : allow('git-local', 'a local git change');
    case 'clean':
      return ask('discard-changes', 'git clean deletes untracked files');
    case 'config': {
      if (args.some((a) => a === '--global' || a === '--system')) return ask('git-config', 'changing your git config');
      const key = args.find((a) => !a.startsWith('-'));
      const setting = args.filter((a) => !a.startsWith('-')).length >= 2;
      return setting && key && GIT_RUNS.test(key) ? ask('git-config', `git config ${key} can run a program`) : allow('git-local', 'reading or setting the repo’s config');
    }
    case 'tag':
      return args.some((a) => a === '-d' || a === '--delete') ? ask('git-tag', 'deleting a tag') : allow('git-local', 'a tag');
    case 'rebase':
      return args.some((a) => a === '-x' || a.startsWith('--exec')) ? ask('hidden-command', 'git rebase --exec runs a command') : allow('git-local', 'git rebase');
    case 'submodule':
      return args[0]?.toLowerCase() === 'foreach' ? ask('hidden-command', 'git submodule foreach runs a command') : allow('git-local', 'git submodule');
    case 'bisect':
      return args[0]?.toLowerCase() === 'run' ? ask('hidden-command', 'git bisect run runs a command') : allow('git-local', 'git bisect');
    case undefined:
      return allow('git', 'git');
    default:
      return ['status', 'diff', 'log', 'show', 'fetch', 'pull', 'add', 'commit', 'switch', 'checkout', 'restore', 'stash', 'remote', 'rev-parse', 'ls-files', 'blame', 'grep', 'worktree', 'cherry-pick', 'describe', 'shortlog', 'reflog', 'mv', 'rm', 'init', 'clone', 'notes', 'apply', 'am', 'format-patch'].includes(sub)
        ? allow('git-local', `git ${sub}`)
        : ask('git-unknown', `git ${sub} isn't on the list`);
  }
}

/** glab / gh: reading yes; merging, releasing, running pipelines, creating things others see: ask. */
function forge(w: string[], deploy: boolean): Verdict {
  const [area, verb] = [w[1]?.toLowerCase(), w[2]?.toLowerCase()];
  const all = w.join(' ').toLowerCase();
  if (verb === 'merge') return ask('merge', 'merging is yours to OK');
  if (area === 'release') return ask('publish', 'a release is yours to OK');
  if ((area === 'ci' || area === 'workflow' || area === 'run') && (verb === 'run' || verb === 'retry' || verb === 'trigger' || verb === 'rerun')) return deploy ? allow('deploy', 'running a pipeline (deploys allowed)') : ask('deploy', 'running a pipeline is yours to OK');
  if (area === 'api') return /(-x|--method)\s*(post|put|patch|delete)\b/.test(all) || /\s-f\s|\s--field\s|\s--raw-field\s/.test(` ${all} `) ? ask('network-write', 'an API call that changes something') : allow('forge-read', 'reading from the API');
  if (['view', 'list', 'status', 'checks', 'diff', 'trace', 'get', 'ls', 'show'].includes(verb ?? '') || ['auth', 'repo'].includes(area ?? '') && verb === 'view') return allow('forge-read', `${w[0]} ${area} ${verb}`);
  return ask('outward', `${w[0]} ${area ?? ''} ${verb ?? ''}: something others will see`.replace(/\s+/g, ' ').trim());
}

const READONLY_OR_LOCAL = new Set(
  (
    'ls dir cat type head tail grep rg egrep find fd echo pwd cd which where wc sort uniq diff cut awk sed tr tee test true false printf date set export mkdir cp mv touch ln chmod stat file tree less more nl sleep ' +
    'get-childitem gci get-content gc select-string sls get-item test-path set-location sl write-output write-host out-file new-item copy-item cpi move-item mi rename-item ni get-location resolve-path measure-object sort-object select-object where-object foreach-object format-table format-list jq yq start-sleep clear cls get-date get-process'
  ).split(' '),
);
/** Commands that write to the paths they're given. */
const WRITERS = new Set(['cp', 'mv', 'mkdir', 'touch', 'tee', 'out-file', 'new-item', 'ni', 'copy-item', 'cpi', 'move-item', 'mi', 'rename-item', 'ln', 'chmod']);
const BUILD_TOOLS = new Set(
  'node tsx ts-node deno bun python python3 py pytest dotnet go cargo make cmake mvn gradle gradlew tsc vitest jest eslint prettier ruff mypy black playwright pip pip3 uv poetry rustc javac java msbuild nuget dotnet-format biome turbo nx vite webpack rollup esbuild'.split(' '),
);
/** Interpreters' run-this-code flags: code that isn't in any file (node -e, python -c). */
const INLINE = /^(-e|--eval|-p|--print|-c|--command)$|^--eval=|^--print=/;
const INTERPRETERS = new Set(['node', 'tsx', 'ts-node', 'deno', 'bun', 'python', 'python3', 'py']);
const PKG = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'pnpm dlx']);
/** Wrappers that run the command after their own options. */
const WRAPPERS = new Set(['env', 'timeout', 'nohup', 'nice', 'ionice', 'stdbuf', 'xargs', 'exec', 'command', 'builtin', 'watch']);
/** Shells: with -c / -Command / /c they run the string they're given. */
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd']);
const DEPLOY_WORDS = /\b(deploy|release|publish)\b/i;

/** A whole command line: its worst part, and anything it hides. */
function line(cmd: string, cwd: string, root: string, ctx: MandateContext, dialect: Dialect): Verdict {
  const parts = splitCommand(cmd);
  if (!parts.length) return allow('nothing', 'an empty command');
  // a command inside another is yours to OK at least, and refused if what it hides would be
  const inner = hiddenCommands(cmd, dialect);
  const hidden = inner ? [ask('hidden-command', 'it runs a command inside another ($( ) or backticks): yours to OK'), ...inner.filter((c) => c.trim()).map((c) => line(c, cwd, root, ctx, dialect))] : [];
  return worst([...parts.map((p) => shell(p, cwd, root, ctx, dialect)), ...hidden]);
}

/** The command after a wrapper's own options (env's VAR=value, timeout's duration). */
function wrapped(cmd: string, rest: string[]): string[] {
  let i = 0;
  while (i < rest.length && (rest[i].startsWith('-') || (cmd === 'env' && rest[i].includes('=')))) i += cmd === 'nice' && rest[i] === '-n' ? 2 : 1;
  if (cmd === 'timeout' && /^\d/.test(rest[i] ?? '')) i++;
  return rest.slice(i);
}

/** `docker run -v`, `--mount`, `--privileged`: a container that can reach your machine outside the repo. */
function containerReach(w: string[], cwd: string, root: string): Verdict | null {
  for (let i = 0; i < w.length; i++) {
    const a = w[i];
    if (/^--privileged$|^--(pid|ipc|userns)=host$/i.test(a)) return ask('container-host', `${a}: the container reaches your machine`);
    let host: string | undefined;
    const vol = a === '-v' || a === '--volume' ? w[i + 1] : /^(-v|--volume)=(.+)$/.exec(a)?.[2];
    if (vol) host = /^[a-z]:[\\/]/i.test(vol) ? vol.slice(0, vol.indexOf(':', 2) > 0 ? vol.indexOf(':', 2) : undefined) : vol.split(':')[0];
    const mount = a === '--mount' ? w[i + 1] : /^--mount=(.+)$/.exec(a)?.[1];
    if (mount) host = /(?:^|,)(?:source|src)=([^,]+)/.exec(mount)?.[1];
    // a path (not a named volume) outside the repo
    if (host && /^([/.~$%]|[a-z]:)/i.test(host) && !inside(at(host, cwd), root)) return ask('container-host', `mounting ${host} (outside the repo) into a container`);
  }
  return null;
}

function shell(seg: string, cwd: string, root: string, ctx: MandateContext, dialect: Dialect): Verdict {
  if (/\bdrop\s+(database|table|schema)\b/i.test(seg) || /\btruncate\s+table\b/i.test(seg)) return refuse('drop-data', 'dropping a database or table: never');
  // whatever the command, a redirect that writes outside the repo is yours to OK
  const out = redirectTargets(seg).find((t) => !inside(at(t, cwd), root));
  const outside = out ? ask('write-outside', `writing ${out}: outside the repo`) : null;
  const v = command(words(seg), cwd, root, ctx, dialect);
  return outside ? worst([v, outside]) : v;
}

function command(w: string[], cwd: string, root: string, ctx: MandateContext, dialect: Dialect): Verdict {
  if (!w.length) return allow('nothing', 'nothing to run');
  const cmd = base(w[0]);
  const deploy = ctx.mandate.deploy;
  const again = (rest: string[]) => (rest.length ? command(rest, cwd, root, ctx, dialect) : allow('local', cmd));
  if (cmd === 'dropdb') return refuse('drop-data', 'dropping a database: never');
  if (['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri'].includes(cmd)) return deleting(w, cwd, root);
  if (cmd === 'git') return git(w, cwd, root, ctx);
  if (cmd === 'glab' || cmd === 'gh') return forge(w, deploy);
  // (Windows' own timeout /t 5 just waits)
  if (cmd === 'timeout' && w[1]?.startsWith('/')) return allow('local', 'timeout');
  if (WRAPPERS.has(cmd)) return again(wrapped(cmd, w.slice(1)));
  if (SHELLS.has(cmd)) {
    const flag = w.findIndex((a, i) => i > 0 && /^(-c|-command|\/c|\/k|--command)$/i.test(a));
    if ((cmd === 'pwsh' || cmd === 'powershell') && w.some((a, i) => i > 0 && /^-(e|ec|enc|encodedcommand)$/i.test(a))) return ask('hidden-command', `${cmd} with an encoded command: yours to OK`);
    if (flag > 0) {
      const inner = w.slice(flag + 1).join(' ');
      const d: Dialect = ['pwsh', 'powershell'].includes(cmd) ? 'powershell' : cmd === 'cmd' ? 'powershell' : 'bash';
      return inner ? line(inner, cwd, root, ctx, d) : allow('local', cmd);
    }
    // a script file: the repo's own runs; anything else (or an interactive shell) asks
    const file = w.slice(1).find((a) => !a.startsWith('-'));
    return file && inside(at(file, cwd), root) ? allow('script', `${cmd} ${file}`) : ask('unknown-command', `${cmd} ${file ?? ''}`.trim());
  }
  if (RUNNERS.has(cmd)) return w.length > 1 ? command(w.slice(1), cwd, root, ctx, dialect) : allow('runner', cmd);
  if (PKG.has(cmd)) {
    const sub = w[1]?.toLowerCase();
    if (sub === 'publish' || (sub === 'npm' && w[2] === 'publish')) return ask('publish', 'publishing a package is yours to OK');
    if (sub === 'run' || sub === 'run-script') return DEPLOY_WORDS.test(w[2] ?? '') ? (deploy ? allow('deploy', `${w[2]} (deploys allowed)`) : ask('deploy', `${w[2]} looks like a deploy`)) : allow('script', `the project's ${w[2] ?? ''} script`);
    if (sub === 'exec' || sub === 'dlx' || sub === 'x') return w.length > 2 ? command(w.slice(2), cwd, root, ctx, dialect) : allow('runner', cmd);
    if (sub && DEPLOY_WORDS.test(sub)) return deploy ? allow('deploy', `${cmd} ${sub} (deploys allowed)`) : ask('deploy', `${cmd} ${sub} looks like a deploy`);
    if (cmd === 'bun' && w.slice(1).some((a) => INLINE.test(a))) return ask('inline-code', 'bun -e runs code that is in no file: yours to OK');
    return allow('package', `${cmd} ${sub ?? ''}`.trim());
  }
  if (BUILD_TOOLS.has(cmd)) {
    const sub = w[1]?.toLowerCase() ?? '';
    if (['publish', 'push', 'upload', 'release'].includes(sub)) return ask('publish', `${cmd} ${sub} is yours to OK`);
    if (INTERPRETERS.has(cmd) && (w.slice(1).some((a) => INLINE.test(a)) || (cmd === 'deno' && sub === 'eval'))) return ask('inline-code', `${cmd} running code that is in no file: yours to OK`);
    return allow('build', `${cmd}${sub ? ` ${sub}` : ''}`);
  }
  if (cmd === 'docker' || cmd === 'podman') {
    const sub = w[1]?.toLowerCase();
    if (sub === 'push') return deploy ? allow('deploy', 'pushing an image (deploys allowed)') : ask('deploy', 'pushing an image is yours to OK');
    return containerReach(w, cwd, root) ?? allow('container', `${cmd} ${sub ?? ''}`.trim());
  }
  if (['kubectl', 'helm', 'terraform', 'pulumi', 'serverless', 'sls', 'vercel', 'netlify', 'fly', 'flyctl', 'eb', 'cdk', 'sam', 'az', 'aws', 'gcloud'].includes(cmd)) {
    const verb = w.slice(1).find((a) => !a.startsWith('-'))?.toLowerCase() ?? '';
    const reading = /^(get|describe|logs|list|ls|show|status|plan|version|top|explain|history|diff|whoami|sts|configure)$/.test(verb) || w.slice(1).some((a) => /^(describe|list|get|show)-/i.test(a));
    if (reading) return allow('cloud-read', `${cmd} ${verb}`);
    return deploy ? allow('deploy', `${cmd} ${verb} (deploys allowed)`) : ask('deploy', `${cmd} ${verb} changes infrastructure`);
  }
  if (['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'http', 'httpie'].includes(cmd)) {
    const all = ` ${w.slice(1).join(' ')} `.toLowerCase();
    const sends = /\s(-x|--request|-method)\s+(post|put|patch|delete)\s/.test(all) || /\s(-d|--data\S*|-f|--form|-t|--upload-file|-body|-infile)\s/.test(all) || /\s--json\s/.test(all);
    if (sends) return ask('network-write', 'sending data out is yours to OK');
    const saved = (cmd === 'curl' || cmd === 'wget' ? w.slice(1).findIndex((a) => /^(-o|--output|-O|--output-document|-outfile)$/i.test(a)) : w.slice(1).findIndex((a) => /^-outfile$/i.test(a))) + 1;
    if (saved > 0 && w[saved + 1] && !inside(at(w[saved + 1], cwd), root)) return ask('write-outside', `saving to ${w[saved + 1]}: outside the repo`);
    return allow('network-read', 'fetching a page');
  }
  if (['ssh', 'scp', 'rsync', 'sftp', 'telnet', 'ftp'].includes(cmd)) return ask('remote', `${cmd}: working on another machine`);
  if (cmd === 'find') {
    const args = w.slice(1);
    const exec = args.findIndex((a) => /^-(exec|execdir|ok|okdir)$/.test(a));
    if (exec >= 0) {
      // it runs the command on what it finds: outside the repo, that's yours to OK
      const first = args.findIndex((a) => /^[-(!]/.test(a));
      const out = args.slice(0, first < 0 ? undefined : first).find((a) => !inside(at(a, cwd), root));
      if (out) return ask('outside-repos', `find ${out} -exec: outside the repo`);
      const end = args.findIndex((a, i) => i > exec && (a === ';' || a === '\\;' || a === '+'));
      return command(args.slice(exec + 1, end > exec ? end : undefined).filter((a) => a !== '{}'), cwd, root, ctx, dialect);
    }
    if (args.includes('-delete')) {
      const first = args.findIndex((a) => /^[-(!]/.test(a));
      const paths = args.slice(0, first < 0 ? undefined : first);
      return deleting(['rm', '-r', ...(paths.length ? paths : ['.'])], cwd, root);
    }
    return allow('local', cmd);
  }
  if (cmd === 'fd' && w.slice(1).some((a) => /^(-x|-X|--exec|--exec-batch)$/.test(a))) {
    const i = w.findIndex((a) => /^(-x|-X|--exec|--exec-batch)$/.test(a));
    return again(w.slice(i + 1));
  }
  if (READONLY_OR_LOCAL.has(cmd)) {
    // sed -i writes the files it's given; so do cp, mv, tee and their kind
    const writes = WRITERS.has(cmd) || (cmd === 'sed' && w.some((a) => /^-i|^--in-place/.test(a)));
    if (writes) {
      for (const a of w.slice(1).filter((x) => !x.startsWith('-'))) {
        if (!inside(at(a, cwd), root)) return ask('write-outside', `${cmd} ${a}: outside the repo`);
      }
    }
    return allow('local', cmd);
  }
  return ask('unknown-command', `${cmd} isn't on the list`);
}

/** The verdict for one request. */
export function judge(req: MandateRequest, ctx: MandateContext): Verdict {
  if (req.kind !== 'permission') return ask('questions-go-to-you', "Claude's questions are yours to answer");
  const root = repoOf(req.cwd, ctx.mandate.repos);
  if (!root) return ask('outside-repos', "the session's folder isn't one of the mandate's repos");
  const input = (req.input ?? {}) as Record<string, unknown>;
  if (READ_TOOLS.has(req.tool)) return allow('read', `${req.tool}: reading`);
  if (EDIT_TOOLS.has(req.tool)) {
    const p = String(input.file_path ?? input.notebook_path ?? '');
    if (!p) return ask('edit-unknown', 'an edit without a file');
    return inside(at(p, req.cwd), root) ? allow('edit-in-repo', 'editing a file in the repo') : ask('edit-outside', `editing ${p}: outside the repo`);
  }
  if (req.tool.startsWith('mcp__cora__')) return allow('cora-tools', "Cora's own tools");
  if (req.tool.startsWith('mcp__')) return ask('mcp-tool', `${req.tool}: another service's tool`);
  if (SHELL_TOOLS.has(req.tool)) return line(String(input.command ?? ''), req.cwd, root, ctx, req.tool === 'PowerShell' ? 'powershell' : 'bash');
  return ask('unknown-tool', `${req.tool} isn't on the list`);
}
