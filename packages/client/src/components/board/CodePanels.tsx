import { useEffect, useMemo, useRef, useState } from 'react';
import type { BrainEvent, Hunk } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { fetchToolDetail } from '../../state/ws';
import { openChanges, turnsFor } from '../../lib/changes';
import { outcome, shortDur, type BgTask } from '../../lib/background';
import { programDetails } from '../../scene/programs';
import { ago } from '../../lib/format';
import { maskSecrets } from '../../lib/mask';
import { Counts, MiniDiff } from '../DiffView';
import { Icon } from '../Icon';
import type { BoardData } from '../LiveBoard';
import { TEST_CMD, testCounts } from '../../lib/testRuns';

const sid = (s: string) => encodeURIComponent(s);

/** Ask again every `ms` while the panel is up (and once now). */
function usePoll(fn: () => void | Promise<void>, ms: number, deps: unknown[]) {
  useEffect(() => {
    let on = true;
    const run = () => on && void fn();
    run();
    const t = setInterval(run, ms);
    return () => {
      on = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/* ------------------------------------------------------------------ Changes */

type FileRow = { path: string; rel: string; add: number; del: number; edits: number; lastTs: number; from: number; isNew: boolean; hunks: Hunk[] };

/**
 * Every file the session changed, newest first, with what it added and removed; pick one to see its change over the
 * whole session (from before its first edit to now), or open it in the diff viewer.
 */
export function ChangesPanel({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const turns = useMemo(() => turnsFor(sessionId), [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const files = useMemo(() => {
    const m = new Map<string, FileRow>();
    for (const t of turns)
      for (const f of t.files) {
        const k = f.path.toLowerCase();
        const had = m.get(k);
        m.set(
          k,
          had
            ? { ...had, add: had.add + f.add, del: had.del + f.del, edits: had.edits + f.edits.length, lastTs: Math.max(had.lastTs, f.lastTs), from: Math.min(had.from, t.from), isNew: had.isNew || f.isNew, hunks: [...had.hunks, ...f.edits.flatMap((x) => x.hunks ?? [])] }
            : { path: f.path, rel: f.rel, add: f.add, del: f.del, edits: f.edits.length, lastTs: f.lastTs, from: t.from, isNew: f.isNew, hunks: f.edits.flatMap((x) => x.hunks ?? []) },
        );
      }
    return [...m.values()].sort((a, b) => b.lastTs - a.lastTs);
  }, [turns]);
  const [pick, setPick] = useState<string | null>(null);
  const cur = files.find((f) => f.path === pick) ?? files[0];
  const [net, setNet] = useState<{ path: string; hunks: Hunk[] | null; tooBig?: boolean } | null>(null);
  // its change over the session, fetched again as new edits land
  useEffect(() => {
    if (!cur) return;
    let dead = false;
    const t = setTimeout(async () => {
      const q = new URLSearchParams({ path: cur.path, from: String(cur.from) });
      const r = await fetch(`/api/sessions/${sid(sessionId)}/changes/net?${q}`).catch(() => null);
      const j = r?.ok ? await r.json() : null;
      if (!dead) setNet(j ? { path: cur.path, hunks: j.hunks, tooBig: j.tooBig } : { path: cur.path, hunks: null });
    }, 250);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [sessionId, cur?.path, cur?.lastTs, cur?.from]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!files.length) return <div className="lb-empty">No files changed in this session yet.</div>;
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return (
    <div className="lb-split">
      <div className="lb-list">
        <div className="lb-sum">
          {files.length} file{files.length === 1 ? '' : 's'} · <span className="plus">+{add}</span> <span className="minus">−{del}</span>
        </div>
        {files.map((f) => (
          <button key={f.path} className={`lb-file${f === cur ? ' on' : ''}`} onClick={() => setPick(f.path)} title={f.path}>
            <span className="p">
              {f.rel}
              {f.isNew ? <span className="tag">new</span> : null}
            </span>
            <Counts add={f.add} del={f.del} />
          </button>
        ))}
      </div>
      <div className="lb-diff-view">
        {cur ? (
          <div className="lb-dh">
            <span className="p" title={cur.path}>
              {cur.rel}
            </span>
            <span className="m">
              {cur.edits} edit{cur.edits === 1 ? '' : 's'} · {ago(cur.lastTs)}
            </span>
            <button className="lb-pop" onClick={() => openChanges(sessionId, cur.path, { from: cur.from })} title="Open it in the diff viewer">
              <Icon name="SquareArrowOutUpRight" size={11} /> Open
            </button>
          </div>
        ) : null}
        {!net || net.path !== cur?.path ? (
          <div className="lb-empty">loading…</div>
        ) : net.hunks?.length ? (
          <MiniDiff hunks={net.hunks} path={cur.path} />
        ) : cur.hunks.length ? (
          // no before-and-after to compare: its edits, one after another
          <>
            <div className="lb-note">Each edit as it landed (the file's before and after can't be compared here).</div>
            <MiniDiff hunks={cur.hunks} path={cur.path} />
          </>
        ) : (
          <div className="lb-empty">{net.tooBig ? 'Too big to show here: open it.' : 'No difference left (the edits cancel out), or it can’t be read: open it.'}</div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Git */

type GitState = { repo: boolean; branch?: string; files: Array<{ path: string; status: string; add: number; del: number; binary?: boolean }> };
const GIT_STATUS: Record<string, [string, string]> = { M: ['M', 'modified'], A: ['A', 'added'], D: ['D', 'deleted'], R: ['R', 'renamed'], '?': ['U', 'untracked'], U: ['!', 'conflict'] };

/** The repo the session works in: its branch, what's uncommitted (click one for its diff), and what the session committed and pushed. */
export function GitPanel({ sessionId }: { sessionId: string }) {
  const [g, setG] = useState<GitState | null>(null);
  const version = useBrain((s) => s.versions[sessionId]);
  const load = async () => {
    last.current = Date.now();
    const r = await fetch(`/api/sessions/${sid(sessionId)}/changes/git`).catch(() => null);
    if (r?.ok) setG(await r.json());
  };
  // every 15 s, and again as the session works (at most every 4 s)
  const last = useRef(0);
  usePoll(load, 15_000, [sessionId]);
  useEffect(() => {
    const t = setTimeout(() => void load(), Math.max(0, 4000 - (Date.now() - last.current)));
    return () => clearTimeout(t);
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  const git = useMemo(() => programDetails(sessionEvents(sessionId)).get('git'), [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!g) return <div className="lb-empty">loading…</div>;
  if (!g.repo) return <div className="lb-empty">This session's folder isn't in a git repository.</div>;
  const st = (s: string) => GIT_STATUS[s.trim()[0] ?? 'M'] ?? [s.trim()[0] ?? '?', s];
  return (
    <div className="lb-git">
      <div className="lb-branch">
        <Icon name="GitBranch" size={13} />
        <b>{g.branch || 'detached'}</b>
        {git?.ahead ? <span className="chip warn">↑{git.ahead} not pushed</span> : git?.pushed ? <span className="chip ok">pushed</span> : null}
        <span className="chip">{g.files.length ? `${g.files.length} uncommitted` : 'clean'}</span>
      </div>
      {g.files.length ? (
        <div className="lb-grp">
          <div className="lb-gh">Uncommitted</div>
          {g.files.map((f) => {
            const [letter, word] = st(f.status);
            return (
              <button key={f.path} className="lb-file" onClick={() => openChanges(sessionId, f.path, { mode: 'git' })} title={`${f.path} · ${word}`}>
                <span className={`gs s-${letter}`}>{letter}</span>
                <span className="p">{f.path}</span>
                {f.binary ? <span className="m">binary</span> : <Counts add={f.add} del={f.del} />}
              </button>
            );
          })}
        </div>
      ) : null}
      {git?.commits?.length ? (
        <div className="lb-grp">
          <div className="lb-gh">Committed this session</div>
          {git.commits.map((c, i) => (
            <div key={i} className="lb-commit">
              <Icon name="GitCommitHorizontal" size={12} /> <span>{c}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Tests */

type Run = { id: string; cmd: string; at: number; ms?: number; ok: boolean | null; counts: ReturnType<typeof testCounts> };
/** Counts read from a run's whole output, for runs whose preview stopped before the summary (by tool call). */
const fullCounts = new Map<string, ReturnType<typeof testCounts> | 'loading'>();

/** The session's test runs, newest first: passed and failed (a bar per run), how long, the command. */
export function TestsPanel({ sessionId }: { sessionId: string }) {
  const version = useBrain((s) => s.versions[sessionId]);
  const [, bump] = useState(0);
  const runs = useMemo(() => {
    const starts = new Map<string, BrainEvent>();
    const out: Run[] = [];
    for (const e of sessionEvents(sessionId)) {
      if (e.kind !== 'tool' || !e.toolUseId || (e.tool?.name !== 'Bash' && e.tool?.name !== 'PowerShell')) continue;
      if (e.phase === 'start') {
        const cmd = String((e.tool.input as { command?: unknown } | undefined)?.command ?? e.tool.summary ?? '');
        if (TEST_CMD.test(cmd)) {
          starts.set(e.toolUseId, e);
          out.push({ id: e.toolUseId, cmd, at: e.ts, ok: null, counts: null });
        }
        continue;
      }
      const r = out.find((x) => x.id === e.toolUseId);
      if (!r) continue;
      r.ok = !e.tool?.failed;
      r.ms = e.durationMs;
      const full = fullCounts.get(r.id);
      r.counts = testCounts(String(e.tool?.preview ?? '')) ?? (full && full !== 'loading' ? full : null);
    }
    return out.reverse();
  }, [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  // the newest few without counts: read their whole output (the preview is only its start)
  useEffect(() => {
    for (const r of runs.slice(0, 6)) {
      if (r.ok == null || r.counts || fullCounts.has(r.id)) continue;
      fullCounts.set(r.id, 'loading');
      void fetchToolDetail(sessionId, r.id).then((d) => {
        fullCounts.set(r.id, d ? testCounts(String(d.result ?? '')) : null);
        bump((n) => n + 1);
      });
    }
  }, [runs, sessionId]);
  if (!runs.length) return <div className="lb-empty">No test runs in this session yet.</div>;
  const last = runs.find((r) => r.counts) ?? runs[0];
  const bars = runs.slice(0, 24).reverse();
  const max = Math.max(1, ...bars.map((r) => (r.counts ? r.counts.pass + r.counts.fail : 1)));
  return (
    <div className="lb-tests">
      <div className="lb-tsum">
        {last.counts ? (
          <>
            <b className={last.counts.fail ? 'bad' : 'ok'}>{last.counts.fail ? `${last.counts.fail} failed` : 'all passed'}</b>
            <span>
              {last.counts.pass} passed{last.counts.fail ? ` · ${last.counts.fail} failed` : ''}
              {last.counts.skip ? ` · ${last.counts.skip} skipped` : ''}
            </span>
          </>
        ) : (
          <b className={last.ok === false ? 'bad' : last.ok ? 'ok' : 'run'}>{last.ok == null ? 'running…' : last.ok ? 'passed' : 'failed'}</b>
        )}
        <span className="when">{ago(last.at)}</span>
      </div>
      <div className="lb-tbars" title="Each run, oldest to newest: green passed, red failed">
        {bars.map((r) => {
          const c = r.counts;
          const h = (n: number) => `${Math.max(n ? 8 : 0, (100 * n) / max)}%`;
          return (
            <span key={r.id} className={`b${r.ok == null ? ' run' : ''}`} title={`${maskSecrets(r.cmd).text}\n${c ? `${c.pass} passed, ${c.fail} failed` : r.ok == null ? 'running' : r.ok ? 'passed' : 'failed'}`}>
              {c ? (
                <>
                  <i className="f" style={{ height: h(c.fail) }} />
                  <i className="p" style={{ height: h(c.pass) }} />
                </>
              ) : (
                <i className={r.ok === false ? 'f' : r.ok ? 'p' : 'r'} style={{ height: '100%' }} />
              )}
            </span>
          );
        })}
      </div>
      {runs.map((r) => (
        <div key={r.id} className="lb-run">
          <Icon name={r.ok == null ? 'LoaderCircle' : r.ok && !r.counts?.fail ? 'CircleCheck' : 'CircleX'} size={13} className={`i ${r.ok == null ? 'run' : r.ok && !r.counts?.fail ? 'ok' : 'bad'}`} />
          <span className="c" title={r.cmd}>
            {maskSecrets(r.cmd).text}
          </span>
          <span className="m">
            {r.counts ? `${r.counts.pass}✓${r.counts.fail ? ` ${r.counts.fail}✗` : ''} · ` : ''}
            {r.ms != null ? shortDur(r.ms) : ago(r.at)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Background */

const BG_ICON: Record<BgTask['status'], string> = { running: 'LoaderCircle', completed: 'CircleCheck', failed: 'CircleX', killed: 'OctagonX', stopped: 'CircleStop', lost: 'CircleHelp' };

/** Commands sent to the background: running first, each with the last lines it wrote (read every few seconds while it runs). */
export function BackgroundPanel({ sessionId, data }: { sessionId: string; data: BoardData }) {
  const tasks = [...data.d.tasks].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt);
  if (!tasks.length) return <div className="lb-empty">Nothing in the background. Commands Claude runs in the background (dev servers, watchers, long builds) show here with their output.</div>;
  return (
    <div className="lb-bgs">
      {tasks.map((t) => (
        <BgCard key={t.key} t={t} sessionId={sessionId} color={data.color[t.agentId]} />
      ))}
    </div>
  );
}

function BgCard({ t, sessionId, color }: { t: BgTask; sessionId: string; color?: string }) {
  const [tail, setTail] = useState<string[] | null>(null);
  const running = t.status === 'running';
  usePoll(
    async () => {
      if (!t.taskId) return;
      const r = await fetch(`/api/sessions/${sid(sessionId)}/tasks/${encodeURIComponent(t.taskId)}/tail`).catch(() => null);
      if (r?.ok) setTail(((await r.json()) as { lines: string[] }).lines);
    },
    running ? 2500 : 600_000,
    [sessionId, t.taskId, running],
  );
  return (
    <div className={`lb-bg s-${t.status}`}>
      <div className="h">
        <Icon name={BG_ICON[t.status]} size={13} className="i" />
        <span className="who" style={{ background: color ?? 'var(--ink4)' }} />
        <span className="c" title={t.command}>
          {maskSecrets(t.label || t.command).text}
        </span>
        <span className="m">{running ? `running ${shortDur(Date.now() - t.startedAt)}` : outcome(t)}</span>
      </div>
      {tail?.length ? (
        <pre className="out">{tail.map((l) => maskSecrets(l).text).join('\n')}</pre>
      ) : t.taskId ? null : (
        <div className="out none">its output isn't saved where Cora can read it</div>
      )}
    </div>
  );
}
