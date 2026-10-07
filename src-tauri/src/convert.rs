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
pub(crate) struct Scratch(PathBuf);

impl Scratch {
    pub(crate) fn new() -> Result<Self, String> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("adika-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create temp folder: {e}"))?;
        Ok(Self(dir))
    }
    pub(crate) fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        // A converter that was just stopped may hold its files for a moment.
        for _ in 0..10 {
            if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                return;
            }
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}

fn hidden(cmd: &mut Command) -> &mut Command {
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped())
}

/// A Windows job holding the converter and every process it starts, so a
/// timeout stops the whole tree (PowerShell's children, Edge's helpers).
#[cfg(windows)]
struct ProcessJob(windows_sys::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl ProcessJob {
    fn for_child(child: &std::process::Child) -> Option<Self> {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let job = ProcessJob(job);
            (AssignProcessToJobObject(job.0, child.as_raw_handle() as _) != 0).then_some(job)
        }
    }
    fn terminate(&self) {
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

fn drain<R: std::io::Read + Send + 'static>(pipe: Option<R>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(mut p) = pipe {
            let _ = p.read_to_end(&mut buf);
        }
        buf
    })
}

/// Runs a process with a hard timeout; returns stderr text on failure. The
/// output pipes are read while it runs (a chatty process never blocks on a
/// full pipe). `on_timeout` stops what the process started outside its own
/// tree (Office, launched by COM).
pub(crate) fn run_with_timeout_then(cmd: &mut Command, timeout: Duration, on_timeout: &dyn Fn()) -> Result<(), String> {
    let mut child = hidden(cmd).spawn().map_err(|e| format!("Could not start converter: {e}"))?;
    #[cfg(windows)]
    let job = ProcessJob::for_child(&child);
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let start = Instant::now();
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if start.elapsed() > timeout => {
                #[cfg(windows)]
                if let Some(job) = &job {
                    job.terminate();
                }
                let _ = child.kill();
                let _ = child.wait();
                on_timeout();
                return Err("The converter timed out.".into());
            }
            None => std::thread::sleep(Duration::from_millis(150)),
        }
    };
    // A grandchild may keep the pipes open: never wait for it.
    let read = |h: std::thread::JoinHandle<Vec<u8>>| {
        let t = Instant::now();
        while !h.is_finished() && t.elapsed() < Duration::from_secs(2) {
            std::thread::sleep(Duration::from_millis(20));
        }
        if h.is_finished() { h.join().unwrap_or_default() } else { Vec::new() }
    };
    let (stdout, stderr) = (read(out), read(err));
    if status.success() {
        return Ok(());
    }
    let msg = String::from_utf8_lossy(&stderr).trim().to_string();
    let msg = if msg.is_empty() { String::from_utf8_lossy(&stdout).trim().to_string() } else { msg };
    if powershell_blocked(&msg) {
        return Err(POWERSHELL_BLOCKED.into());
    }
    Err(if msg.is_empty() { format!("Converter exited with {status}") } else { msg })
}

pub(crate) fn run_with_timeout(cmd: &mut Command, timeout: Duration) -> Result<(), String> {
    run_with_timeout_then(cmd, timeout, &|| {})
}

/// Error text PowerShell prints when the organisation blocks scripts
/// (AllSigned / Restricted policy by Group Policy, Constrained Language Mode, AppLocker).
pub(crate) fn powershell_blocked(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    [
        "running scripts is disabled",
        "is not digitally signed",
        "authorizationmanager check failed",
        "only core types are supported in this language mode",
        "supported only on core types in this language mode",
        "cannot create type. only core types",
        "this program is blocked by group policy",
        "has been blocked by your system administrator",
    ]
    .iter()
    .any(|p| e.contains(p))
}

pub(crate) const POWERSHELL_BLOCKED: &str = "Windows PowerShell is blocked on this computer (execution policy, language mode or application control set by your organisation). Adika needs it for Office conversion and scanning; ask your administrator to allow it.";

/// PowerShell scripts must stay pure ASCII: Windows PowerShell 5.1 reads
/// BOM-less scripts in the ANSI code page.
///
/// Documents are opened read-only with macros force-disabled
/// (AutomationSecurity 3), no link updates, no repair and no conversion
/// prompts. A wrong dummy password makes protected files fail at once
/// instead of waiting on an invisible password prompt. The Office process
/// started for the job is written to `$Out.pid` so a timeout can stop it
/// (COM starts it outside PowerShell's process tree).
const OFFICE_PS1: &str = r#"
param([string]$Kind, [string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
function Release($o) { if ($o) { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) } }
$missing = [System.Reflection.Missing]::Value
$pw = 'adika-no-password'
$exe = @{ word = 'WINWORD'; excel = 'EXCEL'; powerpoint = 'POWERPNT' }[$Kind]
$before = @(Get-Process -Name $exe -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
function Started {
  $now = @(Get-Process -Name $exe -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  if ($now.Count) { Set-Content -LiteralPath ($Out + '.pid') -Value ($now -join ' ') -Encoding ASCII }
  return $now.Count -gt 0
}
function Opened($script) {
  try { & $script }
  catch {
    if ($_.Exception.Message -match 'password|encrypt') { throw 'PASSWORD_PROTECTED' }
    throw
  }
}
switch ($Kind) {
  'word' {
    $app = New-Object -ComObject Word.Application
    $own = Started
    try {
      $app.Visible = $false; $app.DisplayAlerts = 0
      $app.AutomationSecurity = 3
      try { $app.Options.UpdateLinksAtOpen = $false; $app.Options.ConfirmConversions = $false } catch { }
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument, PasswordTemplate, Revert,
      # WritePasswordDocument, WritePasswordTemplate, Format, Encoding, Visible, OpenAndRepair, DocumentDirection, NoEncodingDialog
      $doc = Opened { $app.Documents.Open($In, $false, $true, $false, $pw, $pw, $false, $pw, $pw, 0, $missing, $false, $false, $missing, $true) }
      # 17 = wdExportFormatPDF, 0 = print quality, 1 = bookmarks from headings
      $doc.ExportAsFixedFormat($Out, 17, $false, 0, 0, 1, 1, 0, $true, $true, 1, $true, $true, $false)
      $doc.Close(0); Release $doc
    } finally { try { if ($own -or $app.Documents.Count -eq 0) { $app.Quit() } } catch { }; Release $app }
  }
  'excel' {
    $app = New-Object -ComObject Excel.Application
    $own = Started
    try {
      $app.Visible = $false; $app.DisplayAlerts = $false
      $app.AutomationSecurity = 3
      $app.AskToUpdateLinks = $false; $app.EnableEvents = $false
      # Filename, UpdateLinks (0 = never), ReadOnly, Format, Password, WriteResPassword (a dummy one fails every file), IgnoreReadOnlyRecommended,
      # Origin, Delimiter, Editable, Notify, Converter, AddToMru, Local, CorruptLoad (0 = normal, no repair)
      $wb = Opened { $app.Workbooks.Open($In, 0, $true, 5, $pw, '', $true, 2, ',', $false, $false, 0, $false, $false, 0) }
      # 0 = xlTypePDF; honours print areas, page breaks and gridline settings.
      # Excel refuses to export PDF when no printer is installed: fall back to
      # a web page (44 = xlHtml) that Adika then prints to PDF with Edge.
      try { $wb.ExportAsFixedFormat(0, $Out) }
      catch {
        if ($_.Exception.Message -match 'printer') { $wb.SaveAs(($Out -replace '[.]pdf$', '.htm'), 44) }
        else { throw }
      }
      $wb.Close($false); Release $wb
    } finally { try { if ($own -or $app.Workbooks.Count -eq 0) { $app.Quit() } } catch { }; Release $app }
  }
  'powerpoint' {
    $app = New-Object -ComObject PowerPoint.Application
    # PowerPoint has one instance per user: never close one the user already had open.
    $own = Started
    try {
      $app.AutomationSecurity = 3
      # FileName, ReadOnly, Untitled, WithWindow. "file::password::" is how PowerPoint takes an open password.
      $pres = Opened { $app.Presentations.Open(($In + '::' + $pw + '::'), -1, 0, 0) }
      # 32 = ppSaveAsPDF
      $pres.SaveAs($Out, 32)
      $pres.Close(); Release $pres
    } finally { try { if ($own -or $app.Presentations.Count -eq 0) { $app.Quit() } } catch { }; Release $app }
  }
}
[GC]::Collect(); [GC]::WaitForPendingFinalizers()
if (-not (Test-Path -LiteralPath $Out) -and -not (Test-Path -LiteralPath ($Out -replace '[.]pdf$', '.htm'))) { throw 'Office did not produce a PDF.' }
"#;

const PASSWORD_PROTECTED: &str = "This document is password-protected. Remove the password in Office, then convert it again.";

/// Office Open XML files are ZIP archives; an encrypted one is an OLE compound file instead.
fn encrypted_ooxml(ext: &str, head: &[u8]) -> bool {
    const OLE: &[u8] = &[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    matches!(ext, "docx" | "docm" | "dotx" | "xlsx" | "xlsm" | "xlsb" | "pptx" | "pptm" | "ppsx") && head.starts_with(OLE)
}

/// Stops the Office processes the conversion script started (after a timeout).
fn kill_recorded(pid_file: &Path) {
    let Ok(text) = std::fs::read_to_string(pid_file) else { return };
    for pid in text.split_whitespace().filter_map(|p| p.parse::<u32>().ok()) {
        let _ = Command::new("taskkill").args(["/F", "/T", "/PID", &pid.to_string()]).stdout(Stdio::null()).stderr(Stdio::null()).creation_flags_compat().status();
    }
}

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

        let mut head = [0u8; 8];
        let n = std::fs::File::open(&input).and_then(|mut f| std::io::Read::read(&mut f, &mut head)).unwrap_or(0);
        if encrypted_ooxml(&ext, &head[..n]) {
            return Err(PASSWORD_PROTECTED.into());
        }

        let mut office_err = None;
        if office_prog_id_installed(kind) {
            let script = scratch.path("convert.ps1");
            std::fs::write(&script, OFFICE_PS1).map_err(|e| e.to_string())?;
            let pid_file = PathBuf::from(format!("{}.pid", out.to_string_lossy()));
            let res = run_with_timeout_then(
                Command::new("powershell.exe")
                    .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
                    .arg(&script)
                    .args(["-Kind", kind, "-In"])
                    .arg(&input)
                    .arg("-Out")
                    .arg(&out),
                Duration::from_secs(300),
                &|| kill_recorded(&pid_file),
            );
            let html_fallback = out.with_extension("htm");
            match res {
                Ok(()) if out.is_file() => return read_pdf(&out),
                Ok(()) if html_fallback.is_file() => {
                    // No printer installed: Excel saved HTML; Edge turns it into the PDF.
                    if let Ok(bytes) = std::fs::read(&html_fallback) {
                        let _ = std::fs::write(&html_fallback, with_csp(&bytes));
                    }
                    let target = format!("file:///{}", html_fallback.to_string_lossy().replace('\\', "/"));
                    return read_pdf(&edge_print_to_pdf(&scratch, target, true)?);
                }
                Ok(()) => office_err = Some("Office finished without producing a PDF.".to_string()),
                Err(e) if e.contains("PASSWORD_PROTECTED") => return Err(PASSWORD_PROTECTED.into()),
                Err(e) if e == POWERSHELL_BLOCKED => return Err(e),
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
        // Documents (files, e-mails, e-books) render offline with scripts blocked; a web address loads like in a browser.
        let (target, offline) = match (html, url) {
            (Some(html), _) => {
                let file = scratch.path("page.html");
                std::fs::write(&file, with_csp(html.as_bytes())).map_err(|e| e.to_string())?;
                (format!("file:///{}", file.to_string_lossy().replace('\\', "/")), true)
            }
            (None, Some(url)) => {
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                    return Err("Only http:// and https:// addresses can be converted.".into());
                }
                (url, false)
            }
            (None, None) => return Err("Nothing to convert.".into()),
        };
        read_pdf(&edge_print_to_pdf(&scratch, target, offline)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Content Security Policy put first in a local document: no scripts (inline
/// or not, event handlers included), no plug-ins, no requests other than
/// local images, styles, fonts and frames. (Edge's own switch to disable
/// JavaScript stops headless printing altogether.)
const DOC_CSP: &[u8] = b"<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src file: data: blob:; style-src 'unsafe-inline' file:; font-src file: data:; frame-src file:\">";

/// The document with DOC_CSP before any of its own content (after a doctype, which must stay first).
fn with_csp(html: &[u8]) -> Vec<u8> {
    let bom = if html.starts_with(&[0xEF, 0xBB, 0xBF]) { 3 } else { 0 };
    let body = &html[bom..];
    let lead = body.iter().take_while(|b| b.is_ascii_whitespace()).count();
    let mut at = bom;
    if body.len() >= lead + 9 && body[lead..lead + 9].eq_ignore_ascii_case(b"<!doctype") {
        if let Some(end) = body[lead..].iter().position(|&b| b == b'>') {
            at = bom + lead + end + 1;
        }
    }
    let mut out = Vec::with_capacity(html.len() + DOC_CSP.len());
    out.extend_from_slice(&html[..at]);
    out.extend_from_slice(DOC_CSP);
    out.extend_from_slice(&html[at..]);
    out
}

/// Prints a page (file:// or http(s)) to PDF with headless Edge. `offline`
/// cuts every network request (a dead proxy, no name resolution).
fn edge_print_to_pdf(scratch: &Scratch, target: String, offline: bool) -> Result<PathBuf, String> {
    let edge = find_edge().ok_or("Microsoft Edge was not found; it is needed to render this document to PDF.")?;
    let out = scratch.path("page.pdf");
    let mut cmd = Command::new(edge);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--no-pdf-header-footer",
        "--virtual-time-budget=8000",
    ]);
    if offline {
        cmd.args(["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>", "--host-resolver-rules=MAP * ~NOTFOUND"]);
    }
    run_with_timeout(
        cmd.arg(format!("--user-data-dir={}", scratch.path("edge-profile").to_string_lossy()))
            .arg(format!("--print-to-pdf={}", out.to_string_lossy()))
            .arg(target),
        Duration::from_secs(120),
    )?;
    wait_for_pdf(&out, Duration::from_secs(60))?;
    Ok(out)
}

/// While an Edge update is pending, msedge.exe hands the job to the updated
/// browser process and exits before the PDF is written: wait until the file
/// exists, has stopped growing and ends with %%EOF.
fn wait_for_pdf(path: &Path, timeout: Duration) -> Result<(), String> {
    let start = Instant::now();
    let mut last: Option<u64> = None;
    loop {
        if let Ok(meta) = std::fs::metadata(path) {
            let len = meta.len();
            if len > 0 && last == Some(len) {
                let complete = std::fs::read(path)
                    .map(|b| b[b.len().saturating_sub(1024)..].windows(5).any(|w| w == b"%%EOF"))
                    .unwrap_or(false);
                if complete {
                    return Ok(());
                }
            }
            last = Some(len);
        }
        if start.elapsed() > timeout {
            return Err("Microsoft Edge did not produce the PDF in time.".into());
        }
        std::thread::sleep(Duration::from_millis(250));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csp_goes_first_but_after_the_doctype() {
        let s = |b: Vec<u8>| String::from_utf8(b).unwrap();
        let csp = std::str::from_utf8(DOC_CSP).unwrap();
        assert!(s(with_csp(b"<p>x</p>")).starts_with(csp));
        let d = s(with_csp(b"  <!DOCTYPE html><html><script>1</script>"));
        assert!(d.starts_with("  <!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\""));
        let bom = with_csp(b"\xEF\xBB\xBF<html>");
        assert!(bom.starts_with(b"\xEF\xBB\xBF<meta"));
    }

    #[test]
    fn spots_encrypted_office_files() {
        let ole = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
        assert!(encrypted_ooxml("docx", &ole));
        assert!(!encrypted_ooxml("docx", b"PK\x03\x04"));
        // Old binary formats are OLE files anyway.
        assert!(!encrypted_ooxml("doc", &ole));
    }

    #[test]
    fn recognises_blocked_powershell() {
        assert!(powershell_blocked("File C:\\x\\convert.ps1 cannot be loaded because running scripts is disabled on this system."));
        assert!(powershell_blocked("Cannot create type. Only core types are supported in this language mode."));
        assert!(!powershell_blocked("Office did not produce a PDF."));
    }

    #[cfg(windows)]
    #[test]
    fn a_chatty_process_does_not_block_on_full_pipes() {
        // ~300 KB on stdout, far more than a pipe buffer, then a failure.
        let started = Instant::now();
        let res = run_with_timeout(
            Command::new("cmd").args(["/d", "/c", "(for /L %i in (1,1,6000) do @echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx) & exit /b 3"]),
            Duration::from_secs(60),
        );
        assert!(started.elapsed() < Duration::from_secs(50));
        assert!(res.unwrap_err().contains("xxxx"));
    }

    #[cfg(windows)]
    #[test]
    fn a_timeout_stops_the_process_tree() {
        let started = Instant::now();
        let res = run_with_timeout(Command::new("cmd").args(["/d", "/c", "ping -n 30 127.0.0.1 >nul"]), Duration::from_secs(1));
        assert_eq!(res.unwrap_err(), "The converter timed out.");
        assert!(started.elapsed() < Duration::from_secs(10));
    }
}
