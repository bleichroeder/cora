import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { glowTexture } from './fx';
import { anchorRef, type LabelRegistry } from './labels';
import type { PosFn, WorldRegistry } from './effects';
import { ANTH_ARM_VS, ANTH_HUB_VS, ORB_FS } from './shaders';

/** Claude's clay. */
export const CLAY = '#d97757';
/** The delegation links' curve: midpoint lifted toward the viewer (as in Link). */
export const LINK_LIFT = new THREE.Vector3(0, 0, 2.5);
/** Where Anthropic sits relative to main: straight above, clear of main's speech bubble. */
export const ANTH_OFFSET = new THREE.Vector3(0, 5.4, 0);
/** The hub's radius; the arms reach about five times further. */
export const ANTH_R = 0.1;
const ANTH_SPAN = 0.62;

/** The spark's rays: twelve, irregular in angle and length like the logo's (fixed, so it keeps its shape). */
const ARMS = Array.from({ length: 12 }, (_, i) => {
  const r = (k: number) => (Math.sin(i * 12.9898 + k * 78.233) * 43758.5453) % 1;
  return { angle: (i / 12) * Math.PI * 2 + 0.17 + Math.abs(r(1)) * 0.22, len: 0.4 + Math.abs(r(2)) * 0.2, seed: Math.abs(r(3)) };
});
function armGeometry() {
  const cap = new THREE.CapsuleGeometry(1, 2, 8, 14);
  const g = new THREE.InstancedBufferGeometry();
  g.index = cap.index;
  g.setAttribute('position', cap.getAttribute('position'));
  g.setAttribute('normal', cap.getAttribute('normal'));
  g.setAttribute('aAngle', new THREE.InstancedBufferAttribute(Float32Array.from(ARMS, (a) => a.angle), 1));
  g.setAttribute('aLen', new THREE.InstancedBufferAttribute(Float32Array.from(ARMS, (a) => a.len), 1));
  g.setAttribute('aSeed', new THREE.InstancedBufferAttribute(Float32Array.from(ARMS, (a) => a.seed), 1));
  g.instanceCount = ARMS.length;
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), ANTH_SPAN * 1.6);
  return g;
}

/**
 * Anthropic: Claude's spark directly above main - a small hub with long, thin, gloopy arms that sway and swell at
 * their tips. Quiet by default; the arms reach further and quicken while calls are in flight, and it brightens a
 * little as replies leave.
 */
export function AnthropicOrb({ pos, inflight, flash, world, reg }: { pos: THREE.Vector3; inflight: React.MutableRefObject<number>; flash: React.MutableRefObject<number>; world: WorldRegistry; reg: LabelRegistry }) {
  const core = useRef<THREE.Group>(null);
  const halo = useRef<THREE.SpriteMaterial>(null);
  const uniforms = useMemo(
    () => ({ uColor: { value: new THREE.Color(CLAY) }, uTime: { value: Math.random() * 20 }, uBusy: { value: 0 }, uThink: { value: 0.35 }, uEnergy: { value: 0 }, uAlert: { value: 0 }, uVis: { value: 1 }, uNeural: { value: 0 }, uDeep: { value: 0 }, uFireDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(1, 0, 0)) }, uFireAge: { value: new Array(6).fill(-1) } }),
    [],
  );
  // built here, not via <shaderMaterial uniforms>: R3F copies that prop, so per-frame writes would be lost
  const hubMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: ANTH_HUB_VS, fragmentShader: ORB_FS, uniforms, toneMapped: false }), [uniforms]);
  const armMat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: ANTH_ARM_VS, fragmentShader: ORB_FS, uniforms, toneMapped: false }), [uniforms]);
  const arms = useMemo(armGeometry, []);
  useEffect(() => () => (hubMat.dispose(), armMat.dispose(), arms.dispose()), [hubMat, armMat, arms]);
  const k = useRef({ busy: 0 });
  useFrame((_, dt) => {
    const s = k.current;
    s.busy += ((inflight.current > 0 ? 1 : 0) - s.busy) * Math.min(1, dt * 2);
    flash.current *= Math.pow(0.15, dt);
    uniforms.uTime.value += dt * (0.6 + 0.8 * s.busy);
    uniforms.uBusy.value = s.busy;
    uniforms.uThink.value = 0.35 + 0.45 * s.busy;
    uniforms.uEnergy.value = flash.current * 0.8;
    if (core.current) core.current.rotation.z += dt * (0.05 + 0.12 * s.busy);
    if (halo.current) halo.current.opacity = 0.1 + 0.12 * s.busy + 0.3 * flash.current;
  });
  return (
    <group position={pos} ref={(g) => void (g ? world.set('anthropic', g) : world.delete('anthropic'))}>
      <sprite scale={[ANTH_SPAN * 3, ANTH_SPAN * 3, 1]}>
        <spriteMaterial ref={halo} map={glowTexture()} color={CLAY} transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
      <group ref={core}>
        <mesh material={hubMat}>
          <sphereGeometry args={[ANTH_R, 32, 24]} />
        </mesh>
        <mesh geometry={arms} material={armMat} frustumCulled={false} />
      </group>
      <group ref={anchorRef(reg, 'anthropic:tag')} position={[ANTH_SPAN + 0.45, 0, 0]} />
    </group>
  );
}

const TN = 20;
/** One looping comet (head + gradient trail) up a straight segment: a call waiting on its reply. */
function WaitComet({ from, to, color, phase }: { from: PosFn; to: PosFn; color: string; phase: number }) {
  const { trail, head } = useMemo(() => {
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TN * 3), 3));
    const c = new THREE.Color(color), cols = new Float32Array(TN * 3);
    for (let i = 0; i < TN; i++) {
      const f = Math.pow(1 - i / (TN - 1), 1.7) * 2.2;
      cols.set([c.r * f, c.g * f, c.b * f], i * 3);
    }
    tg.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    const trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    const head = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color: c.clone().lerp(new THREE.Color('#ffffff'), 0.5), transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    head.scale.set(0.7, 0.7, 1);
    return { trail, head };
  }, [color]);
  useEffect(() => () => (trail.geometry.dispose(), (trail.material as THREE.Material).dispose(), head.material.dispose()), [trail, head]);
  const A = useMemo(() => new THREE.Vector3(), []);
  const B = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const a = from(), b = to();
    trail.visible = head.visible = !!(a && b);
    if (!a || !b) return;
    A.copy(a);
    B.copy(b);
    const u = ((Date.now() / 900) + phase) % 1;
    head.position.copy(A).lerp(B, u);
    const p = trail.geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < TN; i++) {
      const t = Math.max(0, u - i * 0.016);
      p.setXYZ(i, A.x + (B.x - A.x) * t, A.y + (B.y - A.y) * t, A.z + (B.z - A.z) * t);
    }
    p.needsUpdate = true;
  });
  return (
    <>
      <primitive object={trail} />
      <primitive object={head} />
    </>
  );
}

/**
 * Main's uplink to Anthropic: a straight, faint line, lit while calls are in flight, with a comet looping up it for
 * each agent waiting on a reply (in that agent's colour; subagents' calls leave through main too).
 */
export function Uplink({ from, to, waiting }: { from: PosFn; to: PosFn; waiting: Array<{ id: string; color: string }> }) {
  const line = useMemo(
    () => new THREE.Line(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)), new THREE.LineBasicMaterial({ color: new THREE.Color(CLAY).multiplyScalar(1.3), transparent: true, opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false })),
    [],
  );
  useEffect(() => () => (line.geometry.dispose(), (line.material as THREE.Material).dispose()), [line]);
  const n = waiting.length;
  useFrame((_, dt) => {
    const a = from(), b = to();
    line.visible = !!(a && b);
    if (!a || !b) return;
    const p = line.geometry.attributes.position as THREE.BufferAttribute;
    p.setXYZ(0, a.x, a.y, a.z);
    p.setXYZ(1, b.x, b.y, b.z);
    p.needsUpdate = true;
    const m = line.material as THREE.LineBasicMaterial;
    const target = n ? 0.3 + 0.08 * Math.sin(Date.now() / 200) : 0.07;
    m.opacity += (target - m.opacity) * Math.min(1, dt * 4);
  });
  return (
    <>
      <primitive object={line} />
      {waiting.map((w, i) => (
        <WaitComet key={w.id} from={from} to={to} color={w.color} phase={i / Math.max(1, n)} />
      ))}
    </>
  );
}
