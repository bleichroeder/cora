/** Plain shell tabs beside a session's Claude: naming them and telling whether one is busy. */

export const SHELL_DEFAULT = 'PowerShell';
/**
 * The titles a kind of shell gives itself (so its tab shows the kind, not "bash"): PowerShell's, Command Prompt's,
 * Git Bash's (MINGW64:/c/x), a WSL distro's (user@host: path). Another shell started inside it is a program like any.
 */
function ownTitle(kind: string): RegExp {
  if (/powershell/i.test(kind)) return /^(pwsh|powershell|windows powershell)$/i;
  if (/^command prompt$/i.test(kind)) return /^(cmd|command prompt)$/i;
  if (/^git bash$/i.test(kind)) return /^(bash|git bash|MINGW(32|64):.*|MSYS:.*)$/i;
  return /^(bash|sh|zsh|fish|wsl|[\w.-]+@[\w.-]+:.*)$/i;
}

/**
 * A shell tab's name from the title its terminal reports (xterm's onTitleChange): the running program, without its
 * folder or .exe ("C:\Program Files\nodejs\node.exe" → "node"; "npm run dev" stays). The shell itself, or no title
 * yet, is the shell's own name (`fallback`: its kind, e.g. "Git Bash", "Ubuntu").
 */
export function shellLabel(title: string | undefined | null, fallback = SHELL_DEFAULT): string {
  let t = (title ?? '').trim().replace(/^administrator:\s*/i, '');
  // a leading program path (it may contain spaces): keep its name, and whatever follows it
  const m = /^"?((?:[a-z]:)?[\\/][^"]*?|[^\s"\\/]*[\\/][^"]*?)\.(?:exe|cmd|bat|com)"?(?=\s|$)(.*)$/i.exec(t);
  if (m) t = `${m[1].split(/[\\/]/).pop()}${m[2]}`.trim();
  else t = t.replace(/\.(?:exe|cmd|bat|com)(?=\s|$)/i, '');
  if (!t || ownTitle(fallback).test(t) || t.toLowerCase() === fallback.toLowerCase()) return fallback;
  return t.length > 40 ? `${t.slice(0, 39)}…` : t;
}

/**
 * Does the line at the cursor look like a prompt waiting for a command? If not, something is probably still
 * running (a dev server, a long build), so closing the tab should ask first. A guess: unusual prompts just ask.
 */
export function atPrompt(line: string): boolean {
  const l = line.trimEnd();
  if (!l) return false;
  return /^PS .*>$/.test(l) || /[>$#%❯➜λ]$/.test(l);
}

/**
 * The command being submitted from a prompt line ("PS C:\x> npm run dev" → "npm run dev"), or null when the line
 * isn't a prompt (Enter pressed inside a running program). Most programs never set a title (node, a dev server), so
 * this is what names a busy shell's tab.
 */
export function commandAt(line: string): string | null {
  const m = /^PS [^>]*>(.*)$/.exec(line) ?? /^[A-Za-z]:\\[^>]*>(.*)$/.exec(line) ?? /^[^$#%❯\s][^$#%❯]*[$#%❯]\s(.*)$/.exec(line);
  const cmd = m?.[1].trim();
  return cmd ? cmd : null;
}

/** The tab on show for a session: the remembered one if that shell is still open, else Claude. */
export function activeTab(remembered: string | undefined, shellIds: string[]): string {
  return remembered && shellIds.includes(remembered) ? remembered : 'claude';
}

/** The tab to show after closing one: the shell to its left, else Claude. */
export function afterClose(closing: string, shellIds: string[]): string {
  const i = shellIds.indexOf(closing);
  return i > 0 ? shellIds[i - 1] : 'claude';
}
