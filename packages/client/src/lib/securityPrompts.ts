import type { SecurityReport } from '@cora/shared';

/** What to ask Claude, in Cora's own repo, to fix what the security check found. */

export function electronPrompt(r: SecurityReport): string {
  const e = r.electron!;
  return [
    `Cora's desktop app runs Electron ${e.installed}, which no longer gets security fixes (Electron patches only its newest three majors: ${e.supportedMajors.join(', ')}).`,
    `Upgrade packages/desktop to Electron ${e.latest}: read Electron's breaking changes for every major in between (https://github.com/electron/electron/blob/main/docs/breaking-changes.md), update the desktop code for them, typecheck, run the tests, and try the app on a test instance (its own --user-data-dir, CORA_HOME and CORA_PORT) before anything touches the running app.`,
    `Don't restart the running Cora without asking me.`,
  ].join('\n\n');
}

export function nodePrompt(r: SecurityReport): string {
  const n = r.node!;
  const why = n.ended ? `Node ${n.version} is past its end of life (${n.endOfLife}).` : `Node ${n.version} is missing security releases (${n.latestInLine} is out).`;
  return [
    `${why} Cora's server and terminal host run on it.`,
    n.ended
      ? `Find the current LTS line, check Cora's server, its node-pty and the tests work on it, then tell me how to switch this machine to it (winget, the installer, or nvm, whichever is in use here).`
      : `Update this machine's Node to ${n.latestInLine} (find how it was installed: winget, the installer or nvm), then run Cora's tests on it.`,
    `Cora's server and terminal host keep running on the old Node until they restart: don't restart them without asking me.`,
  ].join('\n\n');
}

export function npmPrompt(r: SecurityReport): string {
  const list = (r.npm?.findings ?? [])
    .slice(0, 25)
    .map((f) => `- ${f.severity} ${f.name}${f.direct ? ' (direct)' : ''}${f.dev ? ' (dev tools only)' : ''}: ${f.title}${f.url ? ` ${f.url}` : ''}${f.fix === 'breaking' ? ' [fix needs a major upgrade]' : f.fix === 'none' ? ' [no fix yet]' : ''}`)
    .join('\n');
  return [
    `npm audit in Cora's repo reports:`,
    list,
    `Fix them, the ones in what Cora runs first (not marked dev tools only): npm audit fix where that's safe; for the rest, upgrade the direct dependency that pulls the vulnerable package in (check its changelog for breaking changes) or say why it can't be fixed yet. Typecheck and run the tests after each change, and commit what you fix.`,
    `Don't restart the running Cora without asking me.`,
  ].join('\n\n');
}
