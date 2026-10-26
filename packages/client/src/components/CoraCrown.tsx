import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { FLUID_VS, ORB_FS } from '../scene/shaders';
import { glowTexture } from '../scene/fx';
import { useBrain } from '../state/store';
import { useOrch } from '../state/orchestrator';
import { isDismissed, sessionColor } from '../lib/format';
import { sortedSessions } from '../lib/sessionOrder';
import { useCoraLinks } from '../lib/coraLinks';

/**
 * What makes Cora's orb Cora's, not one more session's: a crown around the same fluid. Gyroscope rings at their tilts,
 * turning (faster as it works), one for each session (up to three: more share them; none without); your sessions
 * riding them as small orbs of the same fluid in their own colours (working ones pulse, one that needs you glows red
 * and rides in closer); and a soft aura round it, a field it holds. Only Cora's orb wears it.
 */
const RINGS: Array<{ r: number; tilt: [number, number]; speed: number }> = [
  { r: 1.42, tilt: [1.22, 0.18], speed: 0.16 },
  { r: 1.62, tilt: [1.36, -0.42], speed: -0.11 },
  { r: 1.82, tilt: [1.08, 0.55], speed: 0.07 },
];
const MAX_SATS = 9;
const RED = new THREE.Color('#ff6b6b');

type Sat = { id: string; color: string; state: string };

export function CoraCrown({ R, uniforms, color, work }: { R: number; uniforms: Record<string, { value: unknown }>; color: THREE.Color; /** how busy Cora is now (0..1+), read each frame */ work: () => number }) {
  const sessions = useBrain((st) => st.sessions);
  const agent = useOrch((st) => st.status?.sessionId ?? null);
  const sats: Sat[] = useMemo(
    () =>
      sortedSessions(sessions)
        .filter((x) => x.id !== agent && x.state !== 'ended' && !isDismissed(x))
        .slice(0, MAX_SATS)
        .map((x) => ({ id: x.id, color: sessionColor(x), state: x.state })),
    [sessions, agent],
  );
  const satKey = sats.map((s) => `${s.id}:${s.color}`).join('|');

  // each satellite: the orb's own fluid (its clock), in the session's colour, calm (no spikes or ripples of Cora's)
  const mats = useMemo(
    () =>
      sats.map((s) => {
        const own = (v: number) => ({ value: v });
        return new THREE.ShaderMaterial({
          vertexShader: FLUID_VS,
          fragmentShader: ORB_FS,
          uniforms: { ...uniforms, uColor: { value: new THREE.Color(s.color) }, uWork: own(0), uBusy: own(0), uFerro: own(0), uThink: own(0.3), uNeural: own(0), uDeep: own(0), uAlert: own(0), uShiver: own(0), uReach: own(0), uCore: own(0), uEnergy: own(0.45), uRipDir: { value: Array.from({ length: 6 }, () => new THREE.Vector3(0, 0, 1)) }, uRipAge: { value: new Array(6).fill(-1) }, uRipAmp: { value: new Array(6).fill(0) } },
          toneMapped: false,
        });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [satKey, uniforms],
  );
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats]);

  const ringMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }), []);
  useEffect(() => () => ringMat.dispose(), [ringMat]);

  const ringRefs = useRef<Array<THREE.Group | null>>([]);
  const satRefs = useRef<Array<THREE.Mesh | null>>([]);
  const glowRefs = useRef<Array<THREE.SpriteMaterial | null>>([]);
  const angles = useRef<number[]>([]);
  const st = useRef({ spin: 0 });
  const aura = useRef<THREE.SpriteMaterial>(null);
  // the command pulse: a ripple out from the orb when Cora starts directing a session; that session's satellite lit
  const waveRefs = useRef<Array<THREE.Mesh | null>>([]);
  const waves = useRef<number[]>([-1, -1, -1]);
  const lit = useRef<Record<string, number>>({});
  const reaching = useRef<Set<string>>(new Set());
  const waveMat = useMemo(() => [0, 1, 2].map(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, side: THREE.DoubleSide })), []);
  useEffect(() => () => waveMat.forEach((m) => m.dispose()), [waveMat]);
  // a ring for each session (up to three; more share them): none without sessions
  const rings = RINGS.slice(0, Math.min(RINGS.length, sats.length));

  useFrame(({ clock }, dt) => {
    const t = clock.elapsedTime;
    const w = Math.min(1.5, work());
    st.current.spin = st.current.spin + (w - st.current.spin) * Math.min(1, dt * 2);
    const speed = 1 + st.current.spin * 2.2;
    // Cora starting to direct a session (its link turning out): a pulse, and its satellite lit
    const links = useCoraLinks.getState().links;
    for (const [sid, way] of Object.entries(links)) {
      if (way !== 'out' || reaching.current.has(sid)) continue;
      const free = waves.current.findIndex((a) => a < 0);
      waves.current[free < 0 ? 0 : free] = 0;
      lit.current[sid] = 1;
    }
    reaching.current = new Set(Object.keys(links).filter((k) => links[k] === 'out'));
    waves.current.forEach((age, i) => {
      const m = waveRefs.current[i];
      if (!m) return;
      if (age < 0) return void (m.visible = false);
      const a = (waves.current[i] = age + dt / 1.3);
      if (a >= 1) return void ((waves.current[i] = -1), (m.visible = false));
      m.visible = true;
      // (inside the canvas: past its top and bottom it would show a cut)
      m.scale.setScalar(R * (1.05 + a * 0.62));
      waveMat[i].color.copy(color);
      waveMat[i].opacity = 0.55 * (1 - a) * (1 - a);
    });
    ringMat.color.copy(color).lerp(new THREE.Color('#ffffff'), 0.3);
    if (aura.current) {
      aura.current.color.copy(color);
      aura.current.opacity = 0.12 + 0.03 * Math.sin(t * 1.4) + 0.08 * st.current.spin;
    }
    rings.forEach((r, i) => {
      const g = ringRefs.current[i];
      if (g) g.rotation.z += r.speed * dt * speed;
    });
    sats.forEach((s, i) => {
      const m = satRefs.current[i];
      if (!m) return;
      const ring = rings[i % rings.length];
      const busy = s.state === 'working' || s.state === 'thinking';
      const need = s.state === 'needs-you';
      angles.current[i] = (angles.current[i] ?? (i / Math.max(1, sats.length)) * Math.PI * 2 + i * 0.7) + dt * (busy ? 0.5 : need ? 0.15 : 0.22) * speed;
      const a = angles.current[i];
      const rad = ring.r * R * (need ? 0.88 + 0.025 * Math.sin(t * 5) : 1);
      m.position.set(Math.cos(a) * rad, Math.sin(a) * rad, 0);
      const g = glowRefs.current[i];
      const l = (lit.current[s.id] = Math.max(0, (lit.current[s.id] ?? 0) - dt * 0.5));
      if (g) {
        g.color.set(need ? RED : new THREE.Color(s.color));
        g.opacity = (need ? 0.55 + 0.35 * Math.sin(t * 6) : busy ? 0.32 + 0.22 * Math.sin(t * 3 + i) : 0.12) + l * 0.7;
      }
      m.scale.setScalar(R * 0.12 * (1 + l * 0.45));
    });
  });

  return (
    <group>
      {/* a soft aura fading out with no edge (no wider than the canvas lets it: cut off, it would show a line) */}
      <sprite scale={[R * 3.4, R * 3.4, 1]} renderOrder={-1}>
        <spriteMaterial ref={aura} map={glowTexture()} transparent opacity={0.16} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
      {/* the command pulse's ripples (in the screen's plane, out from the orb) */}
      {waveMat.map((mat, i) => (
        <mesh key={`w${i}`} ref={(m) => void (waveRefs.current[i] = m)} material={mat} visible={false}>
          <ringGeometry args={[1, 1.035, 160]} />
        </mesh>
      ))}
      {rings.map((r, i) => (
        <group key={i} rotation={[r.tilt[0], r.tilt[1], 0]}>
          <group ref={(g) => void (ringRefs.current[i] = g)}>
            <mesh material={ringMat}>
              <torusGeometry args={[r.r * R, 0.006, 6, 240]} />
            </mesh>
            {sats.map((s, j) =>
              j % rings.length === i ? (
                <mesh key={s.id} ref={(m) => void (satRefs.current[j] = m)} material={mats[j]} scale={R * 0.12}>
                  <sphereGeometry args={[1, 32, 24]} />
                  <sprite scale={[5, 5, 1]}>
                    <spriteMaterial ref={(g) => void (glowRefs.current[j] = g)} map={glowTexture()} transparent opacity={0.2} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
                  </sprite>
                </mesh>
              ) : null,
            )}
          </group>
        </group>
      ))}
    </group>
  );
}
