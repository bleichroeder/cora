import { useEffect, useRef, useState, type ReactNode } from 'react';
import { BOARD_LAYOUTS, BOARD_LAYOUT_INFO } from '@cora/shared';
import { LAYOUTS, MAX_PAGES, PANELS, type SavedLayout } from '../../lib/boardLayout';
import { Icon } from '../Icon';

/** Something the Board did that you'd want to know, in its bar: `go` offers that page; `undo` puts the Board back. */
export type BoardNote = { text: string; icon: string; go?: number; undo?: true; at: number };

type Placed = SavedLayout['items'];

/**
 * The Board's bar, along its foot: the pages as named tabs (click to go, double-click to rename; on hover a tab shows
 * its ⋯ menu beside the name (all tabs one width): rename, save as a layout, duplicate, move, remove; right-click works too; drag one to reorder; drag a panel onto one to send it there), ＋ for a new page (blank, or laid out for a
 * kind of work, or one of yours), then + Panel, and ⋯ for the Board as a whole.
 */
export function BoardBar(o: {
  pages: number;
  pg: number;
  names: Array<string | null>;
  /** a panel is being moved: the tabs (and ＋) take it */
  moving: boolean;
  dropPage?: number;
  note: BoardNote | null;
  onNote(): void;
  saved: SavedLayout[];
  onGo(n: number): void;
  onRename(n: number, name: string | null): void;
  onNewPage(layout?: { items: Placed; name: string }): void;
  onSaveLayout(n: number, name: string): void;
  onDeleteLayout(id: string): void;
  onDuplicate(n: number): void;
  onMove(from: number, to: number): void;
  onRemove(n: number): void;
  onTemplate(): void;
  onReset(): void;
  onSettings(): void;
  /** + Panel (its button and menu) */
  panel: ReactNode;
}) {
  const [renaming, setRenaming] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [tabMenu, setTabMenu] = useState<number | null>(null);
  const [savingAs, setSavingAs] = useState<string | null>(null);
  const [newMenu, setNewMenu] = useState(false);
  const [boardMenu, setBoardMenu] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const label = (n: number) => o.names[n] || `Page ${n + 1}`;
  const rename = (n: number) => {
    setTabMenu(null);
    setDraft(o.names[n] ?? '');
    setRenaming(n);
  };
  const doneRenaming = (keep: boolean) => {
    if (keep && renaming != null) o.onRename(renaming, draft.trim() || null);
    setRenaming(null);
  };
  const closeAll = () => (setTabMenu(null), setNewMenu(false), setBoardMenu(false), setSavingAs(null));
  return (
    <div className={`bd-add${o.moving ? ' moving' : ''}`} role="toolbar" aria-label="Board">
      <div className="bd-tabs" role="tablist">
        {Array.from({ length: o.pages }, (_, n) => (
          <span key={n} className="bd-tabw">
            {renaming === n ? (
              <span className="bd-tb bd-pg on renaming">
                <span className="num">{n + 1}</span>
                <input
                  autoFocus
                  value={draft}
                  maxLength={32}
                  placeholder={`Page ${n + 1}`}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => doneRenaming(true)}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') doneRenaming(true);
                    if (e.key === 'Escape') doneRenaming(false);
                  }}
                />
              </span>
            ) : (
              <button
                role="tab"
                aria-selected={n === o.pg}
                className={`bd-tb bd-pg${n === o.pg ? ' on' : ''}${o.dropPage === n ? ' drop' : ''}${dragging === n ? ' lifting' : ''}`}
                data-pg={n}
                title={n === o.pg ? `${label(n)}: double-click to rename, right-click for more` : o.moving ? `Drop here: send it to ${label(n)}` : label(n)}
                draggable={!o.moving}
                onDragStart={(e) => (setDragging(n), e.dataTransfer.setData('text/x-cora-page', String(n)), (e.dataTransfer.effectAllowed = 'move'))}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => dragging != null && dragging !== n && (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))}
                onDrop={(e) => {
                  const from = Number(e.dataTransfer.getData('text/x-cora-page'));
                  if (Number.isInteger(from) && from !== n) o.onMove(from, n);
                  setDragging(null);
                }}
                onClick={() => o.onGo(n)}
                onDoubleClick={() => rename(n)}
                onContextMenu={(e) => (e.preventDefault(), closeAll(), setTabMenu(n))}
              >
                <span className="num">{n + 1}</span>
                <span className="pn">{label(n)}</span>
                {/* on hover its menu shows beside the name (the name gives way: every tab stays one width) */}
                <span className={`acts${tabMenu === n ? ' open' : ''}`}>
                  <span className="act" role="button" title="More" aria-label={`${label(n)}: more`} onClick={(e) => (e.stopPropagation(), closeAll(), setTabMenu(tabMenu === n ? null : n))}>
                    <Icon name="Ellipsis" size={12} />
                  </span>
                </span>
              </button>
            )}
            {tabMenu === n ? (
              <Pop onClose={() => (setTabMenu(null), setSavingAs(null))} className="bd-tabmenu">
                {savingAs != null ? (
                  <label className="bd-mx bd-name">
                    <Icon name="Bookmark" size={13} />
                    <input
                      autoFocus
                      value={savingAs}
                      maxLength={40}
                      placeholder="Name this layout"
                      onChange={(e) => setSavingAs(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter' && savingAs.trim()) (o.onSaveLayout(n, savingAs.trim()), closeAll());
                        if (e.key === 'Escape') setSavingAs(null);
                      }}
                    />
                    <button className="lb-pop" disabled={!savingAs.trim()} onClick={() => savingAs.trim() && (o.onSaveLayout(n, savingAs.trim()), closeAll())}>
                      Save
                    </button>
                  </label>
                ) : (
                  <>
                    <button className="bd-mx" onClick={() => rename(n)}>
                      <Icon name="Pencil" size={13} /> Rename
                    </button>
                    <button className="bd-mx" onClick={() => setSavingAs(o.names[n] ?? '')}>
                      <Icon name="Bookmark" size={13} /> Save as a layout
                    </button>
                    <button className="bd-mx" disabled={o.pages >= MAX_PAGES} onClick={() => (closeAll(), o.onDuplicate(n))}>
                      <Icon name="Copy" size={13} /> Duplicate
                    </button>
                    <button className="bd-mx" disabled={n === 0} onClick={() => (closeAll(), o.onMove(n, n - 1))}>
                      <Icon name="ArrowLeft" size={13} /> Move left
                    </button>
                    <button className="bd-mx" disabled={n === o.pages - 1} onClick={() => (closeAll(), o.onMove(n, n + 1))}>
                      <Icon name="ArrowRight" size={13} /> Move right
                    </button>
                    <div className="sep" />
                    <button className="bd-mx bad" disabled={o.pages < 2} onClick={() => (closeAll(), o.onRemove(n))}>
                      <Icon name="Trash2" size={13} /> Remove page
                      <span className="d">{o.pages < 2 ? 'the only page' : 'Undo after'}</span>
                    </button>
                  </>
                )}
              </Pop>
            ) : null}
          </span>
        ))}
        {o.pages < MAX_PAGES ? (
          <span className="bd-tabw add">
            <button
              className={`bd-tb bd-pg new${o.dropPage === o.pages ? ' drop' : ''}${newMenu ? ' on' : ''}`}
              data-pg={o.moving ? o.pages : undefined}
              title={o.moving ? 'Drop here: a new page for it' : 'A new page: blank, or laid out for a kind of work'}
              onClick={() => (closeAll(), setNewMenu(!newMenu))}
            >
              <Icon name="Plus" size={13} />
            </button>
            {newMenu ? (
              <Pop onClose={() => setNewMenu(false)} className="bd-newmenu">
                <button className="bd-mx" onClick={() => (setNewMenu(false), o.onNewPage())}>
                  <Icon name="Square" size={13} /> Blank page
                  <span className="d">add panels yourself</span>
                </button>
                <div className="mh">Laid out for</div>
                <div className="bd-mgrid lay">
                  {BOARD_LAYOUTS.map((l) => (
                    <button key={l} className="bd-mt" onClick={() => (setNewMenu(false), o.onNewPage({ items: LAYOUTS[l].map((p, i) => ({ ...p, id: `${p.k}:${i}` })), name: BOARD_LAYOUT_INFO[l].name }))}>
                      <span className="ic">
                        <Icon name={BOARD_LAYOUT_INFO[l].icon} size={15} />
                      </span>
                      <span className="tx">
                        <b>{BOARD_LAYOUT_INFO[l].name}</b>
                        <span>{BOARD_LAYOUT_INFO[l].hint}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {o.saved.length ? <div className="mh">Yours</div> : null}
                {o.saved.map((l) => (
                  <div key={l.id} className="bd-mx yours" role="button" tabIndex={0} onClick={() => (setNewMenu(false), o.onNewPage({ items: l.items, name: l.name }))} onKeyDown={(e) => e.key === 'Enter' && (setNewMenu(false), o.onNewPage({ items: l.items, name: l.name }))}>
                    <Icon name="Bookmark" size={13} />
                    <span className="t">{l.name}</span>
                    <span className="d">{l.items.map((p) => (p.k === 'explain' ? 'explain' : PANELS[p.k].name)).join(', ')}</span>
                    <button className="del" title="Forget this layout" onClick={(e) => (e.stopPropagation(), o.onDeleteLayout(l.id))}>
                      <Icon name="X" size={12} />
                    </button>
                  </div>
                ))}
              </Pop>
            ) : null}
          </span>
        ) : null}
      </div>
      {o.note ? (
        <span className="bd-note">
          <Icon name={o.note.icon} size={13} />
          <span>{o.note.text}</span>
          {o.note.undo ? <button onClick={o.onNote}>Undo</button> : o.note.go != null && o.note.go !== o.pg ? <button onClick={o.onNote}>{label(o.note.go)}</button> : null}
        </span>
      ) : null}
      <span className="bd-sp" />
      <span className="bd-sep" />
      {o.panel}
      <span className="bd-tabw">
        <button className={`bd-tb${boardMenu ? ' on' : ''}`} title="The Board" aria-label="The Board" onClick={() => (closeAll(), setBoardMenu(!boardMenu))}>
          <Icon name="Ellipsis" size={14} />
        </button>
        {boardMenu ? (
          <Pop onClose={() => setBoardMenu(false)} className="bd-boardmenu right">
            <button className="bd-mx" onClick={() => (setBoardMenu(false), o.onTemplate())}>
              <Icon name="LayoutTemplate" size={13} /> Use this page for new sessions
              <span className="d">they start with it</span>
            </button>
            <button className="bd-mx" onClick={() => (setBoardMenu(false), o.onReset())}>
              <Icon name="RotateCcw" size={13} /> Reset the Board
              <span className="d">Undo after</span>
            </button>
            <div className="sep" />
            <button className="bd-mx" onClick={() => (setBoardMenu(false), o.onSettings())}>
              <Icon name="Settings" size={13} /> Sessions and the Board…
            </button>
          </Pop>
        ) : null}
      </span>
    </div>
  );
}

/** A menu over the bar: goes on a click elsewhere or Esc. */
function Pop({ children, onClose, className = '' }: { children: ReactNode; onClose(): void; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.parentElement?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [onClose]);
  return (
    <div className={`bd-menu bd-pop ${className}`} ref={box} role="menu">
      {children}
    </div>
  );
}
