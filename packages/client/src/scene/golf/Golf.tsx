import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useBrain } from '../../state/store';
import { sessionName } from '../../lib/format';
import { CENTER, resetCam, type CamState } from '../camera';
import type { Fx, WorldRegistry } from '../effects';
import type { OrbApi } from '../parts';
import { glowTexture } from '../fx';
import { resourceLabel } from '../layout';
import * as P from './physics';
import { makeHud, type Hud } from './hud';

/**
 * Gravity golf: a hidden game in the scene. Double-click empty space to play, Esc (or another double-click) to
 * leave. The live scene is the course: every orb and radiant is a gravity well (main heaviest), and they keep
 * moving as the session works. Pull back anywhere and let go to sling the ball; sink it in the wormhole.
 */
export type GolfApi = { toggle(): void; playing(): boolean };

/** the camera's guaranteed view at the overview (camera.tsx's HALF_W / HALF_H around CENTER): the field */
const FIELD: P.Bounds = { x0: CENTER.x - 13.2, x1: CENTER.x + 13.2, y0: -7.6, y1: 7.6 };
/** mass and core radius by what the well is; the core radii are the orbs' own (main 0.85, a subagent 0.52) */
const KIND = {
  main: { m: 1, r: 0.85 },
  sub: { m: 0.45, r: 0.52 },
  anthropic: { m: 0.3, r: 0.34 },
  res: { m: 0.16, r: 0.36 },
};
const BEST_KEY = 'cora:golf';
const MAX_WELLS = 24;
const TRAIL = 40;
const DOTS = 14;
const PREVIEW_S = 0.7;
/** the ghost: your best shot from this hole's tee, as faint dots (and how many points a shot keeps) */
const GHOST = 56;
const LINE_MAX = 600;

type Phase = 'ready' | 'aim' | 'fly' | 'sink' | 'lost' | 'tee';
/** what survives leaving: come back and it's the same hole, same strokes */
type Run = { sid: string; card: P.Card; hole: P.V2; lie: P.V2; tee: P.V2; ghost: P.Line | null };
let saved: Run | null = null;

function loadBest(): P.Best {
  try {
    return { ...P.NO_BEST, ...JSON.parse(localStorage.getItem(BEST_KEY) ?? '{}') };
  } catch {
    return { ...P.NO_BEST };
  }
}
function saveBest(b: P.Best) {
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(b));
  } catch {
    /* private window: the best is just this page's */
  }
}

/** The wells, from where the scene's objects are this frame. Orbs grow in and shrink as they die: mass follows. */
function collectWells(world: WorldRegistry, out: P.Well[], v: THREE.Vector3): P.Well[] {
  out.length = 0;
  for (const [key, o] of world) {
    if (!o) continue;
    const kind = key === 'agent:main' ? KIND.main : key.startsWith('agent:') ? KIND.sub : key === 'anthropic' ? KIND.anthropic : key.startsWith('res:') ? KIND.res : null;
    if (!kind) continue;
    // an orb's first child is its visuals group, scaled by birth, death and hover
    const s = key.startsWith('agent:') ? Math.min(1.1, o.children[0]?.scale.x ?? 1) : 1;
    if (s < 0.2) continue;
    o.getWorldPosition(v);
    out.push({ key, x: v.x, y: v.y, m: kind.m * s * s, r: kind.r * s });
  }
  return out;
}

const SWIRL_VS = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
/** the wormhole: spiral arms winding into a bright rim around a dark mouth */
const SWIRL_FS = /* glsl */ `
varying vec2 vUv;
uniform float uTime;
uniform float uVis;
uniform float uHot;
void main() {
  vec2 p = (vUv - 0.5) * 2.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float arms = 0.5 + 0.5 * sin(a * 3.0 + log(r + 0.001) * 7.0 + uTime * 3.2);
  float disc = smoothstep(0.24, 0.36, r) * (1.0 - smoothstep(0.36, 1.0, r));
  float rim = exp(-pow((r - 0.35) * 16.0, 2.0));
  vec3 c = mix(vec3(0.42, 0.3, 1.0), vec3(0.35, 0.95, 1.0), arms);
  float k = (disc * (0.18 + 0.8 * pow(arms, 3.0)) + rim * (1.1 + uHot)) * uVis;
  gl_FragColor = vec4(c * k * (1.0 + uHot), k);
}`;

function glow(color: THREE.ColorRepresentation, size: number, opacity = 1) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  s.scale.set(size, size, 1);
  return s;
}
const ringGeo = new THREE.RingGeometry(0.965, 1, 96);
function ring(color: THREE.ColorRepresentation, opacity: number) {
  return new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
}

/** the camera has settled on the whole scene (not zoomed, moved, tilted or focused, nor easing back from it) */
const atOverview = (c: CamState) => !c.focus && Math.abs(c.dist - 1) < 0.03 && Math.abs(c.yaw) < 0.01 && Math.abs(c.pitch) < 0.01 && c.look.distanceTo(CENTER) < 0.1;

/** what swallowed the ball, for the call-out */
const wellName = (key: string) =>
  key === 'agent:main' ? 'main' : key.startsWith('agent:') ? 'a subagent' : key === 'anthropic' ? 'Anthropic' : key.startsWith('res:') ? resourceLabel(key.slice(4)) : key;

const AIM_LOW = new THREE.Color('#67e8f9'), AIM_MID = new THREE.Color('#fde68a'), AIM_HIGH = new THREE.Color('#fb7185');
const aimColor = (u: number, out: THREE.Color) => (u < 0.6 ? out.copy(AIM_LOW).lerp(AIM_MID, u / 0.6) : out.copy(AIM_MID).lerp(AIM_HIGH, (u - 0.6) / 0.4));

export function Golf({ api, cam, world, fx, orbs, sessionId }: { api: React.MutableRefObject<GolfApi | null>; cam: CamState; world: WorldRegistry; fx: React.MutableRefObject<Fx | null>; orbs: Map<string, OrbApi>; sessionId: string }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const get = useThree((s) => s.get);
  const sid = useRef(sessionId);
  sid.current = sessionId;

  // ---------------------------------------------------------------- the visuals (built once, shown while playing)
  const v = useMemo(() => {
    const root = new THREE.Group();
    root.visible = false;
    root.renderOrder = 10;
    const ball = new THREE.Group();
    const halo = glow('#a5f3fc', 1.4, 0.8);
    const core = glow('#ffffff', 0.44, 1);
    const ready = ring('#a5f3fc', 0);
    ball.add(halo, core, ready);
    const trail = Array.from({ length: TRAIL }, (_, i) => {
      const c = new THREE.Color('#e0f2fe').lerp(new THREE.Color('#818cf8'), i / TRAIL);
      return glow(c, 0.5 * (1 - i / TRAIL) + 0.06, 0);
    });
    const dots = Array.from({ length: DOTS }, () => glow('#67e8f9', 0.36, 0));
    const ghost = Array.from({ length: GHOST }, () => glow('#c4b5fd', 0.26, 0));
    const bandGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    const band = new THREE.Line(bandGeo, new THREE.LineBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const knob = glow('#67e8f9', 0.3, 0);
    // the hole: a dark mouth (it hides the stars behind it) inside a swirl
    const hole = new THREE.Group();
    const uniforms = { uTime: { value: 0 }, uVis: { value: 1 }, uHot: { value: 0 } };
    const swirl = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.ShaderMaterial({ vertexShader: SWIRL_VS, fragmentShader: SWIRL_FS, uniforms, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const mouth = new THREE.Mesh(new THREE.CircleGeometry(P.HOLE_R * 0.92, 48), new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.85, depthWrite: false }));
    mouth.position.z = -0.01;
    const holeGlow = glow('#8b5cf6', 2.6, 0.35);
    hole.add(holeGlow, mouth, swirl);
    // around each well: a faint rim where its pull starts to beat friction, and rings drifting inward
    const rims = Array.from({ length: MAX_WELLS }, () => ring('#94a3b8', 0));
    const falls = Array.from({ length: MAX_WELLS * 2 }, () => ring('#a5b4fc', 0));
    root.add(...rims, ...falls, hole, ...ghost, band, knob, ...dots, ...trail, ball);
    return { root, ball, halo, core, ready, trail, dots, ghost, band, bandGeo, knob, hole, uniforms, holeGlow, rims, falls };
  }, []);
  useEffect(
    () => () => {
      v.root.traverse((o) => {
        const m = (o as THREE.Mesh).material as THREE.Material | undefined;
        m?.dispose();
        if (o instanceof THREE.Mesh && o.geometry !== ringGeo) o.geometry.dispose();
      });
      v.bandGeo.dispose();
    },
    [v],
  );

  // ---------------------------------------------------------------- the game's state (mutable, read every frame)
  const S = useRef({
    on: false,
    phase: 'ready' as Phase,
    at: 0,
    card: P.newCard(),
    best: P.NO_BEST,
    hole: { x: 0, y: 0 } as P.V2,
    /** where the ball sits, and where the current shot was taken from (a penalty puts it back there) */
    lie: { x: 0, y: 0 } as P.V2,
    from: { x: 0, y: 0 } as P.V2,
    /** where this hole started (a retry goes back here), the shot in the air (when it's from the tee), the best one */
    tee: { x: 0, y: 0 } as P.V2,
    shot: null as P.Line | null,
    ghost: null as P.Line | null,
    f: null as P.Flight | null,
    press: null as P.V2 | null,
    pull: { x: 0, y: 0 } as P.V2,
    trail: [] as P.V2[],
    trailFade: 0,
    shake: 0,
    holeIn: 1,
    wells: [] as P.Well[],
    hud: null as Hud | null,
    startedAt: 0,
  }).current;
  const tmp = useMemo(() => ({ v: new THREE.Vector3(), c: new THREE.Color(), pos: new THREE.Vector3() }), []);
  const act = useRef<{ leave(why?: string): void; newHole(tee: P.V2): void } | null>(null);

  useEffect(() => {
    const el = gl.domElement;
    // the scene's own box: the canvas and its label overlay (everything the game takes over; not the needs-you bar or
    // the mic beside it)
    const view = (el.closest('.scene-box') as HTMLElement | null) ?? el.parentElement!.parentElement!.parentElement!;
    const ray = new THREE.Raycaster();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    const ndc = new THREE.Vector2();
    const hit = new THREE.Vector3();
    const toPlane = (e: { clientX: number; clientY: number }): P.V2 | null => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, camera);
      return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, y: hit.y } : null;
    };
    const rng = Math.random;
    const wellsNow = () => collectWells(world, S.wells, tmp.v);

    const newHole = (tee: P.V2) => {
      const w = wellsNow();
      S.lie = P.clearOf(tee, w);
      S.from = { ...S.lie };
      S.hole = P.placeHole(rng, w, FIELD, S.lie);
      S.card = { ...S.card, par: P.parFor(S.lie, S.hole), tries: 1 };
      S.holeIn = 0;
      S.tee = { ...S.lie };
      S.ghost = null;
      S.shot = null;
    };
    // R: this hole again from its tee, strokes wiped (the ghost of your best try stays)
    const retry = () => {
      if (S.phase === 'sink') return;
      S.lie = P.clearOf(S.tee, wellsNow());
      S.from = { ...S.lie };
      S.card = P.retry(S.card);
      S.f = null;
      S.shot = null;
      S.press = null;
      S.trail = [];
      S.phase = 'tee';
      S.at = performance.now();
      el.style.cursor = 'crosshair';
      S.hud?.say(`try ${S.card.tries}${S.ghost ? ' · your best line is the ghost' : ''}`, 'info', 1300);
      S.hud?.score(S.card, S.best);
      fx.current?.ripple(() => new THREE.Vector3(S.lie.x, S.lie.y, 0), '#a5f3fc', 0.1, 1.1, 500);
    };

    // ---- input: while playing, the scene's own handlers (picking, tooltips, the camera's drag and zoom) don't hear
    // anything; the game does. Capture phase on the container, so nothing underneath sees the events.
    const stop = (e: Event) => e.stopPropagation();
    const onDown = (e: PointerEvent) => {
      stop(e);
      if (e.button === 2) return void (S.phase === 'aim' && ((S.phase = 'ready'), (S.press = null)));
      if (e.button !== 0 || S.phase !== 'ready') return;
      const p = toPlane(e);
      if (!p) return;
      S.press = p;
      S.pull = { x: 0, y: 0 };
      S.phase = 'aim';
      try {
        view.setPointerCapture(e.pointerId);
      } catch {
        /* not a live pointer (synthetic): moves still arrive over the view */
      }
      el.style.cursor = 'grabbing';
    };
    const onMove = (e: PointerEvent) => {
      stop(e);
      if (S.phase !== 'aim' || !S.press) return;
      const p = toPlane(e);
      if (p) S.pull = { x: p.x - S.press.x, y: p.y - S.press.y };
    };
    const onUp = (e: PointerEvent) => {
      stop(e);
      el.style.cursor = 'crosshair';
      if (S.phase !== 'aim') return;
      S.press = null;
      const vel = P.launch(S.pull);
      if (!vel) return void (S.phase = 'ready');
      S.from = { ...S.lie };
      S.shot = Math.hypot(S.lie.x - S.tee.x, S.lie.y - S.tee.y) < 0.05 ? { pts: [{ ...S.lie }], closest: Infinity } : null;
      S.f = P.flight(S.lie.x, S.lie.y, vel.x, vel.y);
      S.card = P.stroke(S.card);
      S.trail = [];
      S.phase = 'fly';
      S.at = performance.now();
      S.hud?.score(S.card, S.best);
    };
    const onDbl = (e: MouseEvent) => {
      stop(e);
      // the double-click that started the game is still on its way through
      if (performance.now() - S.startedAt > 400 && S.phase !== 'aim') leave();
    };
    const onWheel = (e: WheelEvent) => (e.preventDefault(), stop(e));
    const onMenu = (e: MouseEvent) => (e.preventDefault(), stop(e));
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // keys in the terminal or a text box are theirs (Esc there interrupts Claude)
      if (t?.closest('input, textarea, select, [contenteditable], .xterm') || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Escape') leave();
      else if ((e.key === 'r' || e.key === 'R') && !e.repeat) {
        e.preventDefault();
        retry();
      }
    };
    const evs: Array<[string, (e: any) => void]> = [
      ['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointerover', stop], ['pointerout', stop],
      ['click', stop], ['dblclick', onDbl], ['wheel', onWheel], ['contextmenu', onMenu],
    ];
    let unsub: (() => void) | null = null;

    const start = () => {
      if (S.on) return;
      const st = useBrain.getState();
      if (st.sessions[sid.current]?.state === 'ended') return;
      // this session is asking you something: that comes first
      if (st.pending.some((p) => p.sessionId === sid.current)) return void makeHud(view).close('golf · this session needs you first');
      S.on = true;
      S.startedAt = performance.now();
      S.best = loadBest();
      resetCam(cam);
      // no parallax from where the double-click happened: the view settles dead centre
      get().pointer.set(0, 0);
      for (const [n, h] of evs) view.addEventListener(n, h, { capture: true, passive: n !== 'wheel' });
      window.addEventListener('keydown', onKey);
      view.classList.add('golfing');
      view.querySelector('.labels')?.classList.add('golf-dim');
      const tip = view.querySelector<HTMLElement>('.scene-tip');
      if (tip) tip.style.display = 'none';
      document.body.style.cursor = '';
      el.style.cursor = 'crosshair';
      S.hud = makeHud(view);
      // back to the hole you left (same strokes); on another session's course, a new hole, same card
      const w = wellsNow();
      if (saved) {
        S.card = saved.card;
        if (saved.sid === sid.current) {
          S.lie = P.clearOf(saved.lie, w);
          S.from = { ...S.lie };
          S.hole = saved.hole;
          S.holeIn = 0;
          S.tee = saved.tee;
          S.ghost = saved.ghost;
          S.shot = null;
          if (!w.every((x) => Math.hypot(S.hole.x - x.x, S.hole.y - x.y) >= x.r + P.HOLE_CLEAR * 0.6)) S.hole = P.placeHole(rng, w, FIELD, S.lie);
        } else newHole(P.placeTee(rng, w, FIELD));
        S.hud.say(`hole ${S.card.hole}, where you left it`, 'info', 1400);
      } else {
        S.card = P.newCard();
        newHole(P.placeTee(rng, w, FIELD));
        S.hud.say('pull back anywhere and let go', 'info', 2600);
      }
      S.phase = 'tee';
      S.at = performance.now();
      S.trail = [];
      S.trailFade = 0;
      S.f = null;
      S.press = null;
      S.hud.score(S.card, S.best);
      v.root.visible = true;
      // someone needs you: drop everything (the hole keeps)
      const known = new Set(st.pending.map((p) => p.id));
      unsub = useBrain.subscribe((s) => {
        const fresh = s.pending.find((p) => !known.has(p.id));
        if (!fresh) return;
        const ss = s.sessions[fresh.sessionId];
        leave(`golf paused · ${fresh.sessionId === sid.current ? 'this session' : ss ? sessionName(ss) : 'a session'} needs you`);
      });
    };
    const leave = (why?: string) => {
      if (!S.on) return;
      S.on = false;
      // mid-flight or mid-penalty: the ball goes back to where it was shot from
      const lie = S.phase === 'fly' || S.phase === 'lost' ? S.from : S.lie;
      saved = { sid: sid.current, card: S.card, hole: S.hole, lie, tee: S.tee, ghost: S.ghost };
      for (const [n, h] of evs) view.removeEventListener(n, h, { capture: true });
      window.removeEventListener('keydown', onKey);
      unsub?.();
      unsub = null;
      view.classList.remove('golfing');
      view.querySelector('.labels')?.classList.remove('golf-dim');
      el.style.cursor = '';
      S.hud?.close(why);
      S.hud = null;
      S.press = null;
      v.root.visible = false;
    };
    // the frame loop needs these too
    act.current = { leave, newHole };
    api.current = {
      // double-clicking empty space also resets a zoomed or moved view (the rig): that comes first, and only a
      // double-click on the settled overview plays
      toggle: () => (S.on ? leave() : atOverview(cam) && start()),
      playing: () => S.on,
    };
    if (import.meta.env.DEV) (window as any).__golf = { S, start, leave, FIELD, camera, THREE, P };
    return () => {
      leave();
      api.current = null;
    };
  }, [gl, camera, get, cam, world, api, S, v, tmp]);

  // a session that ends (or another one opened) ends the game
  const state = useBrain((s) => s.sessions[sessionId]?.state);
  useEffect(() => {
    if (state === 'ended') act.current?.leave();
  }, [state]);
  useEffect(() => () => act.current?.leave(), [sessionId]);

  // ---------------------------------------------------------------- the frame loop
  const at = (p: P.V2) => {
    const q = new THREE.Vector3(p.x, p.y, 0);
    return () => q;
  };
  useFrame(({ camera: c, clock }, dtRaw) => {
    if (!S.on) return;
    const dt = Math.min(dtRaw, 0.05);
    const now = performance.now();
    const t = clock.elapsedTime;
    const wells = collectWells(world, S.wells, tmp.v);
    const f = fx.current;
    const since = now - S.at;

    // a well that drifts onto the hole pushes it somewhere else (no charge)
    if (S.phase !== 'sink' && !wells.every((w) => Math.hypot(S.hole.x - w.x, S.hole.y - w.y) >= w.r + P.HOLE_CLEAR * 0.6)) {
      S.hole = P.placeHole(Math.random, wells, FIELD, S.lie);
      S.holeIn = 0;
    }
    const penalty = (text: string, burstAt: P.V2, color: string) => {
      S.card = P.stroke(S.card);
      S.phase = 'lost';
      S.at = now;
      S.shake = 0.16;
      S.trailFade = Math.min(S.trailFade, 1);
      f?.burst(at(burstAt), color, 34);
      S.hud?.say(`${text} · +1`, 'bad', 1500);
      S.hud?.score(S.card, S.best);
    };

    switch (S.phase) {
      case 'tee':
        if (since > 350) S.phase = 'ready';
        break;
      case 'ready':
      case 'aim': {
        // a well that moves onto the resting ball swallows it too: a busy session is a harder course
        const w = P.touching(S.lie, wells);
        if (w) {
          orbs.get(w.key.slice(6))?.shiver();
          S.from = P.clearOf(S.from, wells);
          penalty(`swallowed by ${wellName(w.key)}`, S.lie, '#fca5a5');
        }
        break;
      }
      case 'fly': {
        const fl = S.f!;
        const o = P.advance(fl, wells, S.hole, FIELD, dt);
        S.lie = { x: fl.ball.x, y: fl.ball.y };
        if (S.shot) {
          if (S.shot.pts.length < LINE_MAX) S.shot.pts.push({ ...S.lie });
          if (o.kind !== 'fly') {
            S.shot.closest = o.kind === 'sunk' ? 0 : P.closestTo(S.shot.pts, S.hole);
            S.ghost = P.betterLine(S.ghost, S.shot);
            S.shot = null;
          }
        }
        S.trail.unshift({ ...S.lie });
        if (S.trail.length > TRAIL) S.trail.length = TRAIL;
        S.trailFade = 1;
        if (fl.hot) {
          fl.hot = false;
          S.hud?.say('too hot', 'bad', 900);
          v.uniforms.uHot.value = 0.8;
        }
        if (o.kind === 'rest') {
          S.phase = 'ready';
          S.at = now;
        } else if (o.kind === 'sunk') {
          S.phase = 'sink';
          S.at = now;
          const strokes = S.card.strokes;
          const ace = strokes === 1;
          const r = P.sink(S.card, 3);
          S.card = r.card;
          S.best = P.better(S.best, r.card, ace);
          saveBest(S.best);
          const good = r.diff < 0;
          S.hud?.say(ace ? 'HOLE IN ONE' : `${r.name}${good ? '!' : ''}`, ace ? 'ace' : good ? 'good' : r.diff > 0 ? 'bad' : 'info', 1700);
          S.hud?.score(S.card, S.best);
          f?.burst(at(S.hole), '#a78bfa', 60);
          f?.burst(at(S.hole), '#67e8f9', 36);
          f?.ripple(at(S.hole), '#c4b5fd', 0.3, 2.8, 900);
          if (ace || good) f?.ripple(at(S.hole), ace ? '#fde68a' : '#86efac', 0.5, ace ? 6 : 4, 1300);
          S.shake = ace ? 0.12 : 0.05;
        } else if (o.kind === 'absorbed') {
          const w = o.well;
          const dir = new THREE.Vector3(fl.ball.x - w.x, fl.ball.y - w.y, 0.4).normalize();
          if (w.key.startsWith('agent:')) {
            const orb = orbs.get(w.key.slice(6));
            orb?.ripple(dir, 0.2);
            orb?.shiver();
          }
          f?.ripple(at(w), '#fca5a5', w.r * 1.1, w.r * 3.2, 700);
          penalty(`swallowed by ${wellName(w.key)}`, S.lie, '#fca5a5');
        } else if (o.kind === 'out') {
          penalty('out of bounds', { x: Math.max(FIELD.x0, Math.min(FIELD.x1, fl.ball.x)), y: Math.max(FIELD.y0, Math.min(FIELD.y1, fl.ball.y)) }, '#94a3b8');
        }
        break;
      }
      case 'lost':
        if (since > 650) {
          S.lie = P.clearOf(S.from, wells);
          S.phase = 'tee';
          S.at = now;
          S.trail = [];
          f?.ripple(at(S.lie), '#a5f3fc', 0.1, 1.1, 500);
        }
        break;
      case 'sink':
        if (since > 1100) {
          act.current?.newHole(P.placeTee(Math.random, wells, FIELD));
          S.hud?.score(S.card, S.best);
          S.phase = 'tee';
          S.at = now;
          S.trail = [];
          f?.ripple(at(S.lie), '#a5f3fc', 0.1, 1.3, 600);
        }
        break;
    }

    // ---- draw
    const ph = S.phase;
    const sinceNow = now - S.at;
    // the ball: spirals into the hole when sunk, gone while a penalty plays, pops in at a tee
    let bx = S.lie.x, by = S.lie.y, bs = 1;
    if (ph === 'sink') {
      const u = Math.min(1, sinceNow / 450);
      const ang = u * 7;
      const rad = (1 - u) * 0.35;
      bx = S.hole.x + Math.cos(ang) * rad;
      by = S.hole.y + Math.sin(ang) * rad;
      bs = 1 - u;
    } else if (ph === 'lost') bs = 0;
    else if (ph === 'tee') bs = Math.min(1, sinceNow / 300) * (1 + 0.4 * Math.sin(Math.min(1, sinceNow / 300) * Math.PI));
    v.ball.position.set(bx, by, 0.02);
    v.ball.scale.setScalar(Math.max(0.001, bs));
    v.halo.material.opacity = 0.7 + 0.15 * Math.sin(t * 5);
    // ready to shoot: a slow pulse round the ball
    const rdy = ph === 'ready' ? 0.35 + 0.25 * Math.sin(t * 3.5) : 0;
    v.ready.scale.setScalar(0.36 + 0.06 * Math.sin(t * 3.5));
    (v.ready.material as THREE.MeshBasicMaterial).opacity = rdy;

    // the trail: where the ball has just been; fades once it stops
    if (ph !== 'fly') S.trailFade = Math.max(0, S.trailFade - dt * 1.8);
    v.trail.forEach((s, i) => {
      const p = S.trail[i];
      s.visible = !!p && S.trailFade > 0;
      if (!p) return;
      s.position.set(p.x, p.y, 0.01);
      s.material.opacity = 0.75 * (1 - i / TRAIL) * S.trailFade;
    });

    // aiming: the rubber band behind the ball and the first moments of the path ahead
    const aiming = ph === 'aim' && P.launch(S.pull);
    const pw = P.power(S.pull);
    aimColor(pw, tmp.c);
    v.band.visible = v.knob.visible = !!aiming;
    if (aiming) {
      const L = Math.hypot(S.pull.x, S.pull.y);
      const k = Math.min(L, P.PULL_MAX) / L;
      const pos = v.bandGeo.attributes.position as THREE.BufferAttribute;
      pos.setXYZ(0, S.lie.x, S.lie.y, 0.01);
      pos.setXYZ(1, S.lie.x + S.pull.x * k, S.lie.y + S.pull.y * k, 0.01);
      pos.needsUpdate = true;
      (v.band.material as THREE.LineBasicMaterial).color.copy(tmp.c);
      v.knob.position.set(S.lie.x + S.pull.x * k, S.lie.y + S.pull.y * k, 0.01);
      v.knob.material.color.copy(tmp.c);
      v.knob.material.opacity = 0.8;
    }
    const pts = aiming ? P.preview(S.lie, aiming, wells, S.hole, FIELD, PREVIEW_S, PREVIEW_S / DOTS) : [];
    v.dots.forEach((s, i) => {
      const p = pts[i];
      s.visible = !!p;
      if (!p) return;
      s.position.set(p.x, p.y, 0.01);
      s.material.color.copy(tmp.c);
      s.material.opacity = 1 - (0.75 * i) / DOTS;
    });

    // the ghost: your best shot from this tee so far (gold once one went in), faint behind everything else
    const gp = S.ghost && ph !== 'sink' ? P.thin(S.ghost.pts, GHOST) : [];
    const gold = S.ghost?.closest === 0;
    v.ghost.forEach((s, i) => {
      const p = gp[i];
      s.visible = !!p;
      if (!p) return;
      s.position.set(p.x, p.y, 0.005);
      s.material.color.set(gold ? '#fde68a' : '#c4b5fd');
      s.material.opacity = (ph === 'fly' ? 0.12 : 0.26) * (0.55 + 0.45 * (1 - i / GHOST));
    });

    // the hole: grows in, swirls, flares as the ball goes down
    S.holeIn = Math.min(1, S.holeIn + dt * 2.2);
    const sinkU = ph === 'sink' ? Math.min(1, sinceNow / 1100) : 0;
    const hs = (1 - Math.pow(1 - S.holeIn, 3)) * (ph === 'sink' ? 1 + 0.5 * Math.sin(sinkU * Math.PI) - 0.9 * Math.max(0, sinkU - 0.6) / 0.4 : 1);
    v.hole.position.set(S.hole.x, S.hole.y, -0.02);
    v.hole.scale.setScalar(Math.max(0.001, hs));
    v.uniforms.uTime.value = t * (ph === 'sink' ? 2.5 : 1);
    v.uniforms.uHot.value = ph === 'sink' ? 1.5 * (1 - sinkU) : v.uniforms.uHot.value * Math.pow(0.05, dt);
    v.holeGlow.material.opacity = 0.3 + 0.08 * Math.sin(t * 2) + (ph === 'sink' ? 0.5 * (1 - sinkU) : 0);

    // the pull, made visible: each well's basin rim, and rings sliding down into it
    for (let i = 0; i < MAX_WELLS; i++) {
      const w = wells[i];
      const rim = v.rims[i];
      rim.visible = !!w;
      const fa = v.falls[i * 2], fb = v.falls[i * 2 + 1];
      fa.visible = fb.visible = !!w;
      if (!w) continue;
      const R = Math.max(w.r * 1.5, P.basin(w));
      rim.position.set(w.x, w.y, -0.03);
      rim.scale.setScalar(R);
      // heavier wells show more (a column of radiants would otherwise read as a stack of targets)
      const heft = Math.min(1, w.m);
      (rim.material as THREE.MeshBasicMaterial).opacity = 0.015 + 0.04 * heft;
      [fa, fb].forEach((m, k) => {
        const u = (t / 2.8 + k / 2 + i * 0.37) % 1;
        m.position.set(w.x, w.y, -0.03);
        m.scale.setScalar(w.r + (R - w.r) * (1 - u * u));
        (m.material as THREE.MeshBasicMaterial).opacity = (0.025 + 0.075 * heft) * Math.sin(u * Math.PI);
      });
    }

    // a swallowed ball (or a big moment) kicks the camera; the rig puts it back next frame
    if (S.shake > 0.002) {
      c.position.x += S.shake * Math.sin(now * 0.09);
      c.position.y += S.shake * Math.cos(now * 0.117);
      S.shake *= Math.pow(0.004, dt);
    }
  });

  return <primitive object={v.root} />;
}
