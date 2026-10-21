import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The only desktop capabilities the web UI gets. No Node, no arbitrary IPC.
contextBridge.exposeInMainWorld('coraDesktop', {
  isDesktop: true,
  notify: (title: string, body: string, sessionId: string, open?: string) =>
    ipcRenderer.send('ab:notify', { title: String(title).slice(0, 120), body: String(body).slice(0, 300), sessionId: String(sessionId), ...(open && /^https:\/\//.test(open) ? { open: String(open).slice(0, 1000) } : {}) }),
  onOpenUrl: (cb: (url: string) => void) => {
    const h = (_e: unknown, url: unknown) => cb(String(url));
    ipcRenderer.on('ab:open-url', h);
    return () => ipcRenderer.removeListener('ab:open-url', h);
  },
  setNeedsYou: (n: number) => ipcRenderer.send('ab:needs-you', Math.max(0, Number(n) || 0)),
  popout: (title: string, html: string) => ipcRenderer.send('ab:popout', { title: String(title).slice(0, 200), html: String(html) }),
  // 1Password in Cora's browser: never a password through here (the desktop app fills the page itself)
  opStatus: () => ipcRenderer.invoke('ab:op-status'),
  opLogins: (from: number) => ipcRenderer.invoke('ab:op-logins', { from }),
  opSearch: (q: string) => ipcRenderer.invoke('ab:op-search', { q: String(q) }),
  opFill: (from: number, id: string, anySite = false) => ipcRenderer.invoke('ab:op-fill', { from, id: String(id), anySite: anySite === true }),
  opPrefs: (p: { on: boolean; otp: boolean; tools: boolean }) => ipcRenderer.send('ab:op-prefs', p),
  onOpField: (cb: (m: { from: number; k: 'focus' | 'blur' | 'open'; r?: { x: number; y: number; w: number; h: number }; unlocked: boolean }) => void) => {
    const h = (_e: unknown, m: Parameters<typeof cb>[0]) => cb(m);
    ipcRenderer.on('ab:op-field', h);
    return () => ipcRenderer.removeListener('ab:op-field', h);
  },
  onLoginForm: (cb: (m: { from: number; url: string; form: boolean }) => void) => {
    const h = (_e: unknown, m: { from: number; url: string; form: boolean }) => cb(m);
    ipcRenderer.on('ab:login-form', h);
    return () => ipcRenderer.removeListener('ab:login-form', h);
  },
  // an explain saved as a file, shown in Explorer
  saveExplain: (title: string, ext: 'md' | 'html', content: string) =>
    ipcRenderer.invoke('ab:save-explain', { title: String(title).slice(0, 200), ext, content: String(content) }) as Promise<{ path?: string; error?: string }>,
  onFocusSession: (cb: (sessionId: string) => void) => {
    const h = (_e: unknown, sid: unknown) => cb(String(sid));
    ipcRenderer.on('ab:focus-session', h);
    return () => ipcRenderer.removeListener('ab:focus-session', h);
  },
  readClipboard: () => ipcRenderer.invoke('ab:clipboard-read') as Promise<{ text: string; image: boolean }>,
  // plain text, or the text plus HTML (a reply copied with its formatting)
  writeClipboard: (text: string, html?: string) =>
    ipcRenderer.send('ab:clipboard-write', html == null ? String(text) : { text: String(text), html: String(html) }),
  // where a file dropped into the app lives on disk (the composer puts the path in the prompt)
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },
  // the built-in browser: links clicked in the app arrive here; "open in your browser" goes out
  browser: true,
  onOpenWeb: (cb: (url: string) => void) => {
    const h = (_e: unknown, url: unknown) => cb(String(url));
    ipcRenderer.on('ab:open-web', h);
    return () => ipcRenderer.removeListener('ab:open-web', h);
  },
  openExternal: (url: string) => ipcRenderer.send('ab:open-external', String(url)),
  // restart the app (sessions keep running): installs a waiting update
  restartApp: () => ipcRenderer.send('ab:restart'),
  // installed Cora: a new version downloaded (restartApp installs it)
  updateReady: () => ipcRenderer.invoke('ab:update-ready') as Promise<string | null>,
  onUpdate: (cb: (version: string) => void) => {
    const h = (_e: unknown, v: unknown) => cb(String(v));
    ipcRenderer.on('ab:update', h);
    return () => ipcRenderer.removeListener('ab:update', h);
  },
  // Cora (the orchestrator): a hotkey that works from anywhere, while it's on
  setCoraHotkey: (on: boolean) => ipcRenderer.send('ab:cora-hotkey', !!on),
  onCoraPtt: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('ab:cora-ptt', h);
    return () => ipcRenderer.removeListener('ab:cora-ptt', h);
  },
  onCoraStandDown: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('ab:cora-standdown', h);
    return () => ipcRenderer.removeListener('ab:cora-standdown', h);
  },
  // Tools: one in its own window; which sites are tools (their pages may notify)
  toolWindow: (url: string, title: string) => ipcRenderer.send('ab:tool-window', { url: String(url), title: String(title).slice(0, 80) }),
  setCoraColor: (color: string) => ipcRenderer.send('ab:cora-color', String(color)),
  // "Add to Scratch" from the right-click menu: the selected text
  onJot: (cb: (text: string) => void) => {
    const h = (_e: unknown, t: unknown) => cb(String(t));
    ipcRenderer.on('ab:jot', h);
    return () => ipcRenderer.removeListener('ab:jot', h);
  },
  // quick capture's window: hide it; hear when it's shown again
  hideCapture: () => ipcRenderer.send('ab:capture-hide'),
  onCaptureShown: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('ab:capture-shown', h);
    return () => ipcRenderer.removeListener('ab:capture-shown', h);
  },
  setToolHosts: (hosts: string[]) => ipcRenderer.send('ab:tool-hosts', Array.isArray(hosts) ? hosts.slice(0, 50).map(String) : []),
  onWebTab: (cb: (m: unknown) => void) => {
    const h = (_e: unknown, m: unknown) => cb(m);
    ipcRenderer.on('ab:web-tab', h);
    return () => ipcRenderer.removeListener('ab:web-tab', h);
  },
  // read-only Jira lookups through the browser's Jira login (see jira.ts); results are JiraResult objects
  jira: {
    sites: () => ipcRenderer.invoke('ab:jira', { op: 'sites' }),
    issues: (site: string, keys: string[]) => ipcRenderer.invoke('ab:jira', { op: 'issues', site: String(site), keys: Array.from(keys ?? [], String) }),
    myOpenIssues: (site: string, max?: number) => ipcRenderer.invoke('ab:jira', { op: 'mine', site: String(site), max: Number(max) || 50 }),
    projectKeys: (site: string) => ipcRenderer.invoke('ab:jira', { op: 'projects', site: String(site) }),
    myself: (site: string) => ipcRenderer.invoke('ab:jira', { op: 'myself', site: String(site) }),
    onAuthChange: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('ab:jira-auth', h);
      return () => ipcRenderer.removeListener('ab:jira-auth', h);
    },
  },
  onCommand: (cb: (command: string) => void) => {
    const h = (_e: unknown, c: unknown) => cb(String(c));
    ipcRenderer.on('ab:command', h);
    return () => ipcRenderer.removeListener('ab:command', h);
  },
  // the startup splash: start the server, follow its stages, hand over to the dashboard
  splash: {
    start: (noHost: boolean) => ipcRenderer.send('ab:splash-start', !!noHost),
    done: () => ipcRenderer.send('ab:splash-done'),
    openLog: () => ipcRenderer.send('ab:splash-log'),
    on: (cb: (m: unknown) => void) => {
      const h = (_e: unknown, m: unknown) => cb(m);
      ipcRenderer.on('ab:splash', h);
      return () => ipcRenderer.removeListener('ab:splash', h);
    },
  },
});
