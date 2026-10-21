import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { BlackHolePass, SHADOW_RS, type HoleFrame } from './blackhole';
import { CENTER } from './camera';

/**
 * A session ending (a black hole opens and swallows its scene) or coming back (the hole gives it all back, like a
 * white hole: a flash, a shock ring, everything flung back out to where it belongs). `unwind`: it came back before
 * the collapse finished, so the collapse plays backwards from where it got to (`from`, ms in).
 */
export type CosmicPhase = { kind: 'collapse' | 'bang'; at: number } | { kind: 'unwind'; at: number; from: number } | null;
const UNWIND_SPEED = 1.6;

export const COLLAPSE_MS = 3800;
export const BANG_MS = 2800;
/** What's left once a collapse is over: a smaller, quieter hole. */
const REMNANT_MASS = 0.72;
/** Matter that started this far out (rs) has all fallen in by the end: past the corners of the screen. */
const ALL_FALLEN = 64;

export type CosmicFrame = HoleFrame & { labels: number; done: boolean };

const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const smooth = (a: number, b: number, x: number) => {
  const u = clamp01((x - a) / (b - a));
  return u * u * (3 - 2 * u);
};
const easeInOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

/**
 * Where a collapse or a bang is at `t` ms. Collapse: the hole opens at the centre (the stars start bending before
 * anything moves), then the scene falls in, inner things first, everything accelerating, and the hole settles into
 * a smaller remnant. Bang: the reverse, fast, from a flash.
 */
export function cosmicState(kind: 'collapse' | 'bang', t: number): CosmicFrame {
  if (kind === 'collapse') {
    const u = t / COLLAPSE_MS;
    const fall = clamp01((t - 400) / 2800);
    return {
      mass: easeInOut(clamp01(t / 800)) * (1 - (1 - REMNANT_MASS) * smooth(0.82, 1, u)),
      fallen: ALL_FALLEN * Math.pow(fall, 2.4),
      flash: 0,
      bang: -1,
      heat: 0,
      matter: fall < 1,
      labels: 1 - clamp01(t / 600),
      done: u >= 1,
    };
  }
  const u = t / BANG_MS;
  const out = easeOut(clamp01((t - 60) / 2100));
  return {
    mass: REMNANT_MASS * (1 - easeOut(clamp01(t / 1000))),
    fallen: ALL_FALLEN * Math.pow(1 - out, 1.7),
    // ignition: a fast rise, then a long fall-off
    flash: smooth(0, 70, t) * Math.pow(1 - clamp01(t / 1000), 2),
    bang: u < 1 ? t / 1000 : -1,
    heat: 1 - smooth(150, 1900, t),
    matter: true,
    labels: clamp01((t - 1700) / 900),
    done: u >= 1,
  };
}

/** Where a phase is now (an unwind is the collapse played backwards), and whether it has finished. */
export function cosmicNow(p: NonNullable<CosmicPhase>, now: number): CosmicFrame {
  if (p.kind !== 'unwind') return cosmicState(p.kind, now - p.at);
  const t = p.from - (now - p.at) * UNWIND_SPEED;
  return { ...cosmicState('collapse', Math.max(0, t)), matter: true, done: t <= 0 };
}

/** The phase to start when a session comes back: a bang from a finished collapse, else unwind what's there. */
export function comeBack(p: CosmicPhase, now: number): CosmicPhase {
  if (p?.kind === 'collapse' && now - p.at < COLLAPSE_MS) return { kind: 'unwind', at: now, from: now - p.at };
  if (p?.kind === 'unwind') return p;
  return { kind: 'bang', at: now };
}

/**
 * The scene's post-processing (bloom) with the black hole in it. The hole needs the composer even when effects are
 * turned down, so it's mounted for as long as a collapse or bang is on. While one is, the swallowable group
 * (`cosmos`) is hidden from the main render and the hole's pass draws it, falling; `labels` (the label overlay) fades.
 */
export function Cosmos({
  phase,
  cosmos,
  labels,
  note,
  lowFx,
}: {
  phase: React.MutableRefObject<CosmicPhase>;
  cosmos: React.RefObject<THREE.Group | null>;
  labels: () => HTMLElement | null;
  note: React.RefObject<HTMLDivElement | null>;
  lowFx: boolean;
}) {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const pass = useMemo(() => {
    const p = new BlackHolePass(camera, () => cosmos.current);
    p.center.copy(CENTER);
    p.enabled = false;
    return p;
  }, [camera, cosmos]);
  useEffect(() => {
    // compile the hole's shader now, off the main thread where supported: compiling it when a session ends stalls
    pass.warm(gl).catch(() => {});
    return () => pass.dispose();
  }, [gl, pass]);
  const [active, setActive] = useState(false);
  const activeRef = useRef(false);

  const v = useMemo(() => new THREE.Vector3(), []);
  const w = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera: cam, size }) => {
    pass.tick();
    const p = phase.current;
    // dev: window.__cosmicT holds a phase at that many ms in, for looking at one moment
    const hold = import.meta.env.DEV ? (window as any).__cosmicT : undefined;
    const now = typeof hold === 'number' && p ? p.at + hold : Date.now();
    const c = p ? cosmicNow(p, now) : null;
    // the bang kicks the camera (the rig puts it back next frame)
    if (p?.kind === 'bang' && now - p.at < 900) {
      const t = now - p.at;
      const k = 0.32 * Math.exp(-t / 200) * smooth(0, 40, t);
      cam.position.x += k * Math.sin(t * 0.093);
      cam.position.y += k * Math.cos(t * 0.121);
    }
    if (!!c !== activeRef.current) setActive((activeRef.current = !!c));
    pass.enabled = !!c;
    if (c) pass.frame = c;
    const g = cosmos.current;
    if (g) {
      // hidden from the main render only once the pass is drawing it (the composer may still be mounting)
      g.visible = !(c && pass.drawing());
      // all swallowed: nothing left to hover either
      g.scale.setScalar(c && !c.matter ? 1e-4 : 1);
    }
    const lab = labels();
    if (lab) {
      const o = c ? c.labels : 1;
      const want = o >= 0.999 ? '' : String(o);
      if (lab.style.opacity !== want) lab.style.opacity = want;
    }
    if (note.current) {
      note.current.classList.toggle('on', !!p && p.kind === 'collapse' && !!c?.done);
      if (c) {
        // just under the hole's shadow, wherever the drifting view puts it
        cam.updateMatrixWorld();
        v.copy(CENTER).project(cam);
        w.setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(pass.rsWorld).add(CENTER).project(cam);
        const rsPx = (Math.abs(w.x - v.x) / 2) * size.width;
        note.current.style.left = `${Math.round(((v.x + 1) / 2) * size.width)}px`;
        note.current.style.top = `${Math.round(((1 - v.y) / 2) * size.height + SHADOW_RS * c.mass * rsPx + 18)}px`;
      }
    }
    if (p && c?.done && p.kind !== 'collapse') phase.current = null;
  });

  if (lowFx && !active) return null;
  return (
    <EffectComposer>
      <primitive object={pass} />
      <Bloom intensity={0.85} luminanceThreshold={0.82} luminanceSmoothing={0.2} mipmapBlur radius={0.55} />
    </EffectComposer>
  );
}
