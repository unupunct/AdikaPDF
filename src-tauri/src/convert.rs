//! Import engines that need native help: Office documents (through the
//! locally installed Microsoft Office, or LibreOffice as a fallback), HTML
//! pages (through Microsoft Edge's headless print-to-PDF, which ships with
//! Windows 11) and WIA scanners. Nothing is uploaded anywhere.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::ipc::Response;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A scratch directory removed on drop, so failed conversions leave nothing.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("adika-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create temp folder: {e}"))?;
        Ok(Self(dir))
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
}

/// Runs a process with a hard timeout; returns stderr text on failure.
fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(), String> {
    let mut child = hidden(cmd).spawn().map_err(|e| format!("Could not start converter: {e}"))?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => {
                let out = child.wait_with_output().map_err(|e| e.to_string())?;
                if status.success() {
                    return Ok(());
                }
                let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
                let msg = if msg.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { msg };
                return Err(if msg.is_empty() { format!("Converter exited with {status}") } else { msg });
            }
            None if start.elapsed() > timeout => {
                let _ = child.kill();
                return Err("The converter timed out.".into());
            }
            None => std::thread::sleep(Duration::from_millis(150)),
        }
    }
}

/// PowerShell scripts must stay pure ASCII: Windows PowerShell 5.1 reads
/// BOM-less scripts in the ANSI code page.
const OFFICE_PS1: &str = r#"
param([string]$Kind, [string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
function Release($o) { if ($o) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }
switch ($Kind) {
  'word' {
    $app = New-Object -ComObject Word.Application
    try {
      $app.Visible = $false; $app.DisplayAlerts = 0
      $doc = $app.Documents.Open($In, $false, $true, $false)
      # 17 = wdExportFormatPDF, 0 = print quality, 1 = bookmarks from headings
      $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
      $doc.Close(0); Release $doc
    } finally { $app.Quit(); Release $app }
  }
  'excel' {
    $app = New-Object -ComObject Excel.Application
    try {
      $app.Visible = $false; $app.DisplayAlerts = $false
      $wb = $app.Workbooks.Open($In, 0, $true)
      # 0 = xlTypePDF; honours print areas, page breaks and gridline settings.
      # Excel refuses to export PDF when no printer is installed: fall back to
      # a web page (44 = xlHtml) that Adika then prints to PDF with Edge.
      try { $wb.ExportAsFixedFormat(0, $Out) }
      catch {
        if ($_.Exception.Message -match 'printer') { $wb.SaveAs(($Out -replace '[.]pdf$', '.htm'), 44) }
        else { throw }
      }
      $wb.Close($false); Release $wb
    } finally { $app.Quit(); Release $app }
  }
  'powerpoint' {
    $app = New-Object -ComObject PowerPoint.Application
    try {
      $pres = $app.Presentations.Open($In, -1, 0, 0)
      # 32 = ppSaveAsPDF
      $pres.SaveAs($Out, 32)
      $pres.Close(); Release $pres
    } finally { $app.Quit(); Release $app }
  }
}
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
if (-not (Test-Path -LiteralPath $Out) -and -not (Test-Path -LiteralPath ($Out -replace '[.]pdf$', '.htm'))) { throw 'Office did not produce a PDF.' }
"#;

fn office_kind(ext: &str) -> Option<&'static str> {
    match ext {
        "doc" | "docx" | "docm" | "dot" | "dotx" | "rtf" | "odt" | "wpd" => Some("word"),
        "xls" | "xlsx" | "xlsm" | "xlsb" | "csv" | "ods" => Some("excel"),
        "ppt" | "pptx" | "pptm" | "pps" | "ppsx" | "odp" => Some("powerpoint"),
        _ => None,
    }
}

fn office_prog_id_installed(kind: &str) -> bool {
    let prog = match kind {
        "word" => "Word.Application",
        "excel" => "Excel.Application",
        _ => "PowerPoint.Application",
    };
    Command::new("reg")
        .args(["query", &format!(r"HKCR\{prog}\CLSID")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags_compat()
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

trait CreationFlagsCompat {
    fn creation_flags_compat(&mut self) -> &mut Self;
}
impl CreationFlagsCompat for Command {
    fn creation_flags_compat(&mut self) -> &mut Self {
        #[cfg(windows)]
        self.creation_flags(CREATE_NO_WINDOW);
        self
    }
}

fn find_libreoffice() -> Option<PathBuf> {
    [r"C:\Program Files\LibreOffice\program\soffice.exe", r"C:\Program Files (x86)\LibreOffice\program\soffice.exe"]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
}

fn find_edge() -> Option<PathBuf> {
    [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ]
    .iter()
    .map(PathBuf::from)
    .find(|p| p.is_file())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConverterAvailability {
    word: bool,
    excel: bool,
    powerpoint: bool,
    libreoffice: bool,
    edge: bool,
}

#[tauri::command]
pub fn converter_availability() -> ConverterAvailability {
    ConverterAvailability {
        word: office_prog_id_installed("word"),
        excel: office_prog_id_installed("excel"),
        powerpoint: office_prog_id_installed("powerpoint"),
        libreoffice: find_libreoffice().is_some(),
        edge: find_edge().is_some(),
    }
}

fn read_pdf(path: &Path) -> Result<Response, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("Converted PDF missing: {e}"))?;
    if !bytes.starts_with(b"%PDF") {
        return Err("The converter produced something that is not a PDF.".into());
    }
    Ok(Response::new(bytes))
}

/// Converts a Word/Excel/PowerPoint (or OpenDocument/RTF/CSV) file to PDF.
#[tauri::command]
pub async fn office_to_pdf(path: String) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let src = PathBuf::from(&path);
        if !src.is_file() {
            return Err(format!("File not found: {path}"));
        }
        let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        let kind = office_kind(&ext).ok_or_else(|| format!("Unsupported document type: .{ext}"))?;
        let scratch = Scratch::new()?;
        // Copy first: Office refuses paths with some characters and may lock the original.
        let input = scratch.path(&format!("input.{ext}"));
        std::fs::copy(&src, &input).map_err(|e| format!("Could not read {path}: {e}"))?;
        let out = scratch.path("output.pdf");

        let mut office_err = None;
        if office_prog_id_installed(kind) {
            let script = scratch.path("convert.ps1");
            std::fs::write(&script, OFFICE_PS1).map_err(|e| e.to_string())?;
            let res = run_with_timeout(
                Command::new("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(&script)
                    .args(["-Kind", kind, "-In"])
                    .arg(&input)
                    .arg("-Out")
                    .arg(&out),
                Duration::from_secs(300),
            );
            let html_fallback = out.with_extension("htm");
            match res {
                Ok(()) if out.is_file() => return read_pdf(&out),
                Ok(()) if html_fallback.is_file() => {
                    // No printer installed: Excel saved HTML; Edge turns it into the PDF.
                    let target = format!("file:///{}", html_fallback.to_string_lossy().replace('\\', "/"));
                    return read_pdf(&edge_print_to_pdf(&scratch, target)?);
                }
                Ok(()) => office_err = Some("Office finished without producing a PDF.".to_string()),
                Err(e) => office_err = Some(e),
            }
        }
        if let Some(soffice) = find_libreoffice() {
            let profile = scratch.path("lo-profile");
            let profile_url = format!("-env:UserInstallation=file:///{}", profile.to_string_lossy().replace('\\', "/"));
            run_with_timeout(
                Command::new(soffice)
                    .arg(profile_url)
                    .args(["--headless", "--norestore", "--convert-to", "pdf", "--outdir"])
                    .arg(&scratch.0)
                    .arg(&input),
                Duration::from_secs(300),
            )?;
            return read_pdf(&scratch.path("input.pdf"));
        }
        Err(match office_err {
            Some(e) => format!("Microsoft Office could not convert the file: {e}"),
            None => "Converting Office documents needs Microsoft Office or LibreOffice installed.".into(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Prints an HTML document (or a live http/https URL) to PDF with Edge.
/// `html` wins when both are given. Page size/margins come from the page's
/// own `@page` CSS, which the caller injects for generated HTML.
#[tauri::command]
pub async fn html_to_pdf(html: Option<String>, url: Option<String>) -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scratch = Scratch::new()?;
        let target = match (html, url) {
            (Some(html), _) => {
                let file = scratch.path("page.html");
                std::fs::write(&file, html).map_err(|e| e.to_string())?;
                format!("file:///{}", file.to_string_lossy().replace('\\', "/"))
            }
            (None, Some(url)) => {
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                    return Err("Only http:// and https:// addresses can be converted.".into());
                }
                url
            }
            (None, None) => return Err("Nothing to convert.".into()),
        };
        read_pdf(&edge_print_to_pdf(&scratch, target)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Prints a page (file:// or http(s)) to PDF with headless Edge.
fn edge_print_to_pdf(scratch: &Scratch, target: String) -> Result<PathBuf, String> {
    let edge = find_edge().ok_or("Microsoft Edge was not found; it is needed to render this document to PDF.")?;
    let out = scratch.path("page.pdf");
    run_with_timeout(
        Command::new(edge)
            .args([
                "--headless=new",
                "--disable-gpu",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-extensions",
                "--no-pdf-header-footer",
                "--virtual-time-budget=8000",
            ])
            .arg(format!("--user-data-dir={}", scratch.path("edge-profile").to_string_lossy()))
            .arg(format!("--print-to-pdf={}", out.to_string_lossy()))
            .arg(target),
        Duration::from_secs(120),
    )?;
    Ok(out)
}

const SCAN_PS1: &str = r#"
param([string]$Out)
$ErrorActionPreference = 'Stop'
$dlg = New-Object -ComObject WIA.CommonDialog
# DeviceType 1 = scanner; FormatID = PNG; UseCommonUI = true (lets the user pick DPI/colour)
$img = $dlg.ShowAcquireImage(1, 0, 0, '{B96B3CAF-0728-11D3-9D7B-0000F81EF32E}', $false, $true, $false)
if ($img -eq $null) { exit 3 }
$img.SaveFile($Out)
"#;

/// Acquires one page from a WIA scanner with the standard Windows dialog.
/// Returns PNG (or whatever the driver produced) bytes; empty when cancelled.
#[tauri::command]
pub async fn scan_wia() -> Result<Response, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let scratch = Scratch::new()?;
        let script = scratch.path("scan.ps1");
        std::fs::write(&script, SCAN_PS1).map_err(|e| e.to_string())?;
        let out = scratch.path("scan.png");
        let res = run_with_timeout(
            Command::new("powershell.exe")
                .args(["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
                .arg(&script)
                .arg("-Out")
                .arg(&out),
            Duration::from_secs(600),
        );
        match res {
            Ok(()) if out.is_file() => std::fs::read(&out).map(Response::new).map_err(|e| e.to_string()),
            Ok(()) => Ok(Response::new(Vec::new())),
            Err(e) if e.contains("0x80210015") || e.to_ascii_lowercase().contains("no wia device") => {
                Err("No scanner found. Connect a WIA-compatible scanner and try again.".into())
            }
            Err(e) => Err(format!("Scanning failed: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
