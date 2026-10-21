import { describe, expect, it, vi } from 'vitest';
import { menuItems, quote, searchUrl } from '../src/contextMenu';

// the menu's choices are plain data; Electron itself isn't needed (vi.mock is hoisted above the import)
vi.mock('electron', () => ({ clipboard: {}, Menu: {}, shell: {} }));
type P = Parameters<typeof menuItems>[0];

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };
const params = (o: Partial<P> = {}): P => ({
  isEditable: false,
  editFlags: flags,
  selectionText: '',
  misspelledWord: '',
  dictionarySuggestions: [],
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  hasImageContents: false,
  pageURL: 'https://example.com/a',
  formControlType: 'none',
  ...o,
});
const web = { web: true, canGoBack: true, canGoForward: false };
const app = { web: false };
/** the menu as text: labels, "-" for separators, "(off)" for disabled items */
const show = (p: P, f: Parameters<typeof menuItems>[1]) => menuItems(p, f).map((m) => ('separator' in m ? '-' : m.enabled === false ? `${m.label} (off)` : m.label));

describe('context menu items', () => {
  it('a page with nothing under the cursor: navigation, its address, Inspect', () => {
    expect(show(params(), web)).toEqual(['Back', 'Forward (off)', 'Reload', '-', 'Copy page address', 'Open page in your browser', '-', 'Inspect']);
  });

  it('the dashboard shows nothing for a plain click', () => {
    expect(menuItems(params({ pageURL: 'http://127.0.0.1:4317/' }), app)).toEqual([]);
  });

  it('a link: new tab, your browser, copy address — no page items', () => {
    const items = menuItems(params({ linkURL: 'https://x.dev/p' }), web);
    expect(show(params({ linkURL: 'https://x.dev/p' }), web)).toEqual(['Open link in new tab', 'Open link in your browser', 'Copy link address', '-', 'Inspect']);
    expect(items[0]).toMatchObject({ action: 'openLinkTab', value: 'https://x.dev/p' });
  });

  it('a mailto link copies the address only', () => {
    const items = menuItems(params({ linkURL: 'mailto:a%40b.com?subject=hi' }), web);
    expect(show(params({ linkURL: 'mailto:a@b.com' }), web)).toEqual(['Copy email address', '-', 'Inspect']);
    expect(items[0]).toMatchObject({ action: 'copyLink', value: 'a@b.com' });
  });

  it('an image (inside a link): link items, then image items', () => {
    const p = params({ linkURL: 'https://x.dev/p', mediaType: 'image', srcURL: 'https://x.dev/i.png', hasImageContents: true });
    expect(show(p, web)).toEqual([
      'Open link in new tab',
      'Open link in your browser',
      'Copy link address',
      '-',
      'Open image in new tab',
      'Copy image',
      'Copy image address',
      '-',
      'Inspect',
    ]);
  });

  it("a data: image can be copied but not opened in a tab", () => {
    expect(show(params({ mediaType: 'image', srcURL: 'data:image/png;base64,AA', hasImageContents: false }), web)).toEqual(['Copy image (off)', 'Copy image address', '-', 'Inspect']);
  });

  it('selected text: Copy and a Google search', () => {
    const items = menuItems(params({ selectionText: '  hello\n world & co ' }), web);
    expect(show(params({ selectionText: '  hello\n world & co ' }), web)).toEqual(['Copy', '-', 'Search Google for “hello world && co”', '-', 'Inspect']);
    expect(items.find((m) => 'action' in m && m.action === 'search')).toMatchObject({ value: 'hello\n world & co' });
  });

  it('selected text in the dashboard: Copy, and Add to Scratch', () => {
    expect(show(params({ selectionText: 'abc' }), app)).toEqual(['Copy', '-', 'Add to Scratch']);
    expect(menuItems(params({ selectionText: ' abc ' }), app).find((m) => 'action' in m && m.action === 'jot')).toMatchObject({ value: 'abc' });
    expect(show(params({ selectionText: 'abc' }), web)).not.toContain('Add to Scratch');
  });

  it('a text field in a page: undo/redo, then clipboard, enabled by the edit flags', () => {
    expect(show(params({ isEditable: true, formControlType: 'input-text' }), web)).toEqual([
      'Undo',
      'Redo (off)',
      '-',
      'Cut',
      'Copy',
      'Paste',
      'Paste as plain text',
      'Select all',
      '-',
      'Inspect',
    ]);
  });

  it('a text field in the dashboard: cut/copy/paste/select all', () => {
    expect(show(params({ isEditable: true, editFlags: { ...flags, canCut: false, canCopy: false } }), app)).toEqual(['Cut (off)', 'Copy (off)', 'Paste', 'Select all']);
  });

  it('a misspelled word: suggestions and Add to dictionary first, no search', () => {
    const p = params({ isEditable: true, selectionText: 'teh', misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'tee', 'tel'] });
    expect(show(p, app)).toEqual(['the', 'ten', 'tea', 'tech', 'tee', 'Add to dictionary', '-', 'Cut', 'Copy', 'Paste', 'Select all']);
    const items = menuItems(p, web);
    expect(items[0]).toMatchObject({ action: 'replace', value: 'the' });
    expect(items.find((m) => 'action' in m && m.action === 'learn')).toMatchObject({ value: 'teh' });
    expect(items.some((m) => 'action' in m && m.action === 'search')).toBe(false);
  });

  it('a misspelled word with no suggestions says so', () => {
    expect(show(params({ isEditable: true, misspelledWord: 'qzxv' }), app).slice(0, 3)).toEqual(['No spelling suggestions (off)', 'Add to dictionary', '-']);
  });

  it('a selection in a text field can be searched, but not a password', () => {
    expect(show(params({ isEditable: true, selectionText: 'cora' }), web)).toContain('Search Google for “cora”');
    expect(show(params({ isEditable: true, selectionText: 'secret', formControlType: 'input-password' }), web).join()).not.toContain('Search');
  });

  it('quotes long selections short and builds the search address', () => {
    expect(quote('a'.repeat(40))).toBe(`${'a'.repeat(31)}…`);
    expect(searchUrl(' a&b c ')).toBe('https://www.google.com/search?q=a%26b%20c');
  });
});
