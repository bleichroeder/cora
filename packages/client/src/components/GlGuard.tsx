import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import type { RootState } from '@react-three/fiber';
import { create } from 'zustand';
import { Icon } from './Icon';

/** When the 3D views restarted, and why (for Settings → Scene). */
type GlEvent = { at: number; view: string; why: string };
type GlState = { epoch: number; events: GlEvent[] };
export const useGl = create<GlState>(() => ({ epoch: 0, events: [] }));

const note = (view: string, why: string) => {
  useGl.setState((s) => ({ events: [...s.events, { at: Date.now(), view, why }].slice(-20) }));
  // and in the desktop app's log (it keeps Cora's errors), so how often the GPU lets the 3D views down can be counted
  if (why !== 'you restarted it') console.error(`[3D] ${view}: ${why}`);
};
/** Tear the 3D views down and build them again (nothing else in Cora restarts). */
export function restartGl(why = 'you restarted it'): void {
  note('all', why);
  useGl.setState((s) => ({ epoch: s.epoch + 1 }));
}

/** Retries before giving up: this many failures within the window stops it (and says so). */
export const GL_TRIES = 3;
export const GL_WINDOW_MS = 120_000;
/** After a failure: try again, or (failing over and over) stop and wait for you. */
export function glNext(failures: number[], now: number): 'retry' | 'stop' {
  return failures.filter((t) => now - t < GL_WINDOW_MS).length >= GL_TRIES ? 'stop' : 'retry';
}

/**
 * A 3D canvas that recovers by itself: when its WebGL context is lost (the GPU process crashed or reset) or its scene
 * throws, it's built again a moment later with a new renderer. Failing again and again, it stops and offers a restart.
 * `children` gets the canvas's key and an onCreated to pass to <Canvas>.
 */
export function GlGuard({ name, children }: { name: string; children: (o: { key: string; onCreated: (s: RootState) => void }) => ReactNode }) {
  const epoch = useGl((s) => s.epoch);
  const [n, setN] = useState(0);
  const [stopped, setStopped] = useState<string | null>(null);
  const fails = useRef<number[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  // a restart by hand: start over
  useEffect(() => {
    fails.current = [];
    setStopped(null);
  }, [epoch]);
  const recover = (why: string) => {
    const now = Date.now();
    fails.current = [...fails.current, now];
    if (glNext(fails.current, now) === 'stop') {
      note(name, `stopped: ${why}, again and again`);
      return setStopped(why);
    }
    note(name, `restarted itself: ${why}`);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setN((x) => x + 1), 1200);
  };
  const onCreated = ({ gl }: RootState) => {
    gl.domElement.addEventListener(
      'webglcontextlost',
      (e) => {
        // a canvas being taken down throws its context away itself (React Three Fiber's dispose): it's off the page by
        // then, and not a failure. Counting it rebuilt the view for nothing, with a black flash while it did
        if (!gl.domElement.isConnected) return;
        // ours to handle: rebuild with a fresh context rather than wait on this one
        e.preventDefault();
        recover('the graphics context was lost');
      },
      { once: true },
    );
  };
  if (stopped)
    return (
      <div className="gl-stopped" role="alert">
        <Icon name="TriangleAlert" size={16} />
        <span>
          <b>The 3D view stopped</b>
          <span>{stopped.charAt(0).toUpperCase() + stopped.slice(1)}. It kept failing, so it's waiting for you.</span>
        </span>
        <button className="btn allow" onClick={() => restartGl()}>
          <Icon name="RotateCw" size={12} /> Restart 3D
        </button>
      </div>
    );
  return (
    <GlBoundary key={`${epoch}:${n}`} onError={(e) => recover(`it hit an error (${e.message.slice(0, 120)})`)}>
      {children({ key: `${name}:${epoch}:${n}`, onCreated })}
    </GlBoundary>
  );
}

/** Catches a 3D scene's error, so it's rebuilt instead of the whole window going blank. */
class GlBoundary extends Component<{ onError: (e: Error) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: Error) {
    this.props.onError(e);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** Settings → Scene: restart the 3D views by hand, and when they last restarted (and why). */
export function GlRestart() {
  const last = useGl((s) => s.events.at(-1));
  return (
    <span className="gl-restart">
      {last ? (
        <span className="dim">
          {new Date(last.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · {last.view === 'all' ? '' : `${last.view} `}
          {last.why}
        </span>
      ) : null}
      <button className="btn" onClick={() => restartGl()}>
        <Icon name="RotateCw" size={12} /> Restart the 3D view
      </button>
    </span>
  );
}
