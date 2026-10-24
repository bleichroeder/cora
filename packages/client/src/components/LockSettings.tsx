import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { loadLock, lockNow, removePin, savePin, setLockOnWindows, useLock } from '../state/lock';
import { desktop } from '../lib/desktop';
import { Icon } from './Icon';
import { Row, Section, Toggle } from './settingsUi';
import './dialogs.css';

/** A PIN field: digits only, hidden as you type. */
function PinInput({ value, onChange, label, autoFocus, onEnter }: { value: string; onChange(v: string): void; label: string; autoFocus?: boolean; onEnter?(): void }) {
  return (
    <input
      className="set-input code lk-pin"
      type="password"
      inputMode="numeric"
      autoComplete="off"
      maxLength={8}
      placeholder={label}
      aria-label={label}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
    />
  );
}

/** Choose (or change) the PIN: the new one twice, and the old one when there is one. */
function PinForm({ change, onDone, submit = 'Save PIN' }: { change: boolean; onDone(): void; submit?: string }) {
  const [cur, setCur] = useState('');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (busy) return;
    setBusy(true);
    const e = await savePin(pin, again, change ? cur : undefined);
    setBusy(false);
    if (e) return setErr(e);
    onDone();
  };
  return (
    <div className="lk-form">
      {change ? <PinInput value={cur} onChange={setCur} label="Current PIN" autoFocus onEnter={() => void go()} /> : null}
      <PinInput value={pin} onChange={setPin} label="New PIN (4–8 digits)" autoFocus={!change} onEnter={() => void go()} />
      <PinInput value={again} onChange={setAgain} label="The same again" onEnter={() => void go()} />
      <button className="btn allow" disabled={busy || pin.length < 4} onClick={() => void go()}>
        {submit}
      </button>
      {err ? <span className="lk-err">{err}</span> : null}
    </div>
  );
}

/** Settings › Lockdown: your PIN, locking when Windows locks, and lock now. */
export function LockSection() {
  const st = useLock((s) => s.status);
  const [mode, setMode] = useState<'change' | 'remove' | null>(null);
  const [cur, setCur] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => void loadLock(), []);
  const remove = async () => {
    const e = await removePin(cur);
    if (e) return setErr(e);
    setMode(null);
    setCur('');
    setErr(null);
  };
  return (
    <Section id="lock" title="Lockdown" intro="Lock Cora behind a PIN when you step away: it stays open, your sessions keep running, and nobody can see or touch them.">
      <Row label="PIN" hint={st?.hasPin ? `Set (${st.digits} digits). Cora keeps a hash of it, never the PIN itself.` : 'Choose one to be able to lock Cora.'} wide={!st?.hasPin || mode != null}>
        {!st?.hasPin ? (
          <PinForm change={false} onDone={() => setMode(null)} />
        ) : mode === 'change' ? (
          <PinForm change onDone={() => setMode(null)} submit="Change PIN" />
        ) : mode === 'remove' ? (
          <div className="lk-form">
            <PinInput value={cur} onChange={setCur} label="Current PIN" autoFocus onEnter={() => void remove()} />
            <button className="btn ghost bad" onClick={() => void remove()} disabled={cur.length < 4}>
              Remove PIN
            </button>
            <button className="btn ghost" onClick={() => (setMode(null), setErr(null))}>
              Cancel
            </button>
            {err ? <span className="lk-err">{err}</span> : null}
          </div>
        ) : (
          <span className="lk-acts">
            <button className="btn" onClick={() => setMode('change')}>
              Change
            </button>
            <button className="btn ghost" onClick={() => setMode('remove')}>
              Remove
            </button>
          </span>
        )}
      </Row>
      {desktop ? (
        <Toggle label="Lock when Windows locks or sleeps" hint="Win+L, the screen saver's lock, or sleep: Cora is locked when you're back." checked={st?.onWindowsLock !== false} onChange={(v) => void setLockOnWindows(v)} />
      ) : null}
      <Row
        label="Lock now"
        hint={
          desktop ? (
            <>
              Or press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>L</kbd>, the lock in the nav, or Lock Cora in the tray.
            </>
          ) : (
            'Or the lock in the nav, or Lock Cora in the command palette.'
          )
        }
      >
        <button className="btn" disabled={!st?.hasPin} onClick={() => void lockNow()}>
          <Icon name="Lock" size={13} />
          Lock
        </button>
      </Row>
      <Row label="Forgot your PIN?" hint="Quit Cora from the tray, delete lock.json in Cora's folder (.cora in your user folder), and open Cora again. Your sessions keep running meanwhile.">
        <span />
      </Row>
    </Section>
  );
}

/** Locking with no PIN yet: choose one, and Cora locks. */
export function LockSetup() {
  const on = useLock((s) => s.setup);
  if (!on) return null;
  const close = () => useLock.setState({ setup: false });
  return createPortal(
    <div className="modal-bg" onMouseDown={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <div className="modal dlg lk-setup" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dlg-h">
          <span className="dlg-t">
            <Icon name="Lock" size={15} />
            Choose a PIN to lock Cora
          </span>
        </div>
        <div className="dlg-b">
          <p className="lk-why">4 to 8 digits. You type it on the lock screen to come back. Cora keeps only a hash of it.</p>
          <PinForm
            change={false}
            submit="Save and lock"
            onDone={() => {
              close();
              void lockNow();
            }}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
