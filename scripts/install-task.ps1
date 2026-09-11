# Registers PlatWatch to start at logon, for the current user only.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-task.ps1
#
# Undo with scripts\uninstall-task.ps1. No administrator rights needed: the
# task runs as you, only while you are logged on, so no password is stored.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'platwatch.ps1'
$taskName = 'PlatWatch'

$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`"" `
    -WorkingDirectory $root

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
# ExecutionTimeLimit 0 matters: the default is 72 hours, after which Windows
# would silently kill a daemon that is meant to run indefinitely.

$principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $taskName `
    -Description 'PlatWatch: Warframe platinum trading scanner. Runs the daemon (UI on 127.0.0.1:5173, scheduled crawls, live sniper). Logs to .cache\platwatch.log.' `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Force | Out-Null

Write-Output "Registered scheduled task '$taskName' (starts at logon)."
Write-Output "Start it now with:  Start-ScheduledTask -TaskName $taskName"
