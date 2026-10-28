import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Icon } from './Icon';
import './seat.css';

/** Cora in use on another of your devices (its name): this screen is covered until you use it here. */
export const useSeat = create<{ elsewhere: string | null }>(() => ({ elsewhere: null }));

/**
 * The cover a screen shows while Cora is in use on another device:
 * nothing of Cora behind it (the server sends this screen nothing), Use it here with your PIN (a device can't without one
 * set; the PC can), and on the PC, Disconnect remote devices.
 */
export function SeatCover() {
  const name = useSeat((s) => s.elsewhere);
  const [info, setInfo] = useState<{ pc: boolean; needsPin: boolean; noPin?: boolean } | null>(null);
  const [pin, setPin] = useState('');
  // a missing or wrong PIN: the field turns red (nothing moves); anything else says so in place of the line under the title
  const [bad, setBad] = useState(0);
  const [red, setRed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!name) return;
    setErr(null);
    setRed(false);
    setPin('');
    void fetch('/api/seat')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { pc: boolean; needsPin: boolean; noPin?: boolean } | null) => setInfo(j ? { pc: j.pc, needsPin: j.needsPin, noPin: j.noPin } : null));
  }, [name]);
  useEffect(() => {
    if (info?.needsPin) input.current?.focus();
  }, [info]);
  if (!name) return null;
  const go = async (what: 'take' | 'disconnect') => {
    if (info?.needsPin && !pin) return (setRed(true), setBad((n) => n + 1));
    setBusy(true);
    const r = await fetch(`/api/seat/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(info?.needsPin ? { pin } : {}) }).catch(() => null);
    setBusy(false);
    if (r?.ok) return location.reload();
    const j = r ? ((await r.json().catch(() => ({}))) as { error?: string; waitMs?: number; needsPin?: boolean }) : { error: "Cora didn't answer" };
    setPin('');
    if (j.needsPin) {
      setRed(true);
      setBad((n) => n + 1);
      if (j.waitMs) setWaitUntil(Date.now() + j.waitMs);
      return;
    }
    setErr(j.error ?? 'That did not work');
  };
  return (
    <div className="seat-cover" role="dialog" aria-modal="true">
      <form className="seat-box" onSubmit={(e) => (e.preventDefault(), void go('take'))}>
        <span className="seat-orb" />
        <h2>Cora is in use on {name}</h2>
        <p className={err ? 'seat-err' : undefined}>{err ? err : info?.noPin ? 'Set a PIN on your PC first (Settings › Lockdown): your devices ask for it to use Cora.' : 'Your sessions keep running. Nothing shows here until you use it here.'}</p>
        {info?.needsPin ? (
          <input
            // a new failure: the field again (its shake replays), focused
            ref={input}
            key={bad}
            autoFocus
            className={`seat-pin${red ? ' bad' : ''}`}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            // too many wrong tries: how long to wait, in the field itself
            placeholder={waitUntil > Date.now() ? `wait ${Math.ceil((waitUntil - Date.now()) / 1000)}s` : 'PIN'}
            value={pin}
            onChange={(e) => (setErr(null), setRed(false), setPin(e.target.value.replace(/\D/g, '')))}
          />
        ) : null}
        <button className="seat-go" disabled={busy || !!info?.noPin}>
          <Icon name="MonitorSmartphone" size={15} /> Use it here
        </button>
        {info?.pc ? (
          <button type="button" className="seat-off" disabled={busy} onClick={() => void go('disconnect')}>
            Disconnect remote devices
          </button>
        ) : null}
      </form>
    </div>
  );
}
