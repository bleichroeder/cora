import { Fragment, useEffect, useMemo, useState } from 'react';
import { ago, envOrder, issueUrl, journeySteps, journeyWhere, projectName, serviceRows, type BumpTarget, type DeployBump, type DeployEnv, type DeploySuggestion, type Journey, type ServiceRow } from '@cora/shared';
import { bumpDev, bumpsToShow, dismissDeploy, useDeploys } from '../state/deploys';
import { useCi } from '../state/ci';
import { jiraSite } from '../state/jira';
import { useBrain } from '../state/store';
import { openInBrowser } from './JiraChip';
import { Icon } from './Icon';
import '../deploys.css';

/**
 * Deploys (server/src/deploys.ts): where a ticket's change is (the journey chip in the session header), Cora's next
 * step (the bump cards), and what every environment runs (the Overview's Deploys view). The only write is a dev bump,
 * and it always asks first.
 */

const short = (p: string) => projectName(p);
const envLabel = (envs: DeployEnv[], id: string) => envs.find((e) => e.id === id)?.label ?? id;

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------------------------------------------------------
// the journey chip

/** In the session header: how far its ticket's change has got (a dot per step); hover for the journey and the next step. */
export function DeployHeader({ sessionId }: { sessionId: string }) {
  const j = useDeploys((d) => d.s.journeys.find((x) => x.sessionId === sessionId));
  const envs = useDeploys((d) => d.s.envs);
  const [pinned, setPinned] = useState(false);
  if (!j || !j.mrs.length) return null;
  const steps = journeySteps(j, envs);
  const where = journeyWhere(j, envs);
  const rolling = steps.some((s) => s.state === 'run');
  return (
    <span className={`dp-head${pinned ? ' open' : ''}`} onMouseLeave={() => setPinned(false)}>
      <button className="dp-chip" title="Where this ticket's change is" onClick={() => setPinned(!pinned)}>
        <span className="dp-dots">
          {steps.map((s) => (
            <i key={s.id} className={s.state} />
          ))}
        </span>
        <span className={`dp-where${rolling ? ' run' : ''}`}>{where}</span>
      </button>
      <span className="fh-card dp-card">
        <JourneyCard j={j} envs={envs} />
      </span>
    </span>
  );
}

function JourneyCard({ j, envs }: { j: Journey; envs: DeployEnv[] }) {
  const s = useDeploys((d) => d.s.suggestions.find((x) => x.sessionId === j.sessionId));
  const bump = useDeploys((d) => d.s.bumps.find((b) => b.project === j.project && b.state === 'rolling'));
  const [confirm, setConfirm] = useState(false);
  const now = useNow(30_000);
  const steps = journeySteps(j, envs, now);
  const mr = j.mrs[0];
  return (
    <>
      <span className="dp-h">
        <b>
          <span className="k">{j.key}</span> · {mr.title.replace(new RegExp(`^\\s*\\[?${j.key}\\]?[:\\s-]*`, 'i'), '')}
        </b>
        <span className="dp-sub">
          {short(j.project)} · {j.mrs.map((m) => `!${m.iid}`).join(' ')}
          {j.ready ? ` · ${j.ready}` : ''}
        </span>
        <Scope services={j.services} shared={j.shared} />
      </span>
      <span className="dp-journey" style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
        {steps.map((st) => (
          <span key={st.id} className={`dp-step ${st.state}`}>
            <span className="o" />
            <b>{st.label}</b>
            <span>{st.detail}</span>
          </span>
        ))}
      </span>
      {bump ? (
        <span className="dp-note">
          <span className="dl-glyph run" /> Rolling out {bump.tag} to {envLabel(envs, bump.env)}…
        </span>
      ) : null}
      {confirm && s ? <BumpConfirm s={s} onDone={() => setConfirm(false)} /> : null}
      <span className="dp-acts">
        {s && !confirm && !bump ? (
          <button className="btn allow" onClick={() => setConfirm(true)}>
            <Icon name="Rocket" size={12} /> Bump dev to {s.tag}…
          </button>
        ) : null}
        <button className="btn ghost" onClick={() => openInBrowser(mr.url, j.sessionId)}>
          Open MR
        </button>
        {j.mrs.find((m) => m.pipeline)?.pipeline ? (
          <button className="btn ghost" onClick={() => openInBrowser(j.mrs.find((m) => m.pipeline)!.pipeline!.url, j.sessionId)}>
            Pipeline
          </button>
        ) : null}
      </span>
    </>
  );
}

/** Which services the ticket's MRs change, and the shared code they touch (other services may want it too). */
function Scope({ services, shared }: { services: string[]; shared: string[] }) {
  if (!services.length && !shared.length) return null;
  return (
    <span className="dp-scope">
      {services.length ? `changes ${services.join(', ')}` : "changes no service's own folder"}
      {shared.length ? <em> · shared: {shared.slice(0, 3).join(', ')}{shared.length > 3 ? ` +${shared.length - 3}` : ''}</em> : null}
    </span>
  );
}

/** Which workloads a bump changes (the older ones ticked), then the bump itself. */
function BumpConfirm({ s, onDone }: { s: Pick<DeploySuggestion, 'env' | 'tag' | 'targets'> & { key?: string }; onDone: () => void }) {
  const [on, setOn] = useState<Set<string>>(() => new Set(s.targets.filter((t) => t.on).map((t) => t.name + '/' + t.container)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const env = useDeploys((d) => d.s.envs.find((e) => e.id === s.env));
  const id = (t: BumpTarget) => t.name + '/' + t.container;
  const chosen = s.targets.filter((t) => on.has(id(t)));
  const go = async () => {
    setBusy(true);
    setErr(null);
    const e = await bumpDev(s.env, s.tag, chosen, s.key);
    setBusy(false);
    if (e) setErr(e);
    else onDone();
  };
  return (
    <span className="dp-confirm">
      <span className="dp-ch" title={env?.id}>
        Set {s.tag} on {env?.name ?? 'dev'}
        {env ? <span className="dp-host"> · {env.id}</span> : null}
      </span>
      {s.targets.map((t) => (
        <label key={id(t)} className="dp-t" title={`${t.kind} ${t.namespace}/${t.name} · ${t.container}`}>
          <input type="checkbox" checked={on.has(id(t))} onChange={(e) => setOn((o) => (e.target.checked ? new Set([...o, id(t)]) : new Set([...o].filter((x) => x !== id(t)))))} />
          <span className="n">{t.name}</span>
          <span className="f">{t.from}</span>
        </label>
      ))}
      {err ? <span className="cc-inerr">{err}</span> : null}
      <span className="dp-acts">
        <button className="btn allow" disabled={busy || !chosen.length} onClick={() => void go()}>
          <Icon name="Rocket" size={12} /> {busy ? 'Bumping…' : `Bump ${chosen.length}`}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onDone}>
          Cancel
        </button>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Cora's cards

/** What Cora has for you about deploys: offers to bump dev, and bumps rolling out or just finished. */
export function useDeployCards(): { suggestions: DeploySuggestion[]; bumps: DeployBump[] } {
  const suggestions = useDeploys((d) => d.s.suggestions);
  const all = useDeploys((d) => d.s.bumps);
  useNow(60_000);
  const bumps = useMemo(() => bumpsToShow(all), [all]);
  return { suggestions, bumps };
}

export function DeployCards({ inline = false }: { inline?: boolean }) {
  const { suggestions, bumps } = useDeployCards();
  return (
    <>
      {suggestions.map((s) => (
        <SuggestCard key={s.id} s={s} inline={inline} />
      ))}
      {bumps.map((b) => (
        <BumpCard key={b.id} b={b} inline={inline} />
      ))}
    </>
  );
}

/** A ticket's change is built and dev doesn't run it: bump dev? */
function SuggestCard({ s, inline }: { s: DeploySuggestion; inline: boolean }) {
  const [confirm, setConfirm] = useState(false);
  const envs = useDeploys((d) => d.s.envs);
  const from = [...new Set((s.targets.some((t) => t.on) ? s.targets.filter((t) => t.on) : s.targets).map((t) => t.from))];
  const names = s.targets.filter((t) => t.on).map((t) => t.name);
  const j = useDeploys((d) => d.s.journeys.find((x) => x.sessionId === s.sessionId));
  return (
    <div className={`sd-sent dp-cardx${inline ? ' inline' : ''}`} role="alert">
      <span className="sd-logo-tile">
        <Icon name="Rocket" size={13} />
      </span>
      <span className="sd-sent-t">
        <b>
          <span className="k">{s.key}</span> is built in {s.tag}
        </b>
        <span>
          {envLabel(envs, s.env)} runs {from.join(', ')} · {short(s.project)}
        </span>
        <span className="dp-pick">{names.length ? `bump ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}` : "couldn't tell which services it changes: you pick"}</span>
        {j ? <Scope services={j.services} shared={j.shared} /> : null}
        {confirm ? (
          <BumpConfirm s={s} onDone={() => setConfirm(false)} />
        ) : (
          <span className="dp-acts">
            <button className="btn allow" onClick={() => setConfirm(true)}>
              <Icon name="Rocket" size={11} /> Bump dev…
            </button>
            <button className="btn ghost" onClick={() => useBrain.getState().setFocus(s.sessionId)}>
              Session
            </button>
            <button className="btn ghost" onClick={() => void dismissDeploy(s.id)}>
              Not now
            </button>
          </span>
        )}
      </span>
      <button className="btn ghost jw-x" title="Not now" onClick={() => void dismissDeploy(s.id)}>
        <Icon name="X" size={12} />
      </button>
    </div>
  );
}

/** A bump rolling out, rolled out, or stuck. */
function BumpCard({ b, inline }: { b: DeployBump; inline: boolean }) {
  const envs = useDeploys((d) => d.s.envs);
  const now = useNow(1000);
  const env = envLabel(envs, b.env);
  const took = Math.round(((b.doneAt ?? now) - b.at) / 1000);
  const dur = took < 60 ? `${took}s` : `${Math.floor(took / 60)}m ${took % 60}s`;
  const openTicket = () => {
    const site = jiraSite();
    if (b.key && site) openInBrowser(issueUrl(site, b.key), useBrain.getState().focus ?? undefined);
  };
  return (
    <div className={`sd-sent dp-cardx dp-bump ${b.state}${inline ? ' inline' : ''}`} role="status">
      <span className="sd-logo-tile">
        {b.state === 'rolling' ? <span className="dl-glyph run" /> : <Icon name={b.state === 'done' ? 'Check' : 'TriangleAlert'} size={13} />}
      </span>
      <span className="sd-sent-t">
        <b>
          {b.state === 'rolling' ? `Rolling out ${b.tag} to ${env}` : b.state === 'done' ? `Rolled out to ${env} in ${dur}` : `${b.tag} didn't roll out on ${env}`}
        </b>
        <span>{b.state === 'failed' ? b.error : `${short(b.project)} · ${b.targets.map((t) => t.name).join(', ')}`}</span>
        {b.state === 'done' && b.key ? <span className="dp-pick">Next: test it, then move {b.key} along</span> : null}
      </span>
      {b.key && b.state !== 'rolling' ? (
        <button className="btn ghost" onClick={openTicket}>
          {b.key}
        </button>
      ) : null}
      {b.state !== 'rolling' ? (
        <button className="btn ghost jw-x" title="Dismiss" onClick={() => void dismissDeploy(b.id)}>
          <Icon name="X" size={12} />
        </button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// the Deploys view

/** The Overview's Deploys view: a row per service, a column per environment, newest build; then what changed lately. */
export function DeploysView() {
  const s = useDeploys((d) => d.s);
  const links = useCi((c) => c.links);
  const [mine, setMine] = useState(true);
  const [bumpRow, setBumpRow] = useState<string | null>(null);
  const now = useNow(30_000);
  const envs = envOrder(s.envs).filter((e) => e.label !== 'local');
  const own = useMemo(() => new Set(Object.values(links).flatMap((l) => (l.repo ? [l.repo.project] : []))), [links]);
  const rows = useMemo(() => serviceRows(s).filter((r) => r.project), [s]);
  // Mine: the services your sessions' tickets change; a project none of whose tickets can say: all of it
  const scope = useMemo(() => {
    const m = new Map<string, Set<string> | null>();
    for (const p of own) m.set(p, null);
    for (const j of s.journeys) if (j.services.length && own.has(j.project)) m.set(j.project, new Set([...(m.get(j.project) ?? []), ...j.services]));
    return m;
  }, [own, s.journeys]);
  const shown = mine && own.size ? rows.filter((r) => scope.has(r.project!) && (!scope.get(r.project!) || scope.get(r.project!)!.has(r.service))) : rows;
  const groups = useMemo(() => {
    const m = new Map<string, ServiceRow[]>();
    for (const r of shown) m.set(r.project!, [...(m.get(r.project!) ?? []), r]);
    return [...m];
  }, [shown]);
  const dev = envs.find((e) => e.label === 'dev');
  const cols = `minmax(150px, 1.1fr) repeat(${envs.length}, minmax(110px, 1fr)) minmax(130px, 1fr)`;
  return (
    <div className="dp-view">
      <div className="dp-vh">
        <span className="seg">
          <button className={`seg-b${mine ? ' on' : ''}`} disabled={!own.size} title={own.size ? "The services your sessions' tickets change (a whole project when no ticket says)" : 'No session is in a GitLab repo'} onClick={() => setMine(true)}>
            Mine
          </button>
          <button className={`seg-b${!mine || !own.size ? ' on' : ''}`} onClick={() => setMine(false)}>
            All
          </button>
        </span>
        <span className="spacer" />
        <span className="dp-net">
          {envs.map((e) => (
            <span key={e.id} title={e.error ?? (e.reachable ? 'Reachable now' : e.readAt ? 'Not reachable: its last listing' : 'Not reachable, never read')}>
              <span className={`dl-glyph ${e.error ? 'bad' : e.reachable ? 'ok' : 'idle'}`} />
              {e.label}
              {!e.reachable ? <i>{e.readAt ? ` ${ago(e.readAt, now)} ago` : ' never'}</i> : null}
            </span>
          ))}
        </span>
        {s.health.state !== 'ok' ? <span className="dp-warn" title={s.health.message}>GitLab: {s.health.message}</span> : null}
      </div>
      {!envs.length ? (
        <div className="dp-empty">Cora finds your environments from the kubeconfigs in ~/.kube (Settings › Environments).</div>
      ) : !rows.length ? (
        <div className="dp-empty">Nothing read yet. Cora reads each environment while your VPN reaches it, every few minutes.</div>
      ) : (
        <div className="dp-grid" style={{ gridTemplateColumns: cols }}>
          <div className="hd">Service</div>
          {envs.map((e) => (
            <div key={e.id} className="hd" title={e.name}>
              {e.label === 'other' ? e.name : e.label}
            </div>
          ))}
          <div className="hd">Newest build</div>
          {groups.map(([project, rs]) => (
            <Fragment key={project}>
              <div className="dp-group" style={{ gridColumn: '1 / -1' }}>
                {short(project)} <span>{project}</span>
              </div>
              {rs.map((r) => {
                const dc = dev ? r.cells[dev.id] : undefined;
                const canBump = !!dev?.reachable && !!dc && r.devBehind && !!r.newestOk;
                return (
                  <Fragment key={r.key}>
                    <div className="svc">
                      {r.service}
                      <span>{[...new Set(Object.values(r.cells).flatMap((c) => c.workloads.map((w) => (w.kind === 'deployment' ? null : w.kind))))].filter(Boolean).join(' · ') || `${Object.values(r.cells).reduce((n, c) => Math.max(n, c.workloads.length), 0)} workload${Object.values(r.cells).some((c) => c.workloads.length > 1) ? 's' : ''}`}</span>
                    </div>
                    {envs.map((e) => {
                      const c = r.cells[e.id];
                      if (!c) return <div key={e.id} className="cell dead">—</div>;
                      return (
                        <div key={e.id} className={`cell${c.rolling ? ' roll' : e.id === dev?.id && r.devBehind ? ' waiting' : ''}`} title={c.workloads.map((w) => `${w.namespace}/${w.name} (${w.container}) ${w.tag}${w.desired != null ? ` · ${w.ready}/${w.desired} ready` : ''}`).join('\n')}>
                          {c.tag}
                          {c.tags.length > 1 ? <em> +{c.tags.length - 1}</em> : null}
                          <span>{c.rolling ? `rolling out · ${c.ready}/${c.desired}` : e.id === dev?.id && r.devBehind ? 'newer build waiting' : c.behind ? `behind ${envs.slice(0, envs.indexOf(e)).reverse().find((x) => r.cells[x.id])?.label ?? ''}${c.since ? ` · ${ago(c.since, now)}` : ''}` : c.since ? ago(c.since, now) : c.desired ? `${c.ready}/${c.desired} ready` : ''}</span>
                        </div>
                      );
                    })}
                    <div className="new">
                      {r.newest ? (
                        <>
                          <span className={`dl-glyph ${r.newest.status === 'success' ? 'ok' : r.newest.status === 'failed' ? 'bad' : r.newest.status ? 'run' : 'idle'}`} /> {r.newest.tag}
                          {canBump ? (
                            <button className="dp-b" onClick={() => setBumpRow(bumpRow === r.key ? null : r.key)}>
                              Bump dev
                            </button>
                          ) : null}
                        </>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </div>
                    {bumpRow === r.key && canBump ? (
                      <div className="dp-rowbump" style={{ gridColumn: '1 / -1' }}>
                        <BumpConfirm s={{ env: dev!.id, tag: r.newestOk!.tag, targets: dc!.workloads.filter((w) => w.kind !== 'cronjob').map((w) => ({ kind: w.kind, namespace: w.namespace, name: w.name, container: w.container, image: w.image, from: w.tag, on: w.tag !== r.newestOk!.tag })) }} onDone={() => setBumpRow(null)} />
                      </div>
                    ) : null}
                  </Fragment>
                );
              })}
            </Fragment>
          ))}
        </div>
      )}
      {s.events.length ? (
        <div className="dp-recent">
          <div className="dp-label">
            Lately <span>{s.events.length}</span>
          </div>
          {s.events.slice(0, 12).map((e, i) => (
            <div key={i} className="ev">
              <span className="t">{ago(e.at, now)}</span>
              <span>
                {envLabel(s.envs, e.env)} · {e.service} → {e.to} <span className="w">from {e.from}{e.by ? ', by you through Cora' : ''}</span>
              </span>
              <span className="dim">{e.namespace}/{e.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
