# Opens a document read-only in Microsoft Word (COM), writes Content.Text
# (UTF-8) to OutPath, closes without saving and quits Word.
# Exit codes: 0 ok, 2 Word COM unavailable, 3 open/read failed.
# This file must stay pure ASCII (Windows PowerShell 5.1 reads it as ANSI).
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$OutPath
)
$ErrorActionPreference = 'Stop'
try {
  $word = New-Object -ComObject Word.Application
} catch {
  Write-Output ('WORD_UNAVAILABLE: ' + $_.Exception.Message)
  exit 2
}
$code = 0
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0
  # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles)
  $doc = $word.Documents.Open($Path, $false, $true, $false)
  try {
    $text = $doc.Content.Text
    $pages = $doc.ComputeStatistics(2)
    $tables = $doc.Tables.Count
    $payload = "PAGES=$pages`nTABLES=$tables`n" + $text
    [System.IO.File]::WriteAllText($OutPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
  } finally {
    $doc.Saved = $true
    $doc.Close()
  }
} catch {
  Write-Output ('WORD_ERROR: ' + $_.Exception.Message)
  $code = 3
} finally {
  $word.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
exit $code
