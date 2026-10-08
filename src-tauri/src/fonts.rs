//! Fonts installed in Windows, for drawing letters a PDF's embedded subset
//! font lacks in the same typeface. `system_fonts` lists every font in
//! `%WINDIR%\Fonts` and the per-user fonts folder with its names, style and
//! embedding permission (OS/2 fsType), read from the font's own tables; the
//! index is cached in the app data folder and only changed files are read
//! again. `system_font_read` returns a font file's bytes, limited to those
//! folders and font file types.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::ipc::Response;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemFont {
    pub path: String,
    /// Font index inside a .ttc / .otc collection (0 otherwise).
    pub index: u32,
    pub family: String,
    pub subfamily: String,
    /// Typographic family / subfamily (name IDs 16 / 17), empty when absent.
    pub typo_family: String,
    pub typo_subfamily: String,
    pub full_name: String,
    pub postscript: String,
    pub weight: u16,
    pub italic: bool,
    pub bold: bool,
    pub fs_type: u16,
}

#[derive(Serialize, Deserialize, Default)]
struct Cache {
    version: u32,
    files: HashMap<String, CachedFile>,
}

#[derive(Serialize, Deserialize, Clone)]
struct CachedFile {
    size: u64,
    modified: u64,
    fonts: Vec<SystemFont>,
}

const CACHE_NAME: &str = "fonts-index.json";
const CACHE_VERSION: u32 = 1;
const EXTENSIONS: &[&str] = &["ttf", "otf", "ttc", "otc"];

fn font_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let windir = std::env::var_os("WINDIR").or_else(|| std::env::var_os("SystemRoot")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    dirs.push(windir.join("Fonts"));
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(local).join("Microsoft").join("Windows").join("Fonts"));
    }
    dirs
}

fn is_font_file(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()).map(|e| EXTENSIONS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

fn be16(b: &[u8], o: usize) -> Option<u16> {
    b.get(o..o + 2).map(|s| u16::from_be_bytes([s[0], s[1]]))
}

fn be32(b: &[u8], o: usize) -> Option<u32> {
    b.get(o..o + 4).map(|s| u32::from_be_bytes([s[0], s[1], s[2], s[3]]))
}

fn read_at<R: Read + Seek>(f: &mut R, off: u64, len: usize) -> Option<Vec<u8>> {
    if len > 16 * 1024 * 1024 {
        return None;
    }
    f.seek(SeekFrom::Start(off)).ok()?;
    let mut buf = vec![0u8; len];
    f.read_exact(&mut buf).ok()?;
    Some(buf)
}

/// Decodes a name record: UTF-16BE for Windows / Unicode platforms, Latin-1 for Mac Roman.
fn decode_name(platform: u16, raw: &[u8]) -> String {
    if platform == 3 || platform == 0 {
        let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&units)
    } else {
        raw.iter().map(|&c| c as char).collect()
    }
}

/// Name IDs 1, 2, 4, 6, 16, 17 of a `name` table (English Windows names first).
fn parse_names(name: &[u8]) -> HashMap<u16, String> {
    let mut best: HashMap<u16, (u8, String)> = HashMap::new();
    let count = be16(name, 2).unwrap_or(0) as usize;
    let storage = be16(name, 4).unwrap_or(0) as usize;
    for i in 0..count {
        let r = 6 + i * 12;
        let (Some(platform), Some(_enc), Some(lang), Some(id), Some(len), Some(off)) = (be16(name, r), be16(name, r + 2), be16(name, r + 4), be16(name, r + 6), be16(name, r + 8), be16(name, r + 10)) else {
            break;
        };
        if ![1, 2, 4, 6, 16, 17].contains(&id) {
            continue;
        }
        let rank = match (platform, lang) {
            (3, 0x0409) => 3,
            (3, _) => 2,
            (0, _) => 1,
            (1, 0) => 1,
            _ => continue,
        };
        let start = storage + off as usize;
        let Some(raw) = name.get(start..start + len as usize) else { continue };
        let text = decode_name(platform, raw).trim_matches(char::from(0)).trim().to_string();
        if text.is_empty() {
            continue;
        }
        if best.get(&id).map(|(r, _)| *r < rank).unwrap_or(true) {
            best.insert(id, (rank, text));
        }
    }
    best.into_iter().map(|(k, (_, v))| (k, v)).collect()
}

/// One font of a file (the table directory at `dir_off`).
fn read_face<R: Read + Seek>(f: &mut R, dir_off: u64, path: &str, index: u32) -> Option<SystemFont> {
    let head = read_at(f, dir_off, 12)?;
    let num = be16(&head, 4)? as usize;
    if num == 0 || num > 512 {
        return None;
    }
    let dir = read_at(f, dir_off + 12, num * 16)?;
    let mut name_t = None;
    let mut os2_t = None;
    for i in 0..num {
        let e = i * 16;
        let tag = &dir[e..e + 4];
        let off = be32(&dir, e + 8)? as u64;
        let len = be32(&dir, e + 12)? as usize;
        if tag == b"name" {
            name_t = Some((off, len));
        } else if tag == b"OS/2" {
            os2_t = Some((off, len));
        }
    }
    let (noff, nlen) = name_t?;
    let names = parse_names(&read_at(f, noff, nlen)?);
    let (mut weight, mut fs_type, mut italic, mut bold) = (400u16, 0u16, false, false);
    if let Some((ooff, olen)) = os2_t {
        if let Some(os2) = read_at(f, ooff, olen.min(96)) {
            weight = be16(&os2, 4).unwrap_or(400);
            fs_type = be16(&os2, 8).unwrap_or(0);
            let sel = be16(&os2, 62).unwrap_or(0);
            italic = sel & 1 != 0;
            bold = sel & 0x20 != 0;
        }
    }
    let get = |id: u16| names.get(&id).cloned().unwrap_or_default();
    let family = get(1);
    if family.is_empty() {
        return None;
    }
    Some(SystemFont {
        path: path.to_string(),
        index,
        family,
        subfamily: get(2),
        typo_family: get(16),
        typo_subfamily: get(17),
        full_name: get(4),
        postscript: get(6),
        weight,
        italic,
        bold: bold || weight >= 600,
        fs_type,
    })
}

/// Every font in a .ttf / .otf / .ttc / .otc file.
pub fn read_font_file(path: &Path) -> Vec<SystemFont> {
    let Ok(mut f) = File::open(path) else { return Vec::new() };
    let p = path.to_string_lossy().to_string();
    let Some(head) = read_at(&mut f, 0, 12) else { return Vec::new() };
    if &head[0..4] == b"ttcf" {
        let n = be32(&head, 8).unwrap_or(0).min(64) as usize;
        let Some(offs) = read_at(&mut f, 12, n * 4) else { return Vec::new() };
        (0..n).filter_map(|i| read_face(&mut f, be32(&offs, i * 4)? as u64, &p, i as u32)).collect()
    } else {
        read_face(&mut f, 0, &p, 0).into_iter().collect()
    }
}

fn stamp(meta: &std::fs::Metadata) -> u64 {
    meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs()).unwrap_or(0)
}

/// The installed fonts, reading only files that are new or changed since the cached index.
pub fn index(dirs: &[PathBuf], cache_path: Option<&Path>) -> Vec<SystemFont> {
    let mut cache: Cache = cache_path
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .filter(|c: &Cache| c.version == CACHE_VERSION)
        .unwrap_or_default();
    let mut fresh: HashMap<String, CachedFile> = HashMap::new();
    let mut changed = false;
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let path = e.path();
            if !is_font_file(&path) {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let key = path.to_string_lossy().to_string();
            let (size, modified) = (meta.len(), stamp(&meta));
            match cache.files.remove(&key) {
                Some(c) if c.size == size && c.modified == modified => {
                    fresh.insert(key, c);
                }
                _ => {
                    changed = true;
                    fresh.insert(key, CachedFile { size, modified, fonts: read_font_file(&path) });
                }
            }
        }
    }
    changed |= !cache.files.is_empty();
    if changed {
        if let Some(p) = cache_path {
            let out = Cache { version: CACHE_VERSION, files: fresh.clone() };
            if let Ok(json) = serde_json::to_vec(&out) {
                if let Some(parent) = p.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let tmp = p.with_extension("tmp");
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, p);
                }
            }
        }
    }
    let mut out: Vec<SystemFont> = fresh.into_values().flat_map(|c| c.fonts).collect();
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.index.cmp(&b.index)));
    out
}

#[tauri::command(async)]
pub fn system_fonts() -> Vec<SystemFont> {
    let cache = crate::appdata::root().join(CACHE_NAME);
    index(&font_dirs(), Some(&cache))
}

/// A font file's path, when it is a font file directly inside one of the font folders.
fn allowed_font_path(path: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    let p = crate::pathguard::resolve(Path::new(path));
    if !is_font_file(&p) || !p.is_file() {
        return None;
    }
    let parent = p.parent()?.to_string_lossy().to_lowercase();
    dirs.iter()
        .any(|d| crate::pathguard::resolve(d).to_string_lossy().to_lowercase().trim_end_matches('\\') == parent.trim_end_matches('\\'))
        .then_some(p)
}

#[tauri::command(async)]
pub fn system_font_read(path: String) -> Result<Response, String> {
    let p = allowed_font_path(&path, &font_dirs()).ok_or_else(|| format!("Not an installed font: {path}"))?;
    std::fs::read(&p).map(Response::new).map_err(|e| format!("Could not read {}: {e}", p.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fonts_dir() -> PathBuf {
        font_dirs().remove(0)
    }

    #[test]
    fn reads_arial_names_when_installed() {
        let arial = fonts_dir().join("arial.ttf");
        if !arial.exists() {
            return;
        }
        let faces = read_font_file(&arial);
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].postscript, "ArialMT");
        assert_eq!(faces[0].family, "Arial");
        assert!(!faces[0].bold && !faces[0].italic);
        let bold = read_font_file(&fonts_dir().join("arialbd.ttf"));
        if let Some(b) = bold.first() {
            assert_eq!(b.postscript, "Arial-BoldMT");
            assert!(b.bold);
        }
    }

    #[test]
    fn index_is_cached_and_reused() {
        let dir = std::env::temp_dir().join(format!("adika-fonts-{}", std::process::id()));
        let fonts = dir.join("fonts");
        std::fs::create_dir_all(&fonts).unwrap();
        let arial = fonts_dir().join("arial.ttf");
        if !arial.exists() {
            return;
        }
        std::fs::copy(&arial, fonts.join("arial.ttf")).unwrap();
        std::fs::write(fonts.join("notes.txt"), b"x").unwrap();
        let cache = dir.join("cache.json");
        let first = index(&[fonts.clone()], Some(&cache));
        assert_eq!(first.len(), 1);
        assert!(cache.exists());
        let second = index(&[fonts.clone()], Some(&cache));
        assert_eq!(first, second);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn reading_is_limited_to_font_folders() {
        let dirs = font_dirs();
        let arial = dirs[0].join("arial.ttf");
        if arial.exists() {
            assert!(allowed_font_path(&arial.to_string_lossy(), &dirs).is_some());
            assert!(allowed_font_path(&dirs[0].join("..").join("Fonts").join("arial.ttf").to_string_lossy(), &dirs).is_some());
        }
        assert!(allowed_font_path(r"C:\Windows\System32\drivers\etc\hosts", &dirs).is_none());
        assert!(allowed_font_path(r"C:\Windows\win.ini", &dirs).is_none());
    }
}
