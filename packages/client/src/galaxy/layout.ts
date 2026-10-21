/** Galaxy overview layout: sessions cluster by working directory, clusters sit on a ring around the core. */

export type Placed = { x: number; z: number };
/** A folder's cluster: its folder's name, its centre, how far its members sit from it, and where its name goes. */
export type ClusterInfo = { key: string; label: string; x: number; z: number; r: number; labelAt: Placed; members: string[] };

/** Directory key for clustering: case- and slash-insensitive, no trailing separator. */
export const dirKey = (cwd: string) => cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** A cluster's name: its folder's, the last part of the path ("C:\code\orion-api" → "orion-api"). */
export const folderName = (cwd: string) => cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;

/** How far a cluster's members sit from its centre: far enough apart for their names not to collide. */
export const clusterRadius = (n: number) => (n > 1 ? Math.min(5, Math.max(3, 1.7 + n * 0.35)) : 0);

/** Stable 0..1 hash, so positions don't reshuffle between renders. */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Clusters ordered by key (stable as sessions come and go), spaced evenly on a ring that grows with the
 * number of clusters; members spaced around their cluster centre, ordered by a stable hash of the session id,
 * starting side by side (along x, across the screen) so a pair's names sit apart. Each cluster is named after its
 * folder (never one session's name), just in front of its members.
 */
export function clusterLayout(items: Array<{ id: string; cwd: string }>): { pos: Map<string, Placed>; clusters: ClusterInfo[]; extent: number } {
  const groups = new Map<string, { label: string; ids: string[] }>();
  for (const it of items) {
    const k = dirKey(it.cwd);
    const g = groups.get(k) ?? { label: folderName(it.cwd), ids: [] };
    g.ids.push(it.id);
    groups.set(k, g);
  }
  const keys = [...groups.keys()].sort();
  const n = keys.length;
  const ringR = n <= 1 ? 0 : Math.max(6, n * 1.6);
  const pos = new Map<string, Placed>();
  const clusters: ClusterInfo[] = [];
  let extent = 4;
  keys.forEach((k, i) => {
    const g = groups.get(k)!;
    const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.3;
    const cx = Math.cos(a) * ringR, cz = Math.sin(a) * ringR;
    const ids = g.ids.slice().sort((x, y) => hash01(x) - hash01(y));
    const rr = clusterRadius(ids.length);
    let front = 0;
    ids.forEach((id, j) => {
      const b = (j / ids.length) * Math.PI * 2;
      pos.set(id, { x: cx + Math.cos(b) * rr, z: cz + Math.sin(b) * rr });
      front = Math.max(front, Math.sin(b) * rr);
    });
    clusters.push({ key: k, label: g.label, x: cx, z: cz, r: rr, labelAt: { x: cx, z: cz + front + 1.9 }, members: ids });
    extent = Math.max(extent, Math.hypot(cx, cz) + rr + 2);
  });
  return { pos, clusters, extent };
}
