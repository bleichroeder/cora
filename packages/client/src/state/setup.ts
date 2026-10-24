import { create } from 'zustand';
import { setupFirstRun, type SetupState } from '@cora/shared';

/**
 * Setting Cora up: the checklist from the server, what's being
 * done, and the first run (shown instead of the app until it's done with, or while something required is missing).
 */
type State = {
  state: SetupState | null;
  /** a need being done (`item/need`) */
  busy: Record<string, boolean>;
  err: Record<string, string>;
  /** the first run was put away this time (Open Cora) */
  dismissed: boolean;
  /** the checklist was asked for once (got or not): until then the app waits, so a first run doesn't flash the app */
  checked: boolean;
};
/**
 * The last check found Cora set up (no first run): the app shows at once next time, while the check (a second or two:
 * it looks for Claude Code, glab and the rest) runs again behind it. A fresh install, or one missing something it
 * needs, waits for it.
 */
const SET_UP = 'cora.setup.ok';
const wasSetUp = () => {
  try {
    return localStorage.getItem(SET_UP) === '1';
  } catch {
    return false;
  }
};
export const useSetup = create<State>(() => ({ state: null, busy: {}, err: {}, dismissed: false, checked: wasSetUp() }));

const post = async (url: string, body: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return r.ok ? { ok: true, ...j } : { ok: false, error: (j as { error?: string }).error ?? `HTTP ${r.status}` };
};

export async function loadSetup(): Promise<void> {
  const r = await fetch('/api/setup').catch(() => null);
  const state = r?.ok ? ((await r.json().catch(() => null)) as SetupState | null) : null;
  useSetup.setState(state ? { state, checked: true } : { checked: true });
  if (state)
    try {
      if (setupFirstRun(state)) localStorage.removeItem(SET_UP);
      else localStorage.setItem(SET_UP, '1');
    } catch {
      /* it waits next time */
    }
}

// after a command opens its window: look again every 5 s for 3 minutes (and whenever Cora comes back to the front)
let watchUntil = 0;
let watcher: ReturnType<typeof setInterval> | null = null;
function watch(): void {
  watchUntil = Date.now() + 3 * 60_000;
  if (watcher) return;
  watcher = setInterval(() => {
    if (Date.now() > watchUntil) return void (clearInterval(watcher!), (watcher = null));
    void loadSetup();
  }, 5000);
}
if (typeof window !== 'undefined') window.addEventListener('focus', () => void (useSetup.getState().state && loadSetup()));

const mark = (key: string, busy: boolean, err?: string) =>
  useSetup.setState((s) => ({ busy: { ...s.busy, [key]: busy }, err: Object.fromEntries(Object.entries({ ...s.err, [key]: err ?? '' }).filter(([, v]) => v)) }));

/** Do a need: the hooks are written at once; a command opens in a window of its own, and Cora watches for it. */
export async function runNeed(item: string, need: string): Promise<void> {
  const key = `${item}/${need}`;
  mark(key, true);
  const r = await post('/api/setup/run', { item, need });
  mark(key, false, r.ok ? undefined : r.error);
  if (r.window) watch();
  await loadSetup();
}

export async function skipItem(item: string, skip: boolean): Promise<void> {
  await post('/api/setup/skip', { item, skip });
  await loadSetup();
}

/** Open Cora: the first run is done with (it comes back only if something required goes missing). */
export async function finishFirstRun(): Promise<void> {
  useSetup.setState({ dismissed: true });
  await post('/api/setup/seen', {});
}

/** The ElevenLabs key, pasted in the checklist (checked with ElevenLabs before it's kept). */
export async function saveVoiceKey(key: string): Promise<string | null> {
  mark('voice/key', true);
  const r = await post('/api/voice/key', { key });
  mark('voice/key', false, r.ok ? undefined : r.error);
  await loadSetup();
  return r.ok ? null : (r.error ?? 'failed');
}

export async function hooksPreview(): Promise<{ file: string; diff: string } | null> {
  const r = await fetch('/api/setup/hooks').catch(() => null);
  return r?.ok ? r.json() : null;
}
