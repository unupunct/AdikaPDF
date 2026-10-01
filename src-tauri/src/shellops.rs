//! Windows shell integration: what Explorer asked for when it started Adika
//! (open, combine the selected PDFs, convert a file to PDF) and sending a
//! document by e-mail through the default mail program (Simple MAPI).

use serde::Serialize;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct LaunchRequest {
    /// "open", "combine" or "convert".
    pub action: String,
    pub files: Vec<String>,
}

/// Reads a command line: `--combine a.pdf b.pdf`, `--convert report.docx`, or plain files to open.
pub fn launch_from_args<I: IntoIterator<Item = String>>(args: I) -> LaunchRequest {
    let mut action = "open".to_string();
    let mut files = Vec::new();
    for a in args.into_iter().skip(1) {
        match a.as_str() {
            "--combine" => action = "combine".into(),
            "--convert" => action = "convert".into(),
            _ if a.starts_with("--") => {}
            _ => {
                let lower = a.to_ascii_lowercase();
                let wanted = action == "convert" || lower.ends_with(".pdf") || lower.ends_with(".xml") || lower.ends_with(".zip");
                if wanted && std::path::Path::new(&a).is_file() {
                    files.push(a);
                }
            }
        }
    }
    LaunchRequest { action, files }
}

/// What this process was started with.
#[tauri::command]
pub fn launch_request() -> LaunchRequest {
    launch_from_args(std::env::args())
}

#[cfg(windows)]
mod mapi {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
    use windows_sys::Win32::System::Mapi::{MapiFileDescW, MapiMessageW, MAPI_DIALOG, MAPI_LOGON_UI};

    type SendMailW = unsafe extern "system" fn(usize, usize, *const MapiMessageW, u32, u32) -> u32;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Opens a new message of the default mail program with the file attached.
    pub fn send(path: &str, file_name: &str, subject: &str, body: &str) -> Result<(), String> {
        unsafe {
            let lib = LoadLibraryW(wide("MAPI32.DLL").as_ptr());
            if lib.is_null() {
                return Err("NO_MAPI".into());
            }
            let f = GetProcAddress(lib, c"MAPISendMailW".as_ptr() as *const u8);
            let Some(f) = f else { return Err("NO_MAPI".into()) };
            let send: SendMailW = std::mem::transmute(f);
            let (p, n, s, b) = (wide(path), wide(file_name), wide(subject), wide(body));
            let file = MapiFileDescW { ulReserved: 0, flFlags: 0, nPosition: u32::MAX, lpszPathName: p.as_ptr() as *mut u16, lpszFileName: n.as_ptr() as *mut u16, lpFileType: null_mut::<c_void>() };
            let msg = MapiMessageW {
                ulReserved: 0,
                lpszSubject: s.as_ptr() as *mut u16,
                lpszNoteText: b.as_ptr() as *mut u16,
                lpszMessageType: null_mut(),
                lpszDateReceived: null_mut(),
                lpszConversationID: null_mut(),
                flFlags: 0,
                lpOriginator: null_mut(),
                nRecipCount: 0,
                lpRecips: null_mut(),
                nFileCount: 1,
                lpFiles: &file as *const MapiFileDescW as *mut MapiFileDescW,
            };

            match send(0, 0, &msg, MAPI_DIALOG | MAPI_LOGON_UI, 0) {
                0 | 1 => Ok(()), // sent / the user closed the message
                code => Err(format!("NO_MAPI:{code}")),
            }
        }
    }
}

/// Opens a new e-mail with the file attached (Outlook, Thunderbird, Windows Mail with Simple MAPI).
/// "NO_MAPI…" errors mean no mail program takes attachments this way.
#[tauri::command]
pub async fn mail_send(path: String, file_name: String, subject: String, body: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || mapi::send(&path, &file_name, &subject, &body)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (path, file_name, subject, body);
        Err("NO_MAPI".into())
    }
}

/// Writes the document to attach (raw body, header `x-name` = file name) into a temporary
/// folder and returns its path; files from earlier messages are cleared first.
#[tauri::command]
pub fn mail_prepare(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).ok_or("missing x-name header")?;
    let name = percent_encoding::percent_decode_str(name).decode_utf8().map_err(|e| e.to_string())?.into_owned();
    let clean: String = name.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect();
    let clean = if clean.trim().is_empty() { "document.pdf".to_string() } else { clean };
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected a raw byte body".into());
    };
    let dir = std::env::temp_dir().join("Adika PDF Editor").join("mail");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(clean);
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write the attachment: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// A new window for a document tab moved out of another window; it opens the
/// snapshot `adopt` (a recovery folder name). Async: building a window from a
/// synchronous command would deadlock on Windows.
#[tauri::command]
pub async fn open_document_window(app: tauri::AppHandle, adopt: String) -> Result<String, String> {
    if adopt.is_empty() || !adopt.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err("Invalid window request".into());
    }
    let millis = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let label = format!("doc-{millis}");
    let url = tauri::WebviewUrl::App(format!("index.html?adopt={adopt}").into());
    let mut b = tauri::WebviewWindowBuilder::new(&app, &label, url).title("Adika PDF Editor").inner_size(1280.0, 860.0).min_inner_size(900.0, 600.0);
    // The end-to-end tests' own WebView profile, like the main window.
    if std::env::var("ADIKA_E2E").map(|v| v == "1").unwrap_or(false) {
        if let Some(dir) = std::env::var_os("ADIKA_WEBVIEW_DATA") {
            b = b.data_directory(std::path::PathBuf::from(dir));
        }
    }
    b.build().map_err(|e| e.to_string())?;
    Ok(label)
}

/// Shows a file selected in Explorer.
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    std::process::Command::new("explorer.exe").arg(format!("/select,{path}")).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_shell_commands() {
        let dir = std::env::temp_dir().join("adika-launch-test");
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.pdf");
        let d = dir.join("b.docx");
        std::fs::write(&a, b"%PDF").unwrap();
        std::fs::write(&d, b"PK").unwrap();
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let a = a.to_string_lossy().to_string();
        let d = d.to_string_lossy().to_string();
        assert_eq!(launch_from_args(s(&["exe", &a])), LaunchRequest { action: "open".into(), files: vec![a.clone()] });
        assert_eq!(launch_from_args(s(&["exe", "--combine", &a])).action, "combine");
        // A Word file is only taken for converting.
        assert!(launch_from_args(s(&["exe", &d])).files.is_empty());
        assert_eq!(launch_from_args(s(&["exe", "--convert", &d])), LaunchRequest { action: "convert".into(), files: vec![d] });
    }
}
