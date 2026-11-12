import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mergeElements, outlineBoard, placeBeside, type BoardDrawMsg, type BoardElement } from '@cora/shared';
import { Boards } from '../src/boards';

let n = 0;
const el = (o: Partial<BoardElement> & { id: string }): BoardElement => ({ type: 'rectangle', version: 1, versionNonce: ++n, x: 0, y: 0, width: 100, height: 50, ...o });

function make(o: { app?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cora-boards-'));
  const asked: BoardDrawMsg[] = [];
  let changes = 0;
  const boards = new Boards({ dir, onChange: () => changes++, askApp: (m) => (o.app === false ? false : (asked.push(m), true)), drawWaitMs: 200 });
  return { boards, dir, asked, changes: () => changes };
}

describe('Whiteboard: merging two copies of a board', () => {
  it('each element by id, the higher version winning; what only one side has, kept', () => {
    const a = [el({ id: 'x', version: 2, x: 10 }), el({ id: 'y', version: 1 })];
    const b = [el({ id: 'x', version: 3, x: 99 }), el({ id: 'z', version: 1 })];
    const m = mergeElements(a, b);
    expect(m.map((e) => e.id)).toEqual(['x', 'y', 'z']);
    expect(m[0].x).toBe(99);
    // a tie settles the same way on both sides (the lower nonce)
    const t1 = el({ id: 'q', version: 4, versionNonce: 5, x: 1 });
    const t2 = el({ id: 'q', version: 4, versionNonce: 9, x: 2 });
    expect(mergeElements([t1], [t2])[0].x).toBe(1);
    expect(mergeElements([t2], [t1])[0].x).toBe(1);
  });

  it('a new drawing goes beside what is there, never on it', () => {
    expect(placeBeside([])).toEqual({ x: 0, y: 0 });
    expect(placeBeside([el({ id: 'a', x: 0, y: 40, width: 200 }), el({ id: 'b', x: 300, y: -20, width: 100 }), el({ id: 'gone', x: 5000, isDeleted: true })])).toEqual({ x: 520, y: -20 });
  });

  it("outlines a board in words: frames and who drew them, labels, what's joined to what", () => {
    const els = [
      el({ id: 'f', type: 'frame', name: 'Flow', x: 0, y: 0, width: 400, height: 200, customData: { by: 's1', byName: 'API work' } }),
      el({ id: 'a', frameId: 'f', boundElements: [{ id: 'at', type: 'text' }] }),
      el({ id: 'at', type: 'text', text: 'API', containerId: 'a' }),
      el({ id: 'b', x: 200, frameId: 'f', boundElements: [{ id: 'bt', type: 'text' }] }),
      el({ id: 'bt', type: 'text', text: 'DB', containerId: 'b' }),
      el({ id: 'arr', type: 'arrow', startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' } }),
      el({ id: 'mine', type: 'freedraw', x: -50, y: 300 }),
    ];
    const o = outlineBoard('Plan', els);
    expect(o).toContain('frame "Flow" (drawn by API work)');
    expect(o).toContain('rectangle "API"');
    expect(o).toContain('arrow API → DB');
    expect(o).toContain('a drawn stroke at -50,300');
    expect(outlineBoard('Empty', [])).toContain('(empty)');
  });
});

describe('Whiteboard: boards on disk', () => {
  it('Scratch is always there, first; boards are .excalidraw files (they open on excalidraw.com)', () => {
    const { boards, dir } = make();
    const id = boards.create('Release plan');
    boards.save(id, { elements: [el({ id: 'a' })], appState: { viewBackgroundColor: '#111', selectedElementIds: { a: true } }, files: {} });
    expect(boards.list().map((b) => b.id)).toEqual(['scratch', id]);
    const file = JSON.parse(readFileSync(join(dir, `${id}.excalidraw`), 'utf8'));
    expect(file).toMatchObject({ type: 'excalidraw', version: 2, source: 'cora' });
    // its look is kept, not what you had selected
    expect(file.appState).toEqual({ viewBackgroundColor: '#111' });
    expect(boards.read(id).count).toBe(1);
  });

  it("a save that hadn't seen a session's drawing keeps it, and says the board holds more (the app reloads)", () => {
    const { boards } = make();
    boards.save('scratch', { elements: [el({ id: 'a' }), el({ id: 'theirs', version: 2 })] });
    const r = boards.save('scratch', { elements: [el({ id: 'a', version: 5, x: 40 })] });
    expect(r.changed).toBe(true);
    const els = boards.read('scratch').scene.elements;
    expect(els.map((e) => [e.id, e.x])).toEqual([
      ['a', 40],
      ['theirs', 0],
    ]);
    // the same again: nothing new, no new version
    const v = boards.read('scratch').version;
    expect(boards.save('scratch', { elements: els }).version).toBe(v);
  });

  it('deleting Scratch empties it; any other board goes', () => {
    const { boards } = make();
    boards.save('scratch', { elements: [el({ id: 'a' })] });
    boards.remove('scratch');
    expect(boards.read('scratch').count).toBe(0);
    const id = boards.create('Temp');
    boards.remove(id);
    expect(boards.list().map((b) => b.id)).toEqual(['scratch']);
    expect(() => boards.rename('scratch', 'Mine')).toThrow(/keeps its name/);
  });
});

describe('Whiteboard: a session draws and takes back', () => {
  const by = { sessionId: 's1', name: 'API work' };

  it("asks the app to draw (on the session's own board, made for it), adds what comes back in its name", async () => {
    const { boards, asked } = make();
    const drawing = boards.draw({ by, mermaid: 'flowchart LR; A-->B' });
    expect(asked).toHaveLength(1);
    const m = asked[0];
    expect(m).toMatchObject({ t: 'board-draw', by, mermaid: 'flowchart LR; A-->B' });
    expect(boards.list().find((b) => b.id === m.boardId)).toMatchObject({ title: 'API work', link: { sessionId: 's1' } });
    boards.answerDraw(m.reqId, { elements: [el({ id: 'fr', type: 'frame', name: 'API work' }), el({ id: 'b1', frameId: 'fr' })] });
    const r = await drawing;
    expect(r).toMatchObject({ ok: true, boardId: m.boardId, frame: 'API work', count: 1 });
    const els = boards.read(m.boardId).scene.elements;
    expect(els.every((e) => e.customData?.by === 's1')).toBe(true);
    expect(boards.list().find((b) => b.id === m.boardId)?.unseen).toBe('API work');
    // its next drawing goes on the same board
    void boards.draw({ by, shapes: [{ type: 'rect', label: 'x' }] });
    expect(asked[1].boardId).toBe(m.boardId);
  });

  it("no app open: says so at once; the app not answering: says so after a while", async () => {
    expect(await make({ app: false }).boards.draw({ by, mermaid: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/isn't open/) });
    expect(await make().boards.draw({ by, mermaid: 'x' })).toMatchObject({ ok: false, error: expect.stringMatching(/in time/) });
  });

  it("erasing takes back only that session's frames and what's in them: never yours, never another session's", () => {
    const { boards } = make();
    boards.save('scratch', {
      elements: [
        el({ id: 'mine', type: 'freedraw' }),
        el({ id: 'f1', type: 'frame', name: 'Flow', customData: { by: 's1' } }),
        el({ id: 'r1', frameId: 'f1', customData: { by: 's1' }, boundElements: [{ id: 't1', type: 'text' }] }),
        el({ id: 't1', type: 'text', containerId: 'r1', customData: { by: 's1' } }),
        el({ id: 'f2', type: 'frame', name: 'Other', customData: { by: 's2' } }),
        el({ id: 'r2', frameId: 'f2', customData: { by: 's2' } }),
      ],
    });
    const r = boards.erase('Scratch', 's1');
    expect(r).toEqual({ removed: 3, frames: ['Flow'] });
    const els = boards.read('scratch').scene.elements;
    expect(els.filter((e) => !e.isDeleted).map((e) => e.id)).toEqual(['mine', 'f2', 'r2']);
    expect(boards.erase('scratch', 's1').removed).toBe(0);
  });
});
