//! Small cache files of the app (e.g. the downloaded EU Trusted Lists) under
//! `%LOCALAPPDATA%\Adika PDF Editor\Data` (or `ADIKA_DATA_DIR`, used by the
//! end-to-end tests). Names are single file names, so nothing outside that
//! folder can be read or written.

use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};

/// Portable mode: `<exe>\Data\Data`.
pub(crate) fn root() -> PathBuf {
    crate::deploy::data_root("ADIKA_DATA_DIR", "Data")
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

// Downloaded OCR languages: `<data>\ocr-langs\<code>.traineddata.gz` (the hash is checked before writing).

fn ocr_dir() -> PathBuf {
    root().join("ocr-langs")
}

/// A Tesseract language code ("deu", "chi_sim"): nothing else reaches the file system.
fn ocr_lang_path(code: &str) -> Result<PathBuf, String> {
    let ok = (3..=16).contains(&code.len()) && code.chars().all(|c| c.is_ascii_lowercase() || c == '_') && !code.starts_with('_');
    if !ok {
        return Err(format!("Invalid OCR language: {code}"));
    }
    Ok(ocr_dir().join(format!("{code}.traineddata.gz")))
}

#[derive(serde::Serialize)]
pub struct OcrLangFile {
    code: String,
    size: u64,
}

#[tauri::command]
pub fn ocr_lang_list() -> Result<Vec<OcrLangFile>, String> {
    let entries = match std::fs::read_dir(ocr_dir()) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read the OCR languages folder: {e}")),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(code) = name.strip_suffix(".traineddata.gz") else { continue };
        if ocr_lang_path(code).is_err() {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(OcrLangFile { code: code.to_string(), size });
    }
    out.sort_by(|a, b| a.code.cmp(&b.code));
    Ok(out)
}

/// Body = the gzipped traineddata; header `x-name` = language code.
#[tauri::command]
pub fn ocr_lang_write(request: Request<'_>) -> Result<(), String> {
    let code = request.headers().get("x-name").and_then(|v| v.to_str().ok()).ok_or("missing x-name header")?.to_string();
    let path = ocr_lang_path(&code)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    if bytes.len() < 2 || bytes[0] != 0x1f || bytes[1] != 0x8b {
        return Err("The language data is not a gzip file.".into());
    }
    std::fs::create_dir_all(ocr_dir()).map_err(|e| format!("Could not create the OCR languages folder: {e}"))?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not save the {code} language: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Could not save the {code} language: {e}"))
}

/// The gzipped traineddata, or an empty response when the language is not installed.
#[tauri::command]
pub fn ocr_lang_read(code: String) -> Result<Response, String> {
    let path = ocr_lang_path(&code)?;
    match std::fs::read(path) {
        Ok(b) => Ok(Response::new(b)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Response::new(Vec::new())),
        Err(e) => Err(format!("Could not read the {code} language: {e}")),
    }
}

#[tauri::command]
pub fn ocr_lang_delete(code: String) -> Result<(), String> {
    match std::fs::remove_file(ocr_lang_path(&code)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("Could not remove the {code} language: {e}")),
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ocr_language_codes_only() {
        assert!(ocr_lang_path("deu").is_ok());
        assert!(ocr_lang_path("chi_sim").is_ok());
        for bad in ["", "de", "..", "../x", "a/b", "DEU", "deu.traineddata", "_ab", "deu\\x"] {
            assert!(ocr_lang_path(bad).is_err(), "{bad}");
        }
    }
}
