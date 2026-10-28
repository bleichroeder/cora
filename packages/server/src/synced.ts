import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * Your Cora's look, the same on every device: the screen's own settings (the layout, the board's pages, the tools,
 * the scene, Cora's colour, what's folded, each session's voice, drafts...) that each browser keeps, kept here too so a
 * device you use Cora on gets yours, not the defaults. Only the keys a screen syncs (SYNCED_KEYS); a key's value is
 * the browser's own string. Device-only things (browser profiles, web tabs, shells, the mic) never come here.
 */
export const SYNCED_KEYS = new Set([
  'ab:ui',
  'ab:tool-icons',
  'ab:composer',
  'ab:jira',
  'ab:palette.recent',
  'ab:security-seen',
  'cora.debriefs.seen',
  'cora.notes.open',
  'cora.recap.hidden',
  'cora.switch.mru',
  'cora.tools.expanded',
  'cora.tools.folded',
  'cora.rail.folded',
  'cora.session.voice',
  'cora.vibes.placed',
  'cora:golf',
  'cora.setup.ok',
]);
const MAX_VALUE = 2 * 1024 * 1024;

/**
 * Go live: what a guest's screen takes of your look, to see Cora as you do (read only). The visual part only: the
 * layout and boards ('ab:ui', without your Tools list, shells or the IDE's place), what's folded in the nav, the stickers.
 * Never your drafts, searches, Jira cache, what you've seen, or your notes.
 */
const GUEST_KEYS = new Set(['ab:ui', 'cora.rail.folded', 'cora.vibes.placed']);
const UI_PRIVATE = ['tools', 'defaultShell', 'toolWidth'];
export function lookForGuest(key: string, value: string | null): string | null | undefined {
  if (!GUEST_KEYS.has(key)) return undefined;
  if (value == null || key !== 'ab:ui') return value;
  try {
    const ui = JSON.parse(value) as Record<string, unknown>;
    for (const k of UI_PRIVATE) delete ui[k];
    return JSON.stringify(ui);
  } catch {
    return undefined;
  }
}

export class Synced {
  private values: Record<string, string> = {};
  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const j = JSON.parse(readFileSync(file, 'utf8')) as { values?: Record<string, unknown> };
        for (const [k, v] of Object.entries(j.values ?? {})) if (SYNCED_KEYS.has(k) && typeof v === 'string') this.values[k] = v;
      } catch {
        /* a broken file: start over (each screen still has its own) */
      }
    }
  }

  all(): Record<string, string> {
    return { ...this.values };
  }
  /** a guest's (Go live) share of it: the look, read only */
  forGuest(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.values)) {
      const g = lookForGuest(k, v);
      if (typeof g === 'string') out[k] = g;
    }
    return out;
  }

  /** A screen's new value for a key (null: gone). False: not a key that syncs, or too big. */
  set(key: string, value: string | null): boolean {
    if (!SYNCED_KEYS.has(key) || (value != null && (typeof value !== 'string' || value.length > MAX_VALUE))) return false;
    if (value == null) delete this.values[key];
    else this.values[key] = value;
    this.save();
    return true;
  }

  private save(): void {
    if (!this.file) return;
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ values: this.values }));
    renameSync(tmp, this.file);
  }
}
