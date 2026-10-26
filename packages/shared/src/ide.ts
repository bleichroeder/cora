/** The IDE panel's VS Code (server/src/ide.ts): your installed VS Code serving its web interface on this machine. */
export type IdeStatus = {
  /** missing: no VS Code found; needs-ok: Microsoft's server licence not yet accepted; off: ready to start */
  state: 'missing' | 'needs-ok' | 'off' | 'starting' | 'ready' | 'error';
  /** its address with its secret token (ready only); a folder goes after it as &folder= */
  url?: string;
  /** what it's doing (downloading the server the first time), or what went wrong */
  message?: string;
  /** the terms you accept by starting it */
  license: string;
  /** Claude Code's extension in it (sessions connect to it with /ide, or by themselves): being added, or there */
  claude?: 'installing' | 'ready' | 'failed';
};
