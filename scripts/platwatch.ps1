# Starts the PlatWatch daemon unattended. Task Scheduler runs this at logon.
#
# Runs node directly rather than through `npm start`: stopping an npm wrapper
# leaves its node child running, which is how orphaned daemons ended up holding
# the port during development.
#
# Output goes to .cache\platwatch.log. If PlatWatch is already running this
# exits cleanly (the daemon uses its UI port as a single-instance lock).

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# Resolve node at run time so a Node upgrade does not break the task, with the
# default install location as a fallback for a stripped-down PATH.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) {
    $msg = "$(Get-Date -Format o) FATAL node.exe not found; PlatWatch cannot start"
    New-Item -ItemType Directory -Force (Join-Path $root '.cache') | Out-Null
    Add-Content -Path (Join-Path $root '.cache\platwatch.log') -Value $msg
    exit 1
}

& $node --import tsx scripts/daemon.ts --log .cache/platwatch.log
exit $LASTEXITCODE
