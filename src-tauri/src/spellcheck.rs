//! Spell checking with the Windows spell checker (ISpellCheckerFactory):
//! offline, in every language installed in Windows, with the user's own
//! dictionary (words added here are shared with other Windows programs).
//! The COM interfaces are called through their vtables, so no extra crate
//! is needed. Positions are in UTF-16 units, like JavaScript strings.

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct SpellError {
    /// UTF-16 offset of the word in the text.
    pub start: u32,
    pub length: u32,
    /// "suggest" (misspelt), "replace" (auto-correct), "delete" (repeated word).
    pub action: String,
    pub replacement: String,
    pub suggestions: Vec<String>,
}

#[cfg(windows)]
mod win {
    use super::SpellError;
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use windows_sys::core::{GUID, HRESULT};
    use windows_sys::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};

    const CLSID_SPELL_CHECKER_FACTORY: GUID = GUID::from_u128(0x7ab36653_1796_484b_bdfa_e74f1db7c1dc);
    const IID_ISPELL_CHECKER_FACTORY: GUID = GUID::from_u128(0x8e018a9d_2415_4677_bf08_794ea61f94bb);

    type Raw = *mut c_void;

    /// A COM pointer released on drop. Method `n` is the n-th vtable slot (0-2 are IUnknown).
    struct Com(Raw);
    impl Com {
        unsafe fn slot<T: Copy>(&self, n: usize) -> T {
            let vtbl = *(self.0 as *const *const usize);
            std::mem::transmute_copy(&*vtbl.add(n))
        }
    }
    impl Drop for Com {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    let release: unsafe extern "system" fn(Raw) -> u32 = self.slot(2);
                    release(self.0);
                }
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    unsafe fn take_string(p: *mut u16) -> String {
        if p.is_null() {
            return String::new();
        }
        let mut n = 0;
        while *p.add(n) != 0 {
            n += 1;
        }
        let s = String::from_utf16_lossy(std::slice::from_raw_parts(p, n));
        CoTaskMemFree(p as *const c_void);
        s
    }

    fn check(hr: HRESULT, what: &str) -> Result<(), String> {
        if hr < 0 {
            Err(format!("{what} failed (0x{:08X})", hr as u32))
        } else {
            Ok(())
        }
    }

    /// Reads an IEnumString to the end.
    unsafe fn strings(e: Com) -> Vec<String> {
        let next: unsafe extern "system" fn(Raw, u32, *mut *mut u16, *mut u32) -> HRESULT = e.slot(3);
        let mut out = Vec::new();
        loop {
            let mut p: *mut u16 = null_mut();
            let mut got = 0u32;
            if next(e.0, 1, &mut p, &mut got) != 0 || got == 0 {
                break;
            }
            out.push(take_string(p));
        }
        out
    }

    fn factory() -> Result<Com, String> {
        unsafe {
            // Ok when the thread already has COM (S_FALSE / RPC_E_CHANGED_MODE).
            CoInitializeEx(null_mut(), COINIT_MULTITHREADED as u32);
            let mut p: Raw = null_mut();
            check(CoCreateInstance(&CLSID_SPELL_CHECKER_FACTORY, null_mut(), CLSCTX_INPROC_SERVER, &IID_ISPELL_CHECKER_FACTORY, &mut p), "Windows spell checker")?;
            Ok(Com(p))
        }
    }

    pub fn languages() -> Result<Vec<String>, String> {
        let f = factory()?;
        unsafe {
            let get: unsafe extern "system" fn(Raw, *mut Raw) -> HRESULT = f.slot(3);
            let mut e: Raw = null_mut();
            check(get(f.0, &mut e), "Listing spelling languages")?;
            Ok(strings(Com(e)))
        }
    }

    fn checker(lang: &str) -> Result<Com, String> {
        let f = factory()?;
        unsafe {
            let supported: unsafe extern "system" fn(Raw, *const u16, *mut i32) -> HRESULT = f.slot(4);
            let mut ok = 0i32;
            let tag = wide(lang);
            check(supported(f.0, tag.as_ptr(), &mut ok), "Spelling language")?;
            if ok == 0 {
                return Err(format!("NO_LANGUAGE:{lang}"));
            }
            let create: unsafe extern "system" fn(Raw, *const u16, *mut Raw) -> HRESULT = f.slot(5);
            let mut c: Raw = null_mut();
            check(create(f.0, tag.as_ptr(), &mut c), "Starting the spell checker")?;
            Ok(Com(c))
        }
    }

    pub fn check_texts(lang: &str, texts: &[String], max_suggestions: usize) -> Result<Vec<Vec<SpellError>>, String> {
        let c = checker(lang)?;
        let mut all = Vec::with_capacity(texts.len());
        unsafe {
            // ISpellChecker: 3 get_LanguageTag, 4 Check, 5 Suggest, 6 Add, 7 Ignore, 8 AutoCorrect …
            let check_fn: unsafe extern "system" fn(Raw, *const u16, *mut Raw) -> HRESULT = c.slot(4);
            let suggest: unsafe extern "system" fn(Raw, *const u16, *mut Raw) -> HRESULT = c.slot(5);
            for text in texts {
                let mut found = Vec::new();
                if text.trim().is_empty() {
                    all.push(found);
                    continue;
                }
                let w = wide(text);
                let units: Vec<u16> = text.encode_utf16().collect();
                let mut e: Raw = null_mut();
                check(check_fn(c.0, w.as_ptr(), &mut e), "Spell check")?;
                let errors = Com(e);
                let next: unsafe extern "system" fn(Raw, *mut Raw) -> HRESULT = errors.slot(3);
                loop {
                    let mut er: Raw = null_mut();
                    if next(errors.0, &mut er) != 0 || er.is_null() {
                        break;
                    }
                    let err = Com(er);
                    // ISpellingError: 3 get_StartIndex, 4 get_Length, 5 get_CorrectiveAction, 6 get_Replacement
                    let (mut start, mut len, mut action) = (0u32, 0u32, 0i32);
                    let gs: unsafe extern "system" fn(Raw, *mut u32) -> HRESULT = err.slot(3);
                    let gl: unsafe extern "system" fn(Raw, *mut u32) -> HRESULT = err.slot(4);
                    let ga: unsafe extern "system" fn(Raw, *mut i32) -> HRESULT = err.slot(5);
                    let gr: unsafe extern "system" fn(Raw, *mut *mut u16) -> HRESULT = err.slot(6);
                    gs(err.0, &mut start);
                    gl(err.0, &mut len);
                    ga(err.0, &mut action);
                    let mut rp: *mut u16 = null_mut();
                    gr(err.0, &mut rp);
                    let replacement = take_string(rp);
                    let mut suggestions = Vec::new();
                    if action == 1 && (start + len) as usize <= units.len() {
                        let word = String::from_utf16_lossy(&units[start as usize..(start + len) as usize]);
                        let ww = wide(&word);
                        let mut se: Raw = null_mut();
                        if suggest(c.0, ww.as_ptr(), &mut se) >= 0 && !se.is_null() {
                            suggestions = strings(Com(se));
                            suggestions.truncate(max_suggestions);
                        }
                    }
                    let action = match action {
                        2 => "replace",
                        3 => "delete",
                        1 => "suggest",
                        _ => continue,
                    };
                    found.push(SpellError { start, length: len, action: action.into(), replacement, suggestions });
                }
                all.push(found);
            }
        }
        Ok(all)
    }

    pub fn add_word(lang: &str, word: &str, ignore_only: bool) -> Result<(), String> {
        let c = checker(lang)?;
        unsafe {
            let f: unsafe extern "system" fn(Raw, *const u16) -> HRESULT = c.slot(if ignore_only { 7 } else { 6 });
            let w = wide(word);
            check(f(c.0, w.as_ptr()), "Adding the word")
        }
    }
}

/// Languages the Windows spell checker has (BCP 47 tags such as "en-US", "ro-RO").
#[tauri::command]
pub async fn spell_languages() -> Result<Vec<String>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(win::languages).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        Err("Spell checking needs Windows.".into())
    }
}

/// Misspelt words in each text.
#[tauri::command]
pub async fn spell_check(lang: String, texts: Vec<String>) -> Result<Vec<Vec<SpellError>>, String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || win::check_texts(&lang, &texts, 8)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (lang, texts);
        Err("Spell checking needs Windows.".into())
    }
}

/// Adds a word to the user's dictionary (or ignores it for this session).
#[tauri::command]
pub async fn spell_add(lang: String, word: String, ignore_only: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        tauri::async_runtime::spawn_blocking(move || win::add_word(&lang, &word, ignore_only)).await.map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (lang, word, ignore_only);
        Err("Spell checking needs Windows.".into())
    }
}
