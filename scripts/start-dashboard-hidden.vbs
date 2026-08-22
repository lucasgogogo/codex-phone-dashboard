Option Explicit

Dim shell, fileSystem, scriptDir, launcherPath, powershellPath
Dim quote, command, exitCode

Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

scriptDir = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fileSystem.BuildPath(scriptDir, "start-dashboard-detached.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
quote = Chr(34)
command = quote & powershellPath & quote & " -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & quote & launcherPath & quote

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
