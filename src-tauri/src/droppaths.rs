//! Paths of files dropped from Explorer.
//!
//! The WebView handles drag and drop itself (`dragDropEnabled: false`, so
//! thumbnails and tabs can be dragged inside the page), which gives the page
//! `File` objects without their location. The page posts the dropped files
//! with `chrome.webview.postMessageWithAdditionalObjects({ adikaDropPaths: token }, files)`;
//! WebView2 hands the host each file's path, kept here until the page takes
//! them with `drop_paths_take(token)`. Such a message is not a string, so
//! wry's own IPC handler ignores it.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;

static PENDING: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);
static INSTALLED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn store(token: String, paths: Vec<String>) {
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let map = g.get_or_insert_with(HashMap::new);
    // A page that never takes its paths must not grow the map forever.
    if map.len() > 32 {
        map.clear();
    }
    map.insert(token, paths);
}

/// The token from a message like `{"adikaDropPaths":"abc"}`.
fn token_of(json: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let t = v.get("adikaDropPaths")?.as_str()?;
    (!t.is_empty() && t.len() <= 64 && t.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')).then(|| t.to_string())
}

#[tauri::command]
pub fn drop_paths_take(token: String) -> Option<Vec<String>> {
    let mut g = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    g.as_mut()?.remove(&token)
}

/// Listens for posted drops in this webview (once per webview).
#[tauri::command]
pub fn drop_paths_install(webview: tauri::Webview) -> Result<(), String> {
    {
        let mut g = INSTALLED.lock().unwrap_or_else(|e| e.into_inner());
        if !g.get_or_insert_with(HashSet::new).insert(webview.label().to_string()) {
            return Ok(());
        }
    }
    install(&webview)
}

#[cfg(windows)]
fn install(webview: &tauri::Webview) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2};
    use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
    use windows_core::{Interface, PWSTR};

    webview
        .with_webview(|wv| unsafe {
            let Ok(core) = wv.controller().CoreWebView2() else { return };
            let handler = WebMessageReceivedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut json = PWSTR::null();
                if args.WebMessageAsJson(&mut json).is_err() {
                    return Ok(());
                }
                let Some(token) = token_of(&take_pwstr(json)) else { return Ok(()) };
                let mut paths = Vec::new();
                if let Ok(objects) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>().and_then(|a| a.AdditionalObjects()) {
                    let mut count = 0u32;
                    let _ = objects.Count(&mut count);
                    // One entry per object, empty when it has no path (a file made by the page itself).
                    for i in 0..count.min(10_000) {
                        let mut path = PWSTR::null();
                        let ok = objects.GetValueAtIndex(i).and_then(|o| o.cast::<ICoreWebView2File>()).and_then(|f| f.Path(&mut path)).is_ok();
                        paths.push(if ok { take_pwstr(path) } else { String::new() });
                    }
                }
                store(token, paths);
                Ok(())
            }));
            let mut cookie = 0i64;
            let _ = core.add_WebMessageReceived(&handler, &mut cookie);
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn install(_webview: &tauri::Webview) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_checked_and_taken_once() {
        assert_eq!(token_of(r#"{"adikaDropPaths":"d1-x_2"}"#).as_deref(), Some("d1-x_2"));
        assert_eq!(token_of(r#""adikaDropPaths""#), None);
        assert_eq!(token_of(r#"{"adikaDropPaths":"../x"}"#), None);
        assert_eq!(token_of(r#"{"adikaDropPaths":""}"#), None);
        store("t1".into(), vec![r"C:\a.pdf".into()]);
        assert_eq!(drop_paths_take("t1".into()), Some(vec![r"C:\a.pdf".to_string()]));
        assert_eq!(drop_paths_take("t1".into()), None);
    }
}
