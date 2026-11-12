import { convertToExcalidrawElements, exportToBlob, restoreElements, FONT_FAMILY, ROUNDNESS } from '@excalidraw/excalidraw';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import { BOARD_COLORS, mergeElements, placeBeside, type BoardDrawMsg, type BoardElement, type BoardShape } from '@cora/shared';
import { fetchBoard, savePreview } from '../../state/boards';

/**
 * A session's drawing, made into Excalidraw elements here (the converter needs a browser): Mermaid through Excalidraw's
 * own converter, simple shapes through ours; one clean style (Nunito, no wobble); all of it in a frame named for the
 * session, placed beside what's on the board. The board's picture is renewed before answering, so the session's next
 * board_read sees what it drew.
 */

// Excalidraw's fonts come from Cora itself (copied into the build at /excalidraw/fonts), never its CDN. Read when it
// first draws text, so set before anything renders (this module loads with the Whiteboard, before its first board)
(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';

/** Cora's look for new things on a board: clean lines, Nunito. */
export const CLEAN = { roughness: 0, strokeWidth: 2, fontFamily: FONT_FAMILY.Nunito };

type Skeleton = ExcalidrawElementSkeleton & { id?: string; label?: { text: string; fontSize?: number; fontFamily?: number }; start?: { id?: string }; end?: { id?: string }; children?: string[] };

/** Shapes a session listed → skeletons Excalidraw converts (unplaced ones in rows; arrows join by id or label). */
export function shapesToSkeletons(shapes: BoardShape[]): Skeleton[] {
  const SIZE: Record<string, [number, number]> = { rect: [180, 72], ellipse: [170, 84], diamond: [170, 110], note: [190, 120], text: [180, 30] };
  const ids = new Map<string, string>();
  const out: Skeleton[] = [];
  let slot = 0;
  const place = () => {
    const at = { x: (slot % 4) * 260, y: Math.floor(slot / 4) * 170 };
    slot++;
    return at;
  };
  const boxes = shapes.filter((s) => s.type !== 'arrow' && s.type !== 'line');
  boxes.forEach((s, i) => {
    const id = `s${i}`;
    for (const k of [s.id, s.label]) if (k) ids.set(k.trim().toLowerCase(), id);
    const [w0, h0] = SIZE[s.type] ?? [180, 72];
    const w = s.w ?? w0;
    const h = s.h ?? h0;
    const at = s.x != null && s.y != null ? { x: s.x, y: s.y } : place();
    const c = s.color ? BOARD_COLORS[s.color] : undefined;
    if (s.type === 'text') {
      out.push({ type: 'text', id, x: at.x, y: at.y, text: s.label ?? '', fontSize: 20, fontFamily: CLEAN.fontFamily, ...(c ? { strokeColor: c.stroke } : {}) } as Skeleton);
      return;
    }
    const note = s.type === 'note';
    out.push({
      type: note ? 'rectangle' : s.type === 'rect' ? 'rectangle' : s.type,
      id,
      x: at.x,
      y: at.y,
      width: w,
      height: h,
      roughness: CLEAN.roughness,
      strokeWidth: CLEAN.strokeWidth,
      ...(s.type === 'rect' || note ? { roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS } } : {}),
      ...(note ? { strokeColor: c?.stroke ?? '#f08c00', backgroundColor: c?.fill ?? '#ffec99', fillStyle: 'solid' } : c ? { strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: 'solid' } : {}),
      ...(s.label ? { label: { text: s.label, fontSize: note ? 16 : 18, fontFamily: CLEAN.fontFamily, ...(note ? { textAlign: 'left', verticalAlign: 'top' } : {}) } } : {}),
    } as Skeleton);
  });
  const byId = new Map(out.map((s) => [s.id as string, s as Skeleton & { x: number; y: number; width?: number; height?: number }]));
  shapes
    .filter((s) => s.type === 'arrow' || s.type === 'line')
    .forEach((s, i) => {
      const from = s.from ? ids.get(s.from.trim().toLowerCase()) : undefined;
      const to = s.to ? ids.get(s.to.trim().toLowerCase()) : undefined;
      const a = from ? byId.get(from) : undefined;
      const b = to ? byId.get(to) : undefined;
      const c = s.color ? BOARD_COLORS[s.color] : undefined;
      // from the start shape's right edge toward the end shape (the converter binds and routes it)
      const x = a ? a.x + (a.width ?? 0) : (s.x ?? place().x);
      const y = a ? a.y + (a.height ?? 0) / 2 : (s.y ?? 0);
      const ex = b ? b.x : x + (s.w ?? 160);
      const ey = b ? b.y + (b.height ?? 0) / 2 : y;
      out.push({
        type: s.type,
        id: `a${i}`,
        x,
        y,
        width: ex - x,
        height: ey - y,
        points: [
          [0, 0],
          [ex - x, ey - y],
        ],
        roughness: CLEAN.roughness,
        strokeWidth: CLEAN.strokeWidth,
        ...(c ? { strokeColor: c.stroke } : {}),
        ...(a ? { start: { id: a.id } } : {}),
        ...(b ? { end: { id: b.id } } : {}),
        ...(s.label ? { label: { text: s.label, fontSize: 16, fontFamily: CLEAN.fontFamily } } : {}),
      } as unknown as Skeleton);
    });
  return out;
}

/** Mermaid → skeletons, through Excalidraw's converter (loaded only when a session draws one), in Cora's look. */
async function mermaidToSkeletons(def: string): Promise<{ skeletons: Skeleton[]; files: Record<string, unknown> }> {
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  const r = await parseMermaidToExcalidraw(def, { themeVariables: { fontSize: '16px' } } as never);
  const skeletons = (r.elements as Skeleton[]).map((s) => {
    const x = { ...s, roughness: CLEAN.roughness } as Skeleton & { fontFamily?: number };
    if (x.label) x.label = { ...x.label, fontFamily: CLEAN.fontFamily };
    if (x.type === 'text') x.fontFamily = CLEAN.fontFamily;
    return x;
  });
  return { skeletons, files: (r.files ?? {}) as Record<string, unknown> };
}

/** Skeletons → elements, in a frame of their own, moved to where they go. */
export function framed(skeletons: Skeleton[], name: string, at: { x: number; y: number }): BoardElement[] {
  const withIds = skeletons.map((s, i) => (s.id ? s : { ...s, id: `k${i}` }));
  const frame = { type: 'frame', children: withIds.map((s) => s.id as string), name } as unknown as Skeleton;
  const els = convertToExcalidrawElements([...withIds, frame] as ExcalidrawElementSkeleton[]) as unknown as BoardElement[];
  const f = els.find((e) => e.type === 'frame');
  const dx = at.x - (f?.x ?? 0);
  const dy = at.y - (f?.y ?? 0);
  // the frame after what's in it (Excalidraw draws frames over their children's clip)
  return [...els.filter((e) => e.type !== 'frame'), ...els.filter((e) => e.type === 'frame')].map((e) => ({ ...e, x: e.x + dx, y: e.y + dy, index: null }));
}

/** A picture of a board (light, for a session's eyes): what board_read hands it, and what Send attaches. */
export async function renderPng(elements: readonly BoardElement[], files: Record<string, unknown>, o: { max?: number } = {}): Promise<Blob> {
  const live = restoreElements(elements.filter((e) => !e.isDeleted) as never, null);
  return exportToBlob({ elements: live, appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false }, files: files as never, mimeType: 'image/png', maxWidthOrHeight: o.max ?? 1600, exportPadding: 24 });
}

/** A session's drawing request → the elements (and pasted files) to add. */
export async function drawForSession(m: BoardDrawMsg): Promise<{ elements: BoardElement[]; files: Record<string, unknown> }> {
  const doc = await fetchBoard(m.boardId);
  const made = m.mermaid ? await mermaidToSkeletons(m.mermaid) : { skeletons: shapesToSkeletons(m.shapes ?? []), files: {} };
  if (!made.skeletons.length) throw new Error('nothing to draw');
  const elements = framed(made.skeletons, m.title?.trim() || m.by.name, placeBeside(doc.scene.elements));
  // its picture first: the session's next look sees what it drew
  try {
    const all = mergeElements(doc.scene.elements, elements);
    await savePreview(m.boardId, await renderPng(all, { ...doc.scene.files, ...made.files }));
  } catch {
    /* the picture comes with the next save */
  }
  return { elements, files: made.files };
}
