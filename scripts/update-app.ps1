# Rebuilds and reinstalls BridgeMind from the latest commit of `main` (local main, or origin/main when it is ahead).
# The build runs in its own git worktree (%LOCALAPPDATA%\BridgeMind-build), so uncommitted edits in the repo are never shipped.
#   -IfNeeded : do nothing when the installed copy is already up to date, or when BridgeMind is running (agents would be killed).
#   -Launch   : open BridgeMind at the end (also when nothing was rebuilt, or when the build failed).
# The Desktop / Start menu "BridgeMind" shortcuts run this with -IfNeeded -Launch (through launch-latest.vbs, hidden).
param([string]$Repo, [switch]$IfNeeded, [switch]$Launch, [switch]$Visible)
$ErrorActionPreference = 'Continue' # native stderr must not throw (PS 5.1); exit codes are checked
$exe = Join-Path $env:LOCALAPPDATA 'Programs\BridgeMind\BridgeMind.exe'
$stamp = Join-Path $env:LOCALAPPDATA 'Programs\BridgeMind\commit.txt'
$build = Join-Path $env:LOCALAPPDATA 'BridgeMind-build'
$env:GIT_TERMINAL_PROMPT = '0'
if (-not $Repo) {
  $f = Join-Path $PSScriptRoot 'repo.txt'
  $Repo = if (Test-Path $f) { (Get-Content $f -Raw).Trim() } else { Split-Path $PSScriptRoot -Parent }
}

function Open-App { if ($Launch -and (Test-Path $exe)) { Start-Process $exe -WorkingDirectory (Split-Path $exe) } }
function RGit { & git.exe -C $Repo @args 2>$null }
function Fail([string]$msg) {
  Write-Host "`n[X] $msg" -ForegroundColor Red
  Write-Host 'La version installée est conservée.' -ForegroundColor Yellow
  Open-App
  if ($Visible -or -not $IfNeeded) { Read-Host 'Entrée pour fermer' | Out-Null }
  exit 1
}

if (-not (Get-Command git -ErrorAction SilentlyContinue) -or -not (Test-Path (Join-Path $Repo '.git'))) {
  if ($IfNeeded) { Open-App; exit 0 } else { Fail "Dépôt introuvable : $Repo" }
}

# Which commit is "latest": fetch origin quickly (offline is fine), take origin/main only if it is ahead of local main.
$p = Start-Process git -ArgumentList @('-C', "`"$Repo`"", 'fetch', '--quiet', 'origin', 'main') -WindowStyle Hidden -PassThru
if (-not $p.WaitForExit(10000)) { try { $p.Kill() } catch {} }
$target = RGit rev-parse --verify --quiet 'main^{commit}'
$remote = RGit rev-parse --verify --quiet 'origin/main^{commit}'
if ($remote -and $remote -ne $target) {
  if (-not $target) { $target = $remote }
  else { RGit merge-base --is-ancestor $target $remote; if ($LASTEXITCODE -eq 0) { $target = $remote } }
}
if (-not $target) { if ($IfNeeded) { Open-App; exit 0 } else { Fail 'Branche main introuvable.' } }

# Up to date = installed commit is the target, or a descendant of it (e.g. installed by hand from a newer branch).
$installed = if (Test-Path $stamp) { ((Get-Content $stamp -Raw).Trim() -replace '-dirty$', '') } else { '' }
$upToDate = $false
if ($installed -and (Test-Path $exe)) {
  if ($installed -eq $target) { $upToDate = $true }
  else { RGit merge-base --is-ancestor $target $installed; $upToDate = ($LASTEXITCODE -eq 0) }
}
$running = [bool](Get-Process BridgeMind -ErrorAction SilentlyContinue)

if ($IfNeeded) {
  # Never kill a running app (and its agents) just because it was clicked again: update on next start.
  if ($upToDate -or $running) { Open-App; exit 0 }
  if (-not $Visible) {
    # Rebuilding takes a minute or two: show progress in a console window.
    $args2 = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Repo', "`"$Repo`"", '-IfNeeded', '-Visible')
    if ($Launch) { $args2 += '-Launch' }
    Start-Process powershell -ArgumentList $args2
    exit 0
  }
}

$Host.UI.RawUI.WindowTitle = 'BridgeMind - mise à jour'
$mutex = New-Object System.Threading.Mutex($false, 'Local\BridgeMindUpdate')
if (-not $mutex.WaitOne(0)) { Write-Host 'Une mise à jour est déjà en cours.'; Start-Sleep 3; exit 0 }

$short = $target.Substring(0, 7)
Write-Host "BridgeMind : mise à jour vers $short" -ForegroundColor Cyan
RGit log -1 --format='  %s (%cr)' $target | Write-Host
if ($upToDate) { Write-Host '(déjà à jour, réinstallation forcée)' }
if ($running -and -not $IfNeeded) {
  $r = Read-Host "BridgeMind est ouvert : la mise à jour va le fermer et arrêter tous les agents. Continuer ? (o/N)"
  if ($r -notmatch '^[oOyY]') { exit 0 }
}

# Node may not be on PATH (winget install): look for it.
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
  $n = @(Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\OpenJS.NodeJS*\node-*" -Directory -ErrorAction SilentlyContinue) +
       @(Get-Item "$env:ProgramFiles\nodejs" -ErrorAction SilentlyContinue) | Where-Object { Test-Path "$_\npm.cmd" } | Select-Object -First 1
  if (-not $n) { Fail 'Node.js introuvable (Node >= 24 requis).' }
  $env:Path = "$($n.FullName);$env:Path"
}

$log = Join-Path $env:USERPROFILE '.bridgemind\update.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
try {
  Write-Host '[1/4] Préparation des sources...'
  if (-not (Test-Path (Join-Path $build '.git'))) {
    RGit worktree prune
    if (Test-Path $build) { Remove-Item -LiteralPath $build -Recurse -Force }
    RGit worktree add --detach --force $build $target | Out-Null
    if ($LASTEXITCODE) { throw 'git worktree add a échoué' }
  }
  & git.exe -C $build checkout --quiet --detach --force $target; if ($LASTEXITCODE) { throw 'git checkout a échoué' }
  & git.exe -C $build clean -fdq; if ($LASTEXITCODE) { throw 'git clean a échoué' }

  Push-Location $build
  $lock = (Get-FileHash package-lock.json).Hash
  $lockStamp = 'node_modules\.bm-lock'
  if (-not (Test-Path $lockStamp) -or (Get-Content $lockStamp -Raw).Trim() -ne $lock) {
    Write-Host '[2/4] Installation des dépendances (première fois ou package-lock modifié)...'
    cmd /c "npm ci --no-audit --no-fund >> `"$log`" 2>&1"; if ($LASTEXITCODE) { throw "npm ci a échoué (voir $log)" }
    cmd /c "node node_modules/electron/install.js >> `"$log`" 2>&1"; if ($LASTEXITCODE) { throw "téléchargement d'Electron échoué (voir $log)" }
    Set-Content $lockStamp $lock
  } else { Write-Host '[2/4] Dépendances à jour.' }

  Write-Host '[3/4] Compilation...'
  cmd /c "npm run package >> `"$log`" 2>&1"; if ($LASTEXITCODE) { throw "la compilation a échoué (voir $log)" }

  Write-Host '[4/4] Installation...'
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $build 'scripts\install-app.ps1'); if ($LASTEXITCODE) { throw "l'installation a échoué" }
  Pop-Location
} catch { Pop-Location -ErrorAction SilentlyContinue; Fail $_.Exception.Message }

Write-Host "`nBridgeMind est à jour ($short)." -ForegroundColor Green
Open-App
Start-Sleep 2
