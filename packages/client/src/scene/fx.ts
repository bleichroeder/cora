import * as THREE from 'three';

let tex: THREE.CanvasTexture | null = null;

/** Soft radial sprite used for halos, comet heads and nebulae. */
export function glowTexture(): THREE.CanvasTexture {
  if (tex) return tex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.2, 'rgba(255,255,255,.45)');
  gr.addColorStop(0.55, 'rgba(255,255,255,.08)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export const hot = (hex: string, k: number) => new THREE.Color(hex).multiplyScalar(k);

/** Quadratic bezier point. */
export function bez(a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3): THREE.Vector3 {
  const v = 1 - u;
  return out.set(v * v * a.x + 2 * v * u * c.x + u * u * b.x, v * v * a.y + 2 * v * u * c.y + u * u * b.y, v * v * a.z + 2 * v * u * c.z + u * u * b.z);
}
