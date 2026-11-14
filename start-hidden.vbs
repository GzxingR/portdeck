' Launch the PortDeck supervisor with no console window.
' Synchronous so the scheduled task stays Running while the supervisor lives;
' Task Scheduler restart-on-failure covers a supervisor crash.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & root & "\supervise.ps1"""
sh.Run cmd, 0, True
