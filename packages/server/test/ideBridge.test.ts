import { describe, expect, it } from 'vitest';
import { IdeBridge, folderKey, inFolder } from '../src/ideBridge';

describe('Cora and the IDE panel talking', () => {
  it('folders as both sides write them', () => {
    expect(folderKey('C:\\code\\Cora\\')).toBe('c:/code/cora');
    expect(inFolder('C:\\code\\cora\\src\\a.ts', 'c:/code/cora')).toBe(true);
    expect(inFolder('C:\\code\\cora2\\a.ts', 'c:/code/cora')).toBe(false);
  });

  it("a window waiting gets what's sent at once; one that isn't open gets nothing", async () => {
    let now = 1000;
    const b = new IdeBridge({ now: () => now });
    // no window open on it yet: not sent
    expect(b.send('C:\\code\\cora', { kind: 'open', path: 'C:\\code\\cora\\a.ts' })).toBe(false);
    const waiting = b.next('c:/code/cora', 5000);
    expect(b.connected('C:\\code\\cora')).toBe(true);
    expect(b.folderFor('C:\\code\\cora\\src\\x.ts')).toBe('c:/code/cora');
    expect(b.send('C:\\code\\cora', { kind: 'open', path: 'C:\\code\\cora\\a.ts', line: 3 })).toBe(true);
    expect(await waiting).toEqual([{ kind: 'open', path: 'C:\\code\\cora\\a.ts', line: 3 }]);
    // between its asks: kept for its next one
    expect(b.send('c:/code/cora', { kind: 'open', path: 'C:\\code\\cora\\b.ts' })).toBe(true);
    expect(await b.next('c:/code/cora')).toEqual([{ kind: 'open', path: 'C:\\code\\cora\\b.ts' }]);
    // gone quiet a while: not open any more
    now += 60_000;
    expect(b.connected('c:/code/cora')).toBe(false);
  });

  it('nothing comes: the wait ends empty', async () => {
    const b = new IdeBridge();
    expect(await b.next('c:/x', 20)).toEqual([]);
  });
});
