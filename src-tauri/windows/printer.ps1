# Adika PDF Editor - virtual printer setup (run by the installer as administrator).
# Creates the printer "Adika PDF Editor" on Windows' built-in "Microsoft Print To PDF"
# driver with a file port, so print jobs are written silently to
#   %ProgramData%\Adika PDF Editor\print\adika-print.pdf
# where the Adika print helper of the user who printed picks them up and opens them in Adika.
# ASCII only: Windows PowerShell 5.1 reads BOM-less scripts in the ANSI code page.
param(
  [ValidateSet('install', 'uninstall')][string]$Action = 'install',
  [switch]$EnableSpooler,
  # Uninstall only: put back the Print Spooler start type and the Print to PDF feature
  # if this script changed them at install (not when the uninstall is part of an update).
  [switch]$RestoreSystem
)
$ErrorActionPreference = 'Continue'
$printerName = 'Adika PDF Editor'
$driverName = 'Microsoft Print To PDF'
$spoolDir = Join-Path $env:ProgramData 'Adika PDF Editor\print'
$port = Join-Path $spoolDir 'adika-print.pdf'
# What the install changed in Windows, so the uninstall can undo exactly that.
$stateKey = 'HKLM:\SOFTWARE\Adika PDF Editor\Printer'
$feature = 'Printing-PrintToPDFServices-Features'

function Log($msg) {
  $logDir = Join-Path $PSScriptRoot 'logs'
  if (Test-Path -LiteralPath $logDir) {
    Add-Content -LiteralPath (Join-Path $logDir 'printer-setup.log') -Value ("{0} {1}" -f (Get-Date -Format s), $msg)
  }
}

function Remember($name, $value) {
  if (-not (Test-Path $stateKey)) { New-Item -Path $stateKey -Force | Out-Null }
  # Only the first change counts: that is the state before Adika.
  if ($null -eq (Get-ItemProperty -Path $stateKey -Name $name -ErrorAction SilentlyContinue)) {
    New-ItemProperty -Path $stateKey -Name $name -Value $value -PropertyType String -Force | Out-Null
  }
}

if ($Action -eq 'uninstall') {
  try { Remove-Printer -Name $printerName -ErrorAction Stop; Log 'printer removed' } catch { Log "remove printer: $_" }
  try { Remove-PrinterPort -Name $port -ErrorAction Stop; Log 'port removed' } catch { Log "remove port: $_" }
  Remove-Item -LiteralPath $spoolDir -Recurse -Force -ErrorAction SilentlyContinue
  if ($RestoreSystem -and (Test-Path $stateKey)) {
    $state = Get-ItemProperty -Path $stateKey -ErrorAction SilentlyContinue
    if ($state.SpoolerStartType) {
      try {
        Set-Service -Name Spooler -StartupType $state.SpoolerStartType -ErrorAction Stop
        if ($state.SpoolerStartType -eq 'Disabled') { Stop-Service -Name Spooler -Force -ErrorAction SilentlyContinue }
        Log "Print Spooler start type restored to $($state.SpoolerStartType)"
      } catch { Log "restore spooler: $_" }
    }
    if ($state.EnabledPrintToPdf -eq '1') {
      Disable-WindowsOptionalFeature -Online -FeatureName $feature -NoRestart -ErrorAction SilentlyContinue | Out-Null
      Log 'Microsoft Print to PDF feature disabled again'
    }
    Remove-Item -Path $stateKey -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -Path 'HKLM:\SOFTWARE\Adika PDF Editor' -ErrorAction SilentlyContinue
  }
  exit 0
}

# Folder where print jobs land. Every user may create a file there, but a file is
# reachable only by its owner (the user whose job the spooler wrote): nobody can
# read, replace or take another user's print job. No inheritance from ProgramData.
#   S-1-5-18 SYSTEM, S-1-5-32-544 Administrators: full control
#   S-1-3-0 CREATOR OWNER: full control of the files a user creates
#   S-1-5-32-545 Users, this folder only: list, create files, read attributes, traverse
New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null
# A job left by an earlier version (looser ACL) is not handed to anyone.
Remove-Item -LiteralPath $port -Force -ErrorAction SilentlyContinue
& icacls.exe $spoolDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' '*S-1-3-0:(OI)(CI)(IO)F' '*S-1-5-32-545:(RD,WD,RA,REA,X,RC)' /Q | Out-Null
if ($LASTEXITCODE -ne 0) { Log "icacls on the spool folder failed ($LASTEXITCODE)" }

$spooler = Get-Service -Name Spooler -ErrorAction SilentlyContinue
if ($spooler -and $spooler.Status -ne 'Running') {
  if ($EnableSpooler) {
    Remember 'SpoolerStartType' ([string]$spooler.StartType)
    Set-Service -Name Spooler -StartupType Automatic
    Start-Service -Name Spooler
    Log "Print Spooler set to Automatic and started (was $($spooler.StartType))"
  } else {
    Log 'Print Spooler is not running; printer not created (run printer.ps1 -EnableSpooler to add it later)'
    exit 0
  }
}

if (-not (Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue)) {
  Log 'Microsoft Print To PDF driver missing; enabling the Windows feature'
  $before = Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue
  Enable-WindowsOptionalFeature -Online -FeatureName $feature -NoRestart -ErrorAction SilentlyContinue | Out-Null
  if ($before -and [string]$before.State -ne 'Enabled') { Remember 'EnabledPrintToPdf' '1' }
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
