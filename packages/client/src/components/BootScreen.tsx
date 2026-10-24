import { useEffect, useRef, useState } from 'react';
import { CoraOrb } from './CoraOrb';
import './emptyMain.css';

/**
 * While Cora finds out whether this is a first run (a moment, at most a few seconds): just the window's dark at first,
 * so a quick start goes from the desktop splash straight into the app; still waiting after a moment, Cora's live orb
 * (thinking) with its light on the screen, its name, and what it's waiting on.
 */
export function BootScreen({ connected }: { connected: boolean }) {
  const screen = useRef<HTMLDivElement>(null);
  // the 3D orb only once it would be seen (a quick start never pays for it)
  const [late, setLate] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setLate(true), 1100);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="boot-screen" ref={screen} role="status" aria-live="polite">
      <span className="bs-orb" aria-hidden>
        {late ? <CoraOrb state="thinking" size={120} glow={screen} /> : null}
      </span>
      <div className="bs-word">CORA</div>
      <div className="bs-sub">{connected ? 'Getting your sessions' : 'Starting its server'}</div>
    </div>
  );
}
