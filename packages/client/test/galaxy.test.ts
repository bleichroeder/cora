import { describe, expect, it } from 'vitest';
import { clusterLayout, dirKey, folderName } from '../src/galaxy/layout';

describe('dirKey', () => {
  it('ignores case, slash style and trailing separators', () => {
    expect(dirKey('C:\\Code\\Agent-Brain\\')).toBe(dirKey('c:/code/agent-brain'));
  });
});

describe('clusterLayout', () => {
  const s = (id: string, cwd: string) => ({ id, cwd });

  it('one directory: a single cluster at the centre', () => {
    const { pos, clusters } = clusterLayout([s('a', 'C:\\code\\x'), s('b', 'c:/code/x')]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toMatchObject({ x: 0, z: 0, label: 'x' });
    const [pa, pb] = [pos.get('a')!, pos.get('b')!];
    expect(Math.hypot(pa.x - pb.x, pa.z - pb.z)).toBeGreaterThan(2); // members don't overlap
  });

  it('members sit near their cluster centre; clusters are apart', () => {
    const items = [s('a1', 'C:\\p\\a'), s('a2', 'C:\\p\\a'), s('b1', 'C:\\p\\b'), s('c1', 'C:\\p\\c')];
    const { pos, clusters } = clusterLayout(items);
    expect(clusters.map((c) => c.label)).toEqual(['a', 'b', 'c']);
    for (const c of clusters) for (const id of c.members) expect(Math.hypot(pos.get(id)!.x - c.x, pos.get(id)!.z - c.z)).toBeLessThan(5.1);
    const [a, b] = clusters;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(6);
  });

  it('positions are stable when an unrelated session arrives', () => {
    const base = [s('a1', 'C:\\p\\a'), s('b1', 'C:\\p\\b')];
    const before = clusterLayout(base).pos.get('a1');
    const after = clusterLayout([...base, s('b2', 'C:\\p\\b')]).pos.get('a1');
    expect(after).toEqual(before);
  });

  it("names a cluster after its folder, never one of its sessions", () => {
    expect(folderName('C:\\code\\orion-api')).toBe('orion-api');
    expect(folderName('/home/me/orion-api/')).toBe('orion-api');
    const { clusters } = clusterLayout([s('a', 'C:\\code\\orion-api'), s('b', 'C:\\code\\orion-api'), s('c', 'C:\\code\\nimbus-cli')]);
    expect(clusters.map((c) => c.label)).toEqual(['nimbus-cli', 'orion-api']);
  });

  it("keeps a folder's sessions apart, side by side, with the folder's name clear of them", () => {
    const { pos, clusters } = clusterLayout([s('a', 'C:\\code\\orion-api'), s('b', 'C:\\code\\orion-api'), s('c', 'C:\\code\\nimbus-cli')]);
    const [pa, pb] = [pos.get('a')!, pos.get('b')!];
    expect(Math.abs(pa.x - pb.x)).toBeGreaterThanOrEqual(5.9); // across the screen, a name's width apart
    expect(Math.abs(pa.z - pb.z)).toBeLessThan(0.01); // not one behind the other
    const c = clusters.find((x) => x.label === 'orion-api')!;
    for (const id of c.members) expect(c.labelAt.z - pos.get(id)!.z).toBeGreaterThanOrEqual(1.9); // in front of (below) them
  });
});
