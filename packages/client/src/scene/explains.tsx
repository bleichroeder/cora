import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { anchorRef, type LabelRegistry } from './labels';
import type { PosFn } from './effects';
import { pickHandlers, type PickTarget, type Picker } from './parts';

/**
 * The session's explains in the scene. A new one rises out of main as
 * the design language's card (a dark panel, a hairline, its title), holds a moment, then settles toward the dock under
 * main, where the explains are titled pills (labels, drawn by the scene's label layer at the `shelf` anchor).
 */

export type ShelfItem = { id: string; title: string; format: 'markdown' | 'html'; ts: number };

export const SHELF_MAX = 8;
/** How many pills the dock shows (the rest: "+N more"). */
export const DOCK_PILLS = 4;
const RISE_MS = 520, HOLD_MS = 2300, DOCK_MS = 2900;
/** The dock sits under main (Anthropic has the space above it). */
const SHELF = { x: -9.4, y: -4.4 };
const easeOut = (u: number) => 1 - Math.pow(1 - u, 3);

/** The card: the language's panel, a tile with a document glyph, the title, a mono line, a few quiet lines. */
function cardTexture(title: string, format: string): THREE.CanvasTexture {
  const W = 1040, H = 400;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  // the panel and its inset hairline
  g.fillStyle = 'rgba(17, 21, 29, 0.96)';
  g.beginPath();
  g.roundRect(4, 4, W - 8, H - 8, 46);
  g.fill();
  g.strokeStyle = 'rgba(148, 163, 184, 0.22)';
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(6, 6, W - 12, H - 12, 44);
  g.stroke();
  // the tile, with a document glyph
  g.fillStyle = '#161b25';
  g.beginPath();
  g.roundRect(48, 48, 116, 116, 30);
  g.fill();
  g.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  g.lineWidth = 3;
  g.stroke();
  g.strokeStyle = '#a4afbf';
  g.lineWidth = 7;
  g.lineJoin = 'round';
  g.beginPath();
  g.roundRect(78, 80, 56, 40, 6);
  g.moveTo(94, 136);
  g.lineTo(118, 136);
  g.moveTo(106, 120);
  g.lineTo(106, 136);
  g.stroke();
  // the title and its line
  const fit = (t: string, max: number) => {
    if (g.measureText(t).width <= max) return t;
    let s = t;
    while (s.length > 1 && g.measureText(`${s}…`).width > max) s = s.slice(0, -1);
    return `${s}…`;
  };
  g.fillStyle = '#e6ebf2';
  g.font = "600 52px 'Figtree Variable', Figtree, system-ui, sans-serif";
  g.fillText(fit(title, W - 250), 196, 104);
  g.fillStyle = '#465061';
  g.font = "500 34px 'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace";
  g.fillText(`explain · ${format === 'html' ? 'HTML' : 'markdown'}`, 196, 156);
  // a few quiet lines (its content, sketched)
  g.fillStyle = '#161b25';
  for (const [i, w] of [0.9, 0.74, 0.82].entries()) {
    g.beginPath();
    g.roundRect(196, 214 + i * 46, (W - 260) * w, 18, 9);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** The bundled fonts, once loaded (the card is drawn again in them). */
function useFonts(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => live && setN(1));
    return () => {
      live = false;
    };
  }, []);
  return n;
}

/** A new explain's card: out of main, a moment in view, then to the dock (where it becomes a pill). */
function Card({ item, origin, picker }: { item: ShelfItem; origin: PosFn; picker: Picker }) {
  const group = useRef<THREE.Group>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const fonts = useFonts();
  const tex = useMemo(() => cardTexture(item.title, item.format), [item.title, item.format, fonts]);
  useEffect(() => () => tex.dispose(), [tex]);
  const target: PickTarget = useMemo(() => ({ kind: 'explain', id: item.id }), [item.id]);
  const [done, setDone] = useState(false);
  const k = useRef({ hover: 0, rise: new THREE.Vector3(), dock: new THREE.Vector3(SHELF.x + 1.3, SHELF.y - 0.2, 0) });
  useFrame((_, dt) => {
    const g = group.current;
    const o = origin();
    if (!g || !o || done) return;
    const s = k.current;
    const age = Date.now() - item.ts;
    if (age >= DOCK_MS) return setDone(true);
    s.hover += ((picker.isHovered(target) ? 1 : 0) - s.hover) * Math.min(1, dt * 10);
    s.rise.copy(o).add(new THREE.Vector3(3.6, 1.1, 1.6));
    let scale = 1;
    let alpha = 1;
    if (age < RISE_MS) {
      const u = easeOut(Math.max(0, age) / RISE_MS);
      g.position.lerpVectors(o, s.rise, u);
      scale = 0.85 + 0.15 * u;
      alpha = u;
    } else if (age < HOLD_MS) {
      g.position.copy(s.rise);
      g.position.y += Math.sin((age - RISE_MS) / 600) * 0.04;
    } else {
      const u = easeOut((age - HOLD_MS) / (DOCK_MS - HOLD_MS));
      g.position.lerpVectors(s.rise, s.dock, u);
      scale = 1 - 0.55 * u;
      alpha = 1 - u;
    }
    g.scale.setScalar(scale * (1 + 0.06 * s.hover));
    if (mat.current) mat.current.opacity = alpha;
  });
  if (done) return null;
  return (
    <group ref={group} scale={0.01}>
      <mesh {...pickHandlers(picker, target)}>
        <planeGeometry args={[2.6, 1.0]} />
        <meshBasicMaterial ref={mat} map={tex} transparent opacity={0} depthWrite={false} toneMapped={false} />
      </mesh>
    </group>
  );
}

/** The session's explains: a card for each one made while you watch; the dock's anchor (its pills are labels). */
export function ExplainShelf({ items, origin, picker, reg }: { items: ShelfItem[]; origin: PosFn; picker: Picker; reg: LabelRegistry }) {
  // only explains made just now rise; the rest are already in the dock
  const fresh = items.filter((it) => Date.now() - it.ts < DOCK_MS);
  return (
    <group>
      {fresh.map((it) => (
        <Card key={it.id} item={it} origin={origin} picker={picker} />
      ))}
      {items.length ? <group ref={anchorRef(reg, 'shelf')} position={[SHELF.x - 0.45, SHELF.y + 0.55, 0]} /> : null}
    </group>
  );
}
