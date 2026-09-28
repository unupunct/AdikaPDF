//! Log files for troubleshooting.
//!
//! Location: `<install dir>\logs` (the installer creates it and makes it
//! writable for users); if that is not writable (per-user install, locked
//! down machine) the fallback is `%LOCALAPPDATA%\Adika PDF Editor\logs`.
//!
//! * `adika-YYYY-MM-DD.log` — one line per event (errors, warnings, key actions)
//! * `crash-YYYYMMDD-HHMMSS.log` — full details of every crash: Rust panics
//!   (with backtrace) and UI crashes reported by the WebView.
//! Files older than 30 days are deleted at start-up; a daily log stops
//! growing at 20 MB.

use chrono::Local;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

const MAX_DAILY_BYTES: u64 = 20 * 1024 * 1024;
const KEEP_DAYS: u64 = 30;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

fn writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-test");
    let ok = fs::write(&probe, b"ok").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

fn choose_dir() -> PathBuf {
    if let Some(install) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        let dir = install.join("logs");
        if writable(&dir) {
            return dir;
        }
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    let dir = base.join("Adika PDF Editor").join("logs");
    let _ = fs::create_dir_all(&dir);
    dir
}

pub fn dir() -> &'static Path {
    LOG_DIR.get_or_init(choose_dir)
}

fn daily_path() -> PathBuf {
    dir().join(format!("adika-{}.log", Local::now().format("%Y-%m-%d")))
}

/// Appends one line to today's log (best effort; logging never fails the app).
pub fn write(level: &str, message: &str) {
    let path = daily_path();
    if fs::metadata(&path).map(|m| m.len() > MAX_DAILY_BYTES).unwrap_or(false) {
        return;
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let one_line = message.replace('\r', "").replace('\n', "\n    ");
        let _ = writeln!(f, "{} [{}] {}", Local::now().format("%Y-%m-%d %H:%M:%S%.3f"), level.to_uppercase(), one_line);
    }
}

/// Writes a separate crash report and notes it in the daily log.
pub fn write_crash(source: &str, details: &str) -> PathBuf {
    let path = dir().join(format!("crash-{}.log", Local::now().format("%Y%m%d-%H%M%S")));
    let report = format!(
        "Adika PDF Editor {version} crash report\nTime: {time}\nSource: {source}\nOS: {os} {arch}\n\n{details}\n",
        version = env!("CARGO_PKG_VERSION"),
        time = Local::now().format("%Y-%m-%d %H:%M:%S %:z"),
        os = std::env::consts::OS,
        arch = std::env::consts::ARCH,
    );
    let _ = fs::write(&path, report);
    write("crash", &format!("{source} crash — details in {}", path.display()));
    path
}

fn cleanup() {
    let Ok(entries) = fs::read_dir(dir()) else { return };
    let limit = std::time::Duration::from_secs(KEEP_DAYS * 24 * 3600);
    for e in entries.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).map(|age| age > limit).unwrap_or(false);
        let name = e.file_name().to_string_lossy().into_owned();
        if old && name.ends_with(".log") {
            let _ = fs::remove_file(e.path());
        }
    }
}

/// Call first thing at start-up.
pub fn init() {
    cleanup();
    write("info", &format!("Adika PDF Editor {} started (logs in {})", env!("CARGO_PKG_VERSION"), dir().display()));
    std::panic::set_hook(Box::new(|info| {
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        let backtrace = std::backtrace::Backtrace::force_capture();
        write_crash("native (Rust)", &format!("Panic: {payload}\nAt: {location}\n\nBacktrace:\n{backtrace}"));
    }));
}

#[tauri::command]
pub fn log_write(level: String, message: String) {
    write(&level, &message);
}

#[tauri::command]
pub fn log_crash(source: String, details: String) -> String {
    write_crash(&source, &details).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn logs_path() -> String {
    dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub fn open_logs_folder() -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(dir()).spawn().map(|_| ()).map_err(|e| e.to_string())
}
