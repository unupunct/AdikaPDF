//! Automatic backups of unsaved documents, for recovery after a crash.
//! Everything lives under `%LOCALAPPDATA%\Adika PDF Editor\Recovery`
//! (or `ADIKA_RECOVERY_DIR`, used by the end-to-end tests); names are
//! checked so nothing outside that folder can be read, written or removed.

use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};

fn root() -> PathBuf {
    if let Some(dir) = std::env::var_os("ADIKA_RECOVERY_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Adika PDF Editor").join("Recovery")
}

/// `folder` or `folder/file`: letters, digits, `-`, `_`, `.` only.
fn safe(name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty()
        && name.split('/').count() <= 2
        && name
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != ".." && p.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)));
    if !ok {
        return Err(format!("Invalid recovery name: {name}"));
    }
    Ok(name.split('/').fold(root(), |p, part| p.join(part)))
}

/// Body = file bytes; header `x-name` = "folder/file" (percent-encoded).
#[tauri::command]
pub fn recovery_write(request: Request<'_>) -> Result<(), String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).ok_or("missing x-name header")?;
    let name = percent_decode_str(name).decode_utf8().map_err(|e| e.to_string())?.into_owned();
    let path = safe(&name)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not create the recovery folder: {e}"))?;
    }
    // Temp file + rename: a crash mid-write never leaves a broken backup.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not write the backup: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not write the backup: {e}"))
}

#[tauri::command]
pub fn recovery_read(name: String) -> Result<Response, String> {
    std::fs::read(safe(&name)?).map(Response::new).map_err(|e| format!("Could not read the backup: {e}"))
}

#[derive(serde::Serialize)]
pub struct RecoveryEntry {
    dir: String,
    /// Milliseconds since 1970 of the last backup.
    modified: u64,
}

/// Backup folders that contain a complete `state.json`.
#[tauri::command]
pub fn recovery_list() -> Vec<RecoveryEntry> {
    let Ok(read) = std::fs::read_dir(root()) else {
        return Vec::new();
    };
    let mut out: Vec<RecoveryEntry> = read
        .flatten()
        .filter_map(|e| {
            let dir = e.file_name().to_string_lossy().into_owned();
            safe(&dir).ok()?;
            let meta = std::fs::metadata(e.path().join("state.json")).ok()?;
            let modified = meta
                .modified()
                .ok()?
                .duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_millis() as u64;
            Some(RecoveryEntry { dir, modified })
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out
}

#[tauri::command]
pub fn recovery_remove(dir: String) -> Result<(), String> {
    if dir.contains('/') {
        return Err("Only whole backup folders can be removed.".into());
    }
    let path = safe(&dir)?;
    if path.exists() {
        std::fs::remove_dir_all(&path).map_err(|e| format!("Could not remove the backup: {e}"))?;
    }
    Ok(())
}
