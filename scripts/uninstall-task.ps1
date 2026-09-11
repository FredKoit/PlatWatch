# Removes the PlatWatch scheduled task and stops the daemon if it is running.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\uninstall-task.ps1

$ErrorActionPreference = 'Stop'
$taskName = 'PlatWatch'

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed scheduled task '$taskName'."
} else {
    Write-Output "No scheduled task '$taskName' to remove."
}

& (Join-Path $PSScriptRoot 'platwatch-stop.ps1')
