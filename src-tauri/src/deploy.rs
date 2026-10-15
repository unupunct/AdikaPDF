//! Company deployment: Group Policy values and the portable mode.
//!
//! * Policies: `HKLM\SOFTWARE\Policies\Adika PDF Editor` and the HKCU
//!   equivalent are read once at start-up (HKLM wins; the page merges them,
//!   see `src/lib/policy.ts`). Values the installer set (`/NOUPDATES`, `/LANG=`)
//!   live in `Software\unupunct\Adika PDF Editor` and are only defaults.
//!   `DisableOnlineFeatures` is also enforced here, for every native network call.
//! * Portable mode: a `portable.ini` next to the exe. Settings (WebView2
//!   profile), recovery backups, logs and app data then live in a `Data`
//!   folder next to the exe and nothing is written to the registry.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

pub const POLICY_KEY: &str = r"SOFTWARE\Policies\Adika PDF Editor";
pub const INSTALLER_KEY: &str = r"Software\unupunct\Adika PDF Editor";
pub const PORTABLE_MARKER: &str = "portable.ini";

// ---------------------------------------------------------------- portable

/// `<exe dir>\Data` when the marker file sits next to the exe.
pub fn portable_data_dir_for(exe_dir: &Path) -> Option<PathBuf> {
    exe_dir.join(PORTABLE_MARKER).is_file().then(|| exe_dir.join("Data"))
}

/// The portable data folder of this process (None for an installed copy).
pub fn portable_dir() -> Option<&'static Path> {
    static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        portable_data_dir_for(exe.parent()?)
    })
    .as_deref()
}

pub fn is_portable() -> bool {
    portable_dir().is_some()
}

/// Where a kind of data lives: the test override, the portable folder, or `%LOCALAPPDATA%\Adika PDF Editor\<sub>`.
pub fn data_root(env_override: &str, sub: &str) -> PathBuf {
    resolve_root(std::env::var_os(env_override).map(PathBuf::from), portable_dir(), std::env::var_os("LOCALAPPDATA").map(PathBuf::from), sub)
}

pub fn resolve_root(over: Option<PathBuf>, portable: Option<&Path>, local_app_data: Option<PathBuf>, sub: &str) -> PathBuf {
    if let Some(dir) = over.filter(|d| !d.as_os_str().is_empty()) {
        return dir;
    }
    if let Some(p) = portable {
        return p.join(sub);
    }
    local_app_data.unwrap_or_else(std::env::temp_dir).join("Adika PDF Editor").join(sub)
}

// ---------------------------------------------------------------- registry

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(untagged)]
pub enum RegValue {
    Number(u64),
    Text(String),
    List(Vec<String>),
}

pub type Values = BTreeMap<String, RegValue>;

#[cfg(windows)]
mod reg {
    use super::{RegValue, Values};
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegEnumValueW, RegOpenKeyExW, HKEY, KEY_READ, KEY_WOW64_64KEY, REG_DWORD, REG_EXPAND_SZ, REG_MULTI_SZ, REG_QWORD, REG_SZ};

    pub use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn utf16(data: &[u8]) -> Vec<u16> {
        data.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect()
    }

    fn text(units: &[u16]) -> String {
        let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
        String::from_utf16_lossy(&units[..end])
    }

    /// Every value of a key (names as stored); empty when the key does not exist.
    pub fn read_values(root: HKEY, path: &str) -> Values {
        let mut out = Values::new();
        unsafe {
            let mut key: HKEY = std::ptr::null_mut();
            if RegOpenKeyExW(root, wide(path).as_ptr(), 0, KEY_READ | KEY_WOW64_64KEY, &mut key) != ERROR_SUCCESS {
                return out;
            }
            let mut index = 0u32;
            loop {
                let mut name = vec![0u16; 512];
                let mut name_len = name.len() as u32;
                let mut kind = 0u32;
                let mut data = vec![0u8; 16 * 1024];
                let mut data_len = data.len() as u32;
                let r = RegEnumValueW(key, index, name.as_mut_ptr(), &mut name_len, std::ptr::null(), &mut kind, data.as_mut_ptr(), &mut data_len);
                index += 1;
                if r != ERROR_SUCCESS {
                    // ERROR_MORE_DATA (an oversized value) is skipped; anything else ends the list.
                    if r == 234 {
                        continue;
                    }
                    break;
                }
                let name = String::from_utf16_lossy(&name[..name_len as usize]);
                let data = &data[..data_len as usize];
                let value = match kind {
                    REG_DWORD if data.len() >= 4 => Some(RegValue::Number(u32::from_le_bytes([data[0], data[1], data[2], data[3]]) as u64)),
                    REG_QWORD if data.len() >= 8 => Some(RegValue::Number(u64::from_le_bytes(data[..8].try_into().unwrap_or([0; 8])))),
                    REG_SZ | REG_EXPAND_SZ => Some(RegValue::Text(text(&utf16(data)))),
                    REG_MULTI_SZ => Some(RegValue::List(utf16(data).split(|&u| u == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect())),
                    _ => None,
                };
                if let Some(v) = value {
                    out.insert(name, v);
                }
            }
            RegCloseKey(key);
        }
        out
    }
}

#[derive(Serialize, Clone, Debug, Default)]
pub struct Sources {
    /// HKLM policies (they win).
    pub machine: Values,
    pub user: Values,
    /// Defaults the installer wrote (HKLM over HKCU already).
    pub installer: Values,
}

fn read_sources() -> Sources {
    #[cfg(windows)]
    {
        use reg::{read_values, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
        let mut installer = read_values(HKEY_CURRENT_USER, INSTALLER_KEY);
        // A portable copy ignores what an installer left on this computer.
        if is_portable() {
            installer.clear();
        } else {
            installer.extend(read_values(HKEY_LOCAL_MACHINE, INSTALLER_KEY));
        }
        Sources { machine: read_values(HKEY_LOCAL_MACHINE, POLICY_KEY), user: read_values(HKEY_CURRENT_USER, POLICY_KEY), installer }
    }
    #[cfg(not(windows))]
    Sources::default()
}

pub fn sources() -> &'static Sources {
    static S: OnceLock<Sources> = OnceLock::new();
    S.get_or_init(read_sources)
}

/// The machine value of a policy, else the user value.
pub fn policy<'a>(s: &'a Sources, name: &str) -> Option<&'a RegValue> {
    let find = |v: &'a Values| v.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v);
    find(&s.machine).or_else(|| find(&s.user))
}

pub fn flag(v: Option<&RegValue>) -> bool {
    match v {
        Some(RegValue::Number(n)) => *n != 0,
        Some(RegValue::Text(t)) => matches!(t.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        _ => false,
    }
}

pub fn online_disabled() -> bool {
    flag(policy(sources(), "DisableOnlineFeatures"))
}

/// Native network entry points call this first.
pub fn check_online() -> Result<(), String> {
    if online_disabled() {
        return Err("Online features are turned off by your organisation (DisableOnlineFeatures).".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- WebView2

/// True when the Evergreen WebView2 runtime is installed (per machine or per user).
#[cfg(windows)]
pub fn webview2_installed() -> bool {
    use reg::{read_values, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let ok = |v: Values| matches!(v.get("pv"), Some(RegValue::Text(t)) if !t.is_empty() && t != "0.0.0.0");
    ok(read_values(HKEY_LOCAL_MACHINE, &format!(r"SOFTWARE\WOW6432Node\{CLIENT}")))
        || ok(read_values(HKEY_LOCAL_MACHINE, &format!(r"SOFTWARE\{CLIENT}")))
        || ok(read_values(HKEY_CURRENT_USER, &format!(r"Software\{CLIENT}")))
        || std::env::var_os("ProgramFiles(x86)").map(|p| PathBuf::from(p).join(r"Microsoft\EdgeWebView\Application").is_dir()).unwrap_or(false)
}

#[cfg(not(windows))]
pub fn webview2_installed() -> bool {
    true
}

/// Shown when the portable copy cannot start (no installer put WebView2 there).
#[cfg(windows)]
pub fn show_webview2_missing() {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
    let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let text = w("Adika PDF Editor needs the Microsoft Edge WebView2 Runtime, which is not installed on this computer.\n\nWindows 10 and 11 normally include it. Install it from https://go.microsoft.com/fwlink/p/?LinkId=2124703 (or ask your administrator), then start Adika again.");
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), w("Adika PDF Editor").as_ptr(), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
pub fn show_webview2_missing() {}

// ---------------------------------------------------------------- command

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeploymentInfo {
    portable: bool,
    data_dir: Option<String>,
    policies: Sources,
}

#[tauri::command]
pub fn deployment_info() -> DeploymentInfo {
    DeploymentInfo { portable: is_portable(), data_dir: portable_dir().map(|p| p.to_string_lossy().into_owned()), policies: sources().clone() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_marker_moves_data_next_to_the_exe() {
        let dir = std::env::temp_dir().join(format!("adika-portable-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(portable_data_dir_for(&dir), None);
        std::fs::write(dir.join(PORTABLE_MARKER), "[Adika]\n").unwrap();
        let data = portable_data_dir_for(&dir).unwrap();
        assert_eq!(data, dir.join("Data"));
        assert_eq!(resolve_root(None, Some(&data), Some(PathBuf::from(r"C:\Users\x\AppData\Local")), "Recovery"), dir.join("Data").join("Recovery"));
        // The test override wins over everything; without portable the profile folder is used.
        assert_eq!(resolve_root(Some(PathBuf::from(r"D:\t")), Some(&data), None, "Data"), PathBuf::from(r"D:\t"));
        assert_eq!(resolve_root(None, None, Some(PathBuf::from(r"C:\L")), "logs"), PathBuf::from(r"C:\L\Adika PDF Editor\logs"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn machine_policy_wins_and_flags_parse() {
        let mut s = Sources::default();
        s.user.insert("DisableOnlineFeatures".into(), RegValue::Number(1));
        assert!(flag(policy(&s, "disableonlinefeatures")));
        s.machine.insert("DisableOnlineFeatures".into(), RegValue::Number(0));
        assert!(!flag(policy(&s, "DisableOnlineFeatures")));
        assert!(flag(Some(&RegValue::Text("true".into()))));
        assert!(!flag(Some(&RegValue::List(vec!["1".into()]))));
    }

    #[cfg(windows)]
    #[test]
    fn reads_registry_values_of_every_type() {
        use windows_sys::Win32::System::Registry::{RegCreateKeyExW, RegDeleteTreeW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_ALL_ACCESS, REG_DWORD, REG_MULTI_SZ, REG_OPTION_NON_VOLATILE, REG_SZ};
        let path = format!(r"Software\AdikaPDFTest-{}", std::process::id());
        let w = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        unsafe {
            let mut key: HKEY = std::ptr::null_mut();
            assert_eq!(RegCreateKeyExW(HKEY_CURRENT_USER, w(&path).as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_ALL_ACCESS, std::ptr::null(), &mut key, std::ptr::null_mut()), 0);
            let one = 1u32.to_le_bytes();
            RegSetValueExW(key, w("DisableUpdateCheck").as_ptr(), 0, REG_DWORD, one.as_ptr(), 4);
            let sz: Vec<u8> = w("http://timestamp.example/tsa").iter().flat_map(|u| u.to_le_bytes()).collect();
            RegSetValueExW(key, w("DefaultTimestampServer").as_ptr(), 0, REG_SZ, sz.as_ptr(), sz.len() as u32);
            let multi: Vec<u8> = "CA One\0CA Two\0\0".encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
            RegSetValueExW(key, w("AllowedSigningCertificateIssuers").as_ptr(), 0, REG_MULTI_SZ, multi.as_ptr(), multi.len() as u32);
            windows_sys::Win32::System::Registry::RegCloseKey(key);
        }
        let v = reg::read_values(HKEY_CURRENT_USER, &path);
        unsafe {
            RegDeleteTreeW(HKEY_CURRENT_USER, w(&path).as_ptr());
            windows_sys::Win32::System::Registry::RegDeleteKeyW(HKEY_CURRENT_USER, w(&path).as_ptr());
        }
        assert_eq!(v.get("DisableUpdateCheck"), Some(&RegValue::Number(1)));
        assert_eq!(v.get("DefaultTimestampServer"), Some(&RegValue::Text("http://timestamp.example/tsa".into())));
        assert_eq!(v.get("AllowedSigningCertificateIssuers"), Some(&RegValue::List(vec!["CA One".into(), "CA Two".into()])));
        assert!(reg::read_values(HKEY_CURRENT_USER, &path).is_empty());
        assert!(serde_json::to_string(&v).unwrap().contains(r#""DisableUpdateCheck":1"#));
    }
}
