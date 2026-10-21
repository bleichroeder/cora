import type { BrainEvent } from '@cora/shared';

/** Programs we recognise in shell commands, and their colours (droplets around the shell radiant). */
export const PROGRAMS: Record<string, { color: string; match: RegExp }> = {
  git: { color: '#f05133', match: /^git$/ },
  npm: { color: '#cb3837', match: /^(npm|npx|pnpm|yarn)$/ },
  node: { color: '#5fa04e', match: /^(node|tsx|bun|deno)$/ },
  python: { color: '#3776ab', match: /^(python3?|py|pip3?|pytest|uv)$/ },
  glab: { color: '#fc6d26', match: /^(glab|gh)$/ },
  docker: { color: '#2496ed', match: /^(docker|podman)$/ },
  kubectl: { color: '#326ce5', match: /^(kubectl|helm|k9s)$/ },
  curl: { color: '#94a3b8', match: /^(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)$/i },
};
export const programColor = (p: string) => PROGRAMS[p]?.color ?? '#a78bfa';

const programCache = new Map<string, string>();
/** The program a shell command runs (cached: the same commands come up again and again). */
export function programOf(cmd: string): string {
  let p = programCache.get(cmd);
  if (p === undefined) {
    p = programOfUncached(cmd);
    if (programCache.size > 4000) programCache.clear();
    programCache.set(cmd, p);
  }
  return p;
}

/** The program a shell command runs: the last command in a chain, skipping cd, env assignments and sudo. */
function programOfUncached(cmd: string): string {
  const parts = cmd.split(/&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean).reverse();
  for (const p of parts) {
    const toks = p.split(/\s+/).filter((t) => !/^\$?\w+=/.test(t) && t !== 'sudo' && t !== '&');
    const bin = (toks[0] ?? '').replace(/^["'(]+/, '').split(/[\\/]/).pop()!.replace(/\.(exe|cmd|ps1)$/i, '');
    if (!bin || /^(cd|set-location|pushd|echo|sleep|start-sleep)$/i.test(bin)) continue;
    for (const [name, pr] of Object.entries(PROGRAMS)) if (pr.match.test(bin)) return name;
    return bin.toLowerCase().slice(0, 16);
  }
  return 'sh';
}

type Run = { cmd: string; ok: boolean | null; ms?: number };
export type ProgramInfo = {
  n: number;
  ok: number;
  bad: number;
  last: Run[];
  // git
  branch?: string;
  ahead?: number;
  pushed?: boolean;
  dirty?: number;
  commits?: string[];
  // tests and builds (npm, python)
  tests?: { pass: number; fail: number };
  build?: { ok: boolean; ms?: number };
  installed?: number;
  // glab / gh
  mr?: number;
  mrTitle?: string;
  mrState?: string;
  stages?: string[];
  // docker
  image?: string;
  imageVerb?: string;
  // kubectl
  ctx?: string;
  pods?: { running: number; crash: number };
  // node / python
  scripts?: Record<string, number>;
};

const detailsCache = new WeakMap<BrainEvent[], Map<string, ProgramInfo>>();
/** What each program did this session (cached per events list: a session's list is replaced when it changes). */
export function programDetails(events: BrainEvent[]): Map<string, ProgramInfo> {
  let d = detailsCache.get(events);
  if (!d) detailsCache.set(events, (d = programDetailsUncached(events)));
  return d;
}

/** What each program did this session, picked out of the shell commands and what they printed. */
function programDetailsUncached(events: BrainEvent[]): Map<string, ProgramInfo> {
  const starts = new Map<string, BrainEvent>();
  const out = new Map<string, ProgramInfo>();
  for (const e of events) {
    if (e.kind !== 'tool' || !e.toolUseId || (e.tool?.name !== 'Bash' && e.tool?.name !== 'PowerShell')) continue;
    if (e.phase === 'start') {
      starts.set(e.toolUseId, e);
      continue;
    }
    const s = starts.get(e.toolUseId);
    const cmd = String((s?.tool?.input as { command?: unknown } | undefined)?.command ?? e.tool?.summary ?? '');
    if (!cmd) continue;
    const prog = programOf(cmd);
    const d = out.get(prog) ?? { n: 0, ok: 0, bad: 0, last: [] };
    out.set(prog, d);
    const ok = !e.tool?.failed;
    d.n++;
    ok ? d.ok++ : d.bad++;
    d.last.unshift({ cmd, ok, ms: e.durationMs });
    d.last.length = Math.min(d.last.length, 4);
    learn(prog, d, cmd, String(e.tool?.preview ?? ''), ok, e.durationMs);
  }
  return out;
}

function learn(prog: string, d: ProgramInfo, cmd: string, outText: string, ok: boolean, ms?: number) {
  const c = cmd.replace(/^.*?(?=\b(git|npm|npx|pnpm|yarn|glab|gh|docker|kubectl|helm|python3?|py|pip3?|pytest|node|tsx)\b)/, '');
  if (prog === 'git') {
    const br = outText.match(/On branch (\S+)/) ?? outText.match(/->\s+(\S+)\s*$/m);
    if (br) d.branch = br[1];
    const ah = outText.match(/ahead of '[^']+' by (\d+)/);
    if (ah) d.ahead = +ah[1];
    const msg = c.match(/commit\b.*?-m\s+["']([^"']+)/);
    if (msg && ok) {
      (d.commits ??= []).unshift(msg[1]);
      d.ahead = (d.ahead ?? 0) + 1;
      d.pushed = false;
    }
    if (/^git push/.test(c) && ok) {
      d.ahead = 0;
      d.pushed = true;
    }
    if (/^git status/.test(c)) d.dirty = (outText.match(/^\s+(modified|new file|deleted):/gm) ?? []).length + (outText.match(/^ ?[MADRU?]{1,2} /gm) ?? []).length;
  } else if (prog === 'npm' || prog === 'python') {
    const v = outText.match(/Tests?\s+(?:(\d+) failed \|\s*)?(\d+) passed/) ?? null;
    if (v) d.tests = { fail: +(v[1] ?? 0), pass: +v[2] };
    const py = outText.match(/(\d+) passed(?:, (\d+) failed)?/);
    if (!v && py) d.tests = { pass: +py[1], fail: +(py[2] ?? 0) };
    if (/\bbuild\b/.test(c)) d.build = { ok, ms };
    const add = outText.match(/added (\d+) packages?/);
    if (add) d.installed = +add[1];
    const f = c.match(/\s([\w./\\-]+\.py)\b/);
    if (f) {
      const name = f[1].split(/[\\/]/).pop()!;
      (d.scripts ??= {})[name] = (d.scripts[name] ?? 0) + 1;
    }
  } else if (prog === 'glab') {
    const mr = c.match(/\b(?:mr|pr) (?:view|checkout|merge|create)\s+(\d+)/);
    if (mr) {
      d.mr = +mr[1];
      const ti = outText.match(/^title:\s*(.+)$/m);
      if (ti) d.mrTitle = ti[1];
      const st = outText.match(/^state:\s*(\w+)/m);
      if (st) d.mrState = st[1];
    }
    const ci = outText.match(/stages?:\s*(.+)$/m);
    if (ci) d.stages = ci[1].trim().split(/\s+/);
  } else if (prog === 'docker') {
    const tag = c.match(/(?:-t\s+|push\s+)(\S+)/);
    if (tag) {
      d.image = tag[1];
      d.imageVerb = /\bpush\b/.test(c) ? 'pushed' : 'built';
    }
  } else if (prog === 'kubectl') {
    const ctx = c.match(/--context[= ](\S+)/);
    if (ctx) d.ctx = ctx[1];
    const running = (outText.match(/\bRunning\b/g) ?? []).length;
    const crash = (outText.match(/CrashLoopBackOff|\bError\b|ImagePullBackOff/g) ?? []).length;
    if (running + crash) d.pods = { running, crash };
  } else if (prog === 'node') {
    const f = c.match(/\s([\w./\\-]+\.(?:m?[jt]s|cjs))\b/);
    if (f) {
      const name = f[1].split(/[\\/]/).pop()!;
      (d.scripts ??= {})[name] = (d.scripts[name] ?? 0) + 1;
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const dur = (ms?: number) => (ms == null ? '' : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);

/** A program's detail card (tooltip HTML): what it's been doing, with the specifics we could pick out. */
export function programCard(prog: string, d: ProgramInfo | undefined): string {
  const c = programColor(prog);
  const head = `<div class="pc-h"><i style="background:${c};box-shadow:0 0 8px ${c}"></i><b>${esc(prog)}</b><span class="sp"></span>${d ? `<span class="d">${d.n} run${d.n === 1 ? '' : 's'} · <span class="ok">${d.ok}✓</span>${d.bad ? ` <span class="bad">${d.bad}✗</span>` : ''}</span>` : ''}</div>`;
  if (!d) return head + '<div class="d">running…</div>';
  const row = (k: string, v: string) => `<div class="pc-r"><span class="k">${k}</span><span class="v">${v}</span></div>`;
  let body = '';
  if (prog === 'git') {
    if (d.branch) body += row('branch', `⎇ ${esc(d.branch)}${d.ahead ? ` <span class="warn">↑${d.ahead} unpushed</span>` : d.pushed ? ' <span class="ok">✓ pushed</span>' : ''}`);
    if (d.dirty != null) body += row('working', d.dirty ? `<span class="warn">${d.dirty} changed</span>` : '<span class="ok">clean</span>');
    if (d.commits?.length) body += row('commit', esc(d.commits[0]));
  } else if (prog === 'npm' || prog === 'python') {
    if (d.tests) {
      const tot = d.tests.pass + d.tests.fail || 1;
      body += row('tests', `${d.tests.fail ? `<span class="bad">${d.tests.fail} failed</span> · ` : ''}<span class="ok">${d.tests.pass} passed</span>`) + `<div class="pc-tally"><span class="p" style="width:${(d.tests.pass / tot) * 100}%"></span><span class="f" style="width:${(d.tests.fail / tot) * 100}%"></span></div>`;
    }
    if (d.build) body += row('build', `${d.build.ok ? '<span class="ok">ok</span>' : '<span class="bad">failed</span>'}${d.build.ms ? ` · ${dur(d.build.ms)}` : ''}`);
    if (d.installed) body += row('install', `+${d.installed} packages`);
  } else if (prog === 'glab') {
    if (d.mr) body += row('MR', `!${d.mr}${d.mrState ? ` <span class="d">${esc(d.mrState)}</span>` : ''}`) + (d.mrTitle ? `<div class="pc-t">${esc(d.mrTitle)}</div>` : '');
    if (d.stages) body += row('pipeline', `<span class="pc-lights">${d.stages.map((s) => `<i class="${/^(ok|success|passed)$/.test(s) ? 'ok' : /^(run|running)$/.test(s) ? 'run' : /fail/.test(s) ? 'bad' : ''}"></i>`).join('')}</span>`);
  } else if (prog === 'docker') {
    if (d.image) body += row(d.imageVerb ?? 'image', esc(d.image.split('/').pop()!));
  } else if (prog === 'kubectl') {
    if (d.ctx) body += row('cluster', esc(d.ctx));
    if (d.pods) body += row('pods', `<span class="ok">${d.pods.running} running</span>${d.pods.crash ? ` · <span class="bad">${d.pods.crash} failing</span>` : ''}`);
  }
  if (d.scripts) body += Object.entries(d.scripts).slice(0, 3).map(([s, n]) => row('script', `${esc(s)}${n > 1 ? ` <span class="d">×${n}</span>` : ''}`)).join('');
  body += `<div class="pc-l">${d.last.slice(0, 3).map((l) => `<div><span class="${l.ok ? 'ok' : 'bad'}">${l.ok ? '✓' : '✗'}</span> ${esc(l.cmd.length > 70 ? l.cmd.slice(0, 70) + '…' : l.cmd)}${l.ms ? ` <span class="d">${dur(l.ms)}</span>` : ''}</div>`).join('')}</div>`;
  return head + body;
}
