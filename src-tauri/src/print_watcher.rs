//! Background helper for the "Adika PDF Editor" virtual printer.
//!
//! The installer creates a printer that uses Windows' built-in "Microsoft
//! Print to PDF" driver with a *file* port, so every print job is written,
//! without a dialog, to `%ProgramData%\Adika PDF Editor\print\adika-print.pdf`.
//! This helper (`adika-pdf-editor.exe --print-watcher`, started at log-on for
//! every user) waits for that file, moves it to
//! `%LOCALAPPDATA%\Adika PDF Editor\Printed` with a unique name and opens it in
//! Adika (as a new tab when Adika is already running, via the single-instance
//! handler).
//!
//! The spool folder is shared by all users, so a job must only ever reach the
//! user who printed it. The spooler writes a file port's output while
//! impersonating the job's owner, so the file is owned by that user. The
//! folder's ACL (printer.ps1) lets users create files but gives access to a
//! file only to its owner (CREATOR OWNER), so another user can neither read,
//! replace nor rename someone else's job. On top of that the watcher claims a
//! job with an atomic rename (two watchers can never both take it), checks on
//! the open handle that the file is owned by its own user, and only then reads
//! it; a job of someone else that it could claim (an older, looser ACL) is put
//! back for its owner.

use crate::logging;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;

pub const WATCH_FLAG: &str = "--print-watcher";

/// Larger print jobs are refused (a runaway job would otherwise fill memory).
const MAX_JOB_BYTES: u64 = 1024 * 1024 * 1024;
/// Repeated failures (Printed folder not writable…) are logged at most this often.
const LOG_BACKOFF: Duration = Duration::from_secs(600);
/// A job that could not be delivered is retried this often.
const RETRY_EVERY: Duration = Duration::from_secs(30);

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
fn complete(path: &Path) -> bool {
    let mut o = OpenOptions::new();
    o.read(true);
    #[cfg(windows)]
    o.share_mode(0);
    o.open(path).is_ok()
}

#[cfg(windows)]
mod owner {
    use std::os::windows::io::AsRawHandle;
    use std::ptr::null_mut;
    use windows_sys::Win32::Foundation::{CloseHandle, LocalFree, HANDLE};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    /// True when the open file is owned by the user running this process.
    pub fn owned_by_me(file: &std::fs::File) -> bool {
        unsafe {
            let mut owner: PSID = null_mut();
            let mut sd: PSECURITY_DESCRIPTOR = null_mut();
            if GetSecurityInfo(file.as_raw_handle() as HANDLE, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &mut owner, null_mut(), null_mut(), null_mut(), &mut sd) != 0 {
                return false;
            }
            let mut same = false;
            let mut token: HANDLE = null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) != 0 {
                // u64 storage keeps TOKEN_USER aligned.
                let mut buf = vec![0u64; 64];
                let mut len = 0u32;
                if GetTokenInformation(token, TokenUser, buf.as_mut_ptr().cast(), (buf.len() * 8) as u32, &mut len) != 0 {
                    let user = &*(buf.as_ptr() as *const TOKEN_USER);
                    same = !owner.is_null() && EqualSid(user.User.Sid, owner) != 0;
                }
                CloseHandle(token);
            }
            LocalFree(sd);
            same
        }
    }
}

#[cfg(not(windows))]
mod owner {
    pub fn owned_by_me(_file: &std::fs::File) -> bool {
        true
    }
}

fn stamp() -> String {
    chrono::Local::now().format("%Y-%m-%d %H%M%S").to_string()
}

fn unique_in(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    path
}

/// Takes the finished job out of the spool name with an atomic rename (only
/// one watcher can win it, and the next job cannot overwrite it while it is read).
fn claim(spool: &Path) -> Option<PathBuf> {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let claimed = spool.with_file_name(format!("claimed-{}-{nanos}.pdf", std::process::id()));
    fs::rename(spool, &claimed).ok().map(|_| claimed)
}

enum Outcome {
    /// Delivered, or dealt with (put back for its owner, moved aside): nothing to retry.
    Done,
    /// Keep the claimed file and try again later.
    Retry(String),
}

/// Reads a claimed job, checks it belongs to this user and is a PDF, and moves it to Printed.
fn deliver(claimed: &Path, spool: &Path) -> Outcome {
    let mut f = match OpenOptions::new().read(true).open(claimed) {
        Ok(f) => f,
        Err(e) => return Outcome::Retry(format!("could not open {}: {e}", claimed.display())),
    };
    if !owner::owned_by_me(&f) {
        drop(f);
        // Not ours: hand it back to the spool name so its owner's watcher takes it.
        if !spool.exists() && fs::rename(claimed, spool).is_ok() {
            return Outcome::Done;
        }
        logging::write("warn", "Print watcher: left a print job of another user in the spool folder");
        return Outcome::Done;
    }
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len > MAX_JOB_BYTES {
        drop(f);
        let _ = fs::remove_file(claimed);
        logging::write("warn", &format!("Print watcher: refused a print job of {} MB", len / (1024 * 1024)));
        return Outcome::Done;
    }
    let mut bytes = Vec::with_capacity(len as usize);
    if let Err(e) = f.read_to_end(&mut bytes) {
        return Outcome::Retry(format!("could not read the print job: {e}"));
    }
    drop(f);
    let dir = printed_dir();
    if let Err(e) = fs::create_dir_all(&dir) {
        return Outcome::Retry(format!("could not create {}: {e}", dir.display()));
    }
    if !bytes.starts_with(b"%PDF") {
        // Never retried: kept aside for troubleshooting instead of being read again and again.
        let aside = unique_in(&dir, &format!("Unreadable print job {}", stamp()), "bin");
        if fs::write(&aside, &bytes).is_ok() {
            let _ = fs::remove_file(claimed);
        }
        logging::write("warn", &format!("Print watcher: a print job was not a PDF; kept as {}", aside.display()));
        return Outcome::Done;
    }
    let dest = unique_in(&dir, &format!("Printed {}", stamp()), "pdf");
    if let Err(e) = fs::write(&dest, &bytes) {
        let _ = fs::remove_file(&dest);
        return Outcome::Retry(format!("could not write {}: {e}", dest.display()));
    }
    let _ = fs::remove_file(claimed);
    logging::write("info", &format!("Print watcher: received a print job ({} KB) → {}", bytes.len() / 1024, dest.display()));
    if let Ok(exe) = std::env::current_exe() {
        // With Adika running, the single-instance handler turns this into a new tab.
        let _ = std::process::Command::new(exe).arg(&dest).spawn();
    }
    Outcome::Done
}

/// Logs a repeated problem at most every LOG_BACKOFF.
struct Throttle(Option<Instant>);

impl Throttle {
    fn log(&mut self, message: &str) {
        if self.0.map(|t| t.elapsed() >= LOG_BACKOFF).unwrap_or(true) {
            logging::write("error", &format!("Print watcher: {message}"));
            self.0 = Some(Instant::now());
        }
    }
}

/// Runs forever (until log-off). Returns immediately if another watcher is active.
pub fn run() {
    let Some(_lock) = single_watcher_lock() else { return };
    let spool = spool_file();
    logging::write("info", &format!("Print watcher started (watching {})", spool.display()));
    let mut last_size: Option<u64> = None;
    let mut pending: Option<(PathBuf, Instant)> = None;
    let mut throttle = Throttle(None);
    // Jobs this user claimed before a crash or log-off.
    if let Some(Ok(entries)) = spool.parent().map(fs::read_dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            let ours = name.starts_with("claimed-") && fs::File::open(e.path()).map(|f| owner::owned_by_me(&f)).unwrap_or(false);
            if ours && pending.is_none() {
                let now = Instant::now();
                pending = Some((e.path(), now.checked_sub(RETRY_EVERY).unwrap_or(now)));
            }
        }
    }
    loop {
        std::thread::sleep(Duration::from_millis(700));
        if let Some((claimed, since)) = &pending {
            if since.elapsed() >= RETRY_EVERY {
                let claimed = claimed.clone();
                match deliver(&claimed, &spool) {
                    Outcome::Done => pending = None,
                    Outcome::Retry(e) => {
                        throttle.log(&e);
                        pending = Some((claimed, Instant::now()));
                    }
                }
            }
            continue;
        }
        let size = fs::metadata(&spool).map(|m| m.len()).ok();
        match (size, last_size) {
            // Size unchanged since the last look and the spooler released it: done.
            (Some(s), Some(prev)) if s > 0 && s == prev && complete(&spool) => {
                last_size = None;
                let Some(claimed) = claim(&spool) else { continue };
                match deliver(&claimed, &spool) {
                    Outcome::Done => throttle.0 = None,
                    Outcome::Retry(e) => {
                        throttle.log(&e);
                        pending = Some((claimed, Instant::now()));
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claims_a_job_once_and_checks_its_owner() {
        let dir = std::env::temp_dir().join(format!("adika-print-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("print")).unwrap();
        let spool = dir.join("print").join("adika-print.pdf");
        fs::write(&spool, b"%PDF-1.4 test").unwrap();
        let claimed = claim(&spool).expect("first claim wins");
        assert!(claim(&spool).is_none(), "a second watcher cannot claim the same job");
        assert!(!spool.exists());
        // Files this test wrote belong to the user running it.
        let f = fs::File::open(&claimed).unwrap();
        assert!(owner::owned_by_me(&f));
        drop(f);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_names_do_not_overwrite() {
        let dir = std::env::temp_dir().join(format!("adika-print-names-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let a = unique_in(&dir, "Printed x", "pdf");
        fs::write(&a, b"1").unwrap();
        let b = unique_in(&dir, "Printed x", "pdf");
        assert_ne!(a, b);
        assert!(b.to_string_lossy().ends_with("Printed x (2).pdf"));
        let _ = fs::remove_dir_all(&dir);
    }
}
