import { create } from 'zustand';
import type { BoardDoc, BoardDrawMsg, BoardLink, BoardScene, BoardSummary, BoardsMsg } from '@cora/shared';

/**
 * Cora's Whiteboard: your boards, the one open, and what a
 * session asks to draw (drawn here: Excalidraw's converter needs a browser, so Cora's window does it and answers).
 */
export const WHITEBOARD_ID = 'cora:whiteboard';
const CURRENT = 'cora.whiteboard.current';

const readCurrent = () => {
  try {
    return localStorage.getItem(CURRENT) || 'scratch';
  } catch {
    return 'scratch';
  }
};

export const useBoards = create<{ list: BoardSummary[]; current: string; apply(m: BoardsMsg): void; open(id: string): void }>((set, get) => ({
  list: [],
  current: readCurrent(),
  apply: (m) => {
    set({ list: m.list });
    // the open board went (deleted elsewhere): back to Scratch
    if (m.list.length && !m.list.some((b) => b.id === get().current)) get().open('scratch');
  },
  open: (id) => {
    set({ current: id });
    try {
      localStorage.setItem(CURRENT, id);
    } catch {
      /* not kept */
    }
  },
}));

/** A session drew on a board you haven't opened since. */
export const boardsUnseen = (list: BoardSummary[]) => list.some((b) => !!b.unseen);

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export const fetchBoard = async (id: string) => (await call<{ board: BoardDoc }>('GET', `/api/boards/${encodeURIComponent(id)}`)).board;
export const createBoard = async (title: string, link?: BoardLink) => (await call<{ id: string }>('POST', '/api/boards', { title, ...(link ? { link } : {}) })).id;
export const saveBoard = (id: string, scene: BoardScene) => call<{ version: number; changed: boolean }>('PUT', `/api/boards/${encodeURIComponent(id)}`, { scene });
export const patchBoard = (id: string, p: { title?: string; pinned?: boolean; link?: BoardLink | null }) => call<{ ok: true }>('PATCH', `/api/boards/${encodeURIComponent(id)}`, p);
export const deleteBoard = (id: string) => call<{ ok: true }>('DELETE', `/api/boards/${encodeURIComponent(id)}`);
export const seenBoard = (id: string) => call<{ ok: true }>('POST', `/api/boards/${encodeURIComponent(id)}/seen`).catch(() => {});

/** The picture of a board, for sessions (board_read). */
export async function savePreview(id: string, png: Blob): Promise<void> {
  const b64 = await new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => rej(r.error ?? new Error("couldn't read the picture"));
    r.readAsDataURL(png);
  });
  await call('PUT', `/api/boards/${encodeURIComponent(id)}/preview`, { png: b64 });
}

/** A session asks to draw: Excalidraw (loaded only now) converts and places it, and Cora's server is answered. */
export async function onBoardDraw(m: BoardDrawMsg): Promise<void> {
  try {
    const { drawForSession } = await import('../components/whiteboard/draw');
    const { elements, files } = await drawForSession(m);
    await call('POST', `/api/boards/draw/${encodeURIComponent(m.reqId)}`, { elements, files });
  } catch (e) {
    await call('POST', `/api/boards/draw/${encodeURIComponent(m.reqId)}`, { error: `The whiteboard couldn't draw that: ${(e as Error).message}` }).catch(() => {});
  }
}
