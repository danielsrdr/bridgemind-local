# Creates a "BridgeMind" shortcut on the Desktop and in the Start menu.
$root = Split-Path $PSScriptRoot -Parent
$sh = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $sh.CreateShortcut((Join-Path $dir 'BridgeMind.lnk'))
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = "`"$root\scripts\launch.vbs`""
  $lnk.WorkingDirectory = $root
  $lnk.IconLocation = "$root\scripts\bridgemind.ico,0"
  $lnk.Description = 'BridgeMind Local - multi-agent workspace for Claude Code'
  $lnk.Save()
}
Write-Output "Shortcuts created."
