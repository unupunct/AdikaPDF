//! Native shell for Adika PDF Editor.
//!
//! The editor itself runs entirely in the WebView; the Rust side only moves
//! file bytes between disk and the page. Bytes travel as raw IPC bodies (no
//! JSON number arrays), so opening or saving a 100 MB PDF stays fast.

mod convert;
mod net;
mod pkcs11;

use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};

/// Reads a file chosen by the user and returns its bytes as a raw response.
#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path)
        .map(Response::new)
        .map_err(|e| format!("Could not read {path}: {e}"))
}

/// Writes the raw request body to the path given in the `x-path` header
/// (percent-encoded so non-ASCII file names survive the header).
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let encoded = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("missing x-path header")?;
    let path = PathBuf::from(
        percent_decode_str(encoded)
            .decode_utf8()
            .map_err(|e| format!("bad path encoding: {e}"))?
            .into_owned(),
    );
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    // Write to a sibling temp file first, then rename, so a crash mid-write
    // never leaves a truncated PDF behind.
    let tmp = path.with_extension("adika-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Could not replace {}: {e}", path.display())
    })
}

/// PDF paths passed on the command line (Explorer "Open with" / file association).
#[tauri::command]
fn initial_files() -> Vec<String> {
    std::env::args()
        .skip(1)
        .filter(|a| a.to_ascii_lowercase().ends_with(".pdf"))
        .filter(|a| std::path::Path::new(a).is_file())
        .collect()
}

/// True when started with ADIKA_E2E=1: the UI then exposes test hooks so the
/// end-to-end suite can drive the real app without native file dialogs.
#[tauri::command]
fn e2e_mode() -> bool {
    std::env::var("ADIKA_E2E").map(|v| v == "1").unwrap_or(false)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            initial_files,
            e2e_mode,
            convert::converter_availability,
            convert::office_to_pdf,
            convert::html_to_pdf,
            convert::scan_wia,
            net::http_request,
            net::system_certificates,
            pkcs11::pkcs11_detect_modules,
            pkcs11::pkcs11_list_tokens,
            pkcs11::pkcs11_sign,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Adika PDF Editor");
}
