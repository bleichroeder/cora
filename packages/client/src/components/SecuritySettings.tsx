import { useEffect, useState } from 'react';
import { compareVersions, securityLevel, type SecurityReport, type Severity } from '@cora/shared';
import { useBrain } from '../state/store';
import { checkSecurity, useSecurity } from '../state/security';
import { launchTerminal } from '../state/ws';
import { desktop } from '../lib/desktop';
import { ago } from '../lib/format';
import { electronPrompt, nodePrompt, npmPrompt } from '../lib/securityPrompts';
import { Row, Section } from './settingsUi';
import { openSettings } from './SettingsModal';
import { Icon } from './Icon';
import './security.css';

const SEV_COLOR: Record<Severity, string> = { critical: '#f87171', high: '#fb923c', moderate: '#fbbf24', low: '#94a3b8', info: '#64748b' };

/** Start a session in Cora's repo to fix something, and go to it. */
async function askClaude(r: SecurityReport, prompt: string): Promise<string | null> {
  // a brief, not a prompt: it's several sentences, typed in once Claude is ready
  const t = await launchTerminal({ mode: 'new', cwd: r.repo, brief: prompt });
  if (!t.ok) return t.error;
  useBrain.getState().setModal(null);
  useBrain.getState().setFocus(t.terminal.sessionId);
  return null;
}

function Ok({ children }: { children: React.ReactNode }) {
  return (
    <span className="sec-ok">
      <Icon name="ShieldCheck" size={13} /> {children}
    </span>
  );
}
function Bad({ children, level = 'high' }: { children: React.ReactNode; level?: 'high' | 'some' }) {
  return (
    <span className={`sec-bad ${level}`}>
      <Icon name={level === 'high' ? 'ShieldAlert' : 'Shield'} size={13} /> {children}
    </span>
  );
}

/** Settings → Updates & security: Electron, Node.js and npm packages, and what to do about each. */
export function SecuritySection() {
  const r = useSecurity((s) => s.report);
  // the installed app doesn't check: Electron, Node and the packages come with Cora's updates
  const [off, setOff] = useState(false);
  const [node, setNode] = useState<string | null>(null);
  useEffect(() => {
    void fetch('/api/security')
      .then((x) => (x.ok ? x.json() : null))
      .then((j: { off?: boolean; node?: string } | null) => (setOff(!!j?.off), setNode(j?.node ?? null)))
      .catch(() => {});
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (f: () => Promise<string | null>) => {
    setErr(null);
    const e = await f();
    if (e) setErr(e);
  };
  const check = async () => {
    setBusy(true);
    await run(checkSecurity);
    setBusy(false);
  };
  const e = r?.electron;
  const n = r?.node;
  const npm = r?.npm;
  if (off) return <UpdatesSection node={node} />;

  return (
    <Section
      id="security"
      title="Updates & security"
      intro={
        <>
          This copy of Cora runs from source (a development checkout), so these checks are about the checkout: is what it runs on still getting security fixes? Checked when Cora starts and twice a day. Electron
          patches install by themselves the next time Cora starts; anything bigger shows here, with a way to have Claude fix it in the checkout. Installed copies get a fix when you publish a Cora release.
        </>
      }
    >
      <Row label="Checked" hint={r?.checking || busy ? 'checking…' : undefined}>
        <span className="dim">{r ? `${ago(r.checkedAt)}` : 'not yet'}</span>
        <button className="btn ghost" disabled={busy || r?.checking} onClick={() => void check()}>
          <Icon name="RefreshCw" size={12} /> Check now
        </button>
      </Row>
      {e ? (
        <Row
          label="Electron"
          hint={
            e.error
              ? `Couldn't check: ${e.error}`
              : `The desktop app and its built-in browser (Chromium). Electron patches its newest three majors (${e.supportedMajors.join(', ')}); the newest is ${e.latest}.`
          }
        >
          {e.error ? (
            <span className="dim">{e.installed}</span>
          ) : !e.supported ? (
            <>
              <Bad>{e.installed}: no longer gets security fixes</Bad>
              <button className="btn" onClick={() => void run(() => askClaude(r!, electronPrompt(r!)))}>
                <Icon name="Sparkles" size={12} /> Ask Claude to upgrade it
              </button>
            </>
          ) : e.pending ? (
            <>
              <Bad level="some">
                {e.installed} → {e.pending} downloaded, installs when Cora next starts
              </Bad>
              {desktop?.restartApp ? (
                <button className="btn" onClick={() => desktop!.restartApp!()} title="Sessions keep running">
                  <Icon name="RotateCw" size={12} /> Restart now
                </button>
              ) : null}
            </>
          ) : e.failed ? (
            <Bad level="some">
              {e.installed} ({e.failed} wouldn&apos;t install: see update.log in Cora&apos;s data folder)
            </Bad>
          ) : e.latestPatch && compareVersions(e.latestPatch, e.installed) > 0 ? (
            <Bad level="some">
              {e.installed} ({e.latestPatch} is out; downloading)
            </Bad>
          ) : (
            <Ok>{e.installed}: up to date</Ok>
          )}
        </Row>
      ) : null}
      {n ? (
        <Row label="Node.js" hint={n.error ? `Couldn't check: ${n.error}` : `The server and the terminal host.${n.endOfLife ? ` This line gets fixes until ${n.endOfLife}.` : ''}`}>
          {n.error ? (
            <span className="dim">{n.version}</span>
          ) : n.ended || n.securityBehind ? (
            <>
              <Bad>{n.ended ? `${n.version}: past its end of life` : `${n.version}: missing security releases (${n.latestInLine} is out)`}</Bad>
              <button className="btn" onClick={() => void run(() => askClaude(r!, nodePrompt(r!)))}>
                <Icon name="Sparkles" size={12} /> Ask Claude to update it
              </button>
            </>
          ) : n.latestInLine && compareVersions(n.latestInLine, n.version) > 0 ? (
            <Ok>
              {n.version} (no security fixes since; {n.latestInLine} is out)
            </Ok>
          ) : (
            <Ok>{n.version}: up to date</Ok>
          )}
        </Row>
      ) : null}
      {npm ? (
        <Row label="npm packages" wide={!!npm.findings?.length} hint={npm.error ? `Couldn't run npm audit: ${npm.error}` : 'Known vulnerabilities in the packages Cora uses (npm audit).'}>
          {npm.error ? null : npm.findings.length ? (
            <div className="sec-npm">
              <span className="sec-counts">
                {(['critical', 'high', 'moderate', 'low'] as const)
                  .filter((s) => npm.counts[s])
                  .map((s) => (
                    <span key={s} style={{ color: SEV_COLOR[s] }}>
                      {npm.counts[s]} {s}
                    </span>
                  ))}
                <button className="btn" onClick={() => void run(() => askClaude(r!, npmPrompt(r!)))}>
                  <Icon name="Sparkles" size={12} /> Ask Claude to fix them
                </button>
              </span>
              <ul className="sec-list">
                {npm.findings.slice(0, 8).map((f) => (
                  <li key={f.name}>
                    <i style={{ background: SEV_COLOR[f.severity] }} />
                    <b>{f.name}</b>
                    <span className="dim">{f.title}</span>
                    {f.dev ? (
                      <span className="sec-tag" title="Only in development tools (tests, the build), not in what Cora runs">
                        dev only
                      </span>
                    ) : null}
                    {f.fix === 'breaking' ? <span className="sec-tag">major upgrade</span> : f.fix === 'none' ? <span className="sec-tag">no fix yet</span> : null}
                  </li>
                ))}
                {npm.findings.length > 8 ? <li className="dim">and {npm.findings.length - 8} more</li> : null}
              </ul>
            </div>
          ) : (
            <Ok>no known vulnerabilities</Ok>
          )}
        </Row>
      ) : null}
      {err ? <div className="ny-err">{err}</div> : null}
    </Section>
  );
}

type Release = { version: string; url: string; publishedAt?: string } | { error: string };

/**
 * Settings › Updates & security in an installed Cora: the version it is, the latest release, and Restart to update once
 * one has downloaded (Cora checks every few hours and downloads it in the background); what it runs on comes with them.
 */
function UpdatesSection({ node }: { node: string | null }) {
  const [info, setInfo] = useState<{ version: string; electron: string; chrome: string } | null>(null);
  const [latest, setLatest] = useState<Release | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  useEffect(() => {
    void desktop?.appInfo?.().then((i) => i && setInfo(i));
    void fetch('/api/cora-release')
      .then((x) => (x.ok ? x.json() : null))
      .then((j: Release | null) => j && setLatest(j))
      .catch(() => {});
    void desktop?.updateReady?.().then(setReady);
    return desktop?.onUpdate?.(setReady);
  }, []);
  const v = info?.version;
  const newest = latest && 'version' in latest ? latest.version : null;
  const behind = !!(v && newest && compareVersions(newest, v) > 0);
  return (
    <Section id="security" title="Updates & security" intro="Cora keeps itself up to date: new versions download in the background and install when you restart it (your sessions keep running). Security fixes to what Cora runs on (Electron, Chromium, Node.js and its packages) come with them.">
      <Row label="Cora" hint={latest && 'error' in latest ? `Couldn't see the latest release: ${latest.error}` : newest ? `The latest release is ${newest}.` : undefined}>
        {!v ? (
          <span className="dim">…</span>
        ) : ready ? (
          <>
            <Bad level="some">{v}: {ready} is ready</Bad>
            {desktop?.restartApp ? (
              <button className="btn" onClick={() => desktop!.restartApp!()} title="Installs it; your sessions keep running">
                <Icon name="RotateCw" size={12} /> Restart to update
              </button>
            ) : null}
          </>
        ) : behind ? (
          <Bad level="some">{v}: {newest} is out, downloading (it installs when you restart)</Bad>
        ) : (
          <Ok>{v}: up to date</Ok>
        )}
        {latest && 'url' in latest && latest.url ? (
          <button className="btn ghost" onClick={() => desktop?.openExternal?.(latest.url)} title="What's in it">
            <Icon name="ExternalLink" size={12} /> Release notes
          </button>
        ) : null}
      </Row>
      <Row label="Electron" hint="The desktop app and its built-in browser. Security fixes come with Cora's updates.">
        <span className="dim">{info ? `${info.electron} (Chromium ${info.chrome})` : '…'}</span>
      </Row>
      <Row label="Node.js" hint="The server and the terminal host. Security fixes come with Cora's updates.">
        <span className="dim">{node ?? '…'}</span>
      </Row>
    </Section>
  );
}

/** The left nav's shield: only when the check found something (red when it matters). */
export function SecurityBadge() {
  const r = useSecurity((s) => s.report);
  const level = securityLevel(r);
  if (!level) return null;
  return (
    <button className={`rf-sec ${level}`} title={level === 'high' ? 'Security updates needed (Settings → Updates & security)' : 'Security updates available (Settings → Updates & security)'} onClick={() => openSettings('security')}>
      <Icon name={level === 'high' ? 'ShieldAlert' : 'Shield'} size={14} />
    </button>
  );
}
