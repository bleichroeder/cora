import { useEffect, useState } from 'react';
import { ciActive, ciRef, ciRepoName, type CiJob, type CiPipeline } from '@cora/shared';
import { useCi } from '../state/ci';
import { useWeb } from '../state/web';
import { desktop } from '../lib/desktop';
import { CI_COLOR, HEADER_MS, ciLabel, dur, elapsed, followed, jobColor, jobElapsed } from '../lib/ci';
import { Icon } from './Icon';
import '../ci.css';
import './popovers.css';

/** Open a GitLab page in the session's browser (the desktop app), else a new browser tab. */
export function openLink(sessionId: string, url: string) {
  if (desktop?.browser) useWeb.getState().open(sessionId, url, { reload: true });
  else window.open(url, '_blank', 'noopener');
}

function useNow(ms: number, on: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms, on]);
  return on ? now : Date.now();
}

/** The pipeline a session follows, re-rendered only when it (or its link) changes; `within`: how long a finished one stays. */
export function useFollowed(sessionId: string, within?: number) {
  const link = useCi((c) => c.links[sessionId]);
  const pipelines = useCi((c) => c.pipelines);
  return followed(link, pipelines, Date.now(), within);
}

/** How long a pipeline that just finished stays loud in the header (a failure keeps a quieter glow after). */
const FRESH_MS = 2 * 60_000;

/**
 * In the session header: the followed pipeline as a row of stage segments, its status and how long it has run.
 * Hover for the stages and jobs (a failed job opens its log); click to open the pipeline. It asks for a little attention
 * by state: a shimmer while it runs, a breath while a manual job waits on you, a flash when it passes, a red pulse for
 * a couple of minutes when it fails (then a steady glow).
 */
export function CiHeader({ sessionId }: { sessionId: string }) {
  const f = useFollowed(sessionId, HEADER_MS);
  const health = useCi((c) => c.health);
  const onGitLab = useCi((c) => !!c.links[sessionId]?.repo);
  const active = !!f && ciActive(f.p.status);
  const justDone = !!f && !active && f.p.finishedAt != null && Date.now() - f.p.finishedAt < FRESH_MS;
  const now = useNow(1000, active || justDone);
  // pipelines can't be read at all (no glab, signed out, offline): one quiet line, for sessions in a GitLab repo
  if (!f) return onGitLab && health.state !== 'ok' && health.state !== 'error' ? <span className="pl-head off" title={health.message}><Icon name="GitBranch" size={12} /> <span className="pl-msg">{health.message}</span></span> : null;
  const p = f.p;
  const stale = !active && now - (p.finishedAt ?? p.createdAt) > 30 * 60_000;
  const fresh = !active && p.finishedAt != null && now - p.finishedAt < FRESH_MS;
  return (
    <span className={`pl-head st-${p.status}${stale ? ' stale' : ''}${fresh ? ' fresh' : ''}`} style={{ ['--c' as any]: CI_COLOR[p.status] }}>
      <button className="pl-main" onClick={() => openLink(sessionId, p.url)} title="Open the pipeline">
        <span className={`dl-glyph ${glyphOf(p.status)}`} />
        <span className="pl-t">
          {ciLabel(p.status)}
          <span className="pl-when">{p.status === 'failed' ? failedJob(p) ?? dur(elapsed(p, now)) : dur(elapsed(p, now))}</span>
        </span>
      </button>
      <PipelineCard p={p} sessionId={sessionId} now={now} />
    </span>
  );
}

function PipelineCard({ p, sessionId, now }: { p: CiPipeline; sessionId: string; now: number }) {
  return (
    <span className="fh-card pl-card">
      <span className="r">
        <span className="k">pipeline</span>
        <a href={p.url} target="_blank" rel="noopener noreferrer" onClick={(e) => (e.preventDefault(), openLink(sessionId, p.url))}>#{p.id}</a>
      </span>
      <span className="r"><span className="k">repo</span><span>{ciRepoName(p.project)}</span></span>
      <span className="r"><span className="k">ref</span><span>{ciRef(p.ref)}{p.sha ? ` · ${p.sha.slice(0, 8)}` : ''}</span></span>
      <span className="r"><span className="k">status</span><span style={{ color: CI_COLOR[p.status] }}>{ciLabel(p.status)} · {dur(elapsed(p, now))}</span></span>
      <span className="pl-list">
        {p.stages.map((s) => (
          <span key={s.name} className="pl-st">
            <span className="pl-sn" style={{ color: CI_COLOR[s.status] }}>● {s.name}</span>
            <span className="pl-jobs">
              {s.jobs.map((j) => <JobChip key={j.id} j={j} sessionId={sessionId} project={p.project} now={now} />)}
            </span>
          </span>
        ))}
        {!p.stages.length ? <span className="hint">jobs not read yet</span> : null}
      </span>
    </span>
  );
}

function JobChip({ j, sessionId, project, now }: { j: CiJob; sessionId: string; project: string; now: number }) {
  const t = jobElapsed(j, now);
  const failed = j.status === 'failed';
  return (
    <button
      className={`pl-job st-${j.status}${failed ? ' clickable' : ''}`}
      style={{ ['--c' as any]: jobColor(j) }}
      title={`${j.name} · ${ciLabel(j.status)}${j.allowFailure && failed ? ' (allowed to fail)' : ''}${t != null ? ` · ${dur(t)}` : ''}${failed ? ' · click for its log' : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (failed) useCi.getState().openLog({ sessionId, project, job: j });
        else openLink(sessionId, j.url);
      }}
    >
      <i />
      {j.name}
    </button>
  );
}

/** A pipeline's status as the design language's glyph class. */
const glyphOf = (status: string) => (status === 'success' ? 'ok' : status === 'failed' ? 'bad' : ['running', 'pending', 'created', 'preparing', 'waiting_for_resource'].includes(status) ? 'run' : 'idle');
/** The first job that failed (not allowed to), for the header. */
const failedJob = (p: CiPipeline) => p.stages.flatMap((s) => s.jobs).find((j) => j.status === 'failed' && !j.allowFailure)?.name;

/** A session's pipeline as one small glyph: spinning while it runs, green when it passed, red when it failed. */
/** `quiet`: only when it's worth a look (running or failed); a passed one, the usual case, shows nothing. */
export function CiGlyph({ sessionId, quiet }: { sessionId: string; quiet?: boolean }) {
  const f = useFollowed(sessionId);
  if (!f) return null;
  const p = f.p;
  if (quiet && !['run', 'bad'].includes(glyphOf(p.status))) return null;
  return <span className={`dl-glyph ${glyphOf(p.status)}`} title={`Pipeline #${p.id} on ${ciRef(p.ref)}: ${ciLabel(p.status)}`} />;
}

/** A failed job's last lines, over the scene, with a way to open the whole thing. */
export function CiLogPanel({ sessionId }: { sessionId: string }) {
  const log = useCi((c) => c.log);
  const [state, setState] = useState<{ lines?: string[]; error?: string } | null>(null);
  const on = log && log.sessionId === sessionId ? log : null;
  useEffect(() => {
    if (!on) return;
    let alive = true;
    setState(null);
    fetch(`/api/ci/log?project=${encodeURIComponent(on.project)}&job=${on.job.id}`)
      .then(async (r) => {
        const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
        if (alive) setState(j);
      })
      .catch((e) => alive && setState({ error: String(e) }));
    return () => {
      alive = false;
    };
  }, [on?.project, on?.job.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!on) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && useCi.getState().openLog(null);
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [on]);
  useEffect(() => {
    // scrolled to the end: the error is at the bottom
    const el = document.querySelector('.pl-log pre');
    if (el) el.scrollTop = el.scrollHeight;
  }, [state]);
  if (!on) return null;
  const j = on.job;
  return (
    <div className="pl-log" onPointerDown={(e) => e.stopPropagation()}>
      <div className="pl-log-h">
        <span className="pl-dot" style={{ background: jobColor(j) }} />
        <b>{j.name}</b>
        <span className="dim">{j.stage} · {ciLabel(j.status)}{j.failureReason ? ` · ${j.failureReason.replace(/_/g, ' ')}` : ''}</span>
        <span className="spacer" />
        <button className="btn ghost" onClick={() => openLink(sessionId, j.url)}><Icon name="ExternalLink" size={12} /> Open in browser</button>
        <button className="btn ghost" title="Close (Esc)" onClick={() => useCi.getState().openLog(null)}><Icon name="X" size={12} /></button>
      </div>
      <pre>{state == null ? 'reading the log…' : state.error ? `couldn't read the log: ${state.error}` : state.lines?.length ? state.lines.join('\n') : '(empty log)'}</pre>
    </div>
  );
}
