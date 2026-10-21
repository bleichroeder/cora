import { useEffect, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { bez, glowTexture } from './fx';

/**
 * Short-lived effects (ripples, sparks, particle streams, report comets) are imperative: the scene fires them
 * when it first sees an event, and they animate and remove themselves. Positions come from functions so an
 * effect follows the agent or file it is attached to.
 */
export type PosFn = () => THREE.Vector3 | null;

/** World positions of live scene objects, by key ("agent:<id>", "res:<id>", "file:<res>|<name>"). */
export type WorldRegistry = Map<string, THREE.Object3D | null>;

export function worldPosFn(reg: WorldRegistry, key: string, fallback?: string): PosFn {
  const v = new THREE.Vector3();
  let known = false;
  return () => {
    const o = reg.get(key) ?? (fallback ? reg.get(fallback) : null);
    if (o) {
      o.getWorldPosition(v);
      known = true;
    }
    return known ? v : null;
  };
}

export type Fx = {
  /** `flat` lays the ring in the XZ plane (the galaxy disc) instead of facing the camera; `arc` draws only part of it */
  ripple(follow: PosFn, color: THREE.ColorRepresentation, r0: number, r1: number, ms?: number, flat?: boolean, arc?: { start: number; length: number }): void;
  /** a short flare flying out of a point (a tool call in the galaxy view) */
  spark(from: PosFn, color: THREE.ColorRepresentation): void;
  burst(at: PosFn, color: THREE.ColorRepresentation, n?: number): void;
  stream(from: PosFn, to: PosFn, n: number, color: THREE.ColorRepresentation, ms: number, lift: THREE.Vector3, onArrive?: () => void): void;
  /** a finished subagent's report flying home; `lift` bends its path like the link it rides (the same curve) */
  report(from: PosFn, to: PosFn, color: THREE.ColorRepresentation, onArrive?: () => void, lift?: THREE.Vector3): void;
  /** one comet with a short trail along a curve (a model call leaving) */
  comet(from: PosFn, to: PosFn, color: THREE.ColorRepresentation, ms: number, lift: THREE.Vector3, onArrive?: () => void, scale?: number): void;
  /** a small, fast payload accelerating in from a point and hitting `to` (your prompt arriving) */
  payload(from: THREE.Vector3, to: PosFn, color: THREE.ColorRepresentation, ms: number, onArrive?: () => void): void;
};

type Actor = { update(now: number, dt: number): boolean; dispose(): void };

const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);
const easeIO = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);

function glowSprite(color: THREE.ColorRepresentation, size: number, opacity: number) {
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
  s.scale.set(size, size, 1);
  return s;
}
const ringGeo = new THREE.RingGeometry(0.94, 1, 96);
/** Part rings (a beacon open where its agent's name hangs), one geometry per arc. */
const arcGeos = new Map<string, THREE.RingGeometry>();
function arcGeo(arc: { start: number; length: number }) {
  const key = `${arc.start.toFixed(4)}|${arc.length.toFixed(4)}`;
  let g = arcGeos.get(key);
  if (!g) arcGeos.set(key, (g = new THREE.RingGeometry(0.94, 1, 96, 1, arc.start, arc.length)));
  return g;
}

export function FxLayer({ api }: { api: React.MutableRefObject<Fx | null> }) {
  const group = useMemo(() => new THREE.Group(), []);
  const actors = useMemo(() => new Set<Actor>(), []);

  useEffect(() => {
    const add = (a: Actor) => void actors.add(a);
    api.current = {
      ripple(follow, color, r0, r1, ms = 1100, flat = false, arc) {
        const at = Date.now();
        const mesh = new THREE.Mesh(arc ? arcGeo(arc) : ringGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(1.8), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
        if (flat) mesh.rotation.x = -Math.PI / 2;
        group.add(mesh);
        add({
          update(now) {
            const u = (now - at) / ms;
            const p = follow();
            if (u >= 1 || !p) return false;
            mesh.position.copy(p);
            mesh.scale.setScalar(r0 + (r1 - r0) * easeOut(u));
            mesh.material.opacity = 0.9 * (1 - u);
            return true;
          },
          dispose: () => (group.remove(mesh), mesh.material.dispose()),
        });
      },
      burst(at, color, n = 40) {
        const start = at();
        if (!start) return;
        const t0 = Date.now();
        const pos = new Float32Array(n * 3);
        const vel = Array.from({ length: n }, (_, i) => (pos.set([start.x, start.y, start.z], i * 3), new THREE.Vector3().randomDirection().multiplyScalar(2 + Math.random() * 3)));
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const pts = new THREE.Points(g, new THREE.PointsMaterial({ color: new THREE.Color(color).multiplyScalar(2), size: 0.13, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
        group.add(pts);
        add({
          update(now, dt) {
            const age = (now - t0) / 1000;
            if (age > 0.9) return false;
            const a = g.attributes.position as THREE.BufferAttribute;
            vel.forEach((v, i) => {
              a.setXYZ(i, a.getX(i) + v.x * dt, a.getY(i) + v.y * dt - 1.5 * dt * age, a.getZ(i) + v.z * dt);
              v.multiplyScalar(Math.pow(0.15, dt));
            });
            a.needsUpdate = true;
            pts.material.opacity = 1 - age / 0.9;
            return true;
          },
          dispose: () => (group.remove(pts), g.dispose(), pts.material.dispose()),
        });
      },
      spark(from, color) {
        const t0 = Date.now();
        const ms = 700;
        const a = Math.random() * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), 0.3 + Math.random() * 0.8, Math.sin(a)).normalize().multiplyScalar(1.3 + Math.random() * 0.9);
        const head = glowSprite(color, 0.5, 1);
        const tail = glowSprite(color, 0.3, 0.5);
        group.add(head, tail);
        add({
          update(now) {
            const u = (now - t0) / ms;
            const o = from();
            if (u >= 1 || !o) return false;
            head.position.copy(o).addScaledVector(dir, easeOut(u));
            tail.position.copy(o).addScaledVector(dir, easeOut(Math.max(0, u - 0.12)));
            head.material.opacity = 1 - u;
            tail.material.opacity = 0.5 * (1 - u);
            return true;
          },
          dispose: () => (group.remove(head, tail), head.material.dispose(), tail.material.dispose()),
        });
      },
      stream(from, to, n, color, ms, lift, onArrive) {
        const t0 = Date.now();
        const sp = Array.from({ length: n }, () => glowSprite(color, 0.3, 0));
        group.add(...sp);
        const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
        add({
          update(now) {
            const a = from(), b = to();
            if (!a || !b) return false;
            A.copy(a);
            B.copy(b);
            C.copy(A).add(B).multiplyScalar(0.5).add(lift);
            let pending = 0;
            sp.forEach((s, i) => {
              const u = (now - t0 - i * 38) / ms;
              if (u <= 1) pending++;
              if (u < 0 || u > 1) return void (s.material.opacity = 0);
              bez(A, C, B, easeIO(u), s.position);
              s.material.opacity = Math.sin(u * Math.PI) * 0.95;
            });
            if (!pending) onArrive?.();
            return pending > 0;
          },
          dispose: () => (group.remove(...sp), sp.forEach((s) => s.material.dispose())),
        });
      },
      comet(from, to, color, ms, lift, onArrive, scale = 1) {
        const t0 = Date.now();
        const c = new THREE.Color(color);
        const head = glowSprite(c.clone().lerp(new THREE.Color('#ffffff'), 0.5), 0.75 * scale, 1);
        const tail = Array.from({ length: 8 }, (_, i) => glowSprite(c, 0.5 * scale * (1 - i / 9), 0.7 * (1 - i / 8)));
        group.add(head, ...tail);
        const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3();
        add({
          update(now) {
            const a = from(), b = to();
            if (!a || !b) return false;
            const u = (now - t0) / ms;
            if (u >= 1) {
              onArrive?.();
              return false;
            }
            A.copy(a);
            B.copy(b);
            C.copy(A).add(B).multiplyScalar(0.5).add(lift);
            const e = easeIO(u);
            bez(A, C, B, e, head.position);
            tail.forEach((t, i) => bez(A, C, B, Math.max(0, e - (i + 1) * 0.022), t.position));
            return true;
          },
          dispose: () => (group.remove(head, ...tail), head.material.dispose(), tail.forEach((t) => t.material.dispose())),
        });
      },
      payload(from, to, color, ms, onArrive) {
        const t0 = Date.now();
        const c = new THREE.Color(color);
        const head = glowSprite(c.clone().lerp(new THREE.Color('#ffffff'), 0.6), 0.6, 1);
        const trail = Array.from({ length: 7 }, (_, i) => glowSprite(c, 0.46 - i * 0.045, 0.8 - i * 0.1));
        group.add(head, ...trail);
        const start = from.clone();
        add({
          update(now) {
            const b = to();
            if (!b) return false;
            const u = (now - t0) / ms;
            if (u >= 1) {
              onArrive?.();
              return false;
            }
            const e = u * u * u; // speeding up into the hit
            head.position.copy(start).lerp(b, e);
            trail.forEach((t, i) => t.position.copy(start).lerp(b, Math.max(0, e - (i + 1) * 0.018 * (0.3 + 2 * u))));
            return true;
          },
          dispose: () => (group.remove(head, ...trail), head.material.dispose(), trail.forEach((t) => t.material.dispose())),
        });
      },
      report(from, to, color, onArrive, lift = new THREE.Vector3(0, 2.2, 3)) {
        const t0 = Date.now();
        const ms = 1300;
        const start = from()?.clone();
        if (!start) return;
        const c = new THREE.Color(color);
        const card = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.32), new THREE.MeshBasicMaterial({ color: c.clone().lerp(new THREE.Color('#ffffff'), 0.5).multiplyScalar(1.6), toneMapped: false }));
        const halo = glowSprite(c, 1.6, 0.8);
        const tail = Array.from({ length: 14 }, (_, i) => glowSprite(c, 0.5 * (1 - i / 14), 0.7 * (1 - i / 14)));
        group.add(card, halo, ...tail);
        const C = new THREE.Vector3();
        add({
          update(now) {
            const u = (now - t0) / ms;
            const end = to();
            if (!end) return false;
            if (u >= 1) {
              onArrive?.();
              return false;
            }
            // both ends live (the orbs keep moving), so it stays on the link between them
            const s = from();
            if (s) start.copy(s);
            C.copy(start).add(end).multiplyScalar(0.5).add(lift);
            bez(start, C, end, easeIO(u), card.position);
            halo.position.copy(card.position);
            card.rotation.z = Math.sin(u * 9) * 0.3;
            tail.forEach((s, i) => bez(start, C, end, easeIO(Math.max(0, u - i * 0.018)), s.position));
            return true;
          },
          dispose: () => (group.remove(card, halo, ...tail), card.geometry.dispose()),
        });
      },
    };
    return () => {
      api.current = null;
      for (const a of actors) a.dispose();
      actors.clear();
    };
  }, [api, group, actors]);

  useFrame((_, dt) => {
    const now = Date.now();
    for (const a of actors) {
      if (!a.update(now, Math.min(dt, 0.05))) {
        a.dispose();
        actors.delete(a);
      }
    }
  });
  return <primitive object={group} />;
}
