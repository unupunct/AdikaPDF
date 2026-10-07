//! Defence in depth for the file commands the WebView can call with any path.
//!
//! The page only ever writes documents the user saves (PDF, Office, images,
//! text, certificates…) and folders for batch / watched-folder output, so a
//! script that got into the page must not be able to use them to plant a
//! program: writes into Windows, Program Files and the Startup folders, and
//! files with an executable extension, are refused. PKCS#11 modules (DLLs the
//! app loads into itself) must be existing local .dll files outside temp
//! folders.

use std::path::{Component, Path, PathBuf};

/// Extensions Windows runs or loads as code.
const EXECUTABLE: &[&str] = &[
    "exe", "dll", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh", "lnk", "scr", "msi", "msp", "com", "hta", "pif", "cpl", "reg", "sys", "url",
];

/// `\\?\C:\x` -> `C:\x`, `\\?\UNC\srv\share` -> `\\srv\share`.
fn plain(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return PathBuf::from(rest);
    }
    p
}

/// Absolute form of a path that may not exist yet: the deepest existing
/// ancestor is resolved (junctions and links included), the rest is appended
/// with `.` and `..` applied.
pub fn resolve(path: &Path) -> PathBuf {
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut norm = PathBuf::new();
    for c in abs.components() {
        match c {
            Component::ParentDir => {
                norm.pop();
            }
            Component::CurDir => {}
            other => norm.push(other.as_os_str()),
        }
    }
    let mut existing = norm.clone();
    let mut rest = Vec::new();
    while !existing.exists() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => return norm,
        }
    }
    let mut out = existing.canonicalize().map(plain).unwrap_or(existing);
    for name in rest.into_iter().rev() {
        out.push(name);
    }
    out
}

fn lower(p: &Path) -> String {
    p.to_string_lossy().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

fn under(path: &str, root: &Path) -> bool {
    let r = lower(root);
    !r.is_empty() && (path == r || path.starts_with(&format!("{r}\\")))
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// Folders a document is never written to.
fn protected_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for v in ["SystemRoot", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"] {
        if let Some(d) = env_dir(v) {
            roots.push(d);
        }
    }
    if let Some(d) = env_dir("APPDATA") {
        roots.push(d.join(r"Microsoft\Windows\Start Menu\Programs\Startup"));
    }
    if let Some(d) = env_dir("ProgramData") {
        roots.push(d.join(r"Microsoft\Windows\Start Menu\Programs\Startup"));
    }
    roots.into_iter().map(|r| resolve(&r)).collect()
}

/// The file name's extension as Windows sees it (trailing dots and spaces dropped).
fn effective_extension(path: &Path) -> String {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = name.trim_end_matches(['.', ' ']);
    name.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default()
}

fn check_folder(resolved: &Path, shown: &Path) -> Result<(), String> {
    let s = lower(resolved);
    if protected_roots().iter().any(|r| under(&s, r)) {
        return Err(format!("Adika does not write into system or program folders: {}", shown.display()));
    }
    Ok(())
}

/// A file the page asks to write (or move to).
pub fn check_write_file(path: &Path) -> Result<PathBuf, String> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    // "file.pdf:stream" would write an alternate data stream.
    if name.is_empty() || name.contains(':') {
        return Err(format!("Invalid file name: {}", path.display()));
    }
    if EXECUTABLE.contains(&effective_extension(path).as_str()) {
        return Err(format!("Adika does not write program files: {}", path.display()));
    }
    let resolved = resolve(path);
    check_folder(&resolved, path)?;
    Ok(resolved)
}

/// A folder the page asks to create.
pub fn check_make_dir(path: &Path) -> Result<(), String> {
    check_folder(&resolve(path), path)
}

/// A PKCS#11 module to load into this process.
pub fn check_module(module: &str) -> Result<(), String> {
    let p = Path::new(module);
    if !p.is_absolute() || module.starts_with(r"\\") {
        return Err(format!("A PKCS#11 module must be a DLL on this computer: {module}"));
    }
    if cfg!(windows) && effective_extension(p) != "dll" {
        return Err(format!("A PKCS#11 module must be a .dll file: {module}"));
    }
    if !p.is_file() {
        return Err(format!("PKCS#11 module not found: {module}"));
    }
    let s = lower(&resolve(p));
    if s.starts_with(r"\\") {
        return Err(format!("A PKCS#11 module must be a DLL on this computer: {module}"));
    }
    let mut temps = vec![std::env::temp_dir()];
    temps.extend(["TEMP", "TMP"].iter().filter_map(|v| env_dir(v)));
    if let Some(d) = env_dir("LOCALAPPDATA") {
        temps.push(d.join("Temp"));
    }
    if let Some(d) = env_dir("SystemRoot") {
        temps.push(d.join("Temp"));
    }
    if temps.iter().any(|t| under(&s, &resolve(t))) {
        return Err(format!("PKCS#11 modules are not loaded from temporary folders: {module}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_programs_and_system_folders() {
        let docs = std::env::temp_dir().join("adika-guard").join("out.pdf");
        assert!(check_write_file(&docs).is_ok());
        assert!(check_write_file(&docs.with_file_name("x.EXE")).is_err());
        assert!(check_write_file(&docs.with_file_name("x.bat. .")).is_err());
        assert!(check_write_file(&docs.with_file_name("x.pdf:evil")).is_err());
        if let Some(win) = env_dir("SystemRoot") {
            assert!(check_write_file(&win.join("System32").join("a.pdf")).is_err());
            assert!(check_make_dir(&win.join("NewFolder")).is_err());
            // ".." does not get around it.
            assert!(check_write_file(&std::env::temp_dir().join(r"..\..\..\..\..\..\..\..").join(win.strip_prefix(r"C:\").unwrap_or(&win)).join("a.pdf")).is_err());
        }
        if let Some(app) = env_dir("APPDATA") {
            assert!(check_write_file(&app.join(r"Microsoft\Windows\Start Menu\Programs\Startup\a.pdf")).is_err());
        }
        assert!(check_make_dir(&std::env::temp_dir().join("adika-guard").join("Processed")).is_ok());
    }

    #[test]
    fn pkcs11_modules_must_be_local_dlls() {
        let dir = std::env::temp_dir().join(format!("adika-guard-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dll = dir.join("token.dll");
        std::fs::write(&dll, b"MZ").unwrap();
        assert!(check_module(&dll.to_string_lossy()).unwrap_err().contains("temporary"));
        assert!(check_module("token.dll").is_err());
        assert!(check_module(r"\\server\share\token.dll").is_err());
        if let Some(win) = env_dir("SystemRoot") {
            assert!(check_module(&win.join(r"System32\notepad.exe").to_string_lossy()).is_err());
            assert!(check_module(&win.join(r"System32\kernel32.dll").to_string_lossy()).is_ok());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
