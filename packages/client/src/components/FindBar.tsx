import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

/** What the bar needs of a page (a <webview>): finding, and being told what was found. */
export type Findable = {
  findInPage(text: string, o?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }): number;
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void;
  addEventListener(type: string, f: (e: any) => void): void;
  removeEventListener(type: string, f: (e: any) => void): void;
};

/** Clear a page's find highlights (a page already gone has none). */
function clear(page: Findable): void {
  try {
    page.stopFindInPage('clearSelection');
  } catch {
    /* gone */
  }
}
const pageId = (page: Findable): number | null => {
  try {
    return (page as unknown as { getWebContentsId(): number }).getWebContentsId();
  } catch {
    return null;
  }
};

/**
 * Find in page (Ctrl+F), for Cora's browser and the Tools drawer: matches as you type, Enter / Shift+Enter step
 * through them, Esc closes and clears the highlights. `page`: the page on show (it follows tab switches); `press`
 * changes with each Ctrl+F.
 */
export function FindBar({ page, onClose, press }: { page: Findable | undefined; onClose(): void; /** each Ctrl+F: focus it again, what's typed selected */ press: number }) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<{ at: number; of: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [press]);
  // what the page found (its last update for each search); leaving a page (another tab, the bar closed or hidden)
  // clears its highlights, so none are ever left behind
  useEffect(() => {
    if (!page) return;
    const on = (e: { result?: { finalUpdate?: boolean; activeMatchOrdinal?: number; matches?: number } }) => e.result?.finalUpdate !== false && setFound({ at: e.result?.activeMatchOrdinal ?? 0, of: e.result?.matches ?? 0 });
    page.addEventListener('found-in-page', on);
    setFound(null);
    if (text) page.findInPage(text);
    return () => {
      page.removeEventListener('found-in-page', on);
      clear(page);
    };
    // a new page (another tab): search it for what's typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  const close = () => {
    if (page) clear(page);
    onClose();
  };
  // Esc in the page itself closes it too, as in Chrome (the desktop app tells us which page)
  useEffect(() => {
    const esc = (e: Event) => {
      const from = (e as CustomEvent<number>).detail;
      if (page && pageId(page) === from) close();
    };
    window.addEventListener('cora:find-esc', esc);
    return () => window.removeEventListener('cora:find-esc', esc);
  });
  const step = (forward: boolean) => text && page?.findInPage(text, { forward, findNext: true });
  return (
    <div className="web-find">
      <input
        ref={input}
        value={text}
        placeholder="Find in page"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (!page) return;
          if (e.target.value) page.findInPage(e.target.value);
          else (page.stopFindInPage('clearSelection'), setFound(null));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          else if (e.key === 'Enter') step(!e.shiftKey);
        }}
      />
      <span className="wf-n">{text ? (found ? `${found.at}/${found.of}` : '0/0') : ''}</span>
      <button className="ib" disabled={!text} onClick={() => step(false)} title="Previous (Shift+Enter)">
        <Icon name="ChevronUp" size={14} />
      </button>
      <button className="ib" disabled={!text} onClick={() => step(true)} title="Next (Enter)">
        <Icon name="ChevronDown" size={14} />
      </button>
      <button className="ib" onClick={close} title="Close (Esc)">
        <Icon name="X" size={13} />
      </button>
    </div>
  );
}
