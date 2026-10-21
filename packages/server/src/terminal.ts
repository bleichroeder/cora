import { execFile } from 'node:child_process';
import { isSafeId, type SessionInfo } from '@cora/shared';

export type JumpResult = { ok: true; pid: number } | { ok: false; fallback: string; reason: string };

function ps(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 8000, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim()),
    );
  });
}

/**
 * Is a `claude` process running with this session id on its command line (i.e. started with
 * `--resume <id>` or `--session-id <id>`)? Sessions started as plain `claude` can't be detected this way,
 * which is why the UI still asks the user to confirm before resuming.
 */
export async function findSessionProcess(sessionId: string): Promise<number[]> {
  if (process.platform !== 'win32' || !/^[0-9a-f-]{8,}$/i.test(sessionId)) return [];
  try {
    const out = await ps(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match '${sessionId}' -and $_.CommandLine -match 'claude' -and $_.Name -match '^(claude|node)(\\.exe)?$' } | ForEach-Object { $_.ProcessId }`);
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * Bring the terminal window hosting a Claude Code session to the front (Windows).
 * Finds `claude` processes whose command line mentions the session id, or whose working directory
 * is unknown but is the only claude process, then walks up the parent chain to the first process
 * with a main window and activates it. Falls back to a resume command for the clipboard.
 */
export async function jumpToTerminal(session: SessionInfo): Promise<JumpResult> {
  // the id goes into a PowerShell script below: only an id
  if (!isSafeId(session.id)) return { ok: false, fallback: '', reason: "that session's id isn't one Cora can look for" };
  const fallback = `cd "${session.cwd}"; claude --resume ${session.id}`;
  if (process.platform !== 'win32') return { ok: false, fallback, reason: 'only supported on Windows for now' };
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$all = Get-CimInstance Win32_Process
$byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
$claude = $all | Where-Object { $_.CommandLine -match 'claude' -and $_.Name -match '^(claude|node)(\\.exe)?$' }
$hit = $claude | Where-Object { $_.CommandLine -match '${session.id}' } | Select-Object -First 1
if (-not $hit) { $hit = $claude | Where-Object { $_.Name -match '^claude' } | Sort-Object CreationDate -Descending | Select-Object -First 1 }
if (-not $hit) { 'NONE'; exit }
$cur = $hit
for ($i = 0; $i -lt 8 -and $cur; $i++) {
  $proc = Get-Process -Id $cur.ProcessId
  if ($proc -and $proc.MainWindowHandle -ne 0) {
    $sh = New-Object -ComObject WScript.Shell
    if ($sh.AppActivate([int]$cur.ProcessId)) { "OK $($cur.ProcessId)"; exit }
  }
  $cur = $byId[[int]$cur.ParentProcessId]
}
'NOWINDOW'`;
  try {
    const out = await ps(script);
    const m = out.match(/OK (\d+)/);
    if (m) return { ok: true, pid: Number(m[1]) };
    return { ok: false, fallback, reason: out === 'NONE' ? 'no running claude process found' : 'could not find its window' };
  } catch (e) {
    return { ok: false, fallback, reason: (e as Error).message };
  }
}
