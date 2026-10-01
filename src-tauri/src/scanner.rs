//! Scanning through Windows Image Acquisition without the driver dialog:
//! the scanner, source (flatbed / feeder / both sides), colour mode,
//! resolution and paper size are chosen in Adika, and a document feeder is
//! emptied in one go.

use crate::convert::{run_with_timeout, Scratch};
use std::process::Command;
use std::time::Duration;
use tauri::ipc::Response;

const LIST_PS1: &str = r#"
param([string]$Out)
$ErrorActionPreference = 'Stop'
$dm = New-Object -ComObject WIA.DeviceManager
$lines = @()
foreach ($i in $dm.DeviceInfos) {
  if ($i.Type -ne 1) { continue } # scanners only
  $name = $i.Properties.Item('Name').Value
  $feeder = $false
  try {
    $dev = $i.Connect()
    foreach ($p in $dev.Properties) { if ($p.PropertyID -eq 3086 -and ($p.Value -band 1)) { $feeder = $true } } # document handling capabilities: FEED
  } catch {}
  $lines += "$($i.DeviceID)`t$name`t$feeder"
}
[IO.File]::WriteAllLines($Out, [string[]]$lines, [Text.Encoding]::UTF8)
"#;

const SCAN_PS1: &str = r#"
param([string]$Device, [int]$Dpi, [int]$Intent, [int]$Source, [double]$WidthMm, [double]$HeightMm, [string]$OutDir)
$ErrorActionPreference = 'Stop'
$dm = New-Object -ComObject WIA.DeviceManager
$info = $null
foreach ($i in $dm.DeviceInfos) { if ($i.DeviceID -eq $Device) { $info = $i } }
if (-not $info) { throw 'SCANNER_GONE' }
$dev = $info.Connect()
function SetProp($props, [int]$id, $val) { foreach ($p in $props) { if ($p.PropertyID -eq $id) { try { $p.Value = $val } catch {} } } }
# Document handling select (3088): 1 feeder, 2 flatbed, 5 feeder + both sides. Pages (3096): 0 = all.
SetProp $dev.Properties 3088 $Source
if ($Source -ne 2) { SetProp $dev.Properties 3096 0 }
$item = $dev.Items.Item(1)
SetProp $item.Properties 6146 $Intent # 1 colour, 2 grayscale, 4 black and white
SetProp $item.Properties 6147 $Dpi
SetProp $item.Properties 6148 $Dpi
if ($WidthMm -gt 0) {
  SetProp $item.Properties 6149 0
  SetProp $item.Properties 6150 0
  SetProp $item.Properties 6151 ([int]($WidthMm / 25.4 * $Dpi))
  SetProp $item.Properties 6152 ([int]($HeightMm / 25.4 * $Dpi))
}
$png = '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}'
$n = 0
while ($true) {
  try { $img = $item.Transfer($png) }
  catch {
    $code = $_.Exception.HResult
    # 0x80210003 WIA_ERROR_PAPER_EMPTY: the feeder is done (or was empty).
    if ($code -eq -2145320957) { if ($n -eq 0) { throw 'FEEDER_EMPTY' } else { break } }
    throw
  }
  $n++
  $img.SaveFile((Join-Path $OutDir ('page{0:D4}.png' -f $n)))
  if ($Source -eq 2) { break }
}
"#;

#[derive(serde::Serialize)]
pub struct ScannerInfo {
    id: String,
    name: String,
    feeder: bool,
}

fn powershell(script: &std::path::Path) -> Command {
    let mut c = Command::new("powershell.exe");
    c.args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"]).arg(script);
    c
}

/// WIA scanners connected to this computer.
#[tauri::command]
pub async fn wia_devices() -> Result<Vec<ScannerInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let scratch = Scratch::new()?;
        let script = scratch.path("list.ps1");
        std::fs::write(&script, LIST_PS1).map_err(|e| e.to_string())?;
        let out = scratch.path("list.txt");
        run_with_timeout(powershell(&script).arg("-Out").arg(&out), Duration::from_secs(60)).map_err(|e| format!("Could not list the scanners: {e}"))?;
        let text = std::fs::read_to_string(&out).unwrap_or_default();
        Ok(text
            .trim_start_matches('\u{feff}')
            .lines()
            .filter_map(|l| {
                let mut p = l.split('\t');
                Some(ScannerInfo { id: p.next()?.to_string(), name: p.next()?.to_string(), feeder: p.next() == Some("True") })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Scans every page (one from the flatbed, all from the feeder). The
/// response is `count` then `length, bytes` per page (u32 little-endian).
#[tauri::command]
pub async fn wia_scan(device: String, dpi: u32, mode: String, source: String, width_mm: f64, height_mm: f64) -> Result<Response, String> {
    let intent = match mode.as_str() {
        "gray" => 2,
        "bw" => 4,
        _ => 1,
    };
    let src = match source.as_str() {
        "feeder" => 1,
        "duplex" => 5,
        _ => 2,
    };
    tauri::async_runtime::spawn_blocking(move || {
        let scratch = Scratch::new()?;
        let script = scratch.path("scan.ps1");
        std::fs::write(&script, SCAN_PS1).map_err(|e| e.to_string())?;
        let dir = scratch.path("pages");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let res = run_with_timeout(
            powershell(&script)
                .arg("-Device")
                .arg(&device)
                .arg("-Dpi")
                .arg(dpi.clamp(75, 1200).to_string())
                .arg("-Intent")
                .arg(intent.to_string())
                .arg("-Source")
                .arg(src.to_string())
                .arg("-WidthMm")
                .arg(format!("{width_mm:.1}"))
                .arg("-HeightMm")
                .arg(format!("{height_mm:.1}"))
                .arg("-OutDir")
                .arg(&dir),
            Duration::from_secs(1800),
        );
        if let Err(e) = res {
            return Err(if e.contains("FEEDER_EMPTY") {
                "The document feeder is empty. Put the pages in the feeder and try again.".into()
            } else if e.contains("SCANNER_GONE") {
                "The scanner is no longer connected.".into()
            } else if e.contains("0x80210006") || e.contains("-2145320954") {
                "The scanner is busy.".into()
            } else if e.contains("0x8021000C") || e.contains("-2145320948") || e.contains("0x80210002") || e.contains("-2145320958") {
                "The scanner reports a paper jam or a problem. Check it and try again.".into()
            } else {
                format!("Scanning failed: {e}")
            });
        }
        let mut files: Vec<_> = std::fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        files.sort();
        let mut out = Vec::new();
        out.extend_from_slice(&(files.len() as u32).to_le_bytes());
        for f in files {
            let b = std::fs::read(&f).map_err(|e| e.to_string())?;
            out.extend_from_slice(&(b.len() as u32).to_le_bytes());
            out.extend_from_slice(&b);
        }
        Ok(Response::new(out))
    })
    .await
    .map_err(|e| e.to_string())?
}
