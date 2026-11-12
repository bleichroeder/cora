import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { VpnProfile, VpnRequest, VpnState } from '@cora/shared';
import { answerVpn, switchVpn, useVpn } from '../state/vpn';
import { useBrain } from '../state/store';
import { sessionColor, sessionName } from '../lib/format';
import { openSettings } from './SettingsModal';
import { Icon } from './Icon';
import './popovers.css';
import './vpn.css';

const time = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Other sessions working right now: a switch cuts off what they're doing on the VPN that's up. */
function useWorking(except?: string): string[] {
  const sessions = useBrain((s) => s.sessions);
  return Object.values(sessions)
    .filter((s) => s.id !== except && (s.state === 'working' || s.state === 'thinking'))
    .map((s) => sessionName(s));
}

/**
 * The rail's VPN control (when OpenVPN Connect is here and Cora's VPN control is on): what's connected, at a glance.
 * Click: your profiles to switch between, and the sessions asking for one. Only you switch the VPN: sessions ask.
 */
export function VpnControl() {
  const s = useVpn((v) => v.s);
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  if (!s.available || !s.on) return null;
  const connected = s.profiles.find((p) => p.id === s.connected);
  const to = s.switching ? s.profiles.find((p) => p.id === s.switching!.to) : undefined;
  const asks = s.requests.length;
  const label = s.switching ? (s.switching.to ? `→ ${to?.name ?? '…'}` : 'Disconnecting…') : s.phase === 'waiting' ? 'Waiting for you' : connected ? connected.name : s.phase === 'connecting' ? 'Connecting…' : 'No VPN';
  const glyph = s.switching || s.phase === 'connecting' ? 'run' : s.phase === 'waiting' || s.phase === 'failed' || s.error ? 'bad' : connected ? 'ok' : 'idle';
  return (
    <>
      <button
        ref={btn}
        className={`rf-vpn${asks ? ' asks' : ''}${open ? ' on' : ''}`}
        title={asks ? `${asks} session${asks === 1 ? ' asks' : 's ask'} you to switch the VPN` : `VPN: ${label}. Click to switch.`}
        aria-label="VPN"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={`dl-glyph ${glyph}`} />
        <span className="rf-vpn-n">{label}</span>
        {asks ? <b className="rf-vpn-ask">{asks}</b> : null}
      </button>
      {open ? <VpnMenu s={s} anchor={btn.current} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function VpnMenu({ s, anchor, onClose }: { s: VpnState; anchor: HTMLElement | null; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; bottom: number }>({ left: 8, bottom: 52 });
  const [err, setErr] = useState<string | null>(null);
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect();
    if (r) setAt({ left: Math.max(8, Math.min(r.left, window.innerWidth - 328)), bottom: window.innerHeight - r.top + 6 });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => !box.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', down);
      window.removeEventListener('keydown', key);
    };
  }, [onClose, anchor]);
  const working = useWorking();
  const connected = s.profiles.find((p) => p.id === s.connected);
  const go = async (to: string | null) => setErr(await switchVpn(to));
  const busy = !!s.switching;
  return (
    <div className="session-menu vpn-menu" ref={box} style={{ position: 'fixed', left: at.left, bottom: at.bottom }}>
      <div className="sm-h">
        <span className="vpn-tile">
          <Icon name={connected ? 'ShieldCheck' : 'Shield'} size={15} />
        </span>
        <span className="sm-t">
          <b>{busy ? 'Switching…' : connected ? connected.name : s.phase === 'connecting' ? 'Connecting…' : 'Not connected'}</b>
          <span>{busy ? 'OpenVPN Connect' : connected ? `OpenVPN Connect · since ${s.connectedAt ? time(s.connectedAt) : '?'}` : s.phase === 'waiting' ? 'OpenVPN Connect is waiting for you' : 'OpenVPN Connect'}</span>
        </span>
      </div>
      {s.error || err ? (
        <div className="vpn-err">
          <Icon name="TriangleAlert" size={12} />
          <span>{err ?? s.error}</span>
        </div>
      ) : null}
      {s.requests.length ? (
        <>
          <div className="sm-gl">Asked for</div>
          {s.requests.map((r) => (
            <VpnAsk key={r.id} r={r} s={s} onErr={setErr} />
          ))}
        </>
      ) : null}
      <div className="sm-gl">Profiles</div>
      {s.profiles.map((p) => (
        <ProfileRow key={p.id} p={p} s={s} disabled={busy} onPick={() => void go(p.id)} />
      ))}
      {connected || s.phase === 'connecting' ? (
        <button className="sm-row" disabled={busy} onClick={() => void go(null)}>
          <Icon name="Unplug" size={14} /> Disconnect
        </button>
      ) : null}
      {working.length ? (
        <div className="vpn-note" title={working.join(', ')}>
          <Icon name="Info" size={12} />
          <span>
            {working.length === 1 ? `${working[0]} is working` : `${working.length} sessions are working`}: a switch cuts off whatever it{working.length === 1 ? ' is' : "'s"} doing on this VPN.
          </span>
        </div>
      ) : null}
      <div className="sm-sep" />
      <button className="sm-row" onClick={() => (onClose(), openSettings('environments'))}>
        <Icon name="Settings2" size={14} /> Environments and VPN settings
      </button>
    </div>
  );
}

function ProfileRow({ p, s, disabled, onPick }: { p: VpnProfile; s: VpnState; disabled: boolean; onPick(): void }) {
  const on = p.id === s.connected;
  const going = s.switching?.to === p.id;
  const envs = [...new Set(p.reaches.map((r) => (r.label === 'other' ? r.name : r.label)))];
  return (
    <button className={`sm-row vpn-p${on ? ' cur' : ''}`} disabled={disabled || on} title={on ? 'Connected' : `Connect ${p.name}${s.connected ? ' (disconnects the one that is up)' : ''}${p.password ? '. OpenVPN Connect may ask for its password.' : ''}`} onClick={onPick}>
      <span className={`dl-glyph ${going ? 'run' : on ? (s.phase === 'connected' ? 'ok' : 'run') : 'idle'}`} />
      <span className="vpn-pn">{p.name}</span>
      {envs.map((e) => (
        <span key={e} className="vpn-env">
          {e}
        </span>
      ))}
      {p.password ? <Icon name="KeyRound" size={11} className="vpn-key" /> : null}
      <span className="vpn-act">{on ? 'Connected' : going ? 'Connecting…' : 'Connect'}</span>
    </button>
  );
}

/** A session's request: what it wants and why, who'd be cut off, your Switch or Not now. */
function VpnAsk({ r, s, onErr }: { r: VpnRequest; s: VpnState; onErr(e: string | null): void }) {
  const session = useBrain((st) => st.sessions[r.sessionId]);
  const [pick, setPick] = useState<string>(r.profileId ?? '');
  const working = useWorking(r.sessionId);
  const target = s.profiles.find((p) => p.id === (r.profileId ?? pick));
  const busy = !!s.switching;
  return (
    <div className="vpn-ask">
      <div className="vpn-ask-h">
        <span className="dl-tile" style={{ ['--sc' as any]: session ? sessionColor(session) : '#475569' }}>
          {(r.session.match(/[A-Za-z0-9]/)?.[0] ?? '·').toUpperCase()}
        </span>
        <span>
          <b>{r.session}</b> asks for{' '}
          {r.profileId ? (
            <b>{target?.name ?? r.asked}</b>
          ) : (
            <select value={pick} onChange={(e) => setPick(e.target.value)} title={`It asked for "${r.asked}"`}>
              <option value="">“{r.asked}”: which one?</option>
              {s.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </span>
        <span className="vpn-when">{time(r.at)}</span>
      </div>
      <div className="vpn-why">{r.why}</div>
      {working.length ? <div className="vpn-cut">Cuts off {working.length === 1 ? working[0] : `${working.length} working sessions (${working.join(', ')})`}</div> : null}
      <div className="vpn-btns">
        <button className="btn ghost" onClick={async () => onErr(await answerVpn(r.id, false))}>
          Not now
        </button>
        <button className="btn allow" disabled={busy || !target} onClick={async () => onErr(await answerVpn(r.id, true, r.profileId ? undefined : pick))}>
          <Icon name="ArrowRightLeft" size={12} /> Switch
        </button>
      </div>
    </div>
  );
}
