' Target of the "BridgeMind" Desktop / Start menu shortcuts: opens the installed app,
' rebuilding it first (in a visible console) when main has newer commits. No console flash otherwise.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & here & "\update-app.ps1"" -IfNeeded -Launch", 0, False
