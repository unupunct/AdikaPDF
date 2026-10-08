//! Network helpers for signature validation (OCSP, CRL downloads, RFC 3161
//! timestamps) and the Windows trust store. These run natively so they are
//! not blocked by CORS; only http/https URLs taken from certificates or typed
//! by the user are ever contacted.

use std::io::Read;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};

const MAX_RESPONSE: u64 = 32 * 1024 * 1024;

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

/// Raw HTTP request. Headers: `x-url` (percent-encoded), `x-method`
/// (GET/POST), `x-content-type`. Body: raw bytes for POST.
#[tauri::command]
pub async fn http_request(request: Request<'_>) -> Result<Response, String> {
    let url = percent_encoding::percent_decode_str(header(&request, "x-url").ok_or("missing x-url")?)
        .decode_utf8()
        .map_err(|e| e.to_string())?
        .into_owned();
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("Only http(s) URLs are allowed.".into());
    }
    let method = header(&request, "x-method").unwrap_or("GET").to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err("Only GET and POST requests are allowed.".into());
    }
    let content_type = header(&request, "x-content-type").map(str::to_string);
    let body = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(_) => Vec::new(),
    };
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .user_agent("AdikaPDF/1.0")
            .build();
        let mut req = agent.request(&method, &url);
        if let Some(ct) = &content_type {
            req = req.set("Content-Type", ct);
        }
        let resp = if method == "POST" { req.send_bytes(&body) } else { req.call() };
        let resp = resp.map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("{url} answered HTTP {code}"),
            other => format!("Could not reach {url}: {other}"),
        })?;
        let mut buf = Vec::new();
        resp.into_reader()
            .take(MAX_RESPONSE)
            .read_to_end(&mut buf)
            .map_err(|e| format!("Download failed: {e}"))?;
        Ok(Response::new(buf))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct ApiResponse {
    status: u16,
    body: String,
}

/// Checks a web-service URL: https only (remote signing services hold tokens).
pub fn check_api_url(url: &str) -> Result<(), String> {
    if !url.to_ascii_lowercase().starts_with("https://") {
        return Err("Only https:// service addresses are allowed.".into());
    }
    Ok(())
}

/// JSON / form request to a web service (remote signing): https only, with an
/// optional `Authorization` header. Unlike `http_request`, error statuses are
/// returned with their body (the service's error message). Headers and
/// bodies are never logged: they carry access tokens and PINs.
#[tauri::command]
pub async fn api_request(url: String, method: String, authorization: Option<String>, content_type: Option<String>, body: Option<String>) -> Result<ApiResponse, String> {
    check_api_url(&url)?;
    let method = method.to_ascii_uppercase();
    if method != "GET" && method != "POST" {
        return Err("Only GET and POST requests are allowed.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirects(0)
            .user_agent("AdikaPDF/1.0")
            .build();
        let mut req = agent.request(&method, &url).set("Accept", "application/json");
        if let Some(a) = &authorization {
            req = req.set("Authorization", a);
        }
        if let Some(ct) = &content_type {
            req = req.set("Content-Type", ct);
        }
        let resp = match if method == "POST" { req.send_string(body.as_deref().unwrap_or("")) } else { req.call() } {
            Ok(r) => r,
            Err(ureq::Error::Status(_, r)) => r,
            Err(e) => return Err(format!("Could not reach {}: {}", host_of(&url), e.kind())),
        };
        let status = resp.status();
        let mut buf = Vec::new();
        resp.into_reader().take(8 * 1024 * 1024).read_to_end(&mut buf).map_err(|e| format!("Download failed: {e}"))?;
        Ok(ApiResponse { status, body: String::from_utf8_lossy(&buf).into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?
}

fn host_of(url: &str) -> &str {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    rest.split(['/', '?', '#']).next().unwrap_or(rest)
}

/// DER certificates (base64) from the Windows ROOT and CA stores — the same
/// trust anchors Windows itself uses — for signature chain validation.
#[tauri::command]
pub fn system_certificates() -> Result<SystemCertificates, String> {
    #[cfg(windows)]
    {
        use base64::Engine;
        use schannel::cert_store::CertStore;
        let b64 = base64::engine::general_purpose::STANDARD;
        let collect = |name: &str| -> Vec<String> {
            let mut out = Vec::new();
            for store in [CertStore::open_current_user(name), CertStore::open_local_machine(name)].into_iter().flatten() {
                for cert in store.certs() {
                    out.push(b64.encode(cert.to_der()));
                }
            }
            out.sort();
            out.dedup();
            out
        };
        Ok(SystemCertificates { roots: collect("ROOT"), intermediates: collect("CA") })
    }
    #[cfg(not(windows))]
    {
        Ok(SystemCertificates { roots: Vec::new(), intermediates: Vec::new() })
    }
}

#[derive(serde::Serialize)]
pub struct SystemCertificates {
    roots: Vec<String>,
    intermediates: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn api_urls_must_be_https() {
        assert!(check_api_url("https://qtsp.example/csc/v2/info").is_ok());
        assert!(check_api_url("HTTPS://qtsp.example/").is_ok());
        assert!(check_api_url("http://qtsp.example/csc/v2/info").is_err());
        assert!(check_api_url("http://127.0.0.1:8080/").is_err());
        assert!(check_api_url("file:///c:/x").is_err());
        assert_eq!(host_of("https://a.example:8443/csc/v2?x=1"), "a.example:8443");
    }
}
