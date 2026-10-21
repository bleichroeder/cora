import { useEffect, useMemo, useRef, useState } from 'react';
import { GlGuard } from '../components/GlGuard';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import { FAM, type AgentInfo, type BrainEvent, type SessionInfo } from '@cora/shared';
import { sessionEvents, useBrain } from '../state/store';
import { agentColor, currentAction, isDismissed, sessionColor, sessionName } from '../lib/format';
import { sortedSessions } from '../components/SessionRail';
import { InlineMarkdown } from '../components/InlineMarkdown';
import { Icon } from '../components/Icon';
import '../components/overview.css';
import { glowTexture } from '../scene/fx';
import { anchorRef, elRef, LabelProjector, type LabelRegistry } from '../scene/labels';
import { FxLayer, worldPosFn, type Fx, type WorldRegistry } from '../scene/effects';
import { ORB_FS, ORB_VS } from '../scene/shaders';
import { contextMax } from '../scene/derive';
import { clusterLayout, hash01 } from './layout';
import { panLimit, zoomAnchor } from '../scene/camera';

const ENDED_SHOWN_MS = 60 * 60_000;
const MAX_SYSTEMS = 40;
const RED = new THREE.Color('#f87171');

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((x) => x + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

const ago = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`);

type SysView = {
  s: SessionInfo;
  x: number;
  z: number;
  color: string;
  needs: boolean;
  moons: AgentInfo[];
  action: string;
  /** the running tool's icon, tinted by its family */
  icon?: BrainEvent['icon'];
  say: BrainEvent | undefined;
  tools: number;
  context: number | null;
  lastAct: number;
};

function viewOf(s: SessionInfo, x: number, z: number, agents: AgentInfo[], needs: boolean): SysView {
  const events = sessionEvents(s.id);
  let say: BrainEvent | undefined;
  let tools = 0;
  let ctx = 0, peak = 0;
  for (const e of events) {
    if (e.kind === 'say' && e.agentId === 'main') say = e;
    if (e.kind === 'tool' && e.phase === 'start') tools++;
    if (e.agentId === 'main' && e.tokens) {
      ctx = e.tokens.in + e.tokens.out;
      peak = Math.max(peak, ctx);
    }
  }
  const act = currentAction(events);
  return {
    s,
    x,
    z,
    color: sessionColor(s),
    needs,
    moons: agents.filter((a) => a.sessionId === s.id && a.agentId !== 'main' && a.state !== 'done'),
    action: act?.live ? act.text : '',
    icon: act?.live ? act.icon : undefined,
    say,
    tools,
    context: ctx ? ctx / contextMax(s.model, peak) : null,
    lastAct: s.lastTs,
  };
}

// ---------------------------------------------------------------------------- backdrop
function GalaxyBackdrop({ scale }: { scale: number }) {
  const group = useRef<THREE.Group>(null);
  const { dust, stars } = useMemo(() => {
    const n = 9000;
    const p = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const a = new THREE.Color('#38bdf8'), b = new THREE.Color('#a78bfa'), core = new THREE.Color('#fde68a');
    for (let i = 0; i < n; i++) {
      const arm = i % 2, r = Math.pow(Math.random(), 0.7) * 19 + 0.6;
      const ang = arm * Math.PI + r * 0.42 + (Math.random() - 0.5) * 0.7 * (1 + 6 / (r + 1));
      p.set([Math.cos(ang) * r + (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.5 * (1 + 3 / (r + 0.5)), Math.sin(ang) * r + (Math.random() - 0.5) * 1.2], i * 3);
      const c = (r < 3 ? core.clone().lerp(a, r / 3) : a.clone().lerp(b, Math.random())).multiplyScalar(0.5 + Math.random() * 0.5);
      col.set([c.r, c.g, c.b], i * 3);
    }
    const dust = new THREE.BufferGeometry();
    dust.setAttribute('position', new THREE.BufferAttribute(p, 3));
    dust.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const sp = new Float32Array(2500 * 3);
    for (let i = 0; i < 2500; i++) {
      const v = new THREE.Vector3().randomDirection().multiplyScalar(80 + Math.random() * 80);
      sp.set([v.x, v.y, v.z], i * 3);
    }
    const stars = new THREE.BufferGeometry();
    stars.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    return { dust, stars };
  }, []);
  useFrame((_, dt) => {
    if (group.current) group.current.rotation.y -= dt * 0.01;
  });
  return (
    <>
      <points geometry={stars}>
        <pointsMaterial color="#475569" size={0.35} transparent opacity={0.8} />
      </points>
      <group ref={group} scale={[scale, scale, scale]}>
        <points geometry={dust}>
          <pointsMaterial size={0.07} vertexColors transparent opacity={0.55} blending={THREE.AdditiveBlending} depthWrite={false} />
        </points>
        <sprite scale={[9, 9, 1]}>
          <spriteMaterial map={glowTexture()} color="#fde68a" transparent opacity={0.32} blending={THREE.AdditiveBlending} depthWrite={false} />
        </sprite>
        <sprite scale={[22, 22, 1]}>
          <spriteMaterial map={glowTexture()} color="#f472b6" transparent opacity={0.07} blending={THREE.AdditiveBlending} depthWrite={false} />
        </sprite>
      </group>
    </>
  );
}

// ---------------------------------------------------------------------------- star system
function Moon({ a, index }: { a: AgentInfo; index: number }) {
  const mesh = useRef<THREE.Mesh>(null);
  const k = useRef({ ang: hash01(a.agentId) * Math.PI * 2, born: Date.now() });
  const r = 1.0 + index * 0.32;
  const sp = 0.8 + hash01(a.agentId + 'sp') * 0.8;
  const tilt = (hash01(a.agentId + 't') - 0.5) * 0.6;
  const c = useMemo(() => new THREE.Color(agentColor(a)), [a]);
  useFrame((_, dt) => {
    const s = k.current;
    s.ang += dt * sp;
    if (!mesh.current) return;
    mesh.current.position.set(Math.cos(s.ang) * r, Math.sin(s.ang) * r * tilt, Math.sin(s.ang) * r);
    mesh.current.scale.setScalar(Math.min(1, (Date.now() - s.born) / 600));
  });
  return (
    <mesh ref={mesh}>
      <sphereGeometry args={[0.15, 16, 12]} />
      <meshBasicMaterial color={c.clone().multiplyScalar(1.6)} toneMapped={false} />
      <sprite scale={[6, 6, 1]}>
        <spriteMaterial map={glowTexture()} color={c} transparent opacity={0.6} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
      </sprite>
    </mesh>
  );
}

function Star({ v, hovered, onHover, onPick, world, reg, born }: { v: SysView; hovered: boolean; onHover(id: string | null): void; onPick(id: string): void; world: WorldRegistry; reg: LabelRegistry; born: number }) {
  const group = useRef<THREE.Group>(null);
  const body = useRef<THREE.Group>(null);
  const core = useRef<THREE.Mesh>(null);
  const halo = useRef<THREE.SpriteMaterial>(null);
  const aura = useRef<THREE.SpriteMaterial>(null);
  const c = useMemo(() => new THREE.Color(v.color), [v.color]);
  const uniforms = useMemo(() => ({ uColor: { value: c.clone() }, uTime: { value: 0 }, uThink: { value: 0 }, uEnergy: { value: 0 }, uAlert: { value: 0 }, uVis: { value: 1 } }), [c]);
  // built here, not via <shaderMaterial uniforms>: R3F copies that prop, so per-frame writes would be lost
  const mat = useMemo(() => new THREE.ShaderMaterial({ vertexShader: ORB_VS, fragmentShader: ORB_FS, uniforms, toneMapped: false }), [uniforms]);
  useEffect(() => () => mat.dispose(), [mat]);
  const k = useRef({ think: 0, alert: 0, hover: 0, placed: false });
  const target = useMemo(() => new THREE.Vector3(), []);
  target.set(v.x, 0, v.z);
  const ended = v.s.state === 'ended';
  const seed = hash01(v.s.id);

  useFrame(({ clock }, dt) => {
    const s = k.current;
    const t = clock.elapsedTime;
    const g = group.current;
    if (!g) return;
    if (!s.placed) {
      g.position.copy(target);
      s.placed = true;
    } else g.position.lerp(target, Math.min(1, dt * 1.6));
    s.think += ((v.s.state === 'thinking' ? 1 : 0) - s.think) * Math.min(1, dt * 4);
    s.alert += ((v.needs ? 1 : 0) - s.alert) * Math.min(1, dt * 6);
    s.hover += ((hovered ? 1 : 0) - s.hover) * Math.min(1, dt * 10);
    const energy = ended ? 0 : Math.max(0, 1.1 * Math.exp(-(Date.now() - v.lastAct) / 1400));
    const grow = Math.min(1, (Date.now() - born) / 900);
    if (body.current) {
      body.current.position.y = Math.sin(t * 0.7 + seed * 6) * 0.06;
      body.current.scale.setScalar((ended ? 0.6 : 1) * (1 - Math.pow(1 - grow, 3)) * (1 + 0.15 * s.hover) + 0.001);
    }
    uniforms.uTime.value = t + seed * 50;
    uniforms.uThink.value = s.think;
    uniforms.uEnergy.value = energy;
    uniforms.uAlert.value = Math.min(1, s.alert * (0.85 + 0.25 * Math.sin(t * 6)));
    uniforms.uVis.value = ended ? 0.35 : v.s.state === 'idle' ? 0.75 : 1;
    if (core.current) core.current.rotation.y += dt * (0.15 + s.think * 0.7);
    if (halo.current) {
      halo.current.color.copy(c).lerp(RED, s.alert);
      halo.current.opacity = (ended ? 0.08 : 0.25) + 0.3 * energy + 0.3 * s.alert;
    }
    if (aura.current) aura.current.opacity = ended ? 0.02 : 0.06 + 0.06 * energy;
  });

  return (
    <group
      ref={(g) => {
        group.current = g;
        world.set(`sys:${v.s.id}`, g);
      }}
    >
      <group ref={body}>
        <sprite scale={[7, 7, 1]}>
          <spriteMaterial ref={aura} map={glowTexture()} color={c} transparent opacity={0.06} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
        <sprite scale={[3.2, 3.2, 1]}>
          <spriteMaterial ref={halo} map={glowTexture()} color={c} transparent opacity={0.3} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
        </sprite>
        <mesh ref={core} material={mat}>
          <sphereGeometry args={[0.55, 48, 24]} />
        </mesh>
        {/* a larger invisible hit target */}
        <mesh
          onPointerOver={(e) => {
            e.stopPropagation();
            onHover(v.s.id);
          }}
          onPointerOut={() => onHover(null)}
          onClick={(e) => {
            e.stopPropagation();
            if (e.delta <= 5) onPick(v.s.id);
          }}
        >
          <sphereGeometry args={[0.95, 12, 8]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      </group>
      {v.moons.map((a, i) => (
        <Moon key={a.agentId} a={a} index={i} />
      ))}
      <group ref={anchorRef(reg, `${v.s.id}:tag`)} position={[0, -0.85, 0]} />
      <group ref={anchorRef(reg, `${v.s.id}:bubble`)} position={[0, 0.75, 0]} />
    </group>
  );
}

// ---------------------------------------------------------------------------- camera
type GCam = {
  yaw: number; tYaw: number; elev: number; tElev: number; dist: number; tDist: number; px: number; py: number;
  /** look-at offset from the galaxy centre, from zooming toward the cursor (eased) */
  pan: THREE.Vector3; tPan: THREE.Vector3;
  /** a camera flight: into a star (opening its session) or back out of one (arriving from it) */
  fly: { key: string; start: number; ms: number; inward: boolean } | null;
};

function GalaxyRig({ cam, extent, world }: { cam: GCam; extent: React.MutableRefObject<number>; world: WorldRegistry }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const el = gl.domElement;
    const next = new THREE.Vector3();
    let down: { x: number; y: number; yaw: number; elev: number } | null = null;
    const onDown = (e: PointerEvent) => (down = { x: e.clientX, y: e.clientY, yaw: cam.tYaw, elev: cam.tElev });
    const onMove = (e: PointerEvent) => {
      if (!down || !(e.buttons & 1)) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) < 5) return;
      cam.tYaw = down.yaw - dx * 0.005;
      cam.tElev = THREE.MathUtils.clamp(down.elev + dy * 0.003, 0.25, 1.35);
      el.style.cursor = 'grabbing';
    };
    const onUp = () => {
      down = null;
      el.style.cursor = '';
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = THREE.MathUtils.clamp(cam.tDist * Math.exp(e.deltaY * 0.001), 0.35, 1.5);
      // keep the point under the cursor where it is
      zoomAnchor(e, el, camera, next.copy(cam.tPan), d / cam.tDist, next);
      cam.tPan.copy(next).clampLength(0, panLimit(d, extent.current, 1, 0.65));
      cam.tDist = d;
    };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
    };
  }, [gl, cam, camera, extent]);
  const fitRef = useRef(0);
  const look = useMemo(() => new THREE.Vector3(), []);
  const star = useMemo(() => new THREE.Vector3(), []);
  useFrame(({ camera, pointer, size }, dt) => {
    const k = Math.min(1, dt * 3);
    cam.px += (pointer.x - cam.px) * k;
    cam.py += (pointer.y - cam.py) * k;
    cam.yaw += (cam.tYaw - cam.yaw) * k;
    cam.elev += (cam.tElev - cam.elev) * k;
    cam.dist += (cam.tDist - cam.dist) * k;
    cam.pan.lerp(cam.tPan, k);
    const t = Math.tan(((camera as THREE.PerspectiveCamera).fov / 2) * (Math.PI / 180));
    const aspect = size.width / Math.max(1, size.height);
    const R = extent.current;
    const want = Math.max(R / (t * aspect), (R * Math.sin(cam.elev) + 6.5) / t);
    fitRef.current = fitRef.current ? fitRef.current + (want - fitRef.current) * Math.min(1, dt * 2) : want;
    let fit = fitRef.current * cam.dist;
    const yaw = cam.yaw + cam.px * 0.08;
    const elev = cam.elev - cam.py * 0.04;
    look.copy(cam.pan);
    const f = cam.fly;
    const o = f ? world.get(f.key) : null;
    if (f && o) {
      const u = Math.min(1, Math.max(0, (performance.now() - f.start) / f.ms));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      const towardStar = f.inward ? e : 1 - e;
      o.getWorldPosition(star);
      look.lerp(star, towardStar);
      fit *= 1 - 0.9 * towardStar; // right up to the star
      if (u >= 1 && !f.inward) cam.fly = null;
    }
    camera.position.set(look.x + Math.sin(yaw) * Math.cos(elev) * fit, look.y + Math.sin(elev) * fit, look.z + Math.cos(yaw) * Math.cos(elev) * fit);
    camera.lookAt(look);
  });
  return null;
}

function Beacons({ ids, fx, world }: { ids: string[]; fx: React.MutableRefObject<Fx | null>; world: WorldRegistry }) {
  const last = useRef(0);
  useFrame(() => {
    const now = Date.now();
    if (!ids.length || now - last.current < 1300 || !fx.current) return;
    last.current = now;
    for (const id of ids) fx.current.ripple(worldPosFn(world, `sys:${id}`), '#f87171', 0.8, 4.5, 1800, true);
  });
  return null;
}

// ---------------------------------------------------------------------------- overview
/** Every live session as a star system, clustered by working directory. */
export function Galaxy() {
  useTick(500);
  const sessions = useBrain((s) => s.sessions);
  const agents = useBrain((s) => s.agents);
  const pending = useBrain((s) => s.pending);
  useBrain((s) => s.versions);
  const [lowFx, setLowFx] = useState(false);
  const declined = useRef(false);
  const [hover, setHover] = useState<string | null>(null);
  const reg = useRef<LabelRegistry>(new Map()).current;
  const world = useRef<WorldRegistry>(new Map()).current;
  const fx = useRef<Fx | null>(null);
  const seen = useRef(new Set<string>());
  const firstSeen = useRef(new Map<string, number>());
  const extent = useRef(16);
  const cam = useMemo<GCam>(() => ({ yaw: 0.3, tYaw: 0.3, elev: 0.72, tElev: 0.72, dist: 1, tDist: 1, px: 0, py: 0, pan: new THREE.Vector3(), tPan: new THREE.Vector3(), fly: null }), []);
  const [flash, setFlash] = useState<string | null>(null);
  // arriving from a session: start at its star and pull back to the whole galaxy
  useEffect(() => {
    const from = useBrain.getState().focus;
    if (from) cam.fly = { key: `sys:${from}`, start: performance.now() + 60, ms: 1000, inward: false };
  }, [cam]);
  const tip = useRef<HTMLDivElement>(null);

  const now = Date.now();
  const list = sortedSessions(sessions)
    .filter((s) => !isDismissed(s) && (s.state !== 'ended' || now - s.lastTs < ENDED_SHOWN_MS))
    .slice(0, MAX_SYSTEMS);
  const { pos, clusters, extent: ext } = clusterLayout(list.map((s) => ({ id: s.id, cwd: s.cwd })));
  extent.current = ext;
  const allAgents = Object.values(agents);
  const needIds = new Set(pending.map((p) => p.sessionId));
  const views = list.map((s) => viewOf(s, pos.get(s.id)!.x, pos.get(s.id)!.z, allAgents, s.state === 'needs-you' || needIds.has(s.id)));
  for (const v of views) if (!firstSeen.current.has(v.s.id)) firstSeen.current.set(v.s.id, now - v.s.startedAt < 10_000 ? now : 0);

  // one-shot effects for fresh events (everything is marked seen, so opening the overview doesn't replay history)
  useEffect(() => {
    const f = fx.current;
    const t = Date.now();
    for (const v of views) {
      const at = worldPosFn(world, `sys:${v.s.id}`);
      if (!seen.current.has(`born:${v.s.id}`)) {
        seen.current.add(`born:${v.s.id}`);
        if (f && t - v.s.startedAt < 10_000) {
          f.burst(at, v.color, 70);
          f.ripple(at, '#ffffff', 0.5, 5, 1400, true);
        }
      }
      if (lowFx) continue;
      const events = sessionEvents(v.s.id);
      for (let i = events.length - 1; i >= 0 && i > events.length - 30; i--) {
        const e = events[i];
        if (e.kind !== 'tool' || e.phase !== 'start') continue;
        const key = `t:${e.id}`;
        if (seen.current.has(key)) break;
        seen.current.add(key);
        if (f && t - e.ts < 3000) f.spark(at, FAM[e.icon.family].c);
      }
    }
  });

  const hovered = hover ? views.find((v) => v.s.id === hover) : undefined;
  const multi = clusters.filter((c) => c.members.length > 1);
  // opening a session: fly into its star, flare in its colour, then switch
  const focus = (id: string) => {
    if (cam.fly?.inward) return;
    const s = sessions[id];
    cam.fly = { key: `sys:${id}`, start: performance.now(), ms: 520, inward: true };
    setFlash(s ? sessionColor(s) : '#22d3ee');
    setTimeout(() => useBrain.getState().setFocus(id), 470);
  };

  return (
    <div className={`galaxy${hover ? ' hovering' : ''}`}>
      <GlGuard name="overview">
        {({ key, onCreated }) => (
          <Canvas
            key={key}
            onCreated={onCreated}
            camera={{ position: [0, 14, 18], fov: 40, near: 0.1, far: 500 }}
            dpr={[1, 2]}
            gl={{ antialias: true }}
            onPointerMove={(e) => {
              const el = tip.current;
              if (!el) return;
              const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
              el.style.transform = `translate(${Math.round(Math.min(e.clientX - box.left + 14, box.width - 310))}px, ${Math.round(e.clientY - box.top + 16)}px)`;
            }}
            onPointerLeave={() => setHover(null)}
          >
            <color attach="background" args={['#05070d']} />
            {/* the monitor counts every report, even a run of "fine": only settle on low effects if the frame rate dropped */}
            <PerformanceMonitor flipflops={3} onDecline={() => ((declined.current = true), setLowFx(true))} onIncline={() => setLowFx(false)} onFallback={() => setLowFx(declined.current)} />
            <GalaxyRig cam={cam} extent={extent} world={world} />
            <GalaxyBackdrop scale={Math.max(1, ext / 16)} />
            {views.map((v) => (
              <Star key={v.s.id} v={v} hovered={hover === v.s.id} onHover={setHover} onPick={focus} world={world} reg={reg} born={firstSeen.current.get(v.s.id) ?? 0} />
            ))}
            {/* a cluster label (its folder's name) only where it adds something: a lone session's path is on its card */}
            {multi.map((c) => (
              <group key={c.key} ref={anchorRef(reg, `cl:${c.key}`)} position={[c.labelAt.x, 0, c.labelAt.z]} />
            ))}
            <FxLayer api={fx} />
            <Beacons ids={views.filter((v) => v.needs).map((v) => v.s.id)} fx={fx} world={world} />
            <LabelProjector reg={reg} />
            {!lowFx ? (
              <EffectComposer>
                <Bloom intensity={0.9} luminanceThreshold={0.8} luminanceSmoothing={0.2} mipmapBlur radius={0.6} />
              </EffectComposer>
            ) : (
              <></>
            )}
          </Canvas>
        )}
      </GlGuard>
      <div className="labels">
        {multi.map((c) => (
          <div key={c.key} className="lbl" data-declutter="galaxy" data-side="below" ref={elRef(reg, `cl:${c.key}`)}>
            <div data-box className="cluster-l">{c.label.toUpperCase()}</div>
          </div>
        ))}
        {views.map((v) => {
          const ended = v.s.state === 'ended';
          const status = v.needs ? 'Waiting for you' : ended ? 'ended' : v.s.state === 'idle' ? `idle · ${ago(now - v.lastAct)}` : v.action || v.s.state;
          const icon = v.needs ? { name: 'ShieldAlert', c: 'var(--need)' } : v.action && v.icon ? { name: v.icon.name, c: FAM[v.icon.family].c } : null;
          const bubbleOn = !ended && v.say && now - v.say.ts < 4200;
          return (
            <div key={v.s.id}>
              {/* names keep clear of each other and of their cluster's (the projector's declutter) */}
              <div className="lbl" data-declutter="galaxy" data-side="below" ref={elRef(reg, `${v.s.id}:tag`)}>
                <div data-box className={`sys-tag${ended ? ' ended' : ''}`} onClick={() => focus(v.s.id)}>
                  <div className="nm">
                    {sessionName(v.s)}
                    {v.moons.length ? <span className="badge">{v.moons.length + 1} agents</span> : null}
                  </div>
                  <div className={`st ${v.needs ? 'needs' : v.s.state}${v.action && !v.needs ? ' act' : ''}`}>
                    {icon ? <Icon name={icon.name} size={11} style={{ color: icon.c }} /> : null}
                    <span>{status}</span>
                  </div>
                </div>
              </div>
              <div className="lbl" ref={elRef(reg, `${v.s.id}:bubble`)}>
                <div className={`bubble gx${bubbleOn ? ' on' : ''}`} onClick={() => focus(v.s.id)}>
                  <div className="bubble-text">
                    <InlineMarkdown text={(v.say?.text ?? '').slice(0, 300)} />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        <div className="scene-tip" ref={tip} style={{ display: hovered ? 'block' : 'none' }}>
          {hovered ? (
            <>
              <b>{sessionName(hovered.s)}</b> <span className="d">· {hovered.s.title && hovered.s.title !== sessionName(hovered.s) ? hovered.s.title : hovered.s.cwd}</span>
              <div>{hovered.needs ? <span className="needs-t">needs you</span> : hovered.s.state}{hovered.s.state === 'idle' ? ` · ${ago(now - hovered.lastAct)} ago` : ''}</div>
              <div className="d">
                {hovered.moons.length + 1} agent{hovered.moons.length ? 's' : ''} · {hovered.tools} tool calls{hovered.context != null ? ` · context ${Math.round(hovered.context * 100)}%` : ''}
              </div>
              {hovered.say?.text ? <div className="say-t">{hovered.say.text.slice(0, 220)}</div> : null}
              <div className="d">click to open</div>
            </>
          ) : null}
        </div>
        {!views.length ? <div className="galaxy-empty">No live sessions.</div> : null}
        {flash ? <div className="gx-flash" style={{ ['--c' as any]: flash }} /> : null}
      </div>
    </div>
  );
}
