import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useBrain } from '../state/store';
import { useTools } from '../state/tools';
import { useWeb } from '../state/web';
import { NOTES_ID, notesUnseen, useNotes } from '../state/notes';
import { NotesPane } from './Notes';
import { desktop } from '../lib/desktop';
import { tintOf, toolEntries, toolHost, toolSite, unreadOf, type ToolDef, type ToolEntry } from '../lib/tools';
import { BrowserTool, WEB_PARTITION, openFind } from './WebPane';
import { BROWSER_ID, currentGroup, isBrowserGroup } from '../state/browser';
import { SECRETS_ID, useSecrets } from '../state/secrets';
import { SecretsPane } from './SecretsSettings';
import { LibraryButton, LibraryPane } from './Library';
import { LIBRARY_ID } from '../state/library';
import { WHITEBOARD_ID, boardsUnseen, useBoards } from '../state/boards';
// the Whiteboard (Excalidraw): loaded only when it's first opened
const WhiteboardPane = lazy(() => import('./whiteboard/WhiteboardPane'));
import { openSettings } from './SettingsModal';
import { Icon } from './Icon';
import { FindBar } from './FindBar';
import './tools.css';
import './browser.css';

/** Electron's <webview> (desktop app only). */
type Webview = HTMLElement & {
  loadURL(u: string): Promise<void>;
  getURL(): string;
  getWebContentsId(): number;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  reload(): void;
  stop(): void;
  executeJavaScript(code: string): Promise<unknown>;
};

/**
 * In a Tool's page, once it's loaded: remember the last field you typed in (an input, a text box, a rich editor), so
 * opening the Tool again puts you back there.
 */
const TRACK_FIELD = `(() => {
  if (window.__coraField) return;
  window.__coraField = true;
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || (t.tagName === 'INPUT' && !/^(button|checkbox|radio|submit|reset|file|range|color|hidden)$/i.test(t.type)))) window.__coraLastField = t;
  }, true);
})()`;

/**
 * Opening a Tool: the cursor goes where you'd type. Already in a field: left there. Else the field you last typed in
 * (still on the page and visible), else the message box of a chat app Cora knows (Slack, Teams, Discord, Google
 * Chat). Nothing else is guessed at: a dashboard's first text box isn't where you meant to type.
 */
const FOCUS_FIELD = `(() => {
  const ok = (el) => !!el && el.isConnected && el.getClientRects().length > 0 && !el.disabled && !el.readOnly;
  const typing = (el) => !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'INPUT');
  const a = document.activeElement;
  if (typing(a) && ok(a)) return 'kept';
  const caret = (el) => {
    el.focus();
    if (el.isContentEditable) {
      const r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(false);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    }
  };
  if (ok(window.__coraLastField)) return caret(window.__coraLastField), 'last';
  const chat = [
    '[data-qa="message_input"] [contenteditable="true"]',
    '.p-message_input [contenteditable="true"]',
    '[data-tid="ckeditor"][contenteditable="true"]',
    '[role="textbox"][data-slate-editor="true"]',
    'div[contenteditable="true"][aria-label^="Message"]',
  ];
  for (const sel of chat) {
    const el = [...document.querySelectorAll(sel)].find(ok);
    if (el) return caret(el), 'chat';
  }
  return 'none';
})()`;

/** Which tool a page belongs to, by its web contents id (its new-tab links and shortcuts come through the app). */
export const toolOfPage = new Map<number, string>();
const pages = new Map<string, Webview>();

/** Open (or close) a tool: in the drawer in the desktop app, else in a browser tab. */
export function openTool(t: ToolDef): void {
  if (desktop?.browser) (useBrain.getState().setInbox(false), useTools.getState().toggle(t.id));
  else window.open(t.url, '_blank', 'noopener');
}

/** A tool's icon: its site's favicon once seen, else its first letter. */
function ToolGlyph({ t, size = 18 }: { t: ToolDef; size?: number }) {
  const icon = useTools((s) => s.icons[t.id]);
  const [broken, setBroken] = useState(false);
  if (icon && !broken) return <img className="tool-ico" src={icon} alt="" width={size} height={size} onError={() => setBroken(true)} />;
  return (
    <span className="tool-letter" style={{ width: size, height: size }}>
      {t.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const EXPANDED = 'cora.tools.expanded';
/** The expanded list's height, as you dragged it (none: as tall as it needs). */
const TOOLS_H = 'cora.tools.height';
const readExpanded = () => {
  try {
    return localStorage.getItem(EXPANDED) === '1';
  } catch {
    return false;
  }
};

/**
 * The left nav's Tools: one button per tool (unread news as a badge), and one to add more. Or, expanded, a tall card
 * of named rows (each tool's site, its news and its shortcut), raised over the session list.
 */
export function ToolsDock() {
  const tools = useBrain((s) => s.prefs.tools);
  const open = useTools((s) => s.open);
  const unread = useTools((s) => s.unread);
  const playing = useTools((s) => s.playing);
  const [expanded, setExpanded] = useState(readExpanded);
  // the folder popped up from the icon row
  const [pop, setPop] = useState<string | null>(null);
  const flip = () => {
    setExpanded(!expanded);
    try {
      localStorage.setItem(EXPANDED, expanded ? '0' : '1');
    } catch {
      /* not kept */
    }
  };
  // expanded, the list is as tall as you drag it (its top edge); longer, it scrolls. Double-click: as tall as it needs
  const [height, setHeight] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(TOOLS_H));
      return v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  const list = useRef<HTMLDivElement>(null);
  const keepHeight = (h: number | null) => {
    setHeight(h);
    try {
      if (h) localStorage.setItem(TOOLS_H, String(Math.round(h)));
      else localStorage.removeItem(TOOLS_H);
    } catch {
      /* not kept */
    }
  };
  const grab = (e: React.PointerEvent) => {
    const el = list.current;
    if (!el || e.button !== 0) return;
    e.preventDefault();
    const bar = e.currentTarget as HTMLElement;
    bar.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = el.clientHeight;
    const max = Math.max(160, window.innerHeight * 0.6);
    let h = h0;
    document.body.classList.add('ui-dragging');
    const move = (ev: PointerEvent) => {
      h = Math.max(72, Math.min(max, h0 + (y0 - ev.clientY)));
      setHeight(h);
    };
    const up = () => {
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      document.body.classList.remove('ui-dragging');
      keepHeight(h);
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  };
  const entries = toolEntries(tools);
  const badge = (u: number | 'dot' | undefined) => (u != null ? <span className={`rt-badge${u === 'dot' ? ' dot' : ''}`}>{u === 'dot' ? '' : u > 99 ? '99+' : u}</span> : null);
  // a folder's news: the sum of its tools' (a dot when only dots)
  const folderNews = (ts: Array<{ t: ToolDef }>): number | 'dot' | undefined => {
    const us = ts.map(({ t }) => unread[t.id]).filter((u) => u != null);
    if (!us.length) return undefined;
    const n = us.reduce<number>((a, u) => a + (u === 'dot' ? 0 : u), 0);
    return n || 'dot';
  };
  return (
    <div className={`rail-tools${expanded ? ' expanded' : ''}`}>
      {expanded ? <div className="rt-grip" title="Drag to resize the list (double-click: as tall as it needs)" onPointerDown={grab} onDoubleClick={() => keepHeight(null)} /> : null}
      {/* Cora's own tools (Notes) sit in their own group under yours: fixed, no number */}
      {/* the view toggle and the add button sit by the heading: the row is just the tools, centred */}
      <div className="rt-h">
        <span>Tools</span>
        <span className="rt-hb">
          {tools.length ? (
            <button className={`rt-add rt-view${expanded ? ' on' : ''}`} title={expanded ? 'Icons only' : 'Show their names'} onClick={flip}>
              <Icon name={expanded ? 'LayoutGrid' : 'List'} size={12} />
            </button>
          ) : null}
          <button className="rt-add" title="Add a tool (Settings → Tools)" onClick={() => openSettings('tools')}>
            <Icon name="Plus" size={12} />
          </button>
        </span>
      </div>
      {expanded ? (
        <div className="rt-card rt-list" ref={list} style={height ? { maxHeight: height } : undefined}>
          {entries.map((e) => (e.kind === 'tool' ? <ToolRow key={e.t.id} t={e.t} n={e.n} on={open === e.t.id} u={unread[e.t.id]} /> : <FolderRows key={`f:${e.name}`} name={e.name} tools={e.tools} open={open} unread={unread} />))}
          {/* the heading's + adds one; this row only while there are none */}
          {entries.length ? null : (
            <button className="rt-r rt-more" onClick={() => openSettings('tools')}>
              <span className="rt-plus">
                <Icon name="Plus" size={12} />
              </span>
              <span className="rt-nm">
                <b>Add a tool</b>
              </span>
            </button>
          )}
        </div>
      ) : null}
      {expanded ? null : (
        <div className="rt-row">
          {entries.map((e) =>
            e.kind === 'tool' ? (
              <button
                key={e.t.id}
                className={`rt-b${open === e.t.id ? ' on' : ''}`}
                // its tint for the tile itself (the tinted tile's rule is on the button; without it here, the tile went blank)
                style={tintOf(e.t) ? ({ ['--tc' as string]: tintOf(e.t) } as React.CSSProperties) : undefined}
                title={`${e.t.name}${e.n < 9 ? ` (Ctrl+${e.n + 1})` : ''}`}
                onClick={() => openTool(e.t)}
              >
                <ToolIcon t={e.t} size={22} />
                {badge(unread[e.t.id])}
                {playing[e.t.id] ? <Playing /> : null}
              </button>
            ) : (
              <button
                key={`f:${e.name}`}
                className={`rt-b rt-fold${pop === e.name || e.tools.some(({ t }) => t.id === open) ? ' on' : ''}`}
                data-folder
                title={`${e.name}: ${e.tools.map(({ t }) => t.name).join(', ')}`}
                onClick={() => setPop(pop === e.name ? null : e.name)}
              >
                {e.tools.slice(0, 4).map(({ t }) => (
                  <span key={t.id} className="rt-mini" style={tintOf(t) ? ({ ['--tc' as string]: tintOf(t) } as React.CSSProperties) : undefined}>
                    <ToolGlyph t={t} size={10} />
                  </span>
                ))}
                {badge(folderNews(e.tools))}
                {e.tools.some(({ t }) => playing[t.id]) ? <Playing /> : null}
              </button>
            ),
          )}
          {pop ? <FolderPop name={pop} entry={entries.find((e) => e.kind === 'folder' && e.name === pop) as Extract<ToolEntry, { kind: 'folder' }> | undefined} open={open} unread={unread} onClose={() => setPop(null)} /> : null}
        </div>
      )}
      {/* Cora's own: a row of tiles under yours in either view, told apart by their colours (it wraps as Cora gains more); what each holds is in its tooltip */}
      <div className="rt-sep" aria-hidden />
      <div className="rt-row rt-cora-row">
        <NotesButton on={open === NOTES_ID} />
        <LibraryButton on={open === LIBRARY_ID} />
        <WhiteboardButton on={open === WHITEBOARD_ID} />
        {desktop?.browser ? <BrowserButton on={open === BROWSER_ID} /> : null}
        <SecretsButton on={open === SECRETS_ID} />
      </div>
    </div>
  );
}

const openNotes = () => useTools.getState().toggle(NOTES_ID);
const openBrowser = () => (useBrain.getState().setInbox(false), useTools.getState().toggle(BROWSER_ID));

const openWhiteboard = () => useTools.getState().toggle(WHITEBOARD_ID);
/** Cora's Whiteboard in the icon row: a dot while a session has drawn on a board you haven't opened since. */
function WhiteboardButton({ on }: { on: boolean }) {
  const list = useBoards((b) => b.list);
  const drew = list.find((b) => b.unseen);
  return (
    <button className={`rt-b rt-cora cc-whiteboard${on ? ' on' : ''}`} title={`Whiteboard: sketch, and hand it to a session (sessions can draw too) · ${list.length} board${list.length === 1 ? '' : 's'}${drew ? ` · ${drew.unseen} drew on ${drew.title}` : ''}`} onClick={openWhiteboard}>
      <Icon name="Presentation" size={18} />
      {boardsUnseen(list) ? <span className="rt-badge dot cora" /> : null}
    </button>
  );
}

const openSecrets = () => useTools.getState().toggle(SECRETS_ID);
/** Cora's Secrets in the icon row: amber while one of them has expired. */
function SecretsButton({ on }: { on: boolean }) {
  const list = useSecrets((s) => s.list);
  const n = list?.length ?? 0;
  const expired = (list ?? []).filter((x) => !!x.expiresAt && x.expiresAt < Date.now()).length;
  return (
    <button
      className={`rt-b rt-cora cc-secrets${on ? ' on' : ''}`}
      title={`Secrets: tokens and keys your sessions use by name · ${expired ? `${expired} expired` : n ? `${n} kept` : 'none yet'}`}
      onClick={openSecrets}
    >
      <Icon name="KeyRound" size={18} />
      {expired ? <span className="rt-badge dot" /> : null}
    </button>
  );
}

/** Cora's Browser in the icon row: how many tabs it has open, in its tooltip. */
function BrowserButton({ on }: { on: boolean }) {
  // every profile's tabs
  const n = useWeb((w) => Object.entries(w.sessions).reduce((k, [g, sw]) => k + (isBrowserGroup(g) ? sw.tabs.filter((id) => w.tabs[id]?.url).length : 0), 0));
  return (
    <button className={`rt-b rt-cora cc-browser${on ? ' on' : ''}`} title={`Browser (Ctrl+Shift+B) · ${n ? `${n} tab${n === 1 ? '' : 's'}` : 'no tabs open'}`} onClick={openBrowser}>
      <Icon name="Globe" size={18} />
    </button>
  );
}

/** Cora's Notes in the icon row: Cora's colour, a dot while a session's addition is unseen. */
function NotesButton({ on }: { on: boolean }) {
  const unseen = useNotes((s) => notesUnseen(s.list));
  const jots = useNotes((s) => s.list.find((x) => x.kind === 'scratch')?.count ?? 0);
  const flash = useNotes((s) => s.flash);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setLit(true);
    const t = setTimeout(() => setLit(false), 1400);
    return () => clearTimeout(t);
  }, [flash]);
  return (
    <button
      className={`rt-b rt-cora cc-notes${on ? ' on' : ''}${lit ? ' flash' : ''}`}
      title={`Notes (Ctrl+Shift+N) · Scratch: ${jots} jot${jots === 1 ? '' : 's'}${unseen ? ' · a session added something' : ''} · jot from anywhere: Ctrl+Alt+N`}
      onClick={openNotes}
    >
      <Icon name="NotebookPen" size={18} />
      {unseen ? <span className="rt-badge dot cora" /> : null}
    </button>
  );
}

/** A tool's icon with its look: its tile tinted, its tag on the corner. */
function ToolIcon({ t, size }: { t: ToolDef; size: number }) {
  return (
    <span className={`rt-ico${tintOf(t) ? ' tinted' : ''}`} style={tintOf(t) ? ({ ['--tc' as string]: tintOf(t) } as React.CSSProperties) : undefined}>
      <ToolGlyph t={t} size={size} />
      {t.tag ? <span className="rt-tag">{t.tag}</span> : null}
    </span>
  );
}

/** A tool as a named row (the names view, and a folder opened from the icon row). */
/** Sound playing from a tool's page: three small bars on its button. */
function Playing() {
  return (
    <span className="rt-playing" title="Playing">
      <i />
      <i />
      <i />
    </span>
  );
}

function ToolRow({ t, n, on, u, onPick }: { t: ToolDef; n: number; on: boolean; u: number | 'dot' | undefined; onPick?: () => void }) {
  const playing = useTools((s) => !!s.playing[t.id]);
  return (
    <button className={`rt-r${on ? ' on' : ''}`} title={`${t.name}: ${t.url}`} onClick={() => (openTool(t), onPick?.())}>
      <span className="rt-ico">
        <ToolIcon t={t} size={22} />
        {playing ? <Playing /> : null}
      </span>
      <span className="rt-nm">
        <b>{t.name}</b>
        <i>{toolSite(t.url)}</i>
      </span>
      <span className="rt-rr">
        {u === 'dot' ? <span className="rt-dot" /> : u != null ? <span className="rt-n">{u > 99 ? '99+' : u}</span> : null}
        {n < 9 ? <span className="rt-k">^{n + 1}</span> : null}
      </span>
    </button>
  );
}

const FOLDED = 'cora.tools.folded';
const readFolded = (): Record<string, boolean> => {
  try {
    return JSON.parse(localStorage.getItem(FOLDED) ?? '{}');
  } catch {
    return {};
  }
};

/** A folder in the names view: a row that opens and closes (remembered), its tools under it. */
function FolderRows({ name, tools, open, unread }: { name: string; tools: Array<{ t: ToolDef; n: number }>; open: string | null; unread: Record<string, number | 'dot'> }) {
  const [shut, setShut] = useState(() => !!readFolded()[name.toLowerCase()]);
  const flip = () => {
    setShut(!shut);
    try {
      localStorage.setItem(FOLDED, JSON.stringify({ ...readFolded(), [name.toLowerCase()]: !shut }));
    } catch {
      /* not kept */
    }
  };
  return (
    <>
      <button className="rt-r rt-frow" onClick={flip} aria-expanded={!shut} title={shut ? `Show ${name}` : `Hide ${name}`}>
        <span className="rt-fico">
          <Icon name={shut ? 'Folder' : 'FolderOpen'} size={15} />
        </span>
        <span className="rt-nm">
          <b>{name}</b>
        </span>
        <span className="rt-rr">
          <span className="rt-k">{tools.length}</span>
          <Icon name={shut ? 'ChevronRight' : 'ChevronDown'} size={12} />
        </span>
      </button>
      {shut ? null : (
        <div className="rt-fin">
          {tools.map(({ t, n }) => (
            <ToolRow key={t.id} t={t} n={n} on={open === t.id} u={unread[t.id]} />
          ))}
        </div>
      )}
    </>
  );
}

/** A folder opened from the icon row: its tools with their names, above the row. Esc or a click outside closes it. */
function FolderPop({ name, entry, open, unread, onClose }: { name: string; entry?: Extract<ToolEntry, { kind: 'folder' }>; open: string | null; unread: Record<string, number | 'dot'>; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current?.contains(t) || t?.closest('[data-folder]')) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', down), document.removeEventListener('keydown', key));
  }, [onClose]);
  if (!entry) return null;
  return (
    <div className="rt-fpop" ref={ref}>
      <div className="rt-fh">
        <Icon name="FolderOpen" size={12} /> {name}
      </div>
      {entry.tools.map(({ t, n }) => (
        <ToolRow key={t.id} t={t} n={n} on={open === t.id} u={unread[t.id]} onPick={onClose} />
      ))}
    </div>
  );
}

/** One tool's page: created the first time it's opened, then kept (hidden, not removed: moving a webview reloads it). */
function ToolPage({ t, visible }: { t: ToolDef; visible: boolean }) {
  const el = useRef<Webview>(null);
  const first = useRef(t.url);
  const ready = useRef(false);
  // opened before its page had loaded: the cursor goes in once it has
  const focusOnLoad = useRef(false);
  const go = useTools((s) => s.go[t.id]);
  // 0, not the ask it was opened with: a tool first opened at a page (an Inbox link) starts there, not at its home
  const seen = useRef(0);
  // opened at a page: start there
  if (go && !ready.current && seen.current !== go.n) {
    first.current = go.url;
    seen.current = go.n;
  }

  useEffect(() => {
    const w = el.current;
    if (!w) return;
    pages.set(t.id, w);
    let wcId = 0;
    const { setUnread, setIcon } = useTools.getState();
    const on: Array<[string, (e: any) => void]> = [
      [
        'dom-ready',
        () => {
          ready.current = true;
          wcId = w.getWebContentsId();
          toolOfPage.set(wcId, t.id);
          void w.executeJavaScript(TRACK_FIELD).catch(() => {});
        },
      ],
      // opened before its page had loaded: the cursor goes in once it has
      [
        'did-stop-loading',
        () => {
          if (!focusOnLoad.current) return;
          focusOnLoad.current = false;
          setTimeout(() => focusField(w), 300);
        },
      ],
      ['page-title-updated', (e) => setUnread(t.id, unreadOf(e.title))],
      ['did-start-loading', () => useTools.getState().setPage(t.id, { loading: true })],
      ['did-stop-loading', () => useTools.getState().setPage(t.id, { loading: false })],
      ['did-navigate', (e) => useTools.getState().setPage(t.id, { url: e.url })],
      ['did-navigate-in-page', (e) => e.isMainFrame && useTools.getState().setPage(t.id, { url: e.url })],
      ['page-favicon-updated', (e) => e.favicons?.[0] && setIcon(t.id, e.favicons[0])],
      // sound from its page (music, a video): its button shows it while it plays, drawer open or not
      ['media-started-playing', () => useTools.getState().setPlaying(t.id, true)],
      ['media-paused', () => useTools.getState().setPlaying(t.id, false)],
    ];
    for (const [k, f] of on) w.addEventListener(k, f);
    return () => {
      for (const [k, f] of on) w.removeEventListener(k, f);
      pages.delete(t.id);
      if (wcId) toolOfPage.delete(wcId);
      useTools.getState().setPlaying(t.id, false);
    };
  }, [t.id]);

  // opened: the cursor goes in its page, where you'd type (once it has loaded)
  useEffect(() => {
    const w = el.current;
    if (!visible || !w) return;
    if (!ready.current) return void (focusOnLoad.current = true);
    // (after the drawer has drawn it: a hidden webview can't take the keyboard)
    const id = setTimeout(() => focusField(w), 60);
    return () => clearTimeout(id);
  }, [visible]);

  // asked to show a page (Slack at a conversation, say)
  useEffect(() => {
    if (!go || go.n === seen.current) return;
    seen.current = go.n;
    const w = el.current;
    if (w && ready.current) void w.loadURL(go.url).catch(() => {});
  }, [go?.n]);

  return <webview ref={el as never} className={visible ? '' : 'off'} src={first.current} partition={WEB_PARTITION} {...({ allowpopups: 'true' } as object)} />;
}

/** The keyboard into a Tool's page, and its cursor where you'd type (FOCUS_FIELD). */
function focusField(w: Webview): void {
  if (w.classList.contains('off')) return;
  w.focus();
  void w.executeJavaScript(FOCUS_FIELD).catch(() => {});
}

/** Ctrl+F in a Tool's page (or in the drawer): find in that page. */
export const openToolFind = () => window.dispatchEvent(new Event('cora:tool-find'));

/**
 * The Tools drawer: slides out over the scene from the left nav, with the session's transcript and terminal still
 * beside it. Drag its right edge to resize; Esc or the tool's button closes it; its pages keep running while closed.
 */
export function ToolDrawer() {
  const tools = useBrain((s) => s.prefs.tools);
  const width = useBrain((s) => s.prefs.toolWidth);
  const open = useTools((s) => s.open);
  const mounted = useTools((s) => s.mounted);
  const box = useRef<HTMLDivElement>(null);
  const tool = tools.find((t) => t.id === open);
  const builtin = open === NOTES_ID || open === BROWSER_ID || open === SECRETS_ID || open === LIBRARY_ID || open === WHITEBOARD_ID;
  const whiteboard = open === WHITEBOARD_ID;
  // the Whiteboard can take nearly the whole width while you draw
  const [wide, setWide] = useState(false);
  const secrets = open === SECRETS_ID;
  const library = open === LIBRARY_ID;
  const browser = open === BROWSER_ID;
  const at = useTools((s) => (open ? s.page[open] : undefined));
  const [dragging, setDragging] = useState(false);
  // find in the tool's page (Ctrl+F): open, and each press focuses it again; another tool closes it
  const [finding, setFinding] = useState(0);
  useEffect(() => {
    const go = () => setFinding((n) => n + 1);
    window.addEventListener('cora:tool-find', go);
    return () => window.removeEventListener('cora:tool-find', go);
  }, []);
  useEffect(() => setFinding(0), [open]);
  // Ctrl+F with the drawer's own header focused (not the page: that one comes from the desktop app)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f' || !box.current?.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      if (useTools.getState().open === BROWSER_ID) openFind(currentGroup());
      else openToolFind();
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, []);
  // Windows' buttons sit over the window's top-right corner: a drawer reaching under them keeps its header's buttons clear
  const [under, setUnder] = useState(0);
  useEffect(() => {
    const el = box.current;
    const wco = (navigator as { windowControlsOverlay?: { visible: boolean; getTitlebarAreaRect(): DOMRect; addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void } }).windowControlsOverlay;
    if (!open || !el || !wco) return;
    const fit = () => {
      if (!wco.visible) return setUnder(0);
      const r = wco.getTitlebarAreaRect();
      setUnder(Math.max(0, Math.ceil(el.getBoundingClientRect().right - (r.x + r.width))));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    window.addEventListener('resize', fit);
    wco.addEventListener('geometrychange', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
      wco.removeEventListener('geometrychange', fit);
    };
  }, [open]);
  const headPad = under ? { paddingRight: 8 + under } : undefined;

  // Esc closes it (while the app has the keyboard; a page in it keeps its own Esc)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = document.activeElement;
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return;
      useTools.getState().close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  // a tool removed in Settings drops its page
  useEffect(() => {
    for (const id of Object.keys(mounted)) if (!id.startsWith('cora:') && !tools.some((t) => t.id === id)) useTools.getState().forget(id);
  }, [tools, mounted]);
  // which sites may notify (the desktop app lets tools' pages show Windows notifications, not other pages)
  useEffect(() => {
    desktop?.setToolHosts?.(tools.map((t) => toolHost(t.url)).filter(Boolean));
  }, [tools]);

  if (!Object.keys(mounted).length || (!desktop?.browser && !mounted[NOTES_ID] && !mounted[SECRETS_ID] && !mounted[LIBRARY_ID] && !mounted[WHITEBOARD_ID])) return null;
  const page = () => (open ? pages.get(open) : undefined);
  const resize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = box.current?.offsetWidth ?? width;
    const max = (box.current?.parentElement?.clientWidth ?? 1200) - 160;
    document.body.classList.add('ui-dragging');
    setDragging(true);
    const move = (ev: PointerEvent) => box.current && (box.current.style.width = `${Math.max(320, Math.min(max, startW + ev.clientX - startX))}px`);
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('ui-dragging');
      setDragging(false);
      useBrain.getState().setPrefs({ toolWidth: Math.round(Math.max(320, Math.min(max, startW + ev.clientX - startX))) });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const popOut = () => {
    if (!tool) return;
    const url = page()?.getURL() || tool.url;
    desktop?.toolWindow?.(url, tool.name);
    // one copy of it: its own window now
    useTools.getState().forget(tool.id);
  };

  return (
    <div className={`tool-drawer${open ? ' on' : ''}${dragging ? ' dragging' : ''}${whiteboard && wide ? ' wide' : ''}`} ref={box} style={{ width }} aria-hidden={!open}>
      {builtin ? (
        <div className="td-h" style={headPad}>
          <span className="td-tile cora">
            <Icon name={browser ? 'Globe' : secrets ? 'KeyRound' : library ? 'LibraryBig' : whiteboard ? 'Presentation' : 'NotebookPen'} size={13} />
          </span>
          <b>{browser ? 'Browser' : secrets ? 'Secrets' : library ? 'Library' : whiteboard ? 'Whiteboard' : 'Notes'}</b>
          <span className="td-host">{browser ? '' : secrets ? 'encrypted on this PC' : library ? 'everything your sessions made' : whiteboard ? '~/.cora/boards' : '~/.cora/notes'}</span>
          <span className="spacer" />
          {whiteboard ? (
            <button className="icon-btn" title={wide ? 'Back to the drawer’s width' : 'Wider, for drawing'} onClick={() => setWide(!wide)}>
              <Icon name={wide ? 'Minimize2' : 'Maximize2'} size={14} />
            </button>
          ) : null}
          <button className="icon-btn" title="Close (Esc)" onClick={() => useTools.getState().close()}>
            <Icon name="X" size={15} />
          </button>
        </div>
      ) : (
      <div className="td-h" style={headPad}>
        {tool ? (
          <span className="td-tile">
            <ToolGlyph t={tool} size={14} />
          </span>
        ) : null}
        <b>{tool?.name}</b>
        <span className="td-host">{toolHost(at?.url || tool?.url || '')}</span>
        <span className="spacer" />
        <button className="icon-btn" title="Back" onClick={() => page()?.goBack()}>
          <Icon name="ArrowLeft" size={14} />
        </button>
        <button className="icon-btn" title="Forward" onClick={() => page()?.goForward()}>
          <Icon name="ArrowRight" size={14} />
        </button>
        <button className="icon-btn" title={at?.loading ? 'Stop' : 'Reload'} onClick={() => (at?.loading ? page()?.stop() : page()?.reload())}>
          <Icon name={at?.loading ? 'X' : 'RotateCw'} size={14} />
        </button>
        {/* back to the page you set for it (Settings › Tools) */}
        <button className="icon-btn" title={tool ? `Home: ${tool.url}` : 'Home'} disabled={!tool} onClick={() => tool && void page()?.loadURL(tool.url).catch(() => {})}>
          <Icon name="House" size={14} />
        </button>
        <span className="td-vr" />
        <button className="icon-btn" title="Open in your browser" onClick={() => tool && desktop?.openExternal?.(page()?.getURL() || tool.url)}>
          <Icon name="ExternalLink" size={14} />
        </button>
        {desktop?.toolWindow ? (
          <button className="icon-btn" title="Pop out into its own window" onClick={popOut}>
            <Icon name="PictureInPicture2" size={14} />
          </button>
        ) : null}
        <button className="icon-btn" title="Close (Esc)" onClick={() => useTools.getState().close()}>
          <Icon name="X" size={15} />
        </button>
      </div>
      )}
      <div className="td-body">
        {at?.loading && !builtin ? <div className="td-progress" /> : null}
        {finding && open && !builtin && pages.get(open) ? <FindBar press={finding} page={pages.get(open) as never} onClose={() => setFinding(0)} /> : null}
        {mounted[NOTES_ID] ? <NotesPane visible={open === NOTES_ID} /> : null}
        {mounted[SECRETS_ID] ? <SecretsPane visible={secrets} /> : null}
        {mounted[LIBRARY_ID] ? <LibraryPane visible={library} /> : null}
        {mounted[WHITEBOARD_ID] ? (
          <Suspense fallback={<div className="wb-empty">Opening the whiteboard…</div>}>
            <WhiteboardPane visible={whiteboard} />
          </Suspense>
        ) : null}
        {mounted[BROWSER_ID] && desktop?.browser ? <BrowserTool visible={browser} /> : null}
        {tools
          .filter((t) => desktop?.browser && mounted[t.id])
          .map((t) => (
            <ToolPage key={t.id} t={t} visible={open === t.id} />
          ))}
      </div>
      <div className="td-resize" onPointerDown={resize} title="Drag to resize" />
    </div>
  );
}

/** Ctrl+1…9 opens (or closes) the tools in order; Ctrl+Shift+N, Notes. */
export function useToolKeys(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Shift+N: Cora's Notes
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyN') {
        e.preventDefault();
        e.stopPropagation();
        return openNotes();
      }
      // Ctrl+Shift+B: Cora's Browser
      if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === 'KeyB' && desktop?.browser) {
        e.preventDefault();
        e.stopPropagation();
        return openBrowser();
      }
      if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || !/^Digit[1-9]$/.test(e.code)) return;
      const t = useBrain.getState().prefs.tools[Number(e.code.slice(5)) - 1];
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      openTool(t);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}
