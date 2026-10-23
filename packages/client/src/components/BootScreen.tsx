import { useRef } from 'react';
import { CoraOrb } from './CoraOrb';
import './emptyMain.css';

/**
 * While Cora finds out whether this is a first run (a moment, at most a few seconds): the desktop splash's look carried
 * on, Cora's live orb (thinking) with its light on the screen, its name, and what it's waiting on. The orb's code is
 * already loaded (Cora's card has it): one small 3D view for those seconds.
 */
export function BootScreen({ connected }: { connected: boolean }) {
  const screen = useRef<HTMLDivElement>(null);
  return (
    <div className="boot-screen" ref={screen} role="status" aria-live="polite">
      <span className="bs-orb" aria-hidden>
        <CoraOrb state="thinking" size={120} glow={screen} />
      </span>
      <div className="bs-word">CORA</div>
      <div className="bs-sub">{connected ? 'Getting your sessions' : 'Starting its server'}</div>
    </div>
  );
}
