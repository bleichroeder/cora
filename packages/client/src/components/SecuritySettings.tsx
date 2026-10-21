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

/** Settings → Security: Electron, Node.js and npm packages, and what to do about each. */
export function SecuritySection() {
  const r = useSecurity((s) => s.report);
  // the installed app doesn't check: Electron, Node and the packages come with Cora's updates
  const [off, setOff] = useState(false);
  useEffect(() => {
    void fetch('/api/security')
      .then((x) => (x.ok ? x.json() : null))
      .then((j: { off?: boolean } | null) => setOff(!!j?.off))
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
  if (off)
    return (
      <Section id="security" title="Security" intro="What Cora runs on (Electron, Node.js and its packages) gets its security fixes through Cora's updates.">
        <Row label="Updates" hint="When a new version is ready, Restart to update shows at the bottom of the left nav and in the tray menu. Your sessions keep running.">
          <span className="dim">automatic</span>
        </Row>
      </Section>
    );

  return (
    <Section
      id="security"
      title="Security"
      intro={<>Is what Cora runs on still getting security fixes? Checked when Cora starts and twice a day. Electron security patches install by themselves the next time Cora starts; anything bigger shows here, with a way to have Claude fix it.</>}
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

/** The left nav's shield: only when the check found something (red when it matters). */
export function SecurityBadge() {
  const r = useSecurity((s) => s.report);
  const level = securityLevel(r);
  if (!level) return null;
  return (
    <button className={`rf-sec ${level}`} title={level === 'high' ? 'Security updates needed (Settings → Security)' : 'Security updates available (Settings → Security)'} onClick={() => openSettings('security')}>
      <Icon name={level === 'high' ? 'ShieldAlert' : 'Shield'} size={14} />
    </button>
  );
}
