import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';

/**
 * Scene labels are plain DOM in one overlay (no per-label React roots). 3D components register anchor
 * objects; overlay elements register by the same key; a projector moves each element to its anchor's
 * screen position every frame.
 */
export type LabelRegistry = Map<string, { obj?: THREE.Object3D | null; el?: HTMLElement | null }>;

// Stable ref callbacks per key: a new callback on every render would detach and re-attach each label.
const refCache = new WeakMap<LabelRegistry, Map<string, (x: any) => void>>();
function cached(reg: LabelRegistry, key: string, make: () => (x: any) => void) {
  let m = refCache.get(reg);
  if (!m) refCache.set(reg, (m = new Map()));
  let fn = m.get(key);
  if (!fn) m.set(key, (fn = make()));
  return fn;
}

export function anchorRef(reg: LabelRegistry, key: string) {
  return cached(reg, `a:${key}`, () => (obj: THREE.Object3D | null) => {
    const e = reg.get(key) ?? {};
    e.obj = obj;
    reg.set(key, e);
  });
}

export function elRef(reg: LabelRegistry, key: string) {
  return cached(reg, `e:${key}`, () => (el: HTMLElement | null) => {
    const e = reg.get(key) ?? {};
    e.el = el;
    reg.set(key, e);
  });
}

const v = new THREE.Vector3();
/** Counts projector frames (per-frame caches below are keyed by it). */
let frameNo = 0;

/**
 * Brings an anchor's world matrix up to date with this frame's movement (the rig, a bobbing droplet), computing
 * each ancestor once per frame however many labels hang off it. Last frame's matrices would leave the labels a
 * frame behind the scene, which shows as jitter whenever the camera drifts.
 */
const fresh = new WeakMap<THREE.Object3D, number>();
function updateWorld(obj: THREE.Object3D) {
  if (fresh.get(obj) === frameNo) return;
  fresh.set(obj, frameNo);
  if (obj.parent) updateWorld(obj.parent);
  if (obj.matrixAutoUpdate) obj.updateMatrix();
  if (obj.parent) obj.matrixWorld.multiplyMatrices(obj.parent.matrixWorld, obj.matrix);
  else obj.matrixWorld.copy(obj.matrix);
}

/**
 * A label box's size, measured at most every few frames: reading offsetWidth right after moving labels forces the
 * browser to lay the page out again, every frame, for every box.
 */
const sizes = new WeakMap<HTMLElement, { w: number; h: number; at: number }>();
function boxSize(box: HTMLElement): { w: number; h: number } {
  const c = sizes.get(box);
  if (c && frameNo - c.at < 15) return c;
  const s = { w: box.offsetWidth, h: box.offsetHeight, at: frameNo };
  sizes.set(box, s);
  return s;
}

/** A label that keeps clear of the others in its group: its anchor point, and the box it wants beside it. */
export type Placed = { key: string; x: number; y: number; w: number; h: number; /** box's left edge from the anchor (default LABEL_DX) */ dx?: number };

/** Gap kept between decluttered labels, and how far right of its anchor a label sits. */
const GAP = 3;
export const LABEL_DX = 10;
/** Anchors this close in height keep their previous order: bobbing droplets don't make their chips trade places. */
export const SWAP_PX = 10;

/**
 * Where each label of a group goes: just right of its anchor, vertically centred on it, unless that box would
 * overlap one already placed (top to bottom), in which case it moves down until it's clear. Returns each label's
 * vertical offset from its natural place. `prev` is the previous order (key → rank): anchors within SWAP_PX of
 * each other keep it, so small movements don't reshuffle the stack. It's updated with the new order.
 */
export function declutter(items: Placed[], prev?: Map<string, number>): Map<string, number> {
  const rank = (k: string) => prev?.get(k) ?? Infinity;
  const order = [...items].sort((a, b) => (Math.abs(a.y - b.y) < SWAP_PX && rank(a.key) !== rank(b.key) ? rank(a.key) - rank(b.key) : a.y - b.y || a.x - b.x));
  if (prev) {
    prev.clear();
    order.forEach((it, i) => prev.set(it.key, i));
  }
  const placed: Array<{ l: number; r: number; t: number; b: number }> = [];
  const out = new Map<string, number>();
  for (const it of order) {
    const l = it.x + (it.dx ?? LABEL_DX), r = l + it.w;
    let t = it.y - it.h / 2;
    for (let moved = true, guard = 0; moved && guard < 50; guard++) {
      moved = false;
      for (const p of placed) {
        if (l < p.r && r > p.l && t < p.b + GAP && t + it.h > p.t - GAP) {
          t = p.b + GAP;
          moved = true;
        }
      }
    }
    placed.push({ l, r, t, b: t + it.h });
    out.set(it.key, Math.round(t - (it.y - it.h / 2)));
  }
  return out;
}

/** Each declutter group's previous order (kept across frames). */
const lastOrder = new Map<string, Map<string, number>>();

export function LabelProjector({ reg }: { reg: LabelRegistry }) {
  useFrame(({ camera, size }) => {
    frameNo++;
    // the rig moved the camera this frame; its matrices are otherwise only updated when the scene is drawn
    camera.updateMatrixWorld();
    // labels marked data-declutter keep clear of the others in their group (the shell's program chips, the agents' names)
    const groups = new Map<string, Array<Placed & { el: HTMLElement }>>();
    for (const [key, entry] of reg) {
      const { obj, el } = entry;
      if (!el) continue;
      if (!obj) {
        if (el.style.visibility !== 'hidden') el.style.visibility = 'hidden';
        if (!el.isConnected) reg.delete(key);
        continue;
      }
      updateWorld(obj);
      v.setFromMatrixPosition(obj.matrixWorld).project(camera);
      // Whole pixels: sub-pixel movement (camera drift, the orb's bob) makes small text shimmer.
      let x = Math.round(((v.x + 1) / 2) * size.width);
      let y = Math.round(((1 - v.y) / 2) * size.height);
      // data-clampl: a box to the right of its anchor, centred on it vertically, that must stay fully on screen
      if (el.dataset.clampl) {
        const box = el.firstElementChild as HTMLElement | null;
        if (box) {
          const { w, h } = boxSize(box);
          const m = 8;
          x = Math.min(x, size.width - w - m);
          y = Math.max(h / 2 + m, Math.min(y, size.height - h / 2 - m));
        }
      }
      // data-clamp: a right-aligned box hanging from its anchor that must stay fully on screen (it slides up/in)
      if (el.dataset.clamp) {
        const box = el.firstElementChild as HTMLElement | null;
        if (box) {
          const { w, h } = boxSize(box);
          const m = 8;
          y = Math.min(y, size.height - h - m);
          x = Math.max(w + m, Math.min(x, size.width - m));
        }
      }
      const pos = `${x},${y}`;
      if ((el.dataset.pos ?? '') !== pos) {
        el.dataset.pos = pos;
        el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      const vis = v.z > 1 ? 'hidden' : 'visible';
      if (el.style.visibility !== vis) el.style.visibility = vis;
      const g = el.dataset.declutter;
      const box = g && vis === 'visible' ? (el.querySelector('[data-box]') as HTMLElement | null) : null;
      if (g && box) {
        const list = groups.get(g) ?? [];
        // data-side="left": the label extends leftward from its anchor (data-dx is then from its right edge);
        // data-side="below": it hangs centred under its anchor (an agent's or a star's name)
        const { w, h } = boxSize(box);
        const dx = el.dataset.dx != null ? Number(el.dataset.dx) : undefined;
        const side = el.dataset.side;
        if (side === 'below') list.push({ key, el, x, y: y + h / 2, w, h, dx: -w / 2 });
        else list.push({ key, el, x, y, w, h, dx: side === 'left' ? -(dx ?? LABEL_DX) - w : dx });
        groups.set(g, list);
      }
    }
    for (const [g, items] of groups) {
      if (!lastOrder.has(g)) lastOrder.set(g, new Map());
      const dy = declutter(items, lastOrder.get(g));
      for (const it of items) {
        const d = dy.get(it.key) ?? 0;
        if (it.el.dataset.dy === String(d)) continue;
        it.el.dataset.dy = String(d);
        it.el.style.setProperty('--dy', `${d}px`);
        // a connector from the anchor to where the label attaches (its left edge, or data-leadx), when it had to move
        const lx = it.el.dataset.leadx != null ? Number(it.el.dataset.leadx) : (it.dx ?? LABEL_DX);
        it.el.style.setProperty('--lead-len', `${Math.hypot(lx, d)}px`);
        it.el.style.setProperty('--lead-ang', `${Math.atan2(d, lx)}rad`);
        it.el.classList.toggle('moved', Math.abs(d) > 2);
      }
    }
  });
  return null;
}
