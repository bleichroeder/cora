import { useEffect, useState } from 'react';
import type { Settings } from '@cora/shared';
import { ago } from '../lib/format';
import { Choice, Group, Row, Section, Switch } from './settingsUi';
import { Icon } from './Icon';

type Label = 'dev' | 'staging' | 'prod' | 'local' | 'other';
type Env = { id: string; name: string; label: Label; url: string; kubeconfig?: string; on: boolean; reachable: boolean | null; checkedAt?: number };

const LABELS: Array<[Label, string]> = [
  ['dev', 'Dev'],
  ['staging', 'Staging'],
  ['prod', 'Prod'],
  ['other', 'Other'],
];

async function call(url: string, body?: object): Promise<Env[] | null> {
  try {
    const r = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    return r.ok ? ((await r.json()) as { environments: Env[] }).environments : null;
  } catch {
    return null;
  }
}

/**
 * Settings › Environments: which of your environments (VPNs) this PC can reach, found from your kubeconfigs and
 * checked every 30 seconds. Every session can ask (Cora's environment tool) and hears when it changes. Read-only:
 * nothing here, or in any session, can change the VPN.
 */
export function EnvironmentsSection({ server, save }: { server?: Settings | null; save?(p: object): Promise<string | null | void> }) {
  const [envs, setEnvs] = useState<Env[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    const load = () => void call('/api/environments').then((e) => live && e && setEnvs(e));
    load();
    const t = setInterval(() => (load(), setNow(Date.now())), 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const update = async (id: string, p: Partial<Pick<Env, 'label' | 'on'>>) => {
    // dev is the one label Deploys writes to (a bump, with your click): said on purpose, with the cluster's address (audit S14)
    const was = envs?.find((x) => x.id === id);
    if (p.label === 'dev' && was && was.label !== 'dev' && !window.confirm(`Label ${was.name} (${id}) as dev?\n\nDeploys can set new images on a dev cluster (from a card, when you click Bump).`)) return;
    const e = await call(`/api/environments/${encodeURIComponent(id)}`, p);
    if (e) setEnvs(e);
  };
  const checkNow = async () => {
    setBusy(true);
    const e = await call('/api/environments/check', {});
    if (e) setEnvs(e);
    setNow(Date.now());
    setBusy(false);
  };
  const shown = (envs ?? []).filter((e) => e.label !== 'local');
  return (
    <Section
      id="environments"
      title="Environments"
      intro="Which of your environments this PC can reach right now, found from your kubeconfigs and checked every 30 seconds. Every Claude session can ask (Cora's environment tool) and is told with its next prompt when it changes. Read-only: nothing can change your VPN."
    >
      <Group label="Clusters">
        {envs == null ? (
          <Row label="Looking for clusters">
            <span className="dim">Checking…</span>
          </Row>
        ) : !shown.length ? (
          <Row label="None found" hint="Cora looks for clusters in the kubeconfig files in ~/.kube.">
            <span className="dim">—</span>
          </Row>
        ) : (
          shown.map((e) => (
            <Row
              key={e.id}
              label={
                <span className="env-name" title={e.id}>
                  <span className={`dl-glyph ${!e.on ? 'idle' : e.reachable ? 'ok' : e.reachable === false ? 'idle' : 'run'}`} />
                  {e.name}
                </span>
              }
              hint={`${e.on ? (e.reachable ? 'Reachable' : e.reachable === false ? 'Not reachable' : 'Checking…') : 'Not checked'}${e.checkedAt && e.on ? ` · checked ${ago(e.checkedAt, now)} ago` : ''}`}
            >
              <Choice value={e.label} onChange={(label) => void update(e.id, { label })} options={LABELS} />
              <span title={e.on ? 'Checked: click to stop checking it' : 'Not checked: click to check it'}>
                <Switch checked={e.on} onChange={(on) => void update(e.id, { on })} />
              </span>
            </Row>
          ))
        )}
        <Row label="Check now" hint="Cora checks every 30 seconds on its own; this also looks for new kubeconfigs.">
          <button className="btn" disabled={busy} onClick={() => void checkNow()}>
            <Icon name="RefreshCw" size={12} /> {busy ? 'Checking…' : 'Check now'}
          </button>
        </Row>
      </Group>
      {server && save ? (
        <Group label="Pipelines and Deploys">
          <DeploysRows server={server} save={save} />
        </Group>
      ) : null}
    </Section>
  );
}

/** Where pipelines and Deploys read from (GitLab) (a Group's rows). */
function DeploysRows({ server, save }: { server: Settings; save(p: object): Promise<string | null | void> }) {
  const [host, setHost] = useState(server.gitlab?.host ?? 'gitlab.com');
  const [err, setErr] = useState<string | null>(null);
  const saveHost = async () => {
    const h = host.trim().toLowerCase();
    if (!h || h === server.gitlab?.host) return;
    setErr(null);
    const e = await save({ gitlab: { host: h } }).catch((x: Error) => x.message);
    if (e) setErr(`Couldn't save it: ${e}`);
  };
  return (
    <>
      <Row label="GitLab" hint="Where pipelines and Deploys read from. glab must be signed in to it (glab auth login).">
        <input className="set-input code" style={{ width: 220 }} value={host} spellCheck={false} placeholder="gitlab.com" onChange={(e) => setHost(e.target.value)} onBlur={() => void saveHost()} onKeyDown={(e) => e.key === 'Enter' && void saveHost()} />
      </Row>
      {err ? <div className="ny-err">{err}</div> : null}
    </>
  );
}
