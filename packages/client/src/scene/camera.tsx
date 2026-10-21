import { useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WorldRegistry } from './effects';

export const CENTER = new THREE.Vector3(2.2, 0, 0);
/** World-space extent the camera must always show: main (x≈-10) … resource labels (x≈14.5), slots ±6.5. */
const HALF_W = 13.2;
const HALF_H = 7.6;
export const FOV = 38;

export type CamState = {
  yaw: number; pitch: number; dist: number;
  tYaw: number; tPitch: number; tDist: number;
  /** agent the camera is centred on ("agent:<id>" in the world registry), or null for the whole scene */
  focus: string | null;
  look: THREE.Vector3;
  /** offset of the look-at point from the scene centre / focused object, from zooming toward the cursor */
  tPan: THREE.Vector3;
  px: number; py: number;
  /** the last press turned into a drag (so letting go isn't a click on empty space) */
  dragged?: boolean;
};

export const newCam = (): CamState => ({ yaw: 0, pitch: 0, dist: 1, tYaw: 0, tPitch: 0, tDist: 1, focus: null, look: CENTER.clone(), tPan: new THREE.Vector3(), px: 0, py: 0 });

export function resetCam(c: CamState) {
  c.tYaw = 0;
  c.tPitch = 0;
  c.tDist = 1;
  c.focus = null;
  c.tPan.set(0, 0, 0);
}

const _ray = new THREE.Raycaster();
const _plane = new THREE.Plane();
const _hit = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ndc = new THREE.Vector2();
/**
 * Zoom toward the cursor: the world point under it (on the plane through `look`, facing the camera) stays
 * under it while the camera distance scales by `ratio`. Writes the new look-at point into `out`.
 */
export function zoomAnchor(e: WheelEvent, el: HTMLElement, camera: THREE.Camera, look: THREE.Vector3, ratio: number, out: THREE.Vector3): THREE.Vector3 {
  const r = el.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _ray.setFromCamera(_ndc, camera);
  camera.getWorldDirection(_n);
  _plane.setFromNormalAndCoplanarPoint(_n, look);
  if (!_ray.ray.intersectPlane(_plane, _hit)) return out.copy(look);
  return out.copy(look).sub(_hit).multiplyScalar(ratio).add(_hit);
}

/** How far zooming may pan away from centre at a given distance: free when close, none once zoomed back out. */
export const panLimit = (dist: number, full: number, out = 1, span = 0.6) => full * THREE.MathUtils.clamp((out - dist) / span, 0, 1);

/**
 * Fits the layout to the canvas aspect, with pointer parallax and a slow sway. Drag moves the view (like a map),
 * right-drag tilts it a little, the wheel zooms toward the cursor, a focused object becomes the look-at point;
 * double-click (or Esc when focused) resets.
 */
export function Rig({ cam, world }: { cam: CamState; world: WorldRegistry }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  useEffect(() => {
    const base = new THREE.Vector3();
    const next = new THREE.Vector3();
    const baseOf = () => {
      const f = cam.focus ? world.get(cam.focus) : null;
      return f ? f.getWorldPosition(base) : base.copy(CENTER);
    };
    const el = gl.domElement;
    let down: { x: number; y: number; yaw: number; pitch: number; pan: THREE.Vector3; tilt: boolean; moved: boolean } | null = null;
    const right = new THREE.Vector3(), up = new THREE.Vector3();
    const onDown = (e: PointerEvent) => {
      // left (or middle) moves the view; right, or Shift+left, tilts it
      down = { x: e.clientX, y: e.clientY, yaw: cam.tYaw, pitch: cam.tPitch, pan: cam.tPan.clone(), tilt: e.button === 2 || e.shiftKey, moved: false };
      cam.dragged = false;
    };
    const onMove = (e: PointerEvent) => {
      if (!down || !(e.buttons & 7)) return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (!down.moved && Math.hypot(dx, dy) < 5) return;
      down.moved = true;
      cam.dragged = true;
      if (down.tilt) {
        cam.tYaw = THREE.MathUtils.clamp(down.yaw - dx * 0.004, -0.7, 0.7);
        cam.tPitch = THREE.MathUtils.clamp(down.pitch + dy * 0.003, -0.4, 0.4);
      } else {
        // the point under the cursor follows it: world units per pixel at the look-at depth
        const depth = camera.position.distanceTo(cam.look);
        const perPx = (2 * Math.tan(((FOV / 2) * Math.PI) / 180) * depth) / Math.max(1, el.clientHeight);
        right.setFromMatrixColumn(camera.matrixWorld, 0);
        up.setFromMatrixColumn(camera.matrixWorld, 1);
        cam.tPan.copy(down.pan).addScaledVector(right, -dx * perPx).addScaledVector(up, dy * perPx).clampLength(0, 16);
      }
      el.style.cursor = 'grabbing';
    };
    const onUp = () => {
      down = null;
      el.style.cursor = '';
    };
    // right-drag tilts: no context menu over the scene
    const onMenu = (e: MouseEvent) => e.preventDefault();
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const d = THREE.MathUtils.clamp(cam.tDist * Math.exp(e.deltaY * 0.001), 0.4, 1.35);
      // keep the point under the cursor where it is (the look target moves with the zoom)
      baseOf();
      zoomAnchor(e, el, camera, next.copy(base).add(cam.tPan), d / cam.tDist, next);
      // the view stays where you moved it (double-click recentres)
      cam.tPan.subVectors(next, base).clampLength(0, 16);
      cam.tDist = d;
    };
    const onDbl = () => resetCam(cam);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== 'Escape' || !cam.focus || t?.closest('input, textarea, select, [contenteditable], .xterm')) return;
      resetCam(cam);
    };
    window.addEventListener('keydown', onKey);
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('dblclick', onDbl);
    el.addEventListener('contextmenu', onMenu);
    return () => {
      el.removeEventListener('contextmenu', onMenu);
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('dblclick', onDbl);
      window.removeEventListener('keydown', onKey);
    };
  }, [gl, cam, camera, world]);

  const target = new THREE.Vector3();
  useFrame(({ camera, pointer, clock, size }, dt) => {
    const k = Math.min(1, dt * 3);
    cam.px += (pointer.x - cam.px) * k;
    cam.py += (pointer.y - cam.py) * k;
    const f = cam.focus ? world.get(cam.focus) : null;
    if (cam.focus && !f) resetCam(cam);
    if (f) f.getWorldPosition(target);
    else target.copy(CENTER);
    target.add(cam.tPan);
    cam.yaw += (cam.tYaw - cam.yaw) * k;
    cam.pitch += (cam.tPitch - cam.pitch) * k;
    cam.dist += (cam.tDist - cam.dist) * k;
    cam.look.lerp(target, k);
    const t = Math.tan(((FOV / 2) * Math.PI) / 180);
    const aspect = size.width / Math.max(1, size.height);
    // a narrow view (the browser docked beside it) gets a little side margin: labels are screen-sized, so they
    // reach further past the orbs when the scene is small
    const halfW = HALF_W * (1 + 0.3 * Math.min(1, Math.max(0, (1.6 - aspect) / 1.0)));
    const fit = Math.max(HALF_H / t, halfW / (t * aspect)) * cam.dist;
    camera.position.set(
      cam.look.x + Math.sin(cam.yaw) * Math.cos(cam.pitch) * fit + cam.px * 2.2 + Math.sin(clock.elapsedTime * 0.15) * 0.4,
      cam.look.y - 2.2 * cam.dist + Math.sin(cam.pitch) * fit - cam.py * 1.4,
      cam.look.z + Math.cos(cam.yaw) * Math.cos(cam.pitch) * fit,
    );
    camera.lookAt(cam.look);
  });
  return null;
}
