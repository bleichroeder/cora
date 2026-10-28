import { create } from 'zustand';
import { guestAct, isGuest } from './live';
import { BUILTIN_COMMANDS, mergeCommands, type Attachment, type Sent, type SlashCommand } from '../lib/composer';
import { useBrain } from './store';
import { desktop } from '../lib/desktop';

/** What you're writing to a session, kept while you look at others and across reloads. */
export type Draft = { text: string; attachments: Attachment[] };
const EMPTY: Draft = { text: '', attachments: [] };

type ComposerState = {
  drafts: Record<string, Draft>;
  /** prompts sent from here, newest last (the transcript may not show them yet) */
  sent: Record<string, Sent[]>;
  commands: Record<string, { at: number; list: SlashCommand[] }>;
  setDraft(sid: string, d: Partial<Draft>): void;
};

const KEY = 'ab:composer';
const load = (): Pick<ComposerState, 'drafts' | 'sent'> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return { drafts: v?.drafts ?? {}, sent: v?.sent ?? {} };
  } catch {
    return { drafts: {}, sent: {} };
  }
};
let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Saved a moment after the last keystroke; old sessions' drafts and history are let go. */
const save = () => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { drafts, sent } = useComposer.getState();
    const keep = (r: Record<string, unknown>, n: number) => Object.fromEntries(Object.entries(r).slice(-n));
    try {
      localStorage.setItem(KEY, JSON.stringify({ drafts: keep(drafts, 60), sent: keep(sent, 60) }));
    } catch {
      /* storage full or blocked: drafts just don't survive a reload */
    }
  }, 300);
};

export const useComposer = create<ComposerState>((set, get) => ({
  ...load(),
  commands: {},
  setDraft: (sid, d) => {
    const next = { ...(get().drafts[sid] ?? EMPTY), ...d };
    const drafts = { ...get().drafts };
    // insertion order is age: a touched draft moves to the end
    delete drafts[sid];
    if (next.text || next.attachments.length) drafts[sid] = next;
    set({ drafts });
    save();
  },
}));

export const draftOf = (sid: string) => useComposer.getState().drafts[sid] ?? EMPTY;

function remember(sid: string, text: string) {
  const sent = { ...useComposer.getState().sent };
  const list = (sent[sid] ?? []).filter((s) => s.text !== text);
  delete sent[sid];
  sent[sid] = [...list, { text, ts: Date.now() }].slice(-50);
  useComposer.setState({ sent });
  save();
}

/** Image previews for chips (object URLs; not saved, so a reloaded draft shows the file name only). */
export const previews = new Map<string, string>();
const PREVIEWS_KEPT = 60;

/** The live hosted terminal of a session. */
export const liveTerminal = (sid: string) => useBrain.getState().terminals.find((t) => t.sessionId === sid && t.alive);

export type SendResult = { ok: true } | { ok: false; error: string; choice?: boolean };

/** Type a prompt into the session's Claude Code and submit it (the server pastes several lines as one). */
export async function sendToSession(sid: string, text: string, force = false): Promise<SendResult> {
  const t = liveTerminal(sid);
  if (!t) return { ok: false, error: "This session isn't running here" };
  // a guest in an interactive share: their prompt, named, through the share
  if (isGuest()) {
    const r = await guestAct({ kind: 'prompt', sessionId: sid, text });
    if (!r.ok) return { ok: false, error: r.error ?? 'failed', choice: !!r.choice };
    remember(sid, text);
    return { ok: true };
  }
  try {
    const r = await fetch(`/api/terminals/${encodeURIComponent(t.terminalId)}/input`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, submit: true, force }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error ?? `failed (${r.status})`, choice: !!j.choice };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  remember(sid, text);
  return { ok: true };
}

/**
 * Stop what the session is doing, from the composer: Esc or Ctrl+C typed into its terminal. Only while it's working
 * (the server checks); `sent: false` with why when there's nothing to stop.
 */
export async function interruptSession(sid: string, key: 'esc' | 'ctrl-c'): Promise<{ sent: boolean; why: string }> {
  const t = liveTerminal(sid);
  if (!t) return { sent: false, why: "This session isn't running here" };
  try {
    const r = await fetch(`/api/terminals/${encodeURIComponent(t.terminalId)}/interrupt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key }) });
    const j = await r.json().catch(() => ({}));
    return r.ok ? { sent: !!j.sent, why: j.why ?? '' } : { sent: false, why: j.error ?? `failed (${r.status})` };
  } catch (e) {
    return { sent: false, why: (e as Error).message };
  }
}

/** The `/` menu's commands for a session: Claude Code's own plus skills and commands (fetched, kept a minute). */
export async function loadCommands(sid: string): Promise<void> {
  const have = useComposer.getState().commands[sid];
  if (have && Date.now() - have.at < 60_000) return;
  const mark = (list: SlashCommand[]) => useComposer.setState((s) => ({ commands: { ...s.commands, [sid]: { at: Date.now(), list } } }));
  if (!have) mark(BUILTIN_COMMANDS);
  try {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/commands`);
    const j = r.ok ? await r.json() : null;
    if (j?.commands) mark(mergeCommands(BUILTIN_COMMANDS, j.commands));
  } catch {
    /* the built-ins are still there */
  }
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => rej(r.error ?? new Error("couldn't read the file"));
    r.readAsDataURL(blob);
  });

/**
 * A file for the prompt. Dropped from disk in the desktop app it's used where it is; otherwise (a pasted
 * screenshot, a browser drop) the server saves a copy where Claude can read it.
 */
export async function attachFile(sid: string, file: File): Promise<Attachment> {
  const image = file.type.startsWith('image/');
  const local = desktop?.pathForFile?.(file);
  const name = file.name || (image ? `screenshot.${file.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'}` : 'file');
  let path = local;
  if (!path) {
    const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/attachments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, data: await toBase64(file) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error ?? `upload failed (${r.status})`);
    path = String(j.path);
  }
  if (image) {
    previews.set(path, URL.createObjectURL(file));
    // the newest few kept: an older one's image is let go (a draft never shows that many)
    for (const [k, url] of previews) {
      if (previews.size <= PREVIEWS_KEPT) break;
      URL.revokeObjectURL(url);
      previews.delete(k);
    }
  }
  return { path, name, image };
}

/**
 * Push-to-talk hands its words to a session's composer when one is open (for review there) instead of its own
 * box. The mounted composer registers here.
 */
export const composerInbox = new Map<string, (text: string) => void>();
