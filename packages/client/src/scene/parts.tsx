import { useEffect, useMemo, useRef } from 'react';
import type { StarSystem } from './system/generate';
import { Bodies, Nebula } from './system/Bodies';
import { Hyperspace } from './system/Hyperspace';
import { useWarp, warpLevels } from './system/warp';
import { BRIGHT_K, NEBULA_K, STARS_K, type SpaceSettings } from './system/settings';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { bez, glowTexture, hot } from './fx';
import { anchorRef, type LabelRegistry } from './labels';
import type { PosFn, WorldRegistry } from './effects';
import type { FileOp, FileTouch } from './derive';
import type { CamState } from './camera';
import { ORB_R, tagDrop } from './layout';
import { voiceLevels } from '../lib/voice';
import { FLUID_VS, GEM_FS, GEM_VS, MOTE_FS, MOTE_VS, ORB_FS, TUBE_FS, TUBE_VS } from './shaders';

export type PickTarget = { kind: 'agent'; id: string } | { kind: 'res'; id: string } | { kind: 'file'; res: string; name: string } | { kind: 'explain'; id: string };
/** `quiet`: mark it hovered (it lifts) without the scene tooltip, e.g. from its chip, which has its own card */
export type Picker = { hover(t: PickTarget | null, o?: { quiet?: boolean }): void; pick(t: PickTarget): void; isHovered(t: PickTarget): boolean };

export const OP_COLOR: Record<FileOp, string> = { read: '#22d3ee', edit: '#fbbf24', write: '#34d399', run: '#a78bfa' };
/** Program droplets blink when this is bumped for their key (a background command wrote more output). */
export const dropletKick = new Map<string, number>();
/** A program's command is executing right now: it leaves the orbit, holds still in front of the shell, and wears a pill. */
export const programRunning = (f: FileTouch) => f.program?.runningSince != null;

/** a droplet's colour: its program's (around the shell radiant), or what was last done to the file */
export const dropColor = (f: FileTouch) => f.program?.color ?? OP_COLOR[f.op];
const RED = new THREE.Color('#f87171');
const INDIGO = new THREE.Color('#818cf8');

/** Pointer handlers for a pickable mesh; a click that ends a drag is not a click. */
/** The scene hears pointer events from its label overlay too (it's inside the same container): a chip or tag over
 * an object isn't the object. */
const onCanvas = (e: ThreeEvent<PointerEvent | MouseEvent>) => (e.nativeEvent?.target as Element | null)?.tagName === 'CANVAS';

export function pickHandlers(picker: Picker, t: PickTarget) {
  return {
    onPointerOver: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      if (onCanvas(e)) picker.hover(t);
    },
    onPointerOut: (e: ThreeEvent<PointerEvent>) => {
      // onto a label above it: stay lifted, but the tooltip goes (the label may have its own)
      if (onCanvas(e)) picker.hover(null);
      else if (picker.isHovered(t)) picker.hover(t, { quiet: true });
    },
    onClick: (e: ThreeEvent<MouseEvent>) => {
      e.stopPropagation();
      if (e.delta <= 5 && onCanvas(e)) picker.pick(t);
    },
  };
}

// ---------------------------------------------------------------------------- backdrop + motes
// the classic deep space: its stars (depth, count, size, colour) and nebula (x, y, z, colour, size)
const CLASSIC_STARS = [[-25, 700, 0.16, '#475569'], [-60, 900, 0.22, '#334155'], [-120, 1100, 0.32, '#1e293b']] as const;
const CLASSIC_NEBULA = [[-10, 4, -45, '#1d4ed8', 70], [18, -6, -55, '#7c3aed', 80], [4, 8, -70, '#0e7490', 90]] as const;

export function Backdrop({ busy, system, lowFx, space }: { busy: React.MutableRefObject<number>; system: StarSystem; lowFx: boolean; space: SpaceSettings }) {
  const systems = space.mode === 'systems';
  const starK = STARS_K[space.stars];
  // star systems: the stars sit behind the planets (so none draws over one), tinted by the system
  const layers = useMemo(() => {
    const spec = systems
      ? ([[-150, 900, 0.55, 1], [-205, 1100, 0.6, 0.75], [-265, 1300, 0.62, 0.55]] as const).map(([z, count, size, shade]) => {
          const t = parseInt(system.stars.tint.slice(1), 16);
          return { z, n: count * system.stars.density, size, col: `rgb(${Math.round(((t >> 16) & 255) * shade)}, ${Math.round(((t >> 8) & 255) * shade)}, ${Math.round((t & 255) * shade)})` };
        })
      : CLASSIC_STARS.map(([z, count, size, col]) => ({ z, n: count, size, col }));
    // each star its own colour and brightness: mostly white, some blue-white, yellow or orange
    const TINTS = [[1, 1, 1], [1, 1, 1], [0.78, 0.86, 1], [1, 0.93, 0.78], [1, 0.8, 0.6]] as const;
    return spec.map(({ z, n, size, col }) => {
      const count = Math.round(n * starK);
      const p = new Float32Array(count * 3);
      const cols = new Float32Array(count * 3);
      const base = new THREE.Color(col);
      for (let i = 0; i < count; i++) {
        p.set([(Math.random() - 0.5) * (-z * 3 + 60), (Math.random() - 0.5) * (-z * 1.6 + 30), z + (Math.random() - 0.5) * 10], i * 3);
        const t = TINTS[Math.floor(Math.random() * TINTS.length)];
        const k = (0.45 + Math.pow(Math.random(), 2.5) * 1.1) * (systems ? 1.25 : 1);
        cols.set([base.r * t[0] * k, base.g * t[1] * k, base.b * t[2] * k], i * 3);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p, 3));
      g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      return { g, size, col: '#ffffff' };
    });
  }, [system, systems, starK]);
  const nebula = systems ? system.nebula.map(({ x, y, z, color, size }) => [x, y, z, color, size] as const) : CLASSIC_NEBULA;
  const nebK = NEBULA_K[space.nebula];
  const moteGeo = useMemo(() => {
    const n = 520;
    const p = new Float32Array(n * 3);
    const seed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      p.set([-17 + Math.random() * 38, -9 + Math.random() * 18, -7 + Math.random() * 11], i * 3);
      seed[i] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p, 3));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    return g;
  }, []);
  const moteUniforms = useMemo(() => ({ uTime: { value: 0 }, uBusy: { value: 0 } }), []);
  // built here, not via <shaderMaterial uniforms>: R3F copies that prop, so per-frame writes would be lost
  const moteMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: MOTE_VS, fragmentShader: MOTE_FS, uniforms: moteUniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }), [moteUniforms]);
  const neb = useRef<THREE.SpriteMaterial[]>([]);
  const starMats = useRef<THREE.PointsMaterial[]>([]);
  useFrame(({ clock }) => {
    const t = clock.elapsedTime;
    // a jump dims the stars (streaks take over) and fades the nebula with the system
    const w = useWarp.getState();
    const lv = warpLevels(w.phase, Date.now() - w.at);
    starMats.current.forEach((m) => m && (m.opacity = 0.9 * (1 - 0.75 * lv.warp)));
    neb.current.forEach((m, i) => m && (m.opacity = (0.05 + Math.min(0.12, busy.current * 0.025) + 0.015 * Math.sin(t * 0.4 + i * 2)) * nebK * (1 - lv.away)));
    moteUniforms.uTime.value = t;
    moteUniforms.uBusy.value = Math.min(3, busy.current);
  });
  const bodies = useMemo(() => ({ moons: space.moons, rings: space.rings, belts: space.belts, clouds: space.clouds, cities: space.cities, suns: space.suns, bright: BRIGHT_K[space.brightness] }), [space]);
  return (
    <group>
      {layers.map((l, i) => (
        <points key={i} geometry={l.g}>
          <pointsMaterial ref={(m) => void (m && (starMats.current[i] = m))} color={l.col} vertexColors size={l.size} transparent opacity={0.9} />
        </points>
      ))}
      {nebK > 0 && systems ? <Nebula key={`nebula:${system.seed}`} system={system} strength={nebK} busy={busy} /> : null}
      {nebK > 0 && !systems
        ? nebula.map(([x, y, z, c, s], i) => (
            <sprite key={`${systems ? system.seed : 'classic'}:${i}`} position={[x, y, z]} scale={[s, s, 1]}>
              <spriteMaterial ref={(m) => void (m && (neb.current[i] = m))} map={glowTexture()} color={c} transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} />
            </sprite>
          ))
        : null}
      {space.motes && !lowFx ? <points geometry={moteGeo} material={moteMat} /> : null}
      {systems ? <Bodies key={`bodies:${system.seed}`} system={system} lowFx={lowFx} o={bodies} /> : null}
      {systems ? <Hyperspace lowFx={lowFx} /> : null}
    </group>
  );
}

// ---------------------------------------------------------------------------- agent orb
export type OrbProps = {
  id: string;
  pos: THREE.Vector3;
  color: string;
  isMain: boolean;
  /** the session this orb is in: its main orb shows voice only when it's that session being read aloud or talked to */
  sessionId: string;
  thinking: boolean;
  running: boolean;
  alert: boolean;
  lastActivity: number;
  bornAt: number;
  diedAt: number | null;
  /** fly out from here when born recently (subagents bud off main) */
  spawnFrom: THREE.Vector3 | null;
  lowFx: boolean;
  reg: LabelRegistry;
  world: WorldRegistry;
  picker: Picker;
  /** tool calls in flight (more and taller spikes) */
  busy: number;
  /** world-registry key of what the latest call is aimed at: the spikes lean toward it */
  targetKey: string | null;
  /** where the orb registers its event API (ripples, shiver, squash) for the scene's one-shot effects */
  api: Map<string, OrbApi>;
};

/** One-shot reactions the scene triggers when it sees an event. Directions are world-space. */
export type OrbApi = { ripple(dir: THREE.Vector3, amp: number): void; shiver(): void; squash(): void };

const FLIGHT_MS = 1200;
const RIPPLES = 6;

export function Orb(p: OrbProps) {
  const r = p.isMain ? ORB_R.main : ORB_R.sub;
  const c = useMemo(() => new THREE.Color(p.color), [p.color]);
  const group = useRef<THREE.Group>(null);
  /** the visuals: bob and scale apply here, not to `group`, so the label anchors stay still (no 1px text jitter) */
  const body = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.SpriteMaterial>(null);
  const aura = useRef<THREE.SpriteMaterial>(null);
  const vis = useRef(1);
  const k = useRef({ think: 0, work: 0, busy: 0, lean: 0, alert: 0, hover: 0, shiver: 0, squash: 0, clock: Math.random() * 20, listen: 0, speak: 0, ripT: 0, neural: 0, deep: 0, thinkSince: 0 });
  // neuron fires: bright rings racing across the surface while it thinks
  const fires = useRef<Array<{ dir: THREE.Vector3; age: number }>>([]);
  const ripples = useRef<Array<{ dir: THREE.Vector3; age: number; amp: number }>>([]);
  const uniforms = useMemo(
    () => ({
      uColor: { value: c.clone() }, uTime: { value: 0 }, uThink: { value: 0 }, uEnergy: { value: 0 }, uAlert: { value: 0 }, uVis: { value: 1 },
      uWork: { value: 0 }, uBusy: { value: 0 }, uShiver: { value: 0 }, uLean: { value: 0 }, uFerro: { value: 0 }, uTarget: { value: new THREE.Vector3(1, 0, 0) },
      uRipDir: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector3(1, 0, 0)) }, uRipAge: { value: new Array(RIPPLES).fill(-1) }, uRipAmp: { value: new Array(RIPPLES).fill(0) },
      uNeural: { value: 0 }, uDeep: { value: 0 }, uFireDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0, 0)) }, uFireAge: { value: new Array(6).fill(-1) },
    }),
    [c],
  );
  // built here, not via <shaderMaterial uniforms>: R3F copies that prop, so per-frame writes would be lost
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: FLUID_VS, fragmentShader: ORB_FS, uniforms, toneMapped: false }), [uniforms]);
  useEffect(() => () => mat.dispose(), [mat]);
  useEffect(() => {
    const api: OrbApi = {
      ripple: (dir, amp) => {
        ripples.current.push({ dir: dir.clone().normalize(), age: 0, amp });
        if (ripples.current.length > RIPPLES) ripples.current.shift();
      },
      shiver: () => void (k.current.shiver = 1),
      squash: () => void (k.current.squash = 1),
    };
    p.api.set(p.id, api);
    return () => void (p.api.get(p.id) === api && p.api.delete(p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id, p.api]);
  const scratch = useMemo(() => ({ q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3() }), []);
  const flight = useMemo(() => {
    if (!p.spawnFrom || Date.now() - p.bornAt > FLIGHT_MS) return null;
    return { from: p.spawnFrom.clone(), ctrl: p.spawnFrom.clone().add(p.pos).multiplyScalar(0.5).add(new THREE.Vector3(0, 2.4, 3)) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const target: PickTarget = useMemo(() => ({ kind: 'agent', id: p.id }), [p.id]);

  useFrame(({ clock, camera }, dt) => {
    const t = clock.elapsedTime;
    const now = Date.now();
    const s = k.current;
    // voice (main only, and only this session's): listening and speaking
    s.listen += ((p.isMain && voiceLevels.listening && voiceLevels.listenFor === p.sessionId ? 1 : 0) - s.listen) * Math.min(1, dt * 5);
    s.speak += ((p.isMain && voiceLevels.speaking && voiceLevels.speakFor === p.sessionId ? 1 : 0) - s.speak) * Math.min(1, dt * 5);
    const energy = Math.max(0, 1.2 * Math.exp(-(now - p.lastActivity) / 1500));
    const born = Math.min(1, (now - p.bornAt) / 700);
    const die = p.diedAt ? Math.min(1, (now - p.diedAt) / 1600) : 0;
    vis.current = (0.2 + 0.8 * born) * (1 - die);
    s.think += ((p.thinking ? 1 : 0) - s.think) * Math.min(1, dt * 4);
    s.work += ((p.running ? 1 : 0) - s.work) * Math.min(1, dt * 3);
    s.busy += (Math.min(3, p.busy) - s.busy) * Math.min(1, dt * 3);
    s.alert += ((p.alert ? 1 : 0) - s.alert) * Math.min(1, dt * 6);
    s.shiver *= Math.pow(0.05, dt);
    s.squash *= Math.pow(0.02, dt);
    // needs you: the fluid stops dead (its clock freezes) until answered
    const frozen = s.alert > 0.5;
    s.clock += dt * (1 - s.alert * 0.98);
    s.hover += ((p.picker.isHovered(target) ? 1 : 0) - s.hover) * Math.min(1, dt * 10);
    let scale = (0.6 + 0.4 * (1 - Math.pow(1 - born, 3))) * (1 - die * 0.6);
    if (group.current) {
      const fu = flight ? Math.min(1, (now - p.bornAt) / FLIGHT_MS) : 1;
      if (flight && fu < 1) {
        const e = fu < 0.5 ? 4 * fu * fu * fu : 1 - Math.pow(-2 * fu + 2, 3) / 2;
        bez(flight.from, flight.ctrl, p.pos, e, group.current.position);
        scale *= 0.45 + 0.55 * e;
        core.current?.scale.set(1 + 0.5 * Math.sin(fu * Math.PI), 1 - 0.25 * Math.sin(fu * Math.PI), 1);
      } else {
        group.current.position.lerp(p.pos, Math.min(1, dt * 5));
        // compaction: squash flat, then spring back
        const sq = s.squash * Math.cos((1 - s.squash) * 9);
        core.current?.scale.set(1 + 0.25 * sq, 1 - 0.35 * sq, 1 + 0.25 * sq);
      }
    }
    if (body.current) {
      body.current.position.y = p.isMain ? Math.sin(t * 0.6) * 0.12 : 0;
      body.current.scale.setScalar(Math.max(0.001, scale * (1 + 0.12 * s.hover)));
    }
    uniforms.uTime.value = s.clock;
    uniforms.uThink.value = p.lowFx ? 0 : s.think;
    // thinking, made visible: the neural layer, with fires more often (and a deeper glow) the longer it thinks
    if (p.thinking && !s.thinkSince) s.thinkSince = now;
    if (!p.thinking) s.thinkSince = 0;
    const long = s.thinkSince ? Math.min(1, (now - s.thinkSince) / 6000) : 0;
    const neural = p.thinking && !p.lowFx;
    s.neural += ((neural ? 1 : 0) - s.neural) * Math.min(1, dt * 2);
    s.deep += ((neural ? long : 0) - s.deep) * Math.min(1, dt);
    if (neural && !frozen && Math.random() < dt * (2.2 + long * 4)) {
      fires.current.push({ dir: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(), age: 0 });
      if (fires.current.length > 6) fires.current.shift();
    }
    for (const f of fires.current) f.age += frozen ? 0 : dt * 1.4;
    fires.current = fires.current.filter((f) => f.age < 1);
    uniforms.uNeural.value = s.neural;
    uniforms.uDeep.value = s.deep;
    for (let i = 0; i < 6; i++) {
      const f = fires.current[i];
      uniforms.uFireAge.value[i] = f ? f.age : -1;
      if (f) uniforms.uFireDir.value[i].copy(f.dir);
    }
    // speaking: a ferrofluid speaker, its spikes driven by the voice; listening: ripples land on the side facing you
    uniforms.uWork.value = Math.max(s.work, s.speak * (0.15 + voiceLevels.speak * 1.6));
    uniforms.uBusy.value = Math.max(s.busy, s.speak * voiceLevels.speak * 2.5);
    uniforms.uFerro.value = s.speak;
    uniforms.uColor.value.copy(c).lerp(INDIGO, s.speak * 0.5);
    uniforms.uShiver.value = s.shiver;
    uniforms.uEnergy.value = energy;
    uniforms.uAlert.value = Math.max(s.alert, s.shiver * 0.7);
    uniforms.uVis.value = vis.current + 0.001;
    if (core.current) {
      core.current.rotation.y += dt * (0.15 + s.think * 0.4) * (1 - s.alert);
      // the shader works in the orb's own (rotating) frame: bring world directions into it
      core.current.getWorldQuaternion(scratch.q).invert();
      const tgt = p.targetKey ? p.world.get(p.targetKey) : null;
      s.lean += ((tgt ? 1 : 0) - s.lean) * Math.min(1, dt * 3);
      uniforms.uLean.value = s.lean * (1 - s.speak);
      if (tgt && group.current) {
        tgt.getWorldPosition(scratch.v);
        group.current.getWorldPosition(scratch.w);
        uniforms.uTarget.value.lerp(scratch.v.sub(scratch.w).normalize().applyQuaternion(scratch.q), Math.min(1, dt * 4)).normalize();
      }
      s.ripT -= dt;
      if (s.listen > 0.3 && voiceLevels.listen > 0.06 && s.ripT <= 0 && group.current) {
        group.current.getWorldPosition(scratch.w);
        const toYou = scratch.v.copy(camera.position).sub(scratch.w).normalize();
        toYou.x += (Math.random() - 0.5) * 0.4;
        toYou.y += (Math.random() - 0.5) * 0.4;
        ripples.current.push({ dir: toYou.clone().normalize(), age: 0, amp: 0.04 + voiceLevels.listen * 0.16 });
        if (ripples.current.length > RIPPLES) ripples.current.shift();
        s.ripT = 0.11;
      }
      const rs = ripples.current;
      for (const rp of rs) rp.age += frozen ? 0 : dt;
      ripples.current = rs.filter((rp) => rp.age < 1.2);
      for (let i = 0; i < RIPPLES; i++) {
        const rp = ripples.current[i];
        uniforms.uRipAge.value[i] = rp ? rp.age : -1;
        uniforms.uRipAmp.value[i] = rp ? rp.amp : 0;
        if (rp) uniforms.uRipDir.value[i].copy(rp.dir).applyQuaternion(scratch.q);
      }
    }
    if (halo.current) {
      halo.current.color.copy(c).lerp(RED, Math.max(s.alert, s.shiver * 0.6));
      halo.current.opacity = (0.22 + 0.3 * energy + 0.25 * s.alert + 0.3 * s.listen * voiceLevels.listen + 0.35 * s.speak * voiceLevels.speak) * vis.current;
    }
    if (aura.current) aura.current.opacity = (0.06 + 0.08 * energy) * vis.current;
  });

  return (
    <group
      ref={(g) => {
        group.current = g;
        p.world.set(`agent:${p.id}`, g);
      }}
      position={flight ? flight.from : p.pos}
    >
      <group ref={body}>
        <sprite scale={[r * 10, r * 10, 1]}>
          <spriteMaterial ref={aura} map={glowTexture()} color={c} transparent opacity={0.08} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
        <sprite scale={[r * 5.5, r * 5.5, 1]}>
          <spriteMaterial ref={halo} map={glowTexture()} color={c} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
        <mesh ref={core} material={mat} {...pickHandlers(p.picker, target)}>
          {/* dense enough for the spikes and ripples to read */}
          <sphereGeometry args={[r, p.isMain ? 128 : 96, p.isMain ? 80 : 60]} />
        </mesh>
        {p.isMain && !p.lowFx ? <ThoughtMotes r={r} thinking={p.thinking} color={c} /> : null}
      </group>
      <group ref={anchorRef(p.reg, `${p.id}:tag`)} position={[0, -tagDrop(r, p.isMain), 0]} />
      <group ref={anchorRef(p.reg, `${p.id}:bubble`)} position={p.isMain ? [0, r + 0.45, 0] : [-(r + 0.45), 0.15, 0]} />
      <group ref={anchorRef(p.reg, `${p.id}:side`)} position={[r + 0.5, 0, 0]} />
    </group>
  );
}

/** Thought motes: faint particles spiralling into the orb while it thinks, faster as the think goes on. */
function ThoughtMotes({ r, thinking, color }: { r: number; thinking: boolean; color: THREE.Color }) {
  const N = 120;
  const { pts, geo, mat, ps } = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    const mat = new THREE.PointsMaterial({ size: 0.07, color: color.clone().lerp(new THREE.Color('#ffffff'), 0.55), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
    const ps = Array.from({ length: N }, () => ({ r: r * 2.6 + Math.random() * r * 2.6, th: Math.random() * Math.PI * 2, y: (Math.random() - 0.5) * r * 3, sp: 0.4 + Math.random() * 0.6 }));
    return { pts: new THREE.Points(geo, mat), geo, mat, ps };
  }, [r, color]);
  useEffect(() => () => (geo.dispose(), mat.dispose()), [geo, mat]);
  const k = useRef({ vis: 0, since: 0 });
  useFrame((_, dt) => {
    const s = k.current;
    s.vis += ((thinking ? 1 : 0) - s.vis) * Math.min(1, dt * 1.5);
    if (s.vis < 0.01) return void (pts.visible = false);
    pts.visible = true;
    s.since = thinking ? s.since + dt : 0;
    const deep = Math.min(1, s.since / 6);
    mat.opacity = 0.7 * s.vis;
    const a = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < N; i++) {
      const q = ps[i];
      q.th += dt * q.sp * (0.6 + deep);
      q.r -= dt * (0.35 + deep * 0.6) * q.sp * r;
      q.y *= 1 - dt * 0.4;
      if (q.r < r * 1.05) {
        q.r = r * 2.6 + Math.random() * r * 2.6;
        q.y = (Math.random() - 0.5) * r * 3;
      }
      a.setXYZ(i, Math.cos(q.th) * q.r, q.y * (q.r / (r * 4)), Math.sin(q.th) * q.r * 0.6);
    }
    a.needsUpdate = true;
  });
  return <primitive object={pts} />;
}

// ---------------------------------------------------------------------------- delegation link
export function Link({ from, to, color, alive }: { from: PosFn; to: PosFn; color: string; alive: boolean }) {
  const line = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(40 * 3), 3)), new THREE.LineBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.2), transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false })),
    [color],
  );
  const packets = useRef<Array<THREE.Sprite | null>>([]);
  const v = useMemo(() => ({ A: new THREE.Vector3(), B: new THREE.Vector3(), C: new THREE.Vector3(), P: new THREE.Vector3() }), []);
  useFrame(({ clock }) => {
    const a = from(), b = to();
    line.visible = Boolean(a && b);
    if (!a || !b) return;
    v.A.copy(a);
    v.B.copy(b);
    v.C.copy(v.A).add(v.B).multiplyScalar(0.5).add(new THREE.Vector3(0, 0, 2.5));
    const p = line.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < 40; i++) {
      bez(v.A, v.C, v.B, i / 39, v.P);
      p.setXYZ(i, v.P.x, v.P.y, v.P.z);
    }
    p.needsUpdate = true;
    (line.material as THREE.LineBasicMaterial).opacity = alive ? 0.4 : 0.12;
    const t = clock.elapsedTime;
    packets.current.forEach((s, i) => {
      if (!s) return;
      const u = (t * 0.45 + i / 3) % 1;
      bez(v.A, v.C, v.B, u, s.position);
      (s.material as THREE.SpriteMaterial).opacity = alive ? Math.sin(u * Math.PI) * 0.8 : 0;
    });
  });
  return (
    <group>
      <primitive object={line} />
      {[0, 1, 2].map((i) => (
        <sprite key={i} ref={(s) => void (packets.current[i] = s)} scale={[0.55, 0.55, 1]}>
          <spriteMaterial map={glowTexture()} color={hot(color, 1.6)} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------------------- tool comet
const TN = 20;
const LIFT = new THREE.Vector3(0, 0.8, 5.5);
export function Comet({ from, to, startedAt, endedAt, failed, agentColor, lowFx }: { from: PosFn; to: PosFn; startedAt: number; endedAt: number | null; failed: boolean; agentColor: string; lowFx: boolean }) {
  const { line, trail } = useMemo(() => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(48 * 3), 3)),
      new THREE.LineBasicMaterial({ color: hot('#fbbf24', 1.3), transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TN * 3), 3));
    const cols = new Float32Array(TN * 3);
    for (let k = 0; k < TN; k++) {
      const f = Math.pow(1 - k / (TN - 1), 1.7);
      cols.set([3 * f, 2.2 * f, 0.6 * f], k * 3);
    }
    tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    return { line, trail };
  }, []);
  const head = useRef<THREE.Sprite>(null);
  const v = useMemo(() => ({ A: new THREE.Vector3(), B: new THREE.Vector3(), C: new THREE.Vector3(), P: new THREE.Vector3() }), []);
  const fade = useMemo(() => (failed ? hot('#f87171', 2) : new THREE.Color(agentColor).multiplyScalar(0.9)), [failed, agentColor]);

  useFrame(() => {
    const a = from(), b = to();
    const ok = Boolean(a && b);
    line.visible = ok;
    if (!a || !b) {
      if (head.current) head.current.visible = false;
      trail.visible = false;
      return;
    }
    v.A.copy(a);
    v.B.copy(b);
    v.C.copy(v.A).add(v.B).multiplyScalar(0.5).add(LIFT);
    const p = line.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < 48; i++) {
      bez(v.A, v.C, v.B, i / 47, v.P);
      p.setXYZ(i, v.P.x, v.P.y, v.P.z);
    }
    p.needsUpdate = true;
    const mat = line.material as THREE.LineBasicMaterial;
    const now = Date.now();
    if (endedAt == null) {
      const u = ((now - startedAt) / 900) % 1;
      if (head.current) {
        head.current.visible = true;
        bez(v.A, v.C, v.B, u, head.current.position);
      }
      trail.visible = !lowFx;
      const tp = trail.geometry.attributes.position as THREE.BufferAttribute;
      for (let k = 0; k < TN; k++) {
        bez(v.A, v.C, v.B, Math.max(0, u - k * 0.016), v.P);
        tp.setXYZ(k, v.P.x, v.P.y, v.P.z);
      }
      tp.needsUpdate = true;
    } else {
      const age = (now - endedAt) / 1000;
      if (head.current) head.current.visible = false;
      trail.visible = false;
      mat.color.lerp(fade, 0.08);
      mat.opacity = 0.65 * Math.exp(-age * 1.4) + (age < 9 ? 0.06 : Math.max(0, 0.06 * (10 - age)));
    }
  });
  return (
    <group>
      <primitive object={line} />
      <primitive object={trail} />
      <sprite ref={head} scale={[1.1, 1.1, 1]}>
        <spriteMaterial map={glowTexture()} color="#ffe7a3" transparent opacity={1} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
    </group>
  );
}

// ---------------------------------------------------------------------------- resource node + file droplets
/** Resource colours by type: the radiant's heart, its tint and glow, and where its tubes start. */
export const RESOURCE_COLOR: Record<string, string> = { files: '#fbbf24', shell: '#a78bfa', web: '#2dd4bf', browser: '#38bdf8', mcp: '#f472b6' };
export const resourceColor = (id: string) => RESOURCE_COLOR[id.split(':')[0]] ?? '#94a3b8';

const TILT = 0.35;
const TUBE_SEG = 28;
const TUBE_RAD = 8;

/** A liquid tube from the resource's centre to a droplet, rebuilt each frame (in the resource's frame). */
function makeTube(kindColor: THREE.Color, opColor: string) {
  const n = (TUBE_SEG + 1) * TUBE_RAD;
  const geo = new THREE.BufferGeometry();
  const us = new Float32Array(n);
  const idx: number[] = [];
  for (let i = 0; i <= TUBE_SEG; i++) for (let j = 0; j < TUBE_RAD; j++) us[i * TUBE_RAD + j] = i / TUBE_SEG;
  for (let i = 0; i < TUBE_SEG; i++)
    for (let j = 0; j < TUBE_RAD; j++) {
      const a = i * TUBE_RAD + j, b = i * TUBE_RAD + ((j + 1) % TUBE_RAD), c = (i + 1) * TUBE_RAD + j, d = (i + 1) * TUBE_RAD + ((j + 1) % TUBE_RAD);
      idx.push(a, c, b, b, c, d);
    }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    vertexShader: TUBE_VS,
    fragmentShader: TUBE_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: { uA: { value: kindColor.clone().multiplyScalar(0.9) }, uB: { value: new THREE.Color(opColor) }, uPulse: { value: -1 }, uVis: { value: 1 } },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), Q = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), mid = new THREE.Vector3(), origin = new THREE.Vector3();
  return {
    mesh,
    mat,
    /** `drop` in the resource's frame; `dropR` the droplet's radius (the tube swells into it) */
    update(drop: THREE.Vector3, pulse: number, vis: number, dropR: number) {
      mid.copy(drop).multiplyScalar(0.5).add(new THREE.Vector3(0, -0.1, 0));
      const pos = geo.attributes.position.array as Float32Array, nor = geo.attributes.normal.array as Float32Array;
      for (let i = 0; i <= TUBE_SEG; i++) {
        const u = i / TUBE_SEG;
        bez(origin, mid, drop, u, P);
        bez(origin, mid, drop, Math.min(1, u + 0.01), T).sub(bez(origin, mid, drop, Math.max(0, u - 0.01), Q)).normalize();
        N.crossVectors(T, up);
        if (N.lengthSq() < 1e-4) N.set(1, 0, 0);
        N.normalize();
        B.crossVectors(T, N).normalize();
        // thick leaving the resource, pinched in the middle, swelling into the droplet
        const neck = Math.pow(Math.abs(u - 0.5) * 2, 1.8);
        const r = (0.016 + 0.046 * neck) * (u > 0.5 ? Math.min(1, 0.5 + dropR * 4) : 1);
        for (let j = 0; j < TUBE_RAD; j++) {
          const a = (j / TUBE_RAD) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
          const k = (i * TUBE_RAD + j) * 3;
          const nx = N.x * ca + B.x * sa, ny = N.y * ca + B.y * sa, nz = N.z * ca + B.z * sa;
          pos[k] = P.x + nx * r;
          pos[k + 1] = P.y + ny * r;
          pos[k + 2] = P.z + nz * r;
          nor[k] = nx;
          nor[k + 1] = ny;
          nor[k + 2] = nz;
        }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.normal.needsUpdate = true;
      mat.uniforms.uPulse.value = pulse;
      mat.uniforms.uVis.value = vis;
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/**
 * A file the resource's tools touched: a small drop of the agents' fluid, coloured by the last operation, hanging
 * off the resource on a liquid tube. When it's touched again a pulse runs down the tube and it splashes on arrival.
 */
function Droplet({ res, f, index, total, run, kindColor, world, picker, showSats, cam, reg }: { res: string; f: FileTouch; index: number; total: number; /** among the resource's executing programs: its place and their count */ run?: { i: number; n: number }; kindColor: THREE.Color; world: WorldRegistry; picker: Picker; showSats: boolean; cam: CamState; reg: LabelRegistry }) {
  const mesh = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.SpriteMaterial>(null);
  const k = useRef({ ang: (index * 2.39996) % (Math.PI * 2), flash: 0, count: f.count, hover: 0, pulse: 0, splash: true, born: Date.now(), clock: Math.random() * 20, align: 0, part: 0, kick: 0, run: 0, frame: 0 });
  const hit = useRef<THREE.Mesh>(null);
  const centre = useMemo(() => new THREE.Vector3(), []);
  const rad = 0.75 + index * 0.16;
  const sp = (0.3 + ((index * 37) % 10) / 33) * (index % 2 ? -1 : 1);
  const target: PickTarget = useMemo(() => ({ kind: 'file', res, name: f.name }), [res, f.name]);
  const key = `file:${res}|${f.name}`;
  const uniforms = useMemo(
    () => ({
      uColor: { value: new THREE.Color(dropColor(f)) }, uTime: { value: 0 }, uThink: { value: 0.55 }, uEnergy: { value: 0 }, uAlert: { value: 0 }, uVis: { value: 1 },
      uWork: { value: 0 }, uBusy: { value: 0 }, uShiver: { value: 0 }, uLean: { value: 0 }, uFerro: { value: 0 }, uTarget: { value: new THREE.Vector3(1, 0, 0) },
      uRipDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0, 0)) }, uRipAge: { value: new Array(6).fill(-1) }, uRipAmp: { value: new Array(6).fill(0) },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: FLUID_VS, fragmentShader: ORB_FS, uniforms, toneMapped: false }), [uniforms]);
  const tube = useMemo(() => makeTube(kindColor, dropColor(f)), [kindColor]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => (mat.dispose(), tube.dispose()), [mat, tube]);
  const local = useMemo(() => new THREE.Vector3(), []);
  const ringPos = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ pointer, camera, size: view }, dt) => {
    const s = k.current;
    if (f.count !== s.count) {
      s.count = f.count;
      s.pulse = 0; // a call reached the resource: carry it down the tube
      s.splash = true;
    }
    // a command still running: light keeps flowing down the tube (activity, not progress: nobody knows the end)
    const since = f.program?.runningSince ?? null;
    s.run += ((since != null ? 1 : 0) - s.run) * Math.min(1, dt * 3);
    if (s.pulse < 0 && since != null) {
      s.pulse = 0;
      s.splash = false;
    }
    if (s.pulse >= 0) {
      s.pulse += dt * (since != null ? 1.4 : 2.2);
      if (s.pulse >= 1 && s.splash && s.flash < 0.5) s.flash = 1.5; // it arrives: splash
      if (s.pulse > 1.3) s.pulse = -1;
    }
    // a background command wrote more output: a blink
    const kicked = dropletKick.get(key) ?? 0;
    if (kicked > s.kick) {
      s.kick = kicked;
      s.flash = Math.max(s.flash, 0.9);
    }
    // when the resource is focused, the droplets stop orbiting and settle into a still ring facing the camera;
    // a program whose command is executing leaves the orbit anyway and holds still in front of the shell
    const aligned = cam.focus === `res:${res}`;
    const executing = !aligned && !!run && programRunning(f);
    const settled = aligned || executing;
    s.align += ((settled ? 1 : 0) - s.align) * Math.min(1, dt * 4);
    s.ang += dt * sp * (1 - s.align);
    s.flash *= Math.pow(0.12, dt);
    s.clock += dt;
    s.hover += ((picker.isHovered(target) ? 1 : 0) - s.hover) * Math.min(1, dt * 10);
    // droplets are picked only once their radiant is focused (lined up); until then a click goes to the radiant
    if (hit.current) hit.current.raycast = aligned || executing ? THREE.Mesh.prototype.raycast : () => {};
    // aiming at an unfocused radiant: the droplets part, leaving its centre clear to click
    let near = false;
    if (!aligned && mesh.current?.parent) {
      mesh.current.parent.getWorldPosition(centre).project(camera);
      const dx = ((centre.x - pointer.x) * view.width) / 2;
      const dy = ((centre.y - pointer.y) * view.height) / 2;
      near = Math.hypot(dx, dy) < 70 && centre.z < 1;
    }
    s.part += ((near ? 1 : 0) - s.part) * Math.min(1, dt * 6);
    const grow = Math.min(1, (Date.now() - s.born) / 700);
    // the orbit is tilted; positions are in the resource's frame so the droplet and its tube agree
    const r = rad * (1 + 1.1 * s.part);
    const x = Math.cos(s.ang) * r, y = Math.sin(s.ang) * r * 0.3, z = Math.sin(s.ang) * r;
    local.set(x, y * Math.cos(TILT) - z * Math.sin(TILT), y * Math.sin(TILT) + z * Math.cos(TILT));
    if (s.align > 0.001) {
      // focused: everything in a full ring facing the camera, starting at the top (files and programs alike).
      // An executing program, unfocused: just in front of and below the shell, side by side with any others running.
      if (executing && run) ringPos.set((run.i - (run.n - 1) / 2) * 1.15, -1.05, 1.1);
      else {
        const th = Math.PI / 2 - (index / Math.max(1, total)) * Math.PI * 2;
        const R = (f.program ? 1.15 : 0.85) + Math.min(10, total) * 0.05;
        ringPos.set(Math.cos(th) * R, Math.sin(th) * R, 0.15);
      }
      local.lerp(ringPos, s.align);
    }
    const size = (0.06 + 0.012 * Math.min(8, f.count)) * (1 - Math.pow(1 - grow, 3)) * (1 + 0.25 * s.flash) * (1 + 0.5 * s.hover);
    if (mesh.current) {
      mesh.current.position.copy(local);
      mesh.current.scale.setScalar(Math.max(0.001, size));
      mesh.current.rotation.y += dt * 0.4;
    }
    uniforms.uColor.value.set(dropColor(f));
    // running: the droplet churns, a little harder the longer it goes (a minute to full boil)
    const heat = since != null ? Math.min(1, (Date.now() - since) / 60_000) : 0;
    s.clock += dt * s.run * (1.5 + heat);
    uniforms.uTime.value = s.clock;
    uniforms.uThink.value = 0.55 + 0.4 * s.run;
    uniforms.uWork.value = s.run * (0.35 + 0.45 * heat);
    uniforms.uBusy.value = s.run * (0.4 + 0.6 * heat);
    uniforms.uShiver.value = s.flash * 0.6 + (f.program?.failed ? 0.25 : 0);
    uniforms.uEnergy.value = s.flash * 0.6 + s.run * 0.15;
    if (halo.current) {
      halo.current.color.set(f.program?.failed ? '#f87171' : dropColor(f));
      halo.current.opacity = 0.1 + 0.3 * s.flash + 0.35 * s.hover;
    }
    tube.mat.uniforms.uB.value.set(dropColor(f));
    tube.mesh.visible = showSats;
    s.frame++;
    if (showSats && (s.pulse >= 0 || grow < 1 || (s.align > 0.005 && s.align < 0.995) || (s.frame + index) % 2 === 0)) tube.update(local, s.pulse, Math.min(1, grow * 1.5), size);
  });
  return (
    <>
      <primitive object={tube.mesh} />
      <mesh
        ref={(m) => {
          mesh.current = m;
          if (showSats) world.set(key, m);
          else if (world.get(key) === m) world.delete(key);
        }}
        material={mat}
        visible={showSats}
      >
        <sphereGeometry args={[1, 32, 24]} />
        {/* label anchor, used while the resource is focused */}
        <group ref={anchorRef(reg, `${key}:lbl`)} />
        <sprite scale={[3.2, 3.2, 1]}>
          <spriteMaterial ref={halo} map={glowTexture()} color={dropColor(f)} transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
        {/* a larger invisible hit target: the droplets are small */}
        <mesh ref={hit} {...(showSats ? pickHandlers(picker, target) : {})}>
          <sphereGeometry args={[3, 8, 6]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </mesh>
    </>
  );
}

const LATTICE_GREY = new THREE.Color('#3b4658');

/**
 * A resource node in the right-hand column: a wireframe radiant with a faceted heart in its type's colour. It warms
 * with use (a gentle glow that fades over a minute or so). `hits` is shared with the scene: 1 = a tool is touching
 * this resource right now (pulse), 2 = a tool just finished on it (one big flash, then reset to 0).
 */
export function Resource({ id, pos, files, hits, reg, world, picker, showSats, cam }: { id: string; pos: THREE.Vector3; files: FileTouch[]; hits: React.MutableRefObject<Map<string, number>>; reg: LabelRegistry; world: WorldRegistry; picker: Picker; showSats: boolean; cam: CamState }) {
  const group = useRef<THREE.Group>(null);
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const heart = useRef<THREE.Mesh>(null);
  const glow = useRef<THREE.SpriteMaterial>(null);
  const k = useRef({ flash: 0, hover: 0, warmth: 0, spin: 0.3, push: 0, placed: false });
  const goal = useMemo(() => new THREE.Vector3(), []);
  const target: PickTarget = useMemo(() => ({ kind: 'res', id }), [id]);
  const kind = useMemo(() => new THREE.Color(resourceColor(id)), [id]);
  const heartUniforms = useMemo(() => ({ uColor: { value: kind.clone() }, uFlash: { value: 0 }, uTime: { value: 0 } }), [kind]);
  const heartMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: GEM_VS, fragmentShader: GEM_FS, uniforms: heartUniforms, toneMapped: false }), [heartUniforms]);
  useEffect(() => () => heartMat.dispose(), [heartMat]);
  const tint = useMemo(() => new THREE.Color(), []);
  const flashTint = useMemo(() => new THREE.Color(), []);
  useFrame(({ clock }, dt) => {
    const s = k.current;
    const h = hits.current.get(id) ?? 0;
    if (h > 0) s.flash = Math.max(s.flash, h >= 2 ? 1.5 : 0.45 + 0.3 * Math.sin(clock.elapsedTime * 9));
    if (h >= 2) {
      hits.current.set(id, 0);
      s.warmth = Math.min(1, s.warmth + 0.15); // each finished call warms it a little
    }
    s.flash *= Math.pow(0.18, dt);
    s.warmth *= Math.pow(0.5, dt / 40); // half-life 40 s
    s.hover += ((picker.isHovered(target) ? 1 : 0) - s.hover) * Math.min(1, dt * 10);
    s.spin += ((0.3 + (h === 1 ? 1.2 : 0) + s.flash * 2) - s.spin) * Math.min(1, dt * 3);
    const f = s.flash;
    // the lattice is tinted by the resource's type, brighter when warm, and flashes in its colour
    tint.copy(LATTICE_GREY).lerp(kind, 0.35).multiplyScalar(1 + 0.3 * s.warmth).add(flashTint.copy(kind).multiplyScalar(f * 1.8));
    // another radiant is focused: make room for it (the nearest move furthest) and step back visually
    let push = 0;
    const fk = cam.focus;
    if (fk?.startsWith('res:') && fk !== `res:${id}`) {
      const fo = world.get(fk);
      if (fo) {
        const dy = pos.y - fo.position.y;
        push = (dy >= 0 ? 1 : -1) * 2.6 * Math.exp(-Math.abs(dy) / 3.2);
      }
    }
    s.push += (push - s.push) * Math.min(1, dt * 4);
    const dim = Math.min(1, Math.abs(s.push) / 1.5);
    mat.current?.color.copy(tint).multiplyScalar(1 - 0.45 * dim);
    if (glow.current) glow.current.opacity = Math.min(1, f * 0.6 + s.warmth * 0.12);
    if (mesh.current) {
      mesh.current.rotation.y += dt * s.spin;
      mesh.current.rotation.x += dt * 0.15;
      mesh.current.scale.setScalar((1 + 0.3 * s.hover) * (1 - 0.25 * dim));
    }
    if (heart.current) {
      heart.current.rotation.y += dt * (0.6 + s.spin);
      heart.current.rotation.x += dt * 0.4;
    }
    heartUniforms.uFlash.value = f * 0.6 + s.warmth * 0.25 + (h === 1 ? 0.25 : 0);
    heartUniforms.uTime.value = clock.elapsedTime;
    goal.copy(pos);
    goal.y += s.push;
    if (group.current) {
      if (!s.placed) {
        group.current.position.copy(goal);
        s.placed = true;
      } else group.current.position.lerp(goal, Math.min(1, dt * 4));
    }
    reg.get(`res:${id}:tag`)?.el?.classList.toggle('hot', f > 0.3);
  });
  return (
    <group
      ref={(g) => {
        group.current = g;
        world.set(`res:${id}`, g);
      }}
      // no position prop: the scene re-renders twice a second and would snap the node back to its slot, undoing
      // the make-room push (a visible loop). The frame loop owns the position.
    >
      <sprite scale={[2.2, 2.2, 1]}>
        <spriteMaterial ref={glow} map={glowTexture()} color={kind} transparent opacity={0} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
      <mesh ref={mesh} {...pickHandlers(picker, target)}>
        <icosahedronGeometry args={[0.36, 0]} />
        <meshBasicMaterial ref={mat} color="#3b4658" wireframe toneMapped={false} />
      </mesh>
      <mesh ref={heart} material={heartMat}>
        <icosahedronGeometry args={[0.1, 0]} />
      </mesh>
      {files.map((f, i) => {
        const running = files.filter(programRunning);
        const ri = running.indexOf(f);
        return <Droplet key={f.name} res={id} f={f} index={i} total={files.length} run={ri >= 0 ? { i: ri, n: running.length } : undefined} kindColor={kind} world={world} picker={picker} showSats={showSats} cam={cam} reg={reg} />;
      })}
      <group ref={anchorRef(reg, `res:${id}:tag`)} position={[showSats && files.length ? 1.1 : 0.55, 0, 0]} />
      {/* the shell's recent commands, shown while it's focused: right of its ring of programs, past the chips that
          open rightward from the ring's right half (the ring's radius is the focused droplets' own, see Droplet) */}
      {id === 'shell' ? <group ref={anchorRef(reg, 'res:shell:cmds')} position={[1.15 + Math.min(10, files.length) * 0.05 + 2.1, 0, 0.15]} /> : null}
    </group>
  );
}
