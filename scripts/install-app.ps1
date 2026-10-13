# Installs the packaged app like a normal Windows app (per-user, no admin):
#   %LOCALAPPDATA%\Programs\BridgeMind  + Desktop & Start menu shortcuts + "Installed apps" entry (uninstallable).
# The shortcuts go through the launcher (%LOCALAPPDATA%\BridgeMind-launcher), which rebuilds from the latest main when needed.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$src = Join-Path $root 'release\BridgeMind-win32-x64'
$dst = Join-Path $env:LOCALAPPDATA 'Programs\BridgeMind'
if (-not (Test-Path "$src\BridgeMind.exe")) { throw "Run 'npm run package' first." }

# Stop a running instance (window + hub + its agents) so files can be replaced.
Get-Process BridgeMind -ErrorAction SilentlyContinue | Stop-Process -Force
$hubPid = netstat -ano | Select-String ':7777 .*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($hubPid) { taskkill /PID $hubPid /T /F | Out-Null }
Start-Sleep -Milliseconds 800

if (Test-Path $dst) { Remove-Item -LiteralPath $dst -Recurse -Force }
Copy-Item -LiteralPath $src -Destination $dst -Recurse
# Keep only English/French Chromium locales (-45 MB).
Get-ChildItem "$dst\locales" -Filter *.pak | Where-Object { $_.BaseName -notin @('en-US', 'fr') } | Remove-Item -Force

$exe = Join-Path $dst 'BridgeMind.exe'
# Commit this build comes from: the launcher compares it with main to decide whether to rebuild.
$ErrorActionPreference = 'Continue' # git writes to stderr; must not throw on PS 5.1
$sha = git -C $root rev-parse HEAD 2>$null
if ($sha) {
  if (git -C $root status --porcelain 2>$null) { $sha += '-dirty' }
  Set-Content (Join-Path $dst 'commit.txt') $sha
}
# repo.txt = the main checkout (not the build worktree), where the launcher looks for new commits.
$common = git -C $root rev-parse --path-format=absolute --git-common-dir 2>$null
$repo = if ($common) { Split-Path $common -Parent } else { $root }
$ErrorActionPreference = 'Stop'

# Launcher lives outside the install dir, which is replaced on every update.
$launcher = Join-Path $env:LOCALAPPDATA 'BridgeMind-launcher'
New-Item -ItemType Directory -Force $launcher | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'update-app.ps1'), (Join-Path $PSScriptRoot 'launch-latest.vbs') $launcher -Force
Set-Content (Join-Path $launcher 'repo.txt') $repo

$sh = New-Object -ComObject WScript.Shell
$startMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), $startMenu)) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'BridgeMind.lnk'))
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = "`"$launcher\launch-latest.vbs`""
  $lnk.WorkingDirectory = $dst
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = 'BridgeMind - multi-agent workspace for Claude Code (always the latest main)'
  $lnk.Save()
}
# Forced update, also while the app is open (asks before closing it).
$lnk = $sh.CreateShortcut((Join-Path $startMenu 'BridgeMind - Mettre a jour.lnk'))
$lnk.TargetPath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
$lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher\update-app.ps1`" -Launch"
$lnk.WorkingDirectory = $launcher
$lnk.IconLocation = "$exe,0"
$lnk.Description = 'Rebuild and reinstall BridgeMind from the latest main'
$lnk.Save()

# Uninstaller + "Installed apps" entry (HKCU, per-user)
$un = Join-Path $dst 'uninstall.ps1'
@'
Get-Process BridgeMind -ErrorAction SilentlyContinue | Stop-Process -Force
$p = netstat -ano | Select-String ':7777 .*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($p) { taskkill /PID $p /T /F | Out-Null }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'BridgeMind.lnk') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BridgeMind.lnk') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BridgeMind - Mettre a jour.lnk') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:LOCALAPPDATA 'BridgeMind-launcher') -Recurse -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BridgeMind' -Recurse -ErrorAction SilentlyContinue
Start-Process cmd -ArgumentList '/c timeout 2 >nul & rmdir /s /q "%LOCALAPPDATA%\Programs\BridgeMind"' -WindowStyle Hidden
# Data (~\.bridgemind) and the build worktree (%LOCALAPPDATA%\BridgeMind-build) are kept on purpose.
'@ | Set-Content -Encoding UTF8 $un
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BridgeMind'
New-Item $k -Force | Out-Null
$v = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
if ($sha) { $v += "+$($sha.Substring(0, 7))" }
@{ DisplayName = 'BridgeMind'; DisplayVersion = $v; Publisher = 'local'; DisplayIcon = $exe; InstallLocation = $dst; NoModify = 1; NoRepair = 1
   UninstallString = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$un`"" }.GetEnumerator() | ForEach-Object {
  if ($_.Value -is [int]) { New-ItemProperty $k -Name $_.Key -Value $_.Value -PropertyType DWord -Force | Out-Null }
  else { New-ItemProperty $k -Name $_.Key -Value $_.Value -PropertyType String -Force | Out-Null }
}
$size = [int]((Get-ChildItem $dst -Recurse | Measure-Object Length -Sum).Sum / 1KB)
New-ItemProperty $k -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
Write-Output "Installed to $dst ($([int]($size/1024)) MB, $v). Launch: Start menu > BridgeMind"
