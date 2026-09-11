# Shows a Windows toast notification for a PlatWatch alert.
#
# Called by the daemon, never by hand. The text arrives in environment
# variables rather than on the command line, because alerts contain item and
# player names straight from warframe.market: splicing those into a PowerShell
# command would let a crafted in-game name run code on this machine. Here they
# are only ever data — XML-escaped and placed in the toast body.
#
#   PW_TITLE  first line
#   PW_BODY   second line
#   PW_URL    opened when the toast is clicked (the PlatWatch UI)
#
# Needs Windows PowerShell 5.1 for the WinRT type loading below. A failure is
# swallowed: a notification that cannot be shown must never break the daemon.

$ErrorActionPreference = 'Stop'
try {
    $esc = { param($s) [Security.SecurityElement]::Escape([string]$s) }
    $title = & $esc $env:PW_TITLE
    $body  = & $esc $env:PW_BODY
    $url   = & $esc $env:PW_URL

    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

    $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
    $xml.LoadXml(@"
<toast activationType="protocol" launch="$url">
  <visual>
    <binding template="ToastGeneric">
      <text>$title</text>
      <text>$body</text>
    </binding>
  </visual>
</toast>
"@)

    # Borrow Windows PowerShell's app identity so no app registration is needed.
    $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
    $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
} catch {
    exit 0
}
