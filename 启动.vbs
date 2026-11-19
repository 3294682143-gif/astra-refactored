' Zygos one-click launcher - runs the demo server hidden (NO terminal window) and opens the browser.
' Double-click this file. It reuses an existing Python environment (no dependency install).
Dim fso, sh, here, py, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here
py = "python"
If fso.FileExists(here & "\.venv\Scripts\python.exe") Then
  py = here & "\.venv\Scripts\python.exe"
ElseIf fso.FileExists(here & "\venv\Scripts\python.exe") Then
  py = here & "\venv\Scripts\python.exe"
End If
cmd = """" & py & """ """ & here & "\scripts\demo_serve.py"" 8000"
sh.Run cmd, 0, False
' 0 = hidden window, False = do not wait