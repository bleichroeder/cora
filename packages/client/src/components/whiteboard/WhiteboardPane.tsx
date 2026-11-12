import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaptureUpdateAction, Excalidraw, MainMenu, getSceneVersion, restoreElements, THEME } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { mergeElements, sameElements, type BoardDoc, type BoardElement, type SessionInfo } from '@cora/shared';
import { createBoard, deleteBoard, fetchBoard, patchBoard, saveBoard, savePreview, seenBoard, useBoards } from '../../state/boards';
import { useBrain } from '../../state/store';
import { useComposer, attachFile } from '../../state/composer';
import { sessionName } from '../../lib/format';
import { oops } from '../../state/oops';
import { NAV_RESIZED } from '../../lib/navWidth';
import { Icon } from '../Icon';
import { CLEAN, renderPng } from './draw';
import './whiteboard.css';

/**
 * Cora's Whiteboard pane (in the Tools drawer): the open board in Excalidraw, a board picker, Send (a picture of the
 * board or your selection, to a session's composer) and the board's own menu. Saves a second after you stop; what a
 * session draws meanwhile is merged in (the higher version of each thing wins) and fades in as one undo step.
 */
export default function WhiteboardPane({ visible }: { visible: boolean }) {
  const current = useBoards((b) => b.current);
  const list = useBoards((b) => b.list);
  const summary = list.find((b) => b.id === current);
  const [doc, setDoc] = useState<BoardDoc | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setDoc(null);
    setErr(null);
    fetchBoard(current)
      .then((d) => live && setDoc(d))
      .catch((e: Error) => live && setErr(e.message));
    return () => {
      live = false;
    };
  }, [current]);
  // open and looked at: what a session drew is seen
  useEffect(() => {
    if (visible && summary?.unseen) void seenBoard(summary.id);
  }, [visible, summary?.unseen, summary?.id]);

  return (
    <div className="wb" style={visible ? undefined : { display: 'none' }}>
      <BoardBar doc={doc} />
      {err ? <div className="wb-empty">Couldn't open this board: {err}</div> : doc ? <Board key={doc.id} doc={doc} /> : <div className="wb-empty">Opening…</div>}
    </div>
  );
}

/** The open board: Excalidraw, saving as you go and taking in what sessions draw. */
function Board({ doc }: { doc: BoardDoc }) {
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const version = useRef(doc.version);
  const savedHash = useRef(getSceneVersion(doc.scene.elements as never));
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remote = useBoards((b) => b.list.find((x) => x.id === doc.id)?.version ?? 0);
  const initialData = useMemo(
    () => ({
      elements: doc.scene.elements as never,
      files: doc.scene.files as never,
      appState: { ...doc.scene.appState, theme: THEME.DARK, currentItemRoughness: CLEAN.roughness, currentItemFontFamily: CLEAN.fontFamily, currentItemStrokeWidth: 2 } as never,
      scrollToContent: true,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc.id],
  );

  // a picture for sessions, a few seconds after the last change (not on every stroke)
  const picture = useCallback(() => {
    if (picTimer.current) clearTimeout(picTimer.current);
    picTimer.current = setTimeout(() => {
      const a = api.current;
      if (!a) return;
      void renderPng(a.getSceneElementsIncludingDeleted() as unknown as BoardElement[], a.getFiles())
        .then((png) => savePreview(doc.id, png))
        .catch(() => {});
    }, 3000);
  }, [doc.id]);

  /** What the server has now, merged into what's on screen (a session's drawing; another screen's strokes). */
  const pull = useCallback(async () => {
    const a = api.current;
    if (!a) return;
    const d = await fetchBoard(doc.id);
    version.current = Math.max(version.current, d.version);
    const local = a.getSceneElementsIncludingDeleted() as unknown as BoardElement[];
    const merged = mergeElements(local, d.scene.elements);
    const files = Object.entries(d.scene.files).filter(([id]) => !a.getFiles()[id]);
    if (files.length) a.addFiles(files.map(([, f]) => f) as never);
    if (sameElements(merged, local)) return;
    a.updateScene({ elements: restoreElements(merged as never, null, { repairBindings: true }), captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    savedHash.current = getSceneVersion(merged as never);
  }, [doc.id]);

  const save = useCallback(async () => {
    const a = api.current;
    if (!a) return;
    const elements = a.getSceneElementsIncludingDeleted();
    const hash = getSceneVersion(elements);
    if (hash === savedHash.current) return;
    savedHash.current = hash;
    try {
      const r = await saveBoard(doc.id, { elements: elements as unknown as BoardElement[], appState: a.getAppState() as unknown as Record<string, unknown>, files: a.getFiles() as unknown as Record<string, unknown> });
      version.current = Math.max(version.current, r.version);
      if (r.changed) await pull();
      picture();
    } catch (e) {
      savedHash.current = -1;
      oops("Couldn't save the board", (e as Error).message);
    }
  }, [doc.id, pull, picture]);

  // the board moved on elsewhere (a session drew): take it in
  useEffect(() => {
    if (remote > version.current) void pull();
  }, [remote, pull]);
  // leaving it (another board, the drawer closed for good): what's unsaved is saved
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (picTimer.current) clearTimeout(picTimer.current);
      void save();
    },
    [save],
  );

  // Excalidraw keeps where its canvas sits on screen, measured once: the drawer slides in (and widens, and the nav
  // resizes) after that, which left the pen off the cursor. Measured again whenever the box may have moved.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const refresh = () => api.current?.refresh();
    const drawer = el.closest('.tool-drawer');
    const ro = new ResizeObserver(refresh);
    ro.observe(el);
    drawer?.addEventListener('transitionend', refresh);
    window.addEventListener(NAV_RESIZED, refresh);
    const t = setTimeout(refresh, 300);
    return () => {
      ro.disconnect();
      drawer?.removeEventListener('transitionend', refresh);
      window.removeEventListener(NAV_RESIZED, refresh);
      clearTimeout(t);
    };
  }, []);

  return (
    <div className="wb-canvas" ref={box} onPointerEnter={() => api.current?.refresh()}>
      <Excalidraw
        excalidrawAPI={(a) => ((api.current = a), (onScreen.api = a))}
        initialData={initialData}
        theme={THEME.DARK}
        onChange={() => {
          if (saveTimer.current) clearTimeout(saveTimer.current);
          saveTimer.current = setTimeout(() => void save(), 900);
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, export: { saveFileToDisk: true } } }}
        aiEnabled={false}
      >
        <MainMenu>
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}

const live = (s: SessionInfo) => s.state !== 'ended';

/** The board on screen (Send takes its picture from here: what you see, saved or not, and what you've selected). */
const onScreen: { api: ExcalidrawImperativeAPI | null } = { api: null };
const selectionOf = (a: ExcalidrawImperativeAPI | null) => Object.entries(a?.getAppState().selectedElementIds ?? {}).filter(([, on]) => on).map(([id]) => id);

/** Above the canvas: which board (and the others), what it's tied to, Send to a session, its menu. */
function BoardBar({ doc }: { doc: BoardDoc | null }) {
  const list = useBoards((b) => b.list);
  const current = useBoards((b) => b.current);
  const sessions = useBrain((s) => s.sessions);
  const focus = useBrain((s) => s.focus);
  const summary = list.find((b) => b.id === current);
  const [menu, setMenu] = useState<'boards' | 'send' | 'more' | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const down = (e: MouseEvent) => !bar.current?.contains(e.target as Node) && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), setMenu(null));
    window.addEventListener('mousedown', down);
    window.addEventListener('keydown', key, true);
    return () => (window.removeEventListener('mousedown', down), window.removeEventListener('keydown', key, true));
  }, [menu]);
  const tied = summary?.link?.sessionId ? sessions[summary.link.sessionId] : undefined;
  const targets = Object.values(sessions)
    .filter(live)
    .sort((a, b) => Number(b.id === focus) - Number(a.id === focus) || b.lastTs - a.lastTs)
    .slice(0, 12);

  const newBoard = async () => {
    try {
      const id = await createBoard('Untitled board');
      useBoards.getState().open(id);
      setMenu(null);
      setNaming('Untitled board');
    } catch (e) {
      oops("Couldn't make a board", (e as Error).message);
    }
  };
  const rename = async (title: string) => {
    setNaming(null);
    if (!summary || !title.trim() || title.trim() === summary.title) return;
    await patchBoard(summary.id, { title: title.trim() }).catch((e: Error) => oops("Couldn't rename it", e.message));
  };
  /** A picture of the board (or what you've selected) into a session's composer. */
  const send = async (sid: string) => {
    setMenu(null);
    try {
      const a = onScreen.api;
      if (!a) return;
      const all = a.getSceneElementsIncludingDeleted() as unknown as BoardElement[];
      const selected = selectionOf(a);
      // the selection with what's bound to it (labels) and in it (a frame's contents)
      const els = selected.length ? all.filter((e) => selected.includes(e.id) || (e.containerId && selected.includes(e.containerId)) || (e.frameId && selected.includes(e.frameId))) : all;
      if (!els.some((e) => !e.isDeleted)) return oops('Nothing to send', 'The board is empty.', { info: true });
      const png = await renderPng(els, a.getFiles() as unknown as Record<string, unknown>, { max: 2000 });
      const file = new File([png], `${(summary?.title ?? 'board').replace(/[^\w-]+/g, '-').toLowerCase()}.png`, { type: 'image/png' });
      const att = await attachFile(sid, file);
      const draft = useComposer.getState().drafts[sid];
      useComposer.getState().setDraft(sid, { attachments: [...(draft?.attachments ?? []), att] });
      useBrain.getState().setFocus(sid);
    } catch (e) {
      oops("Couldn't send the board", (e as Error).message);
    }
  };

  return (
    <div className="wb-bar" ref={bar}>
      <button className={`wb-pick${menu === 'boards' ? ' on' : ''}`} onClick={() => setMenu(menu === 'boards' ? null : 'boards')} title="Your boards">
        <Icon name="Presentation" size={13} />
        {naming != null ? (
          <input
            className="wb-name"
            autoFocus
            defaultValue={naming}
            onClick={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => void rename(e.currentTarget.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setNaming(null);
            }}
          />
        ) : (
          <b onDoubleClick={(e) => (e.stopPropagation(), summary && summary.id !== 'scratch' && setNaming(summary.title))}>{summary?.title ?? 'Scratch'}</b>
        )}
        <Icon name="ChevronDown" size={12} />
      </button>
      {tied ? (
        <span className="wb-tie" title={`Tied to ${sessionName(tied)}`}>
          <Icon name="Link" size={11} />
          {sessionName(tied)}
        </span>
      ) : null}
      {summary?.unseen ? <span className="wb-new">{summary.unseen} drew here</span> : null}
      <span className="spacer" />
      <button className={`btn wb-send${menu === 'send' ? ' on' : ''}`} disabled={!doc || !targets.length} onClick={() => setMenu(menu === 'send' ? null : 'send')} title="Send a picture of the board (or what you've selected) to a session">
        <Icon name="Send" size={12} /> Send
      </button>
      <button className={`icon-btn${menu === 'more' ? ' on' : ''}`} onClick={() => setMenu(menu === 'more' ? null : 'more')} title="This board">
        <Icon name="Ellipsis" size={14} />
      </button>

      {menu === 'boards' ? (
        <div className="session-menu wb-menu left">
          {list.map((b) => (
            <button key={b.id} className={`sm-row${b.id === current ? ' cur' : ''}`} onClick={() => (useBoards.getState().open(b.id), setMenu(null))}>
              <Icon name={b.id === 'scratch' ? 'PencilLine' : b.pinned ? 'Pin' : 'Presentation'} size={13} />
              <span className="wb-mn">{b.title}</span>
              {b.unseen ? <i className="wb-dot" title={`${b.unseen} drew here`} /> : <span className="wb-mc">{b.count || ''}</span>}
            </button>
          ))}
          <div className="sm-sep" />
          <button className="sm-row" onClick={() => void newBoard()}>
            <Icon name="Plus" size={13} /> New board
          </button>
        </div>
      ) : null}
      {menu === 'send' ? (
        <div className="session-menu wb-menu right">
          <div className="sm-gl">{selectionOf(onScreen.api).length ? 'Send the selection to' : 'Send the board to'}</div>
          {targets.map((s) => (
            <button key={s.id} className="sm-row" onClick={() => void send(s.id)}>
              <Icon name="Terminal" size={13} />
              <span className="wb-mn">{sessionName(s)}</span>
              {s.id === focus ? <span className="wb-mc">open</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {menu === 'more' && summary ? (
        <div className="session-menu wb-menu right">
          {summary.id !== 'scratch' ? (
            <button className="sm-row" onClick={() => (setMenu(null), setNaming(summary.title))}>
              <Icon name="PenLine" size={13} /> Rename
            </button>
          ) : null}
          {summary.id !== 'scratch' ? (
            <button className="sm-row" onClick={() => (setMenu(null), void patchBoard(summary.id, { pinned: !summary.pinned }))}>
              <Icon name={summary.pinned ? 'PinOff' : 'Pin'} size={13} /> {summary.pinned ? 'Unpin' : 'Pin'}
            </button>
          ) : null}
          {tied ? (
            <button className="sm-row" onClick={() => (setMenu(null), void patchBoard(summary.id, { link: null }))}>
              <Icon name="Unlink" size={13} /> Untie from {sessionName(tied)}
            </button>
          ) : focus && sessions[focus] && live(sessions[focus]) ? (
            <button className="sm-row" onClick={() => (setMenu(null), void patchBoard(summary.id, { link: { sessionId: focus } }))}>
              <Icon name="Link" size={13} /> Tie to {sessionName(sessions[focus])}
            </button>
          ) : null}
          <div className="sm-sep" />
          <button
            className="sm-row danger"
            onClick={() => {
              setMenu(null);
              const what = summary.id === 'scratch' ? 'Clear Scratch?' : `Delete "${summary.title}"?`;
              if (window.confirm(`${what}\n\nThis can't be undone.`)) void deleteBoard(summary.id).catch((e: Error) => oops("Couldn't delete it", e.message));
            }}
          >
            <Icon name="Trash2" size={13} /> {summary.id === 'scratch' ? 'Clear Scratch' : 'Delete board'}
          </button>
        </div>
      ) : null}
    </div>
  );
}
