import { useEffect, useMemo, useState } from 'react';
import { ciRef, ciRepoName, type CiJob } from '@cora/shared';
import { useBrain, sessionEvents } from '../../state/store';
import { useCi } from '../../state/ci';
import { useDeploys } from '../../state/deploys';
import { useJiraIssue } from '../../state/jira';
import { useJiraWatch } from '../../state/jiraWatch';
import { CI_COLOR, ciLabel, dur, elapsed, jobElapsed } from '../../lib/ci';
import { programDetails } from '../../scene/programs';
import { ago } from '../../lib/format';
import { useFollowed, openLink } from '../CiStrip';
import { JourneyCard } from '../Deploys';
import { Avatar, JiraText, MISS, openInBrowser, priorityColor, typeIcon } from '../JiraChip';
import { TicketSlack } from '../TicketCard';
import { Icon } from '../Icon';

/* ------------------------------------------------------------------ Pipeline & MR */

/**
 * The pipeline the session follows (its branch's or its MR's), stage by stage with every job and how long it took
 * (a failed job: its log, right here); and the merge request, when Cora knows it.
 */
export function PipelinePanel({ sessionId }: { sessionId: string }) {
  const f = useFollowed(sessionId, 7 * 24 * 3600_000);
  // the session's repo and branch, as CI knows them
  const repo = useCi((c) => c.links[sessionId]?.repo ?? null);
  const journey = useDeploys((d) => d.s.journeys.find((j) => j.sessionId === sessionId));
  const version = useBrain((s) => s.versions[sessionId]);
  const glab = useMemo(() => programDetails(sessionEvents(sessionId)).get('glab'), [sessionId, version]); // eslint-disable-line react-hooks/exhaustive-deps
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const [log, setLog] = useState<{ job: CiJob; lines: string[] | null; error?: string } | null>(null);
  const openLog = async (project: string, job: CiJob) => {
    if (log?.job.id === job.id) return setLog(null);
    setLog({ job, lines: null });
    const r = await fetch(`/api/ci/log?project=${encodeURIComponent(project)}&job=${job.id}`).catch(() => null);
    const j = r ? await r.json().catch(() => null) : null;
    setLog({ job, lines: j?.lines ?? null, error: j?.error ?? (r?.ok ? undefined : "couldn't read it") });
  };
  const mrs = journey?.mrs ?? [];
  if (!f && !mrs.length && !glab?.mr)
    return <div className="lb-empty">{repo ? `No pipeline for ${repo.branch} yet. It shows here once one runs.` : 'No pipeline: this session isn’t on a GitLab branch Cora follows.'}</div>;
  const p = f?.p;
  return (
    <div className="lb-pipe">
      {p ? (
        <>
          <div className="lb-ph2" style={{ ['--c' as string]: CI_COLOR[p.status] }}>
            <span className="st">
              <i /> {ciLabel(p.status)}
            </span>
            <span className="m">
              {ciRepoName(p.project)} · {ciRef(p.ref)} · {dur(elapsed(p, now))}
              {p.finishedAt ? ` · ${ago(p.finishedAt, now)}` : ''}
            </span>
            <button className="lb-pop" onClick={() => openLink(sessionId, p.url)} title="Open the pipeline">
              #{p.id}
            </button>
          </div>
          <div className="lb-stages">
            {p.stages.map((s) => (
              <div key={s.name} className="lb-stage">
                <div className="sn" style={{ color: CI_COLOR[s.status] }}>
                  <i style={{ background: CI_COLOR[s.status] }} /> {s.name}
                </div>
                {s.jobs.map((j) => {
                  const t = jobElapsed(j, now);
                  const failed = j.status === 'failed';
                  return (
                    <button
                      key={j.id}
                      className={`lb-job${log?.job.id === j.id ? ' on' : ''}`}
                      style={{ ['--c' as string]: failed && j.allowFailure ? '#fb923c' : CI_COLOR[j.status] }}
                      onClick={() => (failed ? void openLog(p.project, j) : openLink(sessionId, j.url))}
                      title={`${j.name} · ${ciLabel(j.status)}${failed ? ' · click for its log' : ' · click to open it'}`}
                    >
                      <i />
                      <span className="n">{j.name}</span>
                      <span className="d">{t != null ? dur(t) : ciLabel(j.status)}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!p.stages.length ? <div className="lb-empty">Jobs not read yet.</div> : null}
          </div>
          {log ? (
            <div className="lb-log">
              <div className="h">
                <b>{log.job.name}</b> · the end of its log
                <button className="ib" onClick={() => setLog(null)} title="Close">
                  <Icon name="X" size={12} />
                </button>
              </div>
              <pre>{log.lines ? log.lines.join('\n') : (log.error ?? 'loading…')}</pre>
            </div>
          ) : null}
        </>
      ) : null}
      {mrs.length ? (
        <div className="lb-grp">
          <div className="lb-gh">Merge request{mrs.length > 1 ? 's' : ''}</div>
          {mrs.map((m) => (
            <button key={m.iid} className="lb-mr" onClick={() => openLink(sessionId, m.url)} title="Open the merge request">
              <Icon name={m.state === 'merged' ? 'GitMerge' : 'GitPullRequest'} size={13} className={`i ${m.state}`} />
              <span className="t">
                !{m.iid} {m.title}
              </span>
              <span className="m">
                {m.draft ? 'draft · ' : ''}
                {m.state}
                {m.pipeline ? ` · pipeline ${ciLabel(m.pipeline.status as never)}` : ''}
              </span>
            </button>
          ))}
        </div>
      ) : glab?.mr ? (
        <div className="lb-grp">
          <div className="lb-gh">Merge request (from glab)</div>
          <div className="lb-mr">
            <Icon name="GitPullRequest" size={13} className="i" />
            <span className="t">
              !{glab.mr} {glab.mrTitle ?? ''}
            </span>
            <span className="m">{glab.mrState ?? ''}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Deploys */

/** Where the session's change has got to: its MR, the pipeline, the tag, and each environment (bump dev from here). */
export function DeploysPanel({ sessionId }: { sessionId: string }) {
  const journey = useDeploys((d) => d.s.journeys.find((j) => j.sessionId === sessionId));
  const envs = useDeploys((d) => d.s.envs);
  if (!journey)
    return <div className="lb-empty">Nothing to follow yet. Cora follows a change to the environments once the session has a Jira ticket and a GitLab merge request for it.</div>;
  return (
    <div className="lb-deploy">
      <JourneyCard j={journey} envs={envs} />
    </div>
  );
}

/* ------------------------------------------------------------------ Ticket */

const STATUS_COLOR: Record<string, string> = { done: 'var(--work)', progress: 'var(--run)', todo: 'var(--ink3)' };

/** The session's Jira ticket: its status, who has it, its description, and a way to it (and its Slack mentions). */
export function TicketPanel({ sessionId }: { sessionId: string }) {
  const ticket = useBrain((s) => s.sessions[sessionId]?.ticket);
  if (!ticket) return <div className="lb-empty">This session has no Jira ticket. Cora picks one up from the branch, the conversation or the ticket picker in the header.</div>;
  return <TicketBody sessionId={sessionId} tkey={ticket.key} site={ticket.site ?? undefined} summary={ticket.summary ?? undefined} />;
}

function TicketBody({ sessionId, tkey, site, summary }: { sessionId: string; tkey: string; site?: string; summary?: string }) {
  const r = useJiraIssue(tkey, site);
  const news = useJiraWatch((w) => w.unseen[tkey]);
  const i = r?.ok ? r.value : null;
  return (
    <div className="lb-ticket">
      <div className="lb-tk">
        <Icon name={typeIcon(i?.type)} size={14} className="ty" />
        <b className="k">{tkey}</b>
        {i ? (
          <span className="st" style={{ ['--c' as string]: STATUS_COLOR[i.status.category] ?? 'var(--ink3)' }}>
            {i.status.name}
          </span>
        ) : r && !r.ok ? (
          <span className="st">{MISS[r.error] ?? r.error}</span>
        ) : null}
        {news ? <span className="new">new comments</span> : null}
        <span className="sp" />
        {i ? (
          <button className="lb-pop" onClick={() => openInBrowser(i.url, sessionId)} title="Open the ticket">
            <Icon name="SquareArrowOutUpRight" size={11} /> Open
          </button>
        ) : null}
      </div>
      <div className="lb-ts">{i?.summary ?? summary ?? '…'}</div>
      {i ? (
        <div className="lb-tmeta">
          {i.assignee ? (
            <span>
              <Avatar name={i.assignee.name} url={i.assignee.avatarUrl} /> {i.assignee.name}
            </span>
          ) : (
            <span>unassigned</span>
          )}
          {i.priority ? (
            <span>
              <i className="pr" style={{ background: priorityColor(i.priority.name) }} /> {i.priority.name}
            </span>
          ) : null}
          {i.type ? <span>{i.type.name}</span> : null}
          {i.updated ? <span>updated {ago(Date.parse(i.updated))}</span> : null}
          <TicketSlack ticketKey={tkey} />
        </div>
      ) : null}
      {i?.description ? (
        <div className="lb-tdesc">
          <JiraText text={i.description} sessionId={sessionId} />
        </div>
      ) : i ? (
        <div className="lb-empty">No description.</div>
      ) : null}
    </div>
  );
}
