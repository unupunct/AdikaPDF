//! Background helper for the "Adika PDF Editor" virtual printer.
//!
//! The installer creates a printer that uses Windows' built-in "Microsoft
//! Print to PDF" driver with a *file* port, so every print job is written,
//! without a dialog, to `%ProgramData%\Adika PDF Editor\print\adika-print.pdf`.
//! This helper (`adika-pdf-editor.exe --print-watcher`, started at log-on)
//! waits for that file, moves it to `%LOCALAPPDATA%\Adika PDF Editor\Printed`
//! with a unique name and opens it in Adika (as a new tab when Adika is
//! already running, via the single-instance handler).

use crate::logging;
use std::fs::{self, OpenOptions};
use std::path::PathBuf;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

pub const WATCH_FLAG: &str = "--print-watcher";

/// Tests set ADIKA_PRINT_DIR to keep the spool, output and lock in one scratch folder.
fn test_dir() -> Option<PathBuf> {
    std::env::var_os("ADIKA_PRINT_DIR").map(PathBuf::from)
}

pub fn spool_file() -> PathBuf {
    if let Some(d) = test_dir() {
        return d.join("print").join("adika-print.pdf");
    }
    let base = std::env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    base.join("Adika PDF Editor").join("print").join("adika-print.pdf")
}

fn printed_dir() -> PathBuf {
    if let Some(d) = test_dir() {
        return d.join("Printed");
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Adika PDF Editor").join("Printed")
}

fn lock_path() -> PathBuf {
    if let Some(d) = test_dir() {
        return d.join("print-watcher.lock");
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Adika PDF Editor").join("print-watcher.lock")
}

/// Holds an exclusive lock file for the process lifetime; None if another watcher runs.
fn single_watcher_lock() -> Option<fs::File> {
    let p = lock_path();
    let _ = fs::create_dir_all(p.parent()?);
    let mut o = OpenOptions::new();
    o.write(true).create(true).truncate(false);
    #[cfg(windows)]
    o.share_mode(0);
    o.open(p).ok()
}

/// True when the spooler has finished writing (file can be opened exclusively).
fn complete(path: &PathBuf) -> bool {
    let mut o = OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    o.share_mode(0);
    o.open(path).is_ok()
}

fn unique_name() -> PathBuf {
    let dir = printed_dir();
    let _ = fs::create_dir_all(&dir);
    let stamp = chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string();
    let mut path = dir.join(format!("Printed {stamp}.pdf"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("Printed {stamp} ({n}).pdf"));
        n += 1;
    }
    path
}

/// Moves a finished print job into the user's Printed folder and opens it.
fn deliver(spool: &PathBuf) {
    let bytes = match fs::read(spool) {
        Ok(b) if b.starts_with(b"%PDF") => b,
        Ok(_) => return, // not finished / not a PDF yet
        Err(_) => return,
    };
    let dest = unique_name();
    if fs::write(&dest, &bytes).is_err() {
        logging::write("error", &format!("Print watcher: could not write {}", dest.display()));
        return;
    }
    let _ = fs::remove_file(spool);
    logging::write("info", &format!("Print watcher: received a print job ({} KB) → {}", bytes.len() / 1024, dest.display()));
    if let Ok(exe) = std::env::current_exe() {
        // With Adika running, the single-instance handler turns this into a new tab.
        let _ = std::process::Command::new(exe).arg(&dest).spawn();
    }
}

/// Runs forever (until log-off). Returns immediately if another watcher is active.
pub fn run() {
    let Some(_lock) = single_watcher_lock() else { return };
    let spool = spool_file();
    logging::write("info", &format!("Print watcher started (watching {})", spool.display()));
    let mut last_size: Option<u64> = None;
    loop {
        std::thread::sleep(Duration::from_millis(700));
        let size = fs::metadata(&spool).map(|m| m.len()).ok();
        match (size, last_size) {
            // Size unchanged since the last look and the spooler released it: done.
            (Some(s), Some(prev)) if s > 0 && s == prev && complete(&spool) => {
                deliver(&spool);
                last_size = None;
            }
            (s, _) => last_size = s,
        }
    }
}

/// Starts the watcher in the background if it is not running (called by the app).
#[tauri::command]
pub fn ensure_print_watcher() -> bool {
    // Only meaningful when the virtual printer was installed.
    if !spool_file().parent().map(|p| p.is_dir()).unwrap_or(false) {
        return false;
    }
    if let Some(lock) = single_watcher_lock() {
        drop(lock); // nobody holds it: start one
        if let Ok(exe) = std::env::current_exe() {
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const DETACHED_PROCESS: u32 = 0x0000_0008;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                let _ = std::process::Command::new(exe).arg(WATCH_FLAG).creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW).spawn();
            }
        }
    }
    true
}

/// Whether the virtual printer is installed (its spool folder exists).
#[tauri::command]
pub fn virtual_printer_installed() -> bool {
    spool_file().parent().map(|p| p.is_dir()).unwrap_or(false)
}
