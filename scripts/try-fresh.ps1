# Try Cora the way a new user meets it, on this machine, without touching your own setup:
#   powershell -ExecutionPolicy Bypass -File scripts\try-fresh.ps1 [-Bare] [-Exe <Cora.exe>] [-Keep]
# It starts a Cora (the installed one, else release\dist\win-unpacked) with an empty home folder of its own, so it
# finds no ~/.claude (not signed in, no hooks, no sessions), no ~/.cora, no ~/.kube: the first-run setup screen.
# Its port, data and browser profile are separate too. Anything it sets up (hooks, Claude's sign-in) lands in that
# scratch home. -Bare also hides the tools on PATH (git, glab, kubectl, Node) so every install step shows.
# Without -Keep the scratch home starts empty each time. Close its window (tray: Quit) when done.
param([switch]$Bare, [string]$Exe, [switch]$Keep)

$repo = Split-Path $PSScriptRoot -Parent
if (-not $Exe) {
  $installed = Join-Path $env:LOCALAPPDATA 'Programs\Cora\Cora.exe'
  $unpacked = Join-Path $repo 'release\dist\win-unpacked\Cora.exe'
  $Exe = @($installed, $unpacked) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Exe -or -not (Test-Path $Exe)) { throw 'No Cora.exe: install Cora, or build it (node scripts\package.mjs).' }

$root = Join-Path $env:TEMP 'cora-fresh'
if (-not $Keep -and (Test-Path $root)) {
  # a Cora from last time must be gone first (its files are in use)
  Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like "$root*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Remove-Item $root -Recurse -Force -ErrorAction SilentlyContinue
}
$home2 = Join-Path $root 'home'
New-Item -ItemType Directory -Force (Join-Path $home2 'AppData\Roaming'), (Join-Path $home2 'AppData\Local') | Out-Null

$env:USERPROFILE = $home2
$env:HOME = $home2
$env:CORA_HOME = Join-Path $home2 '.cora'
$env:CORA_PORT = '4333'
if ($Bare) {
  # nothing installed: not even Claude Code (it's found through PATH, %APPDATA%\npm and ~\.local\bin)
  $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot;$env:SystemRoot\System32\WindowsPowerShell\v1.0"
  $env:APPDATA = Join-Path $home2 'AppData\Roaming'
  $env:LOCALAPPDATA = Join-Path $home2 'AppData\Local'
  $env:CORA_SETUP_FIXED_PATH = '1'
}
Write-Host "Cora, fresh: $Exe"
Write-Host "  home  $home2"
Write-Host "  port  4333$(if ($Bare) { '  (bare PATH: no git, glab, kubectl or Node)' })"
Start-Process -FilePath $Exe -ArgumentList "--user-data-dir=`"$(Join-Path $root 'profile')`""
