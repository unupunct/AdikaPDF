# Creates a small .msg via Outlook COM: HTML body, one attachment, SaveAs olMSG (3).
# Exit codes: 0 ok, 2 Outlook COM unavailable, 3 failed.
# This file must stay pure ASCII (Windows PowerShell 5.1 reads it as ANSI).
param(
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$AttachmentPath
)
$ErrorActionPreference = 'Stop'
try {
  $ol = New-Object -ComObject Outlook.Application
} catch {
  Write-Output ('OUTLOOK_UNAVAILABLE: ' + $_.Exception.Message)
  exit 2
}
try {
  $m = $ol.CreateItem(0)
  # "Test diacritice" + s-comma, a-breve, t-comma
  $m.Subject = 'Test diacritice ' + [char]0x0219 + [char]0x0103 + [char]0x021B
  $m.To = 'ana@example.com'
  $m.HTMLBody = '<html><body><p>Salut <b>Outlook</b> ' + [char]0x0219 + [char]0x021B + '</p><script>alert(1)</script></body></html>'
  $null = $m.Attachments.Add($AttachmentPath)
  $m.SaveAs($OutPath, 3)
  $m.Close(1)
  exit 0
} catch {
  Write-Output ('OUTLOOK_ERROR: ' + $_.Exception.Message)
  exit 3
}
