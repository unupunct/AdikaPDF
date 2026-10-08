//! Native shell for Adika PDF Editor.
//!
//! The editor itself runs entirely in the WebView; the Rust side only moves
//! file bytes between disk and the page. Bytes travel as raw IPC bodies (no
//! JSON number arrays), so opening or saving a 100 MB PDF stays fast.

mod convert;
mod logging;
mod print_watcher;
mod net;
mod pkcs11;
mod recovery;
mod appdata;
mod certstore;
mod scanner;
mod automation;
mod spellcheck;
mod shellops;
mod pathguard;

use percent_encoding::percent_decode_str;
use std::path::PathBuf;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager};

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
    let path = pathguard::check_write_file(&path)?;
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

/// "size:mtime" fingerprint of a file, used to notice outside changes (auto-reload).
#[tauri::command]
fn file_stamp(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("{path}: {e}"))?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(format!("{}:{}", meta.len(), modified))
}

/// Windows account name, the default author for comments.
#[tauri::command]
fn os_user_name() -> String {
    std::env::var("USERNAME").unwrap_or_default()
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
    logging::init();
    // Background helper for the virtual printer: no window, no WebView.
    if std::env::args().any(|a| a == print_watcher::WATCH_FLAG) {
        print_watcher::run();
        return;
    }
    // Command line batch: no window, no single instance (it runs next to an open editor).
    let batch = automation::is_batch();
    if batch {
        automation::attach_console();
    }
    let mut builder = tauri::Builder::default().manage(shellops::LaunchQueue::default());
    if !batch {
        // A second launch (Explorer "Open with", the virtual printer) hands its
        // files to the running window, which opens them as new tabs.
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            // Open, combine (Explorer's "Combine in Adika") or convert: the running window does it.
            // Relative names are the second instance's, so they are resolved against its folder.
            let cwd = std::path::PathBuf::from(cwd);
            let req = shellops::launch_from_args_in(argv, Some(cwd.as_path()).filter(|p| !p.as_os_str().is_empty()));
            let window = app.get_webview_window("main");
            if let Some(w) = &window {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
            if !req.files.is_empty() {
                // Queued while the window is still starting (it has not subscribed yet).
                if let Some(req) = app.state::<shellops::LaunchQueue>().offer(req) {
                    if let Some(w) = &window {
                        let _ = w.emit("adika://launch", req);
                    }
                }
            }
        }));
    }
    builder
        .setup(move |app| {
            // The main window is created here (not from the config) so that a
            // command line batch runs without one showing, and the end-to-end
            // tests get their own WebView profile (never the user's settings).
            let cfg = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("no main window in the configuration")?;
            let mut b = tauri::WebviewWindowBuilder::from_config(app, &cfg)?.visible(!batch);
            if e2e_mode() {
                if let Some(dir) = std::env::var_os("ADIKA_WEBVIEW_DATA") {
                    b = b.data_directory(PathBuf::from(dir));
                }
            }
            b.build()?;
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // Contacts the release server only when the interface asks (opt-in check or "Check for updates").
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            initial_files,
            file_stamp,
            os_user_name,
            print_watcher::ensure_print_watcher,
            print_watcher::virtual_printer_installed,
            logging::log_write,
            logging::log_crash,
            logging::logs_path,
            logging::open_logs_folder,
            e2e_mode,
            recovery::recovery_write,
            recovery::recovery_read,
            recovery::recovery_list,
            recovery::recovery_remove,
            appdata::appdata_write,
            appdata::appdata_read,
            certstore::winstore_list,
            certstore::winstore_sign,
            certstore::winstore_decrypt,
            convert::converter_availability,
            convert::office_to_pdf,
            convert::html_to_pdf,
            convert::scan_wia,
            scanner::wia_devices,
            scanner::wia_scan,
            automation::cli_args,
            automation::cli_cwd,
            automation::cli_print,
            automation::cli_exit,
            automation::list_dir,
            automation::move_file,
            automation::make_dir,
            spellcheck::spell_languages,
            spellcheck::spell_check,
            spellcheck::spell_add,
            shellops::launch_request,
            shellops::take_pending_launches,
            shellops::mail_prepare,
            shellops::mail_send,
            shellops::reveal_in_explorer,
            shellops::open_document_window,
            net::http_request,
            net::system_certificates,
            pkcs11::pkcs11_detect_modules,
            pkcs11::pkcs11_list_tokens,
            pkcs11::pkcs11_sign,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Adika PDF Editor");
}
