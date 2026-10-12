' Starts the BridgeMind hub hidden (no console) and opens the app window.
' If the hub is already running, only the window opens.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
sh.CurrentDirectory = root
If Not fso.FolderExists(root & "\dist") Then sh.Run "cmd /c npm run build", 0, True
sh.Run "cmd /c node hub\index.ts --open >> """ & sh.ExpandEnvironmentStrings("%USERPROFILE%") & "\.bridgemind\hub.log"" 2>&1", 0, False
