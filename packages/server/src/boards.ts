import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SCRATCH_BOARD, mergeElements, sameElements, slugOf, type BoardDoc, type BoardDrawMsg, type BoardElement, type BoardLink, type BoardScene, type BoardShape, type BoardSummary } from '@cora/shared';
import { writeFileAtomic } from './fsx';

/**
 * Cora's Whiteboard: one standard .excalidraw file per
 * board in a folder (it opens on excalidraw.com too), a PNG of each beside it (what a session sees), and boards.json
 * for titles, pins, links and versions. Saves merge element by element (the higher version wins), so a session's
 * drawing and your strokes never overwrite each other. A session draws through the app (Excalidraw's converter needs a
 * browser): Cora asks the app, the app answers with the elements, Cora adds them.
 */

type Meta = { title: string; pinned?: boolean; createdAt: number; updatedAt: number; version: number; link?: BoardLink; unseen?: string };
type Index = { boards: Record<string, Meta> };

export const MAX_BOARDS = 500;
/** a board's file at most (pasted images live in it) */
export const MAX_SCENE = 50 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** how long a session's drawing may wait on the app */
export const DRAW_WAIT_MS = 30_000;

export class BoardError extends Error {}

export type DrawOutcome = { ok: true; boardId: string; title: string; frame: string; count: number } | { ok: false; error: string };

export class Boards {
  private idx: Index = { boards: {} };
  private file: string;
  private waiting = new Map<string, { boardId: string; by: { sessionId: string; name: string }; resolve(o: DrawOutcome): void; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private o: {
      dir: string;
      onChange?: () => void;
      /** ask the app to draw (false: no app open to ask) */
      askApp?: (m: BoardDrawMsg) => boolean;
      now?: () => number;
      drawWaitMs?: number;
    },
  ) {
    mkdirSync(o.dir, { recursive: true });
    this.file = join(o.dir, 'boards.json');
    try {
      if (existsSync(this.file)) this.idx = { ...this.idx, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Index) };
    } catch {
      /* start afresh (the boards' files are still there) */
    }
    // Scratch is always there
    if (!this.idx.boards[SCRATCH_BOARD]) {
      const t = this.now();
      this.idx.boards[SCRATCH_BOARD] = { title: 'Scratch', pinned: true, createdAt: t, updatedAt: t, version: 0 };
      writeFileAtomic(this.file, JSON.stringify(this.idx, null, 1));
    }
  }

  private now = () => this.o.now?.() ?? Date.now();
  private path = (id: string) => join(this.o.dir, `${id}.excalidraw`);
  previewPath = (id: string) => join(this.o.dir, `${id}.png`);
  private saveIndex(): void {
    writeFileAtomic(this.file, JSON.stringify(this.idx, null, 1));
    this.o.onChange?.();
  }
  private meta(id: string): Meta {
    const m = ID.test(id) ? this.idx.boards[id] : undefined;
    if (!m) throw new BoardError('no such board');
    return m;
  }
  private readScene(id: string): BoardScene {
    try {
      const j = JSON.parse(readFileSync(this.path(id), 'utf8')) as Partial<BoardScene>;
      return { elements: Array.isArray(j.elements) ? j.elements : [], appState: j.appState && typeof j.appState === 'object' ? j.appState : {}, files: j.files && typeof j.files === 'object' ? j.files : {} };
    } catch {
      return { elements: [], appState: {}, files: {} };
    }
  }
  private writeScene(id: string, s: BoardScene): void {
    const text = JSON.stringify({ type: 'excalidraw', version: 2, source: 'cora', elements: s.elements, appState: s.appState, files: s.files });
    if (text.length > MAX_SCENE) throw new BoardError('the board is too big to keep (large pasted images?)');
    writeFileAtomic(this.path(id), text);
  }
  private summary(id: string, m: Meta): BoardSummary {
    const count = m.version ? this.readScene(id).elements.filter((e) => !e.isDeleted).length : 0;
    return { id, title: m.title, pinned: !!m.pinned, createdAt: m.createdAt, updatedAt: m.updatedAt, version: m.version, ...(m.link ? { link: m.link } : {}), ...(m.unseen ? { unseen: m.unseen } : {}), count };
  }
  private bump(id: string): number {
    const m = this.meta(id);
    m.version += 1;
    m.updatedAt = this.now();
    return m.version;
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Scratch first, then pinned, then newest. */
  list(): BoardSummary[] {
    return Object.entries(this.idx.boards)
      .map(([id, m]) => this.summary(id, m))
      .sort((a, b) => Number(b.id === SCRATCH_BOARD) - Number(a.id === SCRATCH_BOARD) || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }

  read(id: string): BoardDoc {
    const m = this.meta(id);
    return { ...this.summary(id, m), scene: this.readScene(id) };
  }

  /** A board by its id or title (whole, then a part of it). */
  find(ref: string): string | null {
    const r = ref.trim().toLowerCase();
    if (!r) return null;
    if (this.idx.boards[r]) return r;
    const all = Object.entries(this.idx.boards);
    return all.find(([, m]) => m.title.toLowerCase() === r)?.[0] ?? all.find(([, m]) => m.title.toLowerCase().includes(r))?.[0] ?? null;
  }

  /** The board tied to a session (the newest, when more). */
  forSession(sessionId: string): string | null {
    return (
      Object.entries(this.idx.boards)
        .filter(([, m]) => m.link?.sessionId === sessionId)
        .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)[0]?.[0] ?? null
    );
  }

  create(title: string, link?: BoardLink): string {
    const t = title.trim().slice(0, 120) || 'Untitled board';
    if (Object.keys(this.idx.boards).length >= MAX_BOARDS) throw new BoardError(`at most ${MAX_BOARDS} boards`);
    const base = slugOf(t).slice(0, 50) || 'board';
    let id = base;
    while (this.idx.boards[id] || id === SCRATCH_BOARD) id = `${base}-${randomBytes(2).toString('hex')}`;
    const now = this.now();
    this.idx.boards[id] = { title: t, createdAt: now, updatedAt: now, version: 0, ...(link && (link.sessionId || link.projectId) ? { link } : {}) };
    this.saveIndex();
    return id;
  }

  /**
   * Your save: the app's elements merged into the file's (a session may have drawn meanwhile). `changed`: the board
   * now holds something the app didn't send (it reloads it).
   */
  save(id: string, scene: Partial<BoardScene>): { version: number; changed: boolean } {
    const m = this.meta(id);
    const now = this.readScene(id);
    const incoming = Array.isArray(scene.elements) ? (scene.elements as BoardElement[]).filter(okElement) : [];
    const merged = mergeElements(now.elements, incoming);
    const files = { ...now.files, ...(scene.files && typeof scene.files === 'object' ? scene.files : {}) };
    const appState = scene.appState && typeof scene.appState === 'object' ? keepAppState(scene.appState) : now.appState;
    if (sameElements(merged, now.elements) && Object.keys(files).length === Object.keys(now.files).length && JSON.stringify(appState) === JSON.stringify(now.appState)) return { version: m.version, changed: !sameElements(merged, incoming) };
    this.writeScene(id, { elements: merged, appState, files });
    const version = this.bump(id);
    this.saveIndex();
    return { version, changed: !sameElements(merged, incoming) };
  }

  /** The picture of a board (the app renders it after a change): what a session sees. */
  savePreview(id: string, png: Buffer): void {
    this.meta(id);
    if (png.length > 20 * 1024 * 1024 || png.subarray(1, 4).toString('latin1') !== 'PNG') throw new BoardError('not a PNG');
    writeFileAtomic(this.previewPath(id), png);
  }

  preview(id: string): Buffer | null {
    this.meta(id);
    try {
      return readFileSync(this.previewPath(id));
    } catch {
      return null;
    }
  }

  rename(id: string, title: string): void {
    const m = this.meta(id);
    if (id === SCRATCH_BOARD) throw new BoardError("Scratch keeps its name");
    const t = title.trim().slice(0, 120);
    if (!t) throw new BoardError('a board needs a name');
    m.title = t;
    m.updatedAt = this.now();
    this.saveIndex();
  }

  pin(id: string, pinned: boolean): void {
    const m = this.meta(id);
    m.pinned = pinned;
    this.saveIndex();
  }

  link(id: string, link: BoardLink | null): void {
    const m = this.meta(id);
    if (link && (link.sessionId || link.projectId)) m.link = link;
    else delete m.link;
    this.saveIndex();
  }

  seen(id: string): void {
    const m = this.meta(id);
    if (!m.unseen) return;
    delete m.unseen;
    this.saveIndex();
  }

  /** Scratch empties; any other board goes (its file and picture with it). */
  remove(id: string): void {
    this.meta(id);
    if (id === SCRATCH_BOARD) {
      const s = this.readScene(id);
      this.writeScene(id, { elements: s.elements.map((e) => (e.isDeleted ? e : gone(e, this.now()))), appState: s.appState, files: {} });
      this.bump(id);
      rmSync(this.previewPath(id), { force: true });
    } else {
      delete this.idx.boards[id];
      rmSync(this.path(id), { force: true });
      rmSync(this.previewPath(id), { force: true });
    }
    this.saveIndex();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // sessions

  /** Which board a session means: the one it names, else the one tied to it, else a new one named for it. */
  boardFor(ref: string | undefined, by: { sessionId: string; name: string }): { id: string; created: boolean } {
    if (ref?.trim()) {
      const id = this.find(ref);
      if (id) return { id, created: false };
      return { id: this.create(ref, { sessionId: by.sessionId }), created: true };
    }
    const tied = this.forSession(by.sessionId);
    if (tied) return { id: tied, created: false };
    return { id: this.create(by.name, { sessionId: by.sessionId }), created: true };
  }

  /** A session's drawing: the app converts it and answers (answerDraw). */
  draw(o: { board?: string; by: { sessionId: string; name: string }; title?: string; mermaid?: string; shapes?: BoardShape[] }): Promise<DrawOutcome> {
    let target: { id: string; created: boolean };
    try {
      target = this.boardFor(o.board, o.by);
    } catch (e) {
      return Promise.resolve({ ok: false, error: (e as Error).message });
    }
    const reqId = randomBytes(9).toString('base64url');
    const msg: BoardDrawMsg = { t: 'board-draw', reqId, boardId: target.id, by: o.by, ...(o.title ? { title: o.title.slice(0, 120) } : {}), ...(o.mermaid ? { mermaid: o.mermaid } : {}), ...(o.shapes ? { shapes: o.shapes } : {}) };
    return new Promise<DrawOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(reqId);
        resolve({ ok: false, error: "Cora's window didn't draw it in time. Ask the user to open Cora, then try again." });
      }, this.o.drawWaitMs ?? DRAW_WAIT_MS);
      this.waiting.set(reqId, { boardId: target.id, by: o.by, resolve, timer });
      if (!this.o.askApp?.(msg)) {
        clearTimeout(timer);
        this.waiting.delete(reqId);
        resolve({ ok: false, error: "Cora's window isn't open, so nothing can draw on the whiteboard right now. Ask the user to open Cora." });
      }
    });
  }

  /** The app's answer to a drawing: its elements (a frame and what's in it, already placed), or why not. */
  answerDraw(reqId: string, a: { elements?: unknown; files?: unknown; error?: unknown }): { ok: true } | { ok: false; error: string } {
    const w = this.waiting.get(reqId);
    if (!w) return { ok: false, error: 'no such drawing (it timed out?)' };
    this.waiting.delete(reqId);
    clearTimeout(w.timer);
    if (typeof a.error === 'string' || !Array.isArray(a.elements)) {
      w.resolve({ ok: false, error: typeof a.error === 'string' ? a.error.slice(0, 2000) : "the app sent nothing to draw" });
      return { ok: true };
    }
    try {
      const by = { by: w.by.sessionId, byName: w.by.name };
      const els = (a.elements as BoardElement[]).filter(okElement).map((e) => ({ ...e, customData: { ...(e.customData ?? {}), ...by } }));
      const frame = els.find((e) => e.type === 'frame');
      const s = this.readScene(w.boardId);
      const files = a.files && typeof a.files === 'object' ? (a.files as Record<string, unknown>) : {};
      this.writeScene(w.boardId, { elements: mergeElements(s.elements, els), appState: s.appState, files: { ...s.files, ...files } });
      this.bump(w.boardId);
      this.meta(w.boardId).unseen = w.by.name;
      this.saveIndex();
      w.resolve({ ok: true, boardId: w.boardId, title: this.meta(w.boardId).title, frame: (frame?.name as string | undefined) ?? 'its frame', count: els.filter((e) => e.type !== 'frame').length });
    } catch (e) {
      w.resolve({ ok: false, error: (e as Error).message });
    }
    return { ok: true };
  }

  /** A session takes back what it drew: its frames (all of them, or the one named), and what's in them. Never yours. */
  erase(ref: string, sessionId: string, frame?: string): { removed: number; frames: string[] } {
    const id = this.find(ref);
    if (!id) throw new BoardError(`No board called "${ref}". boards_list shows them.`);
    const s = this.readScene(id);
    const mine = (e: BoardElement) => e.customData?.by === sessionId && !e.isDeleted;
    const frames = s.elements.filter((e) => e.type === 'frame' && mine(e) && (!frame || (e.name ?? '').toLowerCase() === frame.trim().toLowerCase()));
    if (!frames.length) return { removed: 0, frames: [] };
    const ids = new Set(frames.map((f) => f.id));
    const t = this.now();
    let removed = 0;
    const elements = s.elements.map((e) => {
      if (mine(e) && (ids.has(e.id) || (e.frameId && ids.has(e.frameId)) || (e.containerId && s.elements.some((c) => c.id === e.containerId && c.frameId && ids.has(c.frameId))))) {
        removed++;
        return gone(e, t);
      }
      return e;
    });
    this.writeScene(id, { elements, appState: s.appState, files: s.files });
    this.bump(id);
    this.saveIndex();
    return { removed, frames: frames.map((f) => String(f.name ?? 'Frame')) };
  }
}

/** Deleted the way Excalidraw deletes: kept, marked, its version past every copy's. */
const gone = (e: BoardElement, t: number): BoardElement => ({ ...e, isDeleted: true, version: e.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: t });

const okElement = (e: unknown): e is BoardElement => {
  const x = e as BoardElement;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && x.id.length > 0 && x.id.length < 100 && typeof x.type === 'string' && typeof x.version === 'number' && typeof x.versionNonce === 'number';
};

/** What of Excalidraw's app state a board keeps (its look, not where you were or what you'd selected). */
function keepAppState(a: Record<string, unknown>): Record<string, unknown> {
  const keep = ['viewBackgroundColor', 'gridSize', 'gridStep', 'gridModeEnabled', 'currentItemFontFamily', 'currentItemRoughness', 'currentItemStrokeColor', 'currentItemBackgroundColor'];
  return Object.fromEntries(keep.filter((k) => k in a).map((k) => [k, a[k]]));
}
