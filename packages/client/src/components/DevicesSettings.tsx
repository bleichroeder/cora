import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ago } from '../lib/format';
import { desktop } from '../lib/desktop';
import { Section, Row, Toggle } from './settingsUi';
import { Icon } from './Icon';
import './devices.css';

type Status = { available: boolean; why?: string; on: boolean; url?: string; host?: string; error?: string };
type Device = { id: string; name: string; pairedAt: number; lastSeen: number };
const json = { 'content-type': 'application/json' };

/**
 * Settings › Devices: your Cora from your other devices (an iPad), over Tailscale. The switch serves Cora on your
 * tailnet; Pair a device shows a QR code and a code for 5 minutes; your paired devices, and removing one.
 */
/** A small QR code for Cora's address on your tailnet. */
function OpenCode({ url }: { url: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void QRCode.toDataURL(url, { margin: 1, width: 240, color: { dark: '#0b0e14', light: '#e6ebf2' } }).then((d: string) => live && setSrc(d));
    return () => {
      live = false;
    };
  }, [url]);
  return src ? <img className="dv-open-qr" src={src} alt={`Scan to open ${url}`} width={104} height={104} /> : null;
}

export function DevicesSection() {
  const [st, setSt] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);
  const [pair, setPair] = useState<{ code: string; until: number; url: string; qr: string } | null>(null);
  const [paired, setPaired] = useState<string | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  const loadDevices = () =>
    fetch('/api/devices')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { devices: Device[] } | null) => j && setDevices(j.devices))
      .catch(() => {});
  useEffect(() => {
    void fetch('/api/remote')
      .then((r) => (r.ok ? r.json() : { available: false, on: false, why: "Cora couldn't ask Tailscale." }))
      .then(setSt)
      .catch(() => setSt({ available: false, on: false, why: "Cora couldn't ask Tailscale." }));
    void loadDevices();
  }, []);
  // while a pairing is open: watch for the device, and the time left
  const [, tick] = useState(0);
  useEffect(() => {
    if (!pair) return;
    const before = devices.length;
    const t = setInterval(() => {
      tick((n) => n + 1);
      if (Date.now() > pair.until) return setPair(null);
      void fetch('/api/devices')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { devices: Device[] } | null) => {
          if (!j || j.devices.length <= before) return;
          setDevices(j.devices);
          setPaired(j.devices.at(-1)?.name ?? 'A device');
          setPair(null);
        });
    }, 2000);
    return () => clearInterval(t);
  }, [pair]); // eslint-disable-line react-hooks/exhaustive-deps

  const turn = async (on: boolean) => {
    setBusy(true);
    const r = await fetch('/api/remote', { method: 'POST', headers: json, body: JSON.stringify({ on }) }).catch(() => null);
    setSt(r?.ok ? await r.json() : { ...(st ?? { available: false, on: false }), error: "Cora couldn't ask Tailscale." });
    setBusy(false);
  };
  const startPair = async () => {
    setPaired(null);
    const r = await fetch('/api/devices/pair', { method: 'POST' }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    if (!r?.ok) return setSt((s) => ({ ...(s ?? { available: false, on: false }), error: j.error ?? "Couldn't start pairing" }));
    setPair({ code: j.code, until: j.until, url: j.url, qr: await QRCode.toDataURL(j.link, { margin: 1, width: 220, color: { dark: '#0b0e14', light: '#e6ebf2' } }) });
  };
  const cancel = () => (void fetch('/api/devices/pair', { method: 'DELETE' }), setPair(null));
  const remove = async (id: string) => {
    await fetch(`/api/devices/${id}`, { method: 'DELETE' }).catch(() => null);
    setSure(null);
    void loadDevices();
  };
  const left = pair ? Math.max(0, Math.round((pair.until - Date.now()) / 1000)) : 0;
  const copy = (t: string) => (desktop?.writeClipboard ? desktop.writeClipboard(t) : void navigator.clipboard?.writeText(t));

  return (
    <Section id="devices" title="Devices" intro="Your Cora on your other devices (an iPad, a laptop) over Tailscale: only your tailnet can reach it, and only devices you pair here can open it. Your sessions keep running on this PC.">
      {st && !st.available ? (
        <Row label="Reach Cora from my devices" hint={st.why ?? "Tailscale isn't available."}>
          <span className="dv-off">Not available</span>
        </Row>
      ) : (
        <Toggle
          label="Reach Cora from my devices"
          hint={st?.on && st.url ? <>At <code className="dv-url">{st.url}</code> on your tailnet. <button className="btn ghost dv-copy" onClick={() => copy(st.url!)}>Copy</button></> : 'Serves Cora on your tailnet with Tailscale (HTTPS, your devices only).'}
          checked={!!st?.on}
          onChange={(on) => !busy && void turn(on)}
        />
      )}
      {st?.error ? <div className="dv-err">{st.error}</div> : null}
      {st?.on && st.url ? (
        <Row label="Open Cora on a device" hint="Scan it with the device's camera: it opens Cora's address there (a device you haven't paired yet asks you to pair it first).">
          <OpenCode url={st.url} />
        </Row>
      ) : null}
      {st?.on ? (
        <Row label="Pair a device" hint="Open the address on the device (or scan the code with its camera), and type the 6 digits. One device, within 5 minutes." wide>
          {pair ? (
            <div className="dv-pair">
              <img src={pair.qr} alt="Scan to pair" width={168} height={168} />
              <div className="dv-pair-r">
                <span className="dv-code">{pair.code.slice(0, 3)} {pair.code.slice(3)}</span>
                <code className="dv-url">{pair.url}</code>
                <span className="dv-left">
                  <i /> waiting for the device · {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
                </span>
                <button className="btn ghost" onClick={cancel}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="dv-start">
              <button className="btn allow" onClick={() => void startPair()}>
                <Icon name="QrCode" size={13} /> Pair a device
              </button>
              {paired ? <span className="dv-ok"><Icon name="Check" size={13} /> Paired {paired}</span> : null}
            </div>
          )}
        </Row>
      ) : null}
      {devices.length ? (
        <Row label="Paired devices" hint="Each opens Cora on its own key; remove one and it's signed out at once. Cora's lock applies on all of them." wide>
          <div className="dv-list">
            {devices.map((d) => (
              <div key={d.id} className="dv-row">
                <Icon name={/iPad|iPhone|Android/.test(d.name) ? 'Tablet' : 'Laptop'} size={15} />
                <span className="dv-n">
                  <b>{d.name}</b>
                  <small>paired {ago(d.pairedAt)} ago · seen {ago(d.lastSeen)} ago</small>
                </span>
                {sure === d.id ? (
                  <>
                    <button className="btn ghost" onClick={() => setSure(null)}>Keep</button>
                    <button className="btn deny" onClick={() => void remove(d.id)}>Remove</button>
                  </>
                ) : (
                  <button className="btn ghost" onClick={() => setSure(d.id)}>Remove</button>
                )}
              </div>
            ))}
          </div>
        </Row>
      ) : null}
    </Section>
  );
}
