import type { JiraIssue, JiraResult, JiraUser } from '@cora/shared';

/** Bridge exposed by the Electron preload; undefined in a normal browser. */
export type DesktopBridge = {
  isDesktop: true;
  /** `open`: a page the notification is about (clicking it opens that, not the session) */
  notify(title: string, body: string, sessionId: string, open?: string): void;
  /** a notification about a page was clicked */
  onOpenUrl?(cb: (url: string) => void): () => void;
  setNeedsYou(n: number): void;
  popout(title: string, html: string): void;
  /** 1Password (the desktop app fills pages itself: no password ever comes through here) */
  opStatus?(): Promise<import('@cora/shared').OpStatus | null>;
  opLogins?(from: number): Promise<{ url?: string; logins?: import('@cora/shared').OpLogin[]; error?: string }>;
  opSearch?(q: string): Promise<{ logins?: import('@cora/shared').OpLogin[]; error?: string }>;
  opFill?(from: number, id: string, anySite?: boolean): Promise<{ filled?: { username: boolean; password: boolean; totp: boolean }; error?: string }>;
  opPrefs?(p: import('@cora/shared').OnePasswordSettings): void;
  onLoginForm?(cb: (m: { from: number; url: string; form: boolean }) => void): () => void;
  /** the key in a page's login field: focused, left, or clicked (`r`: the field, in the page's pixels) */
  openJournal?(file?: string): void;
  /** a file a transcript names: a picture in the viewer, text in Notepad, or shown in Explorer (nothing else opens) */
  openFile?(path: string, how: 'viewer' | 'text' | 'folder'): Promise<{ ok?: true; error?: string }>;
  onOpField?(cb: (m: { from: number; k: 'focus' | 'blur' | 'open'; r?: { x: number; y: number; w: number; h: number }; unlocked: boolean; v?: boolean }) => void): () => void;
  /** save an explain as a file (Documents\\Cora\\Explains) and show it in Explorer */
  saveExplain?(title: string, ext: 'md' | 'html', content: string): Promise<{ path?: string; error?: string }>;
  onFocusSession(cb: (sessionId: string) => void): () => void;
  onCommand(cb: (command: string) => void): () => void;
  readClipboard?(): Promise<{ text: string; image: boolean }>;
  /** plain text; with `html` too, both formats at once (rich editors take the HTML, plain text fields the text) */
  writeClipboard?(text: string, html?: string): void;
  /** a dropped file's path on disk ('' for one that isn't a file on disk, such as a pasted screenshot) */
  pathForFile?(file: File): string;
  /** the built-in browser: links clicked in the app arrive here; "open in Chrome" goes out */
  browser?: boolean;
  onOpenWeb?(cb: (url: string) => void): () => void;
  openExternal?(url: string): void;
  /** a page asked for a new tab (url) or pressed a tab shortcut (key: t, w, l, f, next, prev; k: the command palette); `from` is its web contents id */
  /** a page asking for a tab, a tab shortcut in it, or you using it (`used`: at most once a second) */
  /** a session's Playwright tabs (desktop/src/agentBrowser.ts): which there are, and the desktop asking to open, close or show one */
  agentTabs?(list: Array<{ tabId: string; sessionId: string; wcId: number; url: string; title: string; w: number; h: number; req?: string; opener?: string }>): void;
  onAgentCmd?(cb: (m: { t: 'open'; req: string; sessionId: string; url: string } | { t: 'close' | 'activate'; tabId: string }) => void): () => void;
  onWebTab?(cb: (m: { from: number; url?: string; background?: boolean; key?: string; used?: true }) => void): () => void;
  /** a tool in its own window (same logins as the browser) */
  toolWindow?(url: string, title: string): void;
  /** the tools' sites: their pages may show Windows notifications (other pages may not) */
  setToolHosts?(hosts: string[]): void;
  /** Cora's colour: the window's, tray's and Start menu's icon */
  setCoraColor?(color: string): void;
  /** "Add to Scratch" from the right-click menu */
  onJot?(cb: (text: string) => void): () => void;
  /** quick capture's window (Ctrl+Alt+N): hide it; hear when it's shown again */
  hideCapture?(): void;
  onCaptureShown?(cb: () => void): () => void;
  /** a page whose certificate isn't trusted: hear the questions, the ones still open, answer one */
  onCertAsk?(cb: (ask: CertAsk) => void): () => void;
  certOpen?(): Promise<CertAsk[]>;
  certAnswer?(id: string, ok: boolean): void;
  /** downloads from pages (null: the finished ones were cleared), the list so far, and an act on one */
  onDownload?(cb: (d: PageDownload | null) => void): () => void;
  downloads?(): Promise<PageDownload[]>;
  downloadAct?(act: 'show' | 'cancel' | 'clear', id?: string): void;
  /** a page's DevTools (its web contents id) */
  devTools?(id: number): void;
  /** a page in Cora's browser wants an HTTP sign-in: hear the questions, get the ones still open, answer one (no username: cancelled) */
  onHttpAuth?(cb: (ask: HttpAuthAsk) => void): () => void;
  httpAuthOpen?(): Promise<HttpAuthAsk[]>;
  httpAuthAnswer?(m: { id: string; username?: string; password?: string; keep?: boolean }): void;
  /** restart the app (sessions keep running): installs a waiting update */
  restartApp?(): void;
  /** installed Cora: the new version downloaded and waiting for a restart (null: none) */
  updateReady?(): Promise<string | null>;
  snap?(r: { x: number; y: number; width: number; height: number }): Promise<string | null>;
  appInfo?(): Promise<{ version: string; packaged: boolean; electron: string; chrome: string } | null>;
  onUpdate?(cb: (version: string) => void): () => void;
  /** Cora's hotkey from anywhere (Ctrl+Alt+Space), while the orchestrator is on */
  setCoraHotkey?(on: boolean): void;
  onCoraPtt?(cb: () => void): () => void;
  /** Ctrl+Alt+Backspace from anywhere: stand Cora down */
  onCoraStandDown?(cb: () => void): () => void;
  /** read-only Jira lookups through the built-in browser's Jira login (state/jira.ts caches and batches them) */
  jira?: {
    /** Jira Cloud sites the browser has cookies for, the signed-in one first */
    sites(): Promise<JiraResult<string[]>>;
    /** by key; a failed request as a whole (not the desktop window asking) comes back as one JiraResult */
    issues(site: string, keys: string[]): Promise<Record<string, JiraResult<JiraIssue>> | Extract<JiraResult<never>, { ok: false }>>;
    myOpenIssues(site: string, max?: number): Promise<JiraResult<JiraIssue[]>>;
    projectKeys(site: string): Promise<JiraResult<string[]>>;
    myself(site: string): Promise<JiraResult<JiraUser>>;
    /** the Jira login changed (signed in or out in a Jira tab) */
    onAuthChange(cb: () => void): () => void;
  };
};

export const desktop: DesktopBridge | undefined = (globalThis as { coraDesktop?: DesktopBridge }).coraDesktop;

/** True when the user is looking at this window (so a notification would be noise). */
export const attentive = () => typeof document !== 'undefined' && !document.hidden && document.hasFocus();

/** An HTTP sign-in a page is waiting on (desktop/src/httpAuth.ts): who asks; never a password. */
export type HttpAuthAsk = { id: string; host: string; port: number; realm: string; proxy: boolean; scheme: string; url: string; failed: boolean; plain: boolean };

/** A certificate a page met that isn't trusted (desktop/src/certTrust.ts). */
export type CertAsk = { id: string; host: string; url: string; error: string; why: string; local: boolean; fingerprint: string; subject: string; issuer: string; validFrom: number; validTo: number };
/** A download from a page (desktop/src/downloads.ts). */
export type PageDownload = { id: string; name: string; url: string; path: string; state: 'going' | 'done' | 'failed' | 'cancelled'; received: number; total: number; startedAt: number; from?: number };
