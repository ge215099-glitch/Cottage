' Cottage dev launcher shim -- starts the app without any console window.
'
' Why this file exists: a desktop shortcut that points straight at node.exe would
' flash a black console window (node is a console-subsystem program) and leave it
' open for as long as the app runs. wscript.exe is a GUI-subsystem program, and
' WshShell.Run with window style 0 gives the child no visible window at all.
'
' This file is deliberately ASCII-only: wscript reads .vbs files using the system
' ANSI code page, so non-ASCII comments here would show up as mojibake.
'
' Failure handling: the node launcher writes <repo>\logs\dev-failure.txt and exits
' non-zero when the app fails to start. We open that file in Notepad, because with
' no console left there would otherwise be no way to see why nothing happened.
Option Explicit

Dim fso, shell, scriptDir, repoRoot, launcher, failFile, nodeExe, rc

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
launcher = fso.BuildPath(scriptDir, "launch-dev.mjs")
failFile = fso.BuildPath(fso.BuildPath(repoRoot, "logs"), "dev-failure.txt")

If Not fso.FileExists(launcher) Then
  MsgBox "Launcher not found:" & vbCrLf & launcher, 16, "Cottage"
  WScript.Quit 1
End If

nodeExe = FindNode(fso, shell)
If nodeExe = "" Then
  MsgBox "node.exe not found." & vbCrLf & vbCrLf & _
         "Cottage dev mode needs Node.js 20 or newer on PATH.", 16, "Cottage"
  WScript.Quit 1
End If

' 0 = hidden window, True = wait for the launcher (it lives as long as the app does)
rc = shell.Run("""" & nodeExe & """ """ & launcher & """", 0, True)

If rc <> 0 Then
  If fso.FileExists(failFile) Then
    shell.Run "notepad.exe """ & failFile & """", 1, False
  Else
    MsgBox "Cottage failed to start (exit code " & rc & ")," & vbCrLf & _
           "and no failure report was written.", 16, "Cottage"
  End If
End If

' Locate node.exe: the usual install locations first, then PATH.
Function FindNode(fso, shell)
  Dim candidates, i, dirs, entry, full
  FindNode = ""
  candidates = Array( _
    shell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\Programs\nodejs\node.exe"), _
    shell.ExpandEnvironmentStrings("%APPDATA%\npm\node.exe") _
  )
  For i = 0 To UBound(candidates)
    If candidates(i) <> "" Then
      If fso.FileExists(candidates(i)) Then
        FindNode = candidates(i)
        Exit Function
      End If
    End If
  Next
  dirs = Split(shell.ExpandEnvironmentStrings("%PATH%"), ";")
  For Each entry In dirs
    If Trim(entry) <> "" Then
      full = fso.BuildPath(Trim(entry), "node.exe")
      If fso.FileExists(full) Then
        FindNode = full
        Exit Function
      End If
    End If
  Next
End Function
