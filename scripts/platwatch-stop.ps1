# Stops the running PlatWatch daemon.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\platwatch-stop.ps1
#
# Targets the node process holding the UI port, not the Task Scheduler task.
# Ending the task from Task Scheduler stops the PowerShell launcher but can
# leave its node child running, so the port is the reliable handle.
#
# This is a hard stop. That is safe: the database is SQLite in WAL mode, and an
# interrupted sweep resumes where it left off on the next start.

param([int]$Port = 5173)

$conn = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

if (-not $conn) {
    Write-Output "PlatWatch is not running (nothing listening on 127.0.0.1:$Port)."
    return
}

$proc = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -ne 'node') {
    Write-Output "Port $Port is held by '$($proc.ProcessName)' (pid $($proc.Id)), not PlatWatch. Leaving it alone."
    return
}

Stop-Process -Id $conn.OwningProcess -Force
Write-Output "Stopped PlatWatch (pid $($conn.OwningProcess))."
