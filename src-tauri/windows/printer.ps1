# Adika PDF Editor - virtual printer setup (run by the installer as administrator).
# Creates the printer "Adika PDF Editor" on Windows' built-in "Microsoft Print To PDF"
# driver with a file port, so print jobs are written silently to
#   %ProgramData%\Adika PDF Editor\print\adika-print.pdf
# where the Adika print helper picks them up and opens them in Adika.
# ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [switch]$EnableSpooler
)
$ErrorActionPreference = 'Continue'
$printerName = 'Adika PDF Editor'
$driverName = 'Microsoft Print To PDF'
$spoolDir = Join-Path $env:ProgramData 'Adika PDF Editor\print'
$port = Join-Path $spoolDir 'adika-print.pdf'

function Log($msg) {
  $logDir = Join-Path $PSScriptRoot 'logs'
  if (Test-Path -LiteralPath $logDir) {
    Add-Content -LiteralPath (Join-Path $logDir 'printer-setup.log') -Value ("{0} {1}" -f (Get-Date -Format s), $msg)
  }
}

if ($Action -eq 'uninstall') {
  try { Remove-Printer -Name $printerName -ErrorAction Stop; Log 'printer removed' } catch { Log "remove printer: $_" }
  try { Remove-PrinterPort -Name $port -ErrorAction Stop; Log 'port removed' } catch { Log "remove port: $_" }
  Remove-Item -LiteralPath $spoolDir -Recurse -Force -ErrorAction SilentlyContinue
  exit 0
}

# Folder where print jobs land; every user may write (each job is moved away at once).
New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null
& icacls.exe $spoolDir /grant '*S-1-5-32-545:(OI)(CI)M' /Q | Out-Null

$spooler = Get-Service -Name Spooler -ErrorAction SilentlyContinue
if ($spooler -and $spooler.Status -ne 'Running') {
  if ($EnableSpooler) {
    Set-Service -Name Spooler -StartupType Automatic
    Start-Service -Name Spooler
    Log 'Print Spooler set to Automatic and started'
  } else {
    Log 'Print Spooler is not running; printer not created (run printer.ps1 -EnableSpooler to add it later)'
    exit 0
  }
}

if (-not (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue)) {
  Log 'Microsoft Print To PDF driver missing; enabling the Windows feature'
  Enable-WindowsOptionalFeature -Online -FeatureName 'Printing-PrintToPDFServices-Features' -NoRestart -ErrorAction SilentlyContinue | Out-Null
}

try {
  if (-not (Get-PrinterPort -Name $port -ErrorAction SilentlyContinue)) { Add-PrinterPort -Name $port -ErrorAction Stop }
  if (-not (Get-Printer -Name $printerName -ErrorAction SilentlyContinue)) {
    Add-Printer -Name $printerName -DriverName $driverName -PortName $port -ErrorAction Stop
  }
  Log 'virtual printer ready'
} catch {
  Log "printer setup failed: $_"
}
exit 0
