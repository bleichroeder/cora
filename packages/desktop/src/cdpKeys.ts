/**
 * Playwright's keyboard (CDP Input.dispatchKeyEvent), as Electron's input events for one page
 * (webContents.sendInputEvent). Through a <webview>'s debugger CDP's keys never arrive (only a focused page gets
 * them, and Cora's tabs needn't be: you may be typing elsewhere); Electron's go straight to that page.
 */
export type CdpKey = { type: 'keyDown' | 'rawKeyDown' | 'keyUp' | 'char'; key?: string; code?: string; text?: string; modifiers?: number; autoRepeat?: boolean };
export type ElectronKey = { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers: Array<'alt' | 'control' | 'meta' | 'shift' | 'isAutoRepeat'> };

/** DOM key names Electron spells its own way. */
const NAMES: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', ' ': 'Space', Escape: 'Escape', Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert' };

export function electronKeys(p: CdpKey): ElectronKey[] {
  const modifiers: ElectronKey['modifiers'] = [];
  const m = p.modifiers ?? 0;
  if (m & 1) modifiers.push('alt');
  if (m & 2) modifiers.push('control');
  if (m & 4) modifiers.push('meta');
  if (m & 8) modifiers.push('shift');
  if (p.autoRepeat) modifiers.push('isAutoRepeat');
  const key = p.key ?? p.text ?? '';
  const keyCode = NAMES[key] ?? key;
  if (p.type === 'char') return p.text ? [{ type: 'char', keyCode: p.text, modifiers }] : [];
  if (!keyCode) return [];
  if (p.type === 'keyUp') return [{ type: 'keyUp', keyCode, modifiers }];
  // a key that types (keyDown with text): its character too, as Chrome makes one from it
  return [{ type: 'keyDown', keyCode, modifiers }, ...(p.type === 'keyDown' && p.text ? [{ type: 'char' as const, keyCode: p.text, modifiers }] : [])];
}
