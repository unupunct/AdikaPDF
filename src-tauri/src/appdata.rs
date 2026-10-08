//! Small cache files of the app (e.g. the downloaded EU Trusted Lists) under
//! `%LOCALAPPDATA%\Adika PDF Editor\Data` (or `ADIKA_DATA_DIR`, used by the
//! end-to-end tests). Names are single file names, so nothing outside that
//! folder can be read or written.

use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};

pub(crate) fn root() -> PathBuf {
    if let Some(dir) = std::env::var_os("ADIKA_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("Adika PDF Editor").join("Data")
}

fn safe(name: &str) -> Result<PathBuf, String> {
    let ok = !name.is_empty() && name != "." && name != ".." && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if !ok {
        return Err(format!("Invalid data file name: {name}"));
    }
    Ok(root().join(name))
}

/// Body = file bytes; header `x-name` = file name.
#[tauri::command]
pub fn appdata_write(request: Request<'_>) -> Result<(), String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).ok_or("missing x-name header")?;
    let name = percent_decode_str(name).decode_utf8().map_err(|e| e.to_string())?.into_owned();
    let path = safe(&name)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    std::fs::create_dir_all(root()).map_err(|e| format!("Could not create the data folder: {e}"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not save {name}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save {name}: {e}"))
}

/// The file's bytes, or an empty response when it does not exist.
#[tauri::command]
pub fn appdata_read(name: String) -> Result<Response, String> {
    let path = safe(&name)?;
    match std::fs::read(path) {
        Ok(b) => Ok(Response::new(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Response::new(Vec::new())),
        Err(e) => Err(format!("Could not read {name}: {e}")),
    }
}
