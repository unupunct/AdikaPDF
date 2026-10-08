//! One-shot loopback listener for OAuth 2.0 sign-in in the system browser
//! (RFC 8252): binds 127.0.0.1, waits for the single redirect carrying
//! `code` and `state` (or `error`), answers with a small page and closes.
//! The state is passed through unchanged; the page checks it.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

struct Pending {
    listener: Option<TcpListener>,
    cancel: Arc<AtomicBool>,
    path: String,
}

fn pending() -> &'static Mutex<HashMap<u32, Pending>> {
    static P: OnceLock<Mutex<HashMap<u32, Pending>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_ID: AtomicU32 = AtomicU32::new(1);

#[derive(serde::Serialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackStart {
    pub id: u32,
    pub port: u16,
}

#[derive(serde::Serialize, Debug, Clone, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoopbackResult {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

const PAGE_OK: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Adika PDF Editor</title></head><body style=\"font-family:Segoe UI,sans-serif;text-align:center;margin-top:15vh;color:#0f172a\"><h2>Adika PDF Editor</h2><p>Sign-in finished. You can close this window and return to Adika PDF Editor.</p></body></html>";

/// Binds 127.0.0.1:`port` (0: any free port) for a redirect to `path` (e.g. "/callback").
pub fn start(port: u16, path: &str) -> Result<LoopbackStart, String> {
    let listener = TcpListener::bind(("127.0.0.1", port)).map_err(|e| format!("Could not open the sign-in listener on port {port}: {e}"))?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
    pending().lock().unwrap().insert(id, Pending { listener: Some(listener), cancel: Arc::new(AtomicBool::new(false)), path });
    Ok(LoopbackStart { id, port })
}

/// Waits for the redirect (other paths, e.g. /favicon.ico, get a 404).
pub fn wait(id: u32, timeout: Duration) -> Result<LoopbackResult, String> {
    let (listener, cancel, path) = {
        let mut map = pending().lock().unwrap();
        let p = map.get_mut(&id).ok_or("No sign-in is waiting.")?;
        (p.listener.take().ok_or("This sign-in is already being waited for.")?, p.cancel.clone(), p.path.clone())
    };
    let result = accept_loop(&listener, &cancel, &path, timeout);
    pending().lock().unwrap().remove(&id);
    result
}

/// Stops a waiting sign-in (the wait returns an error).
pub fn cancel(id: u32) {
    if let Some(p) = pending().lock().unwrap().get(&id) {
        p.cancel.store(true, Ordering::Relaxed);
    }
}

fn accept_loop(listener: &TcpListener, cancel: &AtomicBool, path: &str, timeout: Duration) -> Result<LoopbackResult, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("Sign-in cancelled.".into());
        }
        if Instant::now() >= deadline {
            return Err("Sign-in timed out: no answer came from the browser.".into());
        }
        match listener.accept() {
            Ok((stream, _)) => {
                if let Some(r) = handle(stream, path) {
                    return Ok(r);
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(40)),
            Err(e) => return Err(format!("Sign-in listener failed: {e}")),
        }
    }
}

/// Reads one request; Some when it is the redirect.
fn handle(mut stream: TcpStream, path: &str) -> Option<LoopbackResult> {
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buf = Vec::new();
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 16 * 1024 {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let line = text.lines().next().unwrap_or("");
    let mut parts = line.split(' ');
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let (req_path, query) = target.split_once('?').unwrap_or((target, ""));
    if method != "GET" || req_path != path {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    }
    let r = parse_query(query);
    if r.code.is_none() && r.error.is_none() {
        let _ = stream.write_all(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return None;
    }
    let head = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        PAGE_OK.len()
    );
    let _ = stream.write_all(head.as_bytes());
    let _ = stream.write_all(PAGE_OK.as_bytes());
    let _ = stream.flush();
    Some(r)
}

fn decode(v: &str) -> String {
    percent_encoding::percent_decode_str(&v.replace('+', " ")).decode_utf8_lossy().into_owned()
}

fn parse_query(q: &str) -> LoopbackResult {
    let mut r = LoopbackResult::default();
    for pair in q.split('&').filter(|p| !p.is_empty()) {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = Some(decode(v));
        match k {
            "code" => r.code = v,
            "state" => r.state = v,
            "error" => r.error = v,
            "error_description" => r.error_description = v,
            _ => {}
        }
    }
    r
}

#[tauri::command]
pub fn oauth_loopback_start(port: Option<u16>, path: Option<String>) -> Result<LoopbackStart, String> {
    start(port.unwrap_or(0), path.as_deref().unwrap_or("/callback"))
}

#[tauri::command]
pub async fn oauth_loopback_wait(id: u32, timeout_secs: Option<u64>) -> Result<LoopbackResult, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(300).clamp(1, 900));
    tauri::async_runtime::spawn_blocking(move || wait(id, timeout)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn oauth_loopback_cancel(id: u32) {
    cancel(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn get(port: u16, target: &str) -> String {
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(s, "GET {target} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n\r\n").unwrap();
        let mut out = String::new();
        let _ = s.read_to_string(&mut out);
        out
    }

    #[test]
    fn receives_code_and_passes_state_through() {
        let st = start(0, "/callback").unwrap();
        assert!(st.port > 0);
        let port = st.port;
        let client = std::thread::spawn(move || {
            let favicon = get(port, "/favicon.ico");
            let page = get(port, "/callback?code=abc%2F123&state=x-Y_z&scope=service");
            (favicon, page)
        });
        let r = wait(st.id, Duration::from_secs(10)).unwrap();
        let (favicon, page) = client.join().unwrap();
        assert!(favicon.starts_with("HTTP/1.1 404"));
        assert!(page.starts_with("HTTP/1.1 200") && page.contains("You can close this window"));
        assert_eq!(r.code.as_deref(), Some("abc/123"));
        assert_eq!(r.state.as_deref(), Some("x-Y_z"));
        assert!(r.error.is_none());
        // One shot: the listener is gone.
        assert!(wait(st.id, Duration::from_secs(1)).is_err());
    }

    #[test]
    fn reports_provider_errors() {
        let st = start(0, "callback").unwrap();
        let port = st.port;
        let client = std::thread::spawn(move || get(port, "/callback?error=access_denied&error_description=User+said+no&state=s1"));
        let r = wait(st.id, Duration::from_secs(10)).unwrap();
        client.join().unwrap();
        assert_eq!(r.error.as_deref(), Some("access_denied"));
        assert_eq!(r.error_description.as_deref(), Some("User said no"));
        assert_eq!(r.state.as_deref(), Some("s1"));
    }

    #[test]
    fn times_out_and_cancels() {
        let st = start(0, "/callback").unwrap();
        let t = Instant::now();
        let e = wait(st.id, Duration::from_millis(300)).unwrap_err();
        assert!(e.contains("timed out"));
        assert!(t.elapsed() < Duration::from_secs(5));
        let st2 = start(0, "/callback").unwrap();
        let id = st2.id;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel(id);
        });
        assert!(wait(st2.id, Duration::from_secs(10)).unwrap_err().contains("cancelled"));
    }

    #[test]
    fn binds_only_loopback() {
        let st = start(0, "/callback").unwrap();
        let port = st.port;
        cancel(st.id);
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
        let _ = wait(st.id, Duration::from_millis(50));
    }
}
