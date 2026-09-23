' rclone-outbox.vbs - hidden, looping uploader for a mikser-io-drive endpoint.
'
' Windows cannot mount this drive unattended. The WebDAV redirector reads its
' credentials from the Domain Password store and refuses to persist Basic
' credentials there at all (KB 2673544), so a mapped drive re-prompts after
' every restart and an export silently lands on a dead letter. Measured against
' a live endpoint: four redirector requests during a reconnect, none of them
' carrying an Authorization header, while rclone authenticated on its first.
'
' So the export never touches the network. The exporting application writes to
' a local folder and this moves the folder's contents up, which means an export
' cannot fail because a mount dropped, and an unreachable server only delays
' the upload instead of losing the file.
'
' This is a .vbs and not a .cmd because wscript.exe runs with no console at
' all. A .cmd on a two-minute timer flashes a window on the desktop every two
' minutes, and on a shared machine someone eventually turns it off. The other
' way to run a console tool quietly is a Scheduled Task, which needs elevation
' to register in the root task folder - this needs none: put a shortcut to it
' in shell:startup and it begins with the session.
'
' Usage:
'   wscript rclone-outbox.vbs <outbox folder> <rclone remote> [interval seconds]
'
' For example, against an endpoint declared as `SkinCheck: { folder: ... }`:
'   wscript rclone-outbox.vbs "C:\SkinCheck" SkinCheck:Janus 120

Option Explicit

Dim shell, arguments, outbox, remote, interval, rclone, logFile, command

Set shell = CreateObject("WScript.Shell")
Set arguments = WScript.Arguments

If arguments.Count < 2 Then
    WScript.Echo "usage: wscript rclone-outbox.vbs <outbox folder> <remote> [interval seconds]"
    WScript.Quit 1
End If

outbox = arguments(0)
remote = arguments(1)
If arguments.Count > 2 Then
    interval = CLng(arguments(2))
Else
    interval = 120
End If

rclone = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\rclone\rclone.exe")
logFile = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%\rclone\outbox.log")

' move, not copy: the server is the system of record, the same as the mapped
' drive it replaces, and it keeps the exported documents off a shared desktop.
' It also gives whoever works at the machine a correct indicator that needs no
' explaining - an empty outbox means everything is up, and a failing upload
' makes files visibly pile up instead of failing where nobody looks.
'
' --min-age keeps a file that is still being written out of the transfer. The
' exporting application is long finished with it by the time it ages in, and a
' half-written document uploaded and then deleted locally is unrecoverable.
command = """" & rclone & """ move """ & outbox & """ " & remote & _
          " --min-age 1m --transfers 2 --log-level INFO --log-file """ & logFile & """"

Do
    ' 0 hides the window; True waits for the run to finish, so a slow upload
    ' delays the next pass instead of overlapping with it.
    shell.Run command, 0, True
    WScript.Sleep interval * 1000
Loop
