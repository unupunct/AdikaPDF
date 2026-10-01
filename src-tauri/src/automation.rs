//! Automation: the command line (`--batch`: no window, runs the operations
//! and exits with a status code, printing to the calling console), and the
//! folder operations used by watched folders and the folder search.

use std::path::Path;

pub const BATCH_FLAG: &str = "--batch";

pub fn is_batch() -> bool {
    std::env::args().any(|a| a == BATCH_FLAG)
}

/// Lets a GUI program print to the console it was started from.
pub fn attach_console() {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::System::Console::{AttachConsole, ATTACH_PARENT_PROCESS};
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
}

/// The command-line arguments (after the program name).
#[tauri::command]
pub fn cli_args() -> Vec<String> {
    std::env::args().skip(1).collect()
}

/// The folder the program was started in (relative paths of the command line).
#[tauri::command]
pub fn cli_cwd() -> String {
    std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()
}

#[tauri::command]
pub fn cli_print(line: String, error: bool) {
    use std::io::Write;
    if error {
        let _ = writeln!(std::io::stderr(), "{line}");
    } else {
        let mut out = std::io::stdout();
        let _ = writeln!(out, "{line}");
        let _ = out.flush();
    }
}

#[tauri::command]
pub fn cli_exit(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
    size: u64,
    /// Milliseconds since 1970.
    modified: u64,
}

/// The entries of a folder (not recursive).
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let rd = std::fs::read_dir(&path).map_err(|e| format!("Could not read the folder {path}: {e}"))?;
    let mut out = Vec::new();
    for e in rd.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(DirEntry {
            name: e.file_name().to_string_lossy().into_owned(),
            path: e.path().display().to_string(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

/// Moves a file (creating the target folder); never overwrites: " (2)" is added.
#[tauri::command]
pub fn move_file(from: String, to: String) -> Result<String, String> {
    let target = Path::new(&to);
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    }
    let mut dest = target.to_path_buf();
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|s| format!(".{}", s.to_string_lossy())).unwrap_or_default();
    let mut n = 2;
    while dest.exists() {
        dest = target.with_file_name(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::rename(&from, &dest)
        .or_else(|_| std::fs::copy(&from, &dest).and_then(|_| std::fs::remove_file(&from)))
        .map_err(|e| format!("Could not move {from}: {e}"))?;
    Ok(dest.display().to_string())
}

#[tauri::command]
pub fn make_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("Could not create {path}: {e}"))
}
