import { useEffect, useRef, useState } from 'react';
import { useBrain } from '../state/store';
import { useTools } from '../state/tools';
import { useWeb } from '../state/web';
import { NOTES_ID, notesUnseen, useNotes } from '../state/notes';
import { NotesPane } from './Notes';
import { desktop } from '../lib/desktop';
import { toolEntries, toolHost, toolSite, unreadOf, type ToolDef, type ToolEntry } from '../lib/tools';
import { BrowserTool, WEB_PARTITION, openFind } from './WebPane';
import { BROWSER_ID, currentGroup, isBrowserGroup } from '../state/browser';
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
};

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
        <div className="rt-card">
          {entries.map((e) => (e.kind === 'tool' ? <ToolRow key={e.t.id} t={e.t} n={e.n} on={open === e.t.id} u={unread[e.t.id]} /> : <FolderRows key={`f:${e.name}`} name={e.name} tools={e.tools} open={open} unread={unread} />))}
          <button className="rt-r rt-more" onClick={() => openSettings('tools')}>
            <span className="rt-plus">
              <Icon name="Plus" size={12} />
            </span>
            <span className="rt-nm">
              <b>Add a tool</b>
            </span>
          </button>
        </div>
      ) : null}
      {expanded ? (
        <>
          <div className="rt-sub left">Cora</div>
          <div className="rt-card">
            <NotesRow on={open === NOTES_ID} />
            {desktop?.browser ? <BrowserRow on={open === BROWSER_ID} /> : null}
          </div>
        </>
      ) : null}
      {expanded ? null : (
        <div className="rt-row">
          {entries.map((e) =>
            e.kind === 'tool' ? (
              <button key={e.t.id} className={`rt-b${open === e.t.id ? ' on' : ''}`} title={`${e.t.name}${e.n < 9 ? ` (Ctrl+${e.n + 1})` : ''}`} onClick={() => openTool(e.t)}>
                <ToolIcon t={e.t} size={22} />
                {badge(unread[e.t.id])}
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
                  <span key={t.id} className="rt-mini" style={t.tint ? ({ ['--tc' as string]: t.tint } as React.CSSProperties) : undefined}>
                    <ToolGlyph t={t} size={10} />
                  </span>
                ))}
                {badge(folderNews(e.tools))}
              </button>
            ),
          )}
          {pop ? <FolderPop name={pop} entry={entries.find((e) => e.kind === 'folder' && e.name === pop) as Extract<ToolEntry, { kind: 'folder' }> | undefined} open={open} unread={unread} onClose={() => setPop(null)} /> : null}
        </div>
      )}
      {expanded ? null : (
        <>
          <div className="rt-sub">Cora</div>
          <div className="rt-row">
            <NotesButton on={open === NOTES_ID} />
            {desktop?.browser ? <BrowserButton on={open === BROWSER_ID} /> : null}
          </div>
        </>
      )}
    </div>
  );
}

const openNotes = () => useTools.getState().toggle(NOTES_ID);
const openBrowser = () => (useBrain.getState().setInbox(false), useTools.getState().toggle(BROWSER_ID));

/** Cora's Browser in the icon row. */
function BrowserButton({ on }: { on: boolean }) {
  return (
    <button className={`rt-b rt-cora${on ? ' on' : ''}`} title="Browser (Ctrl+Shift+B)" onClick={openBrowser}>
      <Icon name="Globe" size={18} />
    </button>
  );
}

/** Cora's Browser as a named row: how many tabs it has open. */
function BrowserRow({ on }: { on: boolean }) {
  // every profile's tabs
  const n = useWeb((w) => Object.entries(w.sessions).reduce((k, [g, sw]) => k + (isBrowserGroup(g) ? sw.tabs.filter((id) => w.tabs[id]?.url).length : 0), 0));
  return (
    <button className={`rt-r${on ? ' on' : ''}`} title="Browser (Ctrl+Shift+B)" onClick={openBrowser}>
      <span className="rt-cora-ico">
        <Icon name="Globe" size={14} />
      </span>
      <span className="rt-nm">
        <b>Browser</b>
        <i>{n ? `${n} tab${n === 1 ? '' : 's'}` : 'No tabs open'}</i>
      </span>
      <span className="rt-rr">
        <span className="rt-k">^⇧B</span>
      </span>
    </button>
  );
}

/** Cora's Notes in the icon row: Cora's colour, a dot while a session's addition is unseen. */
function NotesButton({ on }: { on: boolean }) {
  const unseen = useNotes((s) => notesUnseen(s.list));
  const flash = useNotes((s) => s.flash);
  const [lit, setLit] = useState(false);
  useEffect(() => {
    if (!flash) return;
    setLit(true);
    const t = setTimeout(() => setLit(false), 1400);
    return () => clearTimeout(t);
  }, [flash]);
  return (
    <button className={`rt-b rt-cora${on ? ' on' : ''}${lit ? ' flash' : ''}`} title="Notes (Ctrl+Shift+N) · jot from anywhere: Ctrl+Alt+N" onClick={openNotes}>
      <Icon name="NotebookPen" size={18} />
      {unseen ? <span className="rt-badge dot cora" /> : null}
    </button>
  );
}

/** Cora's Notes as a named row. */
function NotesRow({ on }: { on: boolean }) {
  const unseen = useNotes((s) => notesUnseen(s.list));
  const n = useNotes((s) => s.list.find((x) => x.kind === 'scratch')?.count ?? 0);
  return (
    <button className={`rt-r${on ? ' on' : ''}`} title="Notes (Ctrl+Shift+N) · jot from anywhere: Ctrl+Alt+N" onClick={openNotes}>
      <span className="rt-cora-ico">
        <Icon name="NotebookPen" size={14} />
      </span>
      <span className="rt-nm">
        <b>Notes</b>
        <i>Scratch · {n} jot{n === 1 ? '' : 's'}</i>
      </span>
      <span className="rt-rr">{unseen ? <span className="rt-pdot" title="A session added something" /> : <span className="rt-k">^⇧N</span>}</span>
    </button>
  );
}

/** A tool's icon with its look: its tile tinted, its tag on the corner. */
function ToolIcon({ t, size }: { t: ToolDef; size: number }) {
  return (
    <span className={`rt-ico${t.tint ? ' tinted' : ''}`} style={t.tint ? ({ ['--tc' as string]: t.tint } as React.CSSProperties) : undefined}>
      <ToolGlyph t={t} size={size} />
      {t.tag ? <span className="rt-tag">{t.tag}</span> : null}
    </span>
  );
}

/** A tool as a named row (the names view, and a folder opened from the icon row). */
function ToolRow({ t, n, on, u, onPick }: { t: ToolDef; n: number; on: boolean; u: number | 'dot' | undefined; onPick?: () => void }) {
  return (
    <button className={`rt-r${on ? ' on' : ''}`} title={`${t.name}: ${t.url}`} onClick={() => (openTool(t), onPick?.())}>
      <ToolIcon t={t} size={22} />
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
        },
      ],
      ['page-title-updated', (e) => setUnread(t.id, unreadOf(e.title))],
      ['did-start-loading', () => useTools.getState().setPage(t.id, { loading: true })],
      ['did-stop-loading', () => useTools.getState().setPage(t.id, { loading: false })],
      ['did-navigate', (e) => useTools.getState().setPage(t.id, { url: e.url })],
      ['did-navigate-in-page', (e) => e.isMainFrame && useTools.getState().setPage(t.id, { url: e.url })],
      ['page-favicon-updated', (e) => e.favicons?.[0] && setIcon(t.id, e.favicons[0])],
    ];
    for (const [k, f] of on) w.addEventListener(k, f);
    return () => {
      for (const [k, f] of on) w.removeEventListener(k, f);
      pages.delete(t.id);
      if (wcId) toolOfPage.delete(wcId);
    };
  }, [t.id]);

  // asked to show a page (Slack at a conversation, say)
  useEffect(() => {
    if (!go || go.n === seen.current) return;
    seen.current = go.n;
    const w = el.current;
    if (w && ready.current) void w.loadURL(go.url).catch(() => {});
  }, [go?.n]);

  return <webview ref={el as never} className={visible ? '' : 'off'} src={first.current} partition={WEB_PARTITION} {...({ allowpopups: 'true' } as object)} />;
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
  const builtin = open === NOTES_ID || open === BROWSER_ID;
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

  if (!Object.keys(mounted).length || (!desktop?.browser && !mounted[NOTES_ID])) return null;
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
    <div className={`tool-drawer${open ? ' on' : ''}${dragging ? ' dragging' : ''}`} ref={box} style={{ width }} aria-hidden={!open}>
      {builtin ? (
        <div className="td-h" style={headPad}>
          <span className="td-tile cora">
            <Icon name={browser ? 'Globe' : 'NotebookPen'} size={13} />
          </span>
          <b>{browser ? 'Browser' : 'Notes'}</b>
          <span className="td-host">{browser ? '' : '~/.cora/notes'}</span>
          <span className="spacer" />
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
