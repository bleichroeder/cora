import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CORA_COLOR, isCoraColor } from '@cora/shared';
import { coraIco } from './icons';

/**
 * Cora's colour, kept by the desktop app for its next start: the window's icon and the splash come before the
 * dashboard (which keeps the choice and tells the app).
 */
const file = (dataDir: string) => join(dataDir, 'look.json');

export function readCoraColor(dataDir: string): string {
  try {
    const c = (JSON.parse(readFileSync(file(dataDir), 'utf8')) as { coraColor?: unknown }).coraColor;
    return isCoraColor(c) ? c.toLowerCase() : DEFAULT_CORA_COLOR;
  } catch {
    return DEFAULT_CORA_COLOR;
  }
}

export function saveCoraColor(dataDir: string, color: string): void {
  try {
    writeFileSync(file(dataDir), JSON.stringify({ coraColor: color }));
  } catch {
    /* next start is teal */
  }
}

/**
 * Cora's icon file in its colour (the Start-menu shortcut's, which the taskbar shows): one file per colour, so
 * Windows never shows a cached icon for a path whose file changed. The other colours' files go.
 */
export function coraIcoFile(dataDir: string, color: string): string | null {
  const name = `cora-${color.slice(1).toLowerCase()}.ico`;
  const f = join(dataDir, name);
  try {
    if (!existsSync(f)) writeFileSync(f, coraIco(color));
    for (const old of readdirSync(dataDir)) if (/^cora-[0-9a-f]{6}\.ico$/.test(old) && old !== name) rmSync(join(dataDir, old), { force: true });
    return f;
  } catch {
    return null;
  }
}
