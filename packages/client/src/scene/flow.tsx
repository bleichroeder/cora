import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import type { PosFn } from './effects';
import { TUBE_FS, TUBE_VS } from './shaders';

/**
 * Connections as liquid tubes, the way a radiant feeds its droplets: a glassy tube along a curve between two moving
 * points (thick where it leaves and arrives, pinched in the middle) with light pulsing down it while something
 * flows. The prototype alternative to the line-and-comet look (Settings → Scene).
 */

const SEG = 40;
const RAD = 8;
const MAX_PULSES = 6;

/** The tube shader with several coloured pulses at once (the uplink: one per agent waiting on a reply). */
const MULTI_FS = /* glsl */ `uniform vec3 uA; uniform vec3 uB; uniform float uVis; uniform float uP[${MAX_PULSES}]; uniform vec3 uPC[${MAX_PULSES}];
varying float vU; varying vec3 vN; varying vec3 vV;
void main(){
  float facing=abs(dot(normalize(vN),normalize(vV)));
  vec3 col=mix(uA,uB,smoothstep(0.0,1.0,vU));
  float body=0.18+0.55*pow(1.0-facing,1.5);
  vec3 add=vec3(0.0); float al=0.0;
  for(int i=0;i<${MAX_PULSES};i++){ if(uP[i]<0.0) continue; float band=exp(-pow((vU-uP[i])/0.06,2.0)); add+=uPC[i]*band*2.4; al+=band; }
  gl_FragColor=vec4((col*body+add)*uVis,(body*0.9+al)*uVis);
}`;

function bez(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3) {
  const k = 1 - u;
  return out.set(k * k * a.x + 2 * k * u * c.x + u * u * b.x, k * k * a.y + 2 * k * u * c.y + u * u * b.y, k * k * a.z + 2 * k * u * c.z + u * u * b.z);
}

/** A tube from A through control C to B, rebuilt when asked (world space). `thick` scales its radius. */
export function makeFlowTube(colA: THREE.ColorRepresentation, colB: THREE.ColorRepresentation, thick: number, multi = false) {
  const n = (SEG + 1) * RAD;
  const geo = new THREE.BufferGeometry();
  const us = new Float32Array(n);
  const idx: number[] = [];
  for (let i = 0; i <= SEG; i++) for (let j = 0; j < RAD; j++) us[i * RAD + j] = i / SEG;
  for (let i = 0; i < SEG; i++)
    for (let j = 0; j < RAD; j++) {
      const a = i * RAD + j, b = i * RAD + ((j + 1) % RAD), c = (i + 1) * RAD + j, d = (i + 1) * RAD + ((j + 1) % RAD);
      idx.push(a, c, b, b, c, d);
    }
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(us, 1));
  geo.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    vertexShader: TUBE_VS,
    fragmentShader: multi ? MULTI_FS : TUBE_FS,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    uniforms: {
      uA: { value: new THREE.Color(colA) },
      uB: { value: new THREE.Color(colB) },
      uPulse: { value: -1 },
      uVis: { value: 1 },
      ...(multi ? { uP: { value: new Array(MAX_PULSES).fill(-1) }, uPC: { value: Array.from({ length: MAX_PULSES }, () => new THREE.Color()) } } : {}),
    },
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  const P = new THREE.Vector3(), T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), Q = new THREE.Vector3();
  const up = new THREE.Vector3(0, 0, 1), side = new THREE.Vector3(1, 0, 0);
  return {
    mesh,
    mat,
    update(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3) {
      const pos = geo.attributes.position.array as Float32Array, nor = geo.attributes.normal.array as Float32Array;
      for (let i = 0; i <= SEG; i++) {
        const u = i / SEG;
        bez(a, c, b, u, P);
        bez(a, c, b, Math.min(1, u + 0.01), T).sub(bez(a, c, b, Math.max(0, u - 0.01), Q)).normalize();
        N.crossVectors(T, up);
        if (N.lengthSq() < 1e-4) N.crossVectors(T, side);
        N.normalize();
        B.crossVectors(T, N).normalize();
        // thick leaving and arriving, pinched in the middle
        const neck = Math.pow(Math.abs(u - 0.5) * 2, 1.8);
        const r = (0.022 + 0.05 * neck) * thick;
        for (let j = 0; j < RAD; j++) {
          const ang = (j / RAD) * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
          const k = (i * RAD + j) * 3;
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
    },
    dispose() {
      geo.dispose();
      mat.dispose();
    },
  };
}

/** Where a looping pulse is, `period` ms per trip (it runs a little past the end, so trips don't overlap). */
const loop = (ms: number, period: number) => ((ms % period) / period) * 1.3;

/** Whether two points moved since last frame (an idle tube needn't be rebuilt). */
function moved(prev: THREE.Vector3, next: THREE.Vector3) {
  const d = prev.distanceToSquared(next) > 1e-6;
  prev.copy(next);
  return d;
}

/** A delegation (an agent to the subagent it started): a slow pulse runs down it while the subagent works. */
export function FlowLink({ from, to, color, alive }: { from: PosFn; to: PosFn; color: string; alive: boolean }) {
  const tube = useMemo(() => makeFlowTube(new THREE.Color(color).multiplyScalar(0.7), new THREE.Color(color).multiplyScalar(1.2), 1), [color]);
  useEffect(() => () => tube.dispose(), [tube]);
  const v = useMemo(() => ({ A: new THREE.Vector3(), B: new THREE.Vector3(), C: new THREE.Vector3(), pa: new THREE.Vector3(1e9, 0, 0), pb: new THREE.Vector3() }), []);
  const vis = useMemo(() => ({ v: alive ? 1 : 0.3 }), []); // eslint-disable-line react-hooks/exhaustive-deps
  useFrame((_, dt) => {
    const a = from(), b = to();
    tube.mesh.visible = Boolean(a && b);
    if (!a || !b) return;
    v.A.copy(a);
    v.B.copy(b);
    if (moved(v.pa, v.A) || moved(v.pb, v.B)) {
      v.C.copy(v.A).add(v.B).multiplyScalar(0.5).add(new THREE.Vector3(0, 0, 2.5));
      tube.update(v.A, v.C, v.B);
    }
    vis.v += ((alive ? 1 : 0.3) - vis.v) * Math.min(1, dt * 2);
    tube.mat.uniforms.uVis.value = vis.v;
    tube.mat.uniforms.uPulse.value = alive ? loop(performance.now(), 2400) : -1;
  });
  return <primitive object={tube.mesh} />;
}

/** How a tool call's curve bows (the tube, and anything else travelling between the agent and the resource). */
export const COMET_LIFT = new THREE.Vector3(0, 0.8, 5.5);
const LIFT = COMET_LIFT;

/**
 * A tool call from an agent to a resource: while it runs, light keeps pulsing down the tube (activity, not
 * progress); when it ends, its result pulses back up the tube to the agent, then the tube fades (red if it failed,
 * with no result coming back) and lingers faintly a few seconds.
 */
export function FlowComet({ from, to, startedAt, endedAt, failed, agentColor, resColor }: { from: PosFn; to: PosFn; startedAt: number; endedAt: number | null; failed: boolean; agentColor: string; resColor: string }) {
  const tube = useMemo(() => makeFlowTube(new THREE.Color(agentColor).multiplyScalar(0.8), new THREE.Color(resColor).multiplyScalar(1.1), 0.85), [agentColor, resColor]);
  useEffect(() => () => tube.dispose(), [tube]);
  const red = useMemo(() => new THREE.Color('#f87171').multiplyScalar(1.4), []);
  const v = useMemo(() => ({ A: new THREE.Vector3(), B: new THREE.Vector3(), C: new THREE.Vector3(), pa: new THREE.Vector3(1e9, 0, 0), pb: new THREE.Vector3() }), []);
  useFrame(() => {
    const a = from(), b = to();
    tube.mesh.visible = Boolean(a && b);
    if (!a || !b) return;
    v.A.copy(a);
    v.B.copy(b);
    if (moved(v.pa, v.A) || moved(v.pb, v.B)) {
      v.C.copy(v.A).add(v.B).multiplyScalar(0.5).add(LIFT);
      tube.update(v.A, v.C, v.B);
    }
    const now = Date.now();
    const u = tube.mat.uniforms;
    if (endedAt == null) {
      u.uPulse.value = loop(now - startedAt, 1100);
      u.uVis.value = Math.min(1, (now - startedAt) / 250);
    } else {
      const age = (now - endedAt) / 1000;
      // the result travelling back: from the resource end to the agent
      u.uPulse.value = !failed && age < 0.75 ? 1.15 - (age / 0.75) * 1.3 : -1;
      if (failed) (u.uB.value as THREE.Color).lerp(red, 0.1);
      u.uVis.value = 0.9 * Math.exp(-age * 1.4) + (age < 9 ? 0.12 : Math.max(0, 0.12 * (10 - age)));
    }
  });
  return <primitive object={tube.mesh} />;
}

/**
 * Main's uplink to Anthropic: a straight tube, faint while nothing's in flight, with a pulse looping up it for each
 * agent waiting on a reply (in that agent's colour; subagents' calls leave through main too).
 */
export function FlowUplink({ from, to, waiting, clay }: { from: PosFn; to: PosFn; waiting: Array<{ id: string; color: string }>; clay: string }) {
  const tube = useMemo(() => makeFlowTube(new THREE.Color(clay).multiplyScalar(0.6), new THREE.Color(clay).multiplyScalar(1.1), 0.8, true), [clay]);
  useEffect(() => () => tube.dispose(), [tube]);
  const v = useMemo(() => ({ A: new THREE.Vector3(), B: new THREE.Vector3(), C: new THREE.Vector3(), pa: new THREE.Vector3(1e9, 0, 0), pb: new THREE.Vector3(), vis: 0.25 }), []);
  useFrame((_, dt) => {
    const a = from(), b = to();
    tube.mesh.visible = Boolean(a && b);
    if (!a || !b) return;
    v.A.copy(a);
    v.B.copy(b);
    if (moved(v.pa, v.A) || moved(v.pb, v.B)) {
      v.C.copy(v.A).add(v.B).multiplyScalar(0.5);
      tube.update(v.A, v.C, v.B);
    }
    const u = tube.mat.uniforms;
    const n = Math.min(MAX_PULSES, waiting.length);
    const now = Date.now();
    for (let i = 0; i < MAX_PULSES; i++) {
      u.uP.value[i] = i < n ? ((now / 900 + i / Math.max(1, n)) % 1) * 1.1 - 0.05 : -1;
      if (i < n) (u.uPC.value[i] as THREE.Color).set(waiting[i].color).multiplyScalar(1.3);
    }
    v.vis += ((n ? 0.85 : 0.22) - v.vis) * Math.min(1, dt * 4);
    u.uVis.value = v.vis;
  });
  return <primitive object={tube.mesh} />;
}
