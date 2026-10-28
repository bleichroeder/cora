/**
 * Your Cora's look on every device (server/src/synced.ts): the screen's own settings each browser keeps (the layout,
 * the board's pages, the tools, the scene, Cora's colour, what's folded, each session's voice, drafts...) also kept on
 * the server. A screen writes them as it always has (localStorage); the ones that sync go up as they change, and come
 * down when Cora opens on a device or moves to it. Device-only things (browser profiles, web tabs, shells, the mic)
 * stay on the device.
 */
export const SYNCED = new Set([
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

let on = false;
/**
 * Go live: a guest's screen is a mirror of the host's Cora. Their look is the host's, held while they're here: what
 * they change of it isn't kept (nor sent anywhere), and leaving takes it all away from their browser.
 */
let mirror = false;
export const isMirror = () => mirror;
export function beMirror(): void {
  mirror = true;
  // leaving (the tab closed, the share over): nothing of the host's stays in this browser
  window.addEventListener('pagehide', wipeSynced);
}
export function wipeSynced(): void {
  if (!store || !rawRemove) return;
  for (const key of SYNCED) rawRemove.call(store, key);
}
const queued = new Map<string, string | null>();
let timer: ReturnType<typeof setTimeout> | undefined;
const store = (() => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
})();
const rawSet = store ? Storage.prototype.setItem : null;
const rawRemove = store ? Storage.prototype.removeItem : null;

function push(): void {
  timer = undefined;
  const batch = [...queued];
  queued.clear();
  for (const [key, value] of batch)
    void fetch(`/api/synced/${encodeURIComponent(key)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value }) }).catch(() => {});
}
function queue(key: string, value: string | null): void {
  if (!on) return;
  queued.set(key, value);
  timer ??= setTimeout(push, 400);
}

// every write of a key that syncs goes up too (a beat later, the last of a burst)
if (store && rawSet && rawRemove) {
  Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    rawSet.call(this, k, v);
    if (this === store && SYNCED.has(k)) queue(k, String(v));
  };
  Storage.prototype.removeItem = function (this: Storage, k: string) {
    rawRemove.call(this, k);
    if (this === store && SYNCED.has(k)) queue(k, null);
  };
}

/**
 * Yours from the server into this browser (before Cora draws). `seed`: your PC, the first time: what it has goes up
 * (the server has nothing yet). True when anything here changed (the screen then starts again with it).
 */
export async function pullSynced(seed: boolean, readOnly = false): Promise<boolean> {
  if (!store || !rawSet || !rawRemove) return false;
  const r = await fetch('/api/synced').catch(() => null);
  if (!r?.ok) return false;
  const j = (await r.json().catch(() => null)) as { values?: Record<string, string> } | null;
  if (!j?.values) return false;
  let changed = false;
  for (const key of SYNCED) {
    const theirs = j.values[key];
    const mine = store.getItem(key);
    if (theirs != null && theirs !== mine) {
      rawSet.call(store, key, theirs);
      changed = true;
    } else if (theirs == null && mine != null && seed) {
      on = true;
      queue(key, mine);
    }
  }
  // (a guest's screen takes your look but never writes it)
  if (!readOnly) on = true;
  return changed;
}

/** Another screen of yours changed one (the live stream): kept here for when this screen starts again. */
export function syncedFromServer(key: string, value: string | null): boolean {
  if (!store || !rawSet || !rawRemove || !SYNCED.has(key)) return false;
  if (value == null) {
    if (store.getItem(key) == null) return false;
    rawRemove.call(store, key);
    return true;
  }
  if (store.getItem(key) === value) return false;
  rawSet.call(store, key, value);
  return true;
}

/** Start again with what came down (once: a reload that changes nothing doesn't reload again). */
export function restartWithSynced(): boolean {
  try {
    if (sessionStorage.getItem('cora.synced.reloaded') === '1') return false;
    sessionStorage.setItem('cora.synced.reloaded', '1');
  } catch {
    return false;
  }
  location.reload();
  return true;
}
export function syncedSettled(): void {
  try {
    sessionStorage.removeItem('cora.synced.reloaded');
  } catch {
    /* ignore */
  }
}
