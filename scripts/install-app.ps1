# Installs the packaged app like a normal Windows app (per-user, no admin):
#   %LOCALAPPDATA%\Programs\BridgeMind  + Desktop & Start menu shortcuts + "Installed apps" entry (uninstallable).
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
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'BridgeMind.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dst
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = 'BridgeMind - multi-agent workspace for Claude Code'
  $lnk.Save()
}

# Uninstaller + "Installed apps" entry (HKCU, per-user)
$un = Join-Path $dst 'uninstall.ps1'
@'
Get-Process BridgeMind -ErrorAction SilentlyContinue | Stop-Process -Force
$p = netstat -ano | Select-String ':7777 .*LISTENING' | ForEach-Object { ($_ -split '\s+')[-1] } | Select-Object -First 1
if ($p) { taskkill /PID $p /T /F | Out-Null }
Remove-Item (Join-Path ([Environment]::GetFolderPath('Desktop')) 'BridgeMind.lnk') -ErrorAction SilentlyContinue
Remove-Item (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\BridgeMind.lnk') -ErrorAction SilentlyContinue
Remove-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BridgeMind' -Recurse -ErrorAction SilentlyContinue
Start-Process cmd -ArgumentList '/c timeout 2 >nul & rmdir /s /q "%LOCALAPPDATA%\Programs\BridgeMind"' -WindowStyle Hidden
# Data (~\.bridgemind) is kept on purpose.
'@ | Set-Content -Encoding UTF8 $un
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\BridgeMind'
New-Item $k -Force | Out-Null
$v = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
@{ DisplayName = 'BridgeMind'; DisplayVersion = $v; Publisher = 'local'; DisplayIcon = $exe; InstallLocation = $dst; NoModify = 1; NoRepair = 1
   UninstallString = "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$un`"" }.GetEnumerator() | ForEach-Object {
  if ($_.Value -is [int]) { New-ItemProperty $k -Name $_.Key -Value $_.Value -PropertyType DWord -Force | Out-Null }
  else { New-ItemProperty $k -Name $_.Key -Value $_.Value -PropertyType String -Force | Out-Null }
}
$size = [int]((Get-ChildItem $dst -Recurse | Measure-Object Length -Sum).Sum / 1KB)
New-ItemProperty $k -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
Write-Output "Installed to $dst ($([int]($size/1024)) MB). Launch: Start menu > BridgeMind"
