//! Secrets in Windows Credential Manager (generic credentials of the current
//! user, "Adika PDF Editor/<name>"): ANAF client secret and, when the user
//! agrees, the e-Factura refresh token. Only Adika's own names can be read,
//! written or removed. Values longer than one credential blob (2560 bytes)
//! are split over "<name>", "<name>~1", "<name>~2"…; the first blob starts
//! with the number of parts.

const PREFIX: &str = "Adika PDF Editor/";
const CHUNK: usize = 2048;
const MAX_PARTS: usize = 16;

/// Letters, digits, '.', '_' and '-' (1 to 64): never a path or another program's credential.
pub fn check_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 64 || !name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) {
        return Err("Invalid secret name.".into());
    }
    Ok(())
}

fn target(name: &str, part: usize) -> String {
    if part == 0 {
        format!("{PREFIX}{name}")
    } else {
        format!("{PREFIX}{name}~{part}")
    }
}

/// The blobs a value is stored in (the first one prefixed with the part count).
pub fn split(value: &str) -> Result<Vec<Vec<u8>>, String> {
    let bytes = value.as_bytes();
    let parts: Vec<&[u8]> = if bytes.is_empty() { vec![&[][..]] } else { bytes.chunks(CHUNK).collect() };
    if parts.len() > MAX_PARTS {
        return Err("The value is too long to keep in Windows Credential Manager.".into());
    }
    Ok(parts
        .iter()
        .enumerate()
        .map(|(i, p)| if i == 0 { [&[parts.len() as u8][..], p].concat() } else { p.to_vec() })
        .collect())
}

#[cfg(windows)]
mod imp {
    use super::*;
    use windows_sys::Win32::Security::Credentials::{CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC};

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn write_one(target: &str, blob: &[u8]) -> Result<(), String> {
        let mut name = wide(target);
        let mut user = wide("Adika PDF Editor");
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: name.as_mut_ptr(),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_ptr() as *mut u8,
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            UserName: user.as_mut_ptr(),
            ..Default::default()
        };
        if unsafe { CredWriteW(&cred, 0) } == 0 {
            return Err(format!("Windows Credential Manager refused the secret: {}", std::io::Error::last_os_error()));
        }
        Ok(())
    }

    fn read_one(target: &str) -> Option<Vec<u8>> {
        let name = wide(target);
        let mut out: *mut CREDENTIALW = std::ptr::null_mut();
        if unsafe { CredReadW(name.as_ptr(), CRED_TYPE_GENERIC, 0, &mut out) } == 0 || out.is_null() {
            return None;
        }
        let blob = unsafe {
            let c = &*out;
            let v = if c.CredentialBlob.is_null() { Vec::new() } else { std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec() };
            CredFree(out as *const core::ffi::c_void);
            v
        };
        Some(blob)
    }

    fn delete_one(target: &str) {
        let name = wide(target);
        unsafe { CredDeleteW(name.as_ptr(), CRED_TYPE_GENERIC, 0) };
    }

    pub fn store(name: &str, value: &str) -> Result<(), String> {
        check_name(name)?;
        let blobs = split(value)?;
        for (i, b) in blobs.iter().enumerate() {
            write_one(&target(name, i), b)?;
        }
        for i in blobs.len()..MAX_PARTS {
            delete_one(&target(name, i));
        }
        Ok(())
    }

    pub fn read(name: &str) -> Result<Option<String>, String> {
        check_name(name)?;
        let Some(first) = read_one(&target(name, 0)) else { return Ok(None) };
        let Some((&count, rest)) = first.split_first() else { return Ok(None) };
        let mut bytes = rest.to_vec();
        for i in 1..count as usize {
            match read_one(&target(name, i)) {
                Some(b) => bytes.extend_from_slice(&b),
                None => return Ok(None),
            }
        }
        Ok(Some(String::from_utf8_lossy(&bytes).into_owned()))
    }

    pub fn delete(name: &str) -> Result<(), String> {
        check_name(name)?;
        for i in 0..MAX_PARTS {
            delete_one(&target(name, i));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn store(_: &str, _: &str) -> Result<(), String> {
        Err("Windows Credential Manager is only available on Windows.".into())
    }
    pub fn read(_: &str) -> Result<Option<String>, String> {
        Ok(None)
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Ok(())
    }
}

#[tauri::command]
pub fn secret_store(name: String, value: String) -> Result<(), String> {
    imp::store(&name, &value)
}

#[tauri::command]
pub fn secret_read(name: String) -> Result<Option<String>, String> {
    imp::read(&name)
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    imp::delete(&name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_restricted() {
        assert!(check_name("anaf.clientSecret").is_ok());
        assert!(check_name("anaf-refresh_1").is_ok());
        for bad in ["", "../x", "a/b", "a\\b", "x y", "Adika PDF Editor/x", &"a".repeat(65)] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn long_values_are_split() {
        assert_eq!(split("").unwrap(), vec![vec![1u8]]);
        let v = "x".repeat(5000);
        let parts = split(&v).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0][0], 3);
        assert_eq!(parts[0].len(), CHUNK + 1);
        assert_eq!(parts.iter().map(|p| p.len()).sum::<usize>(), 5001);
        assert!(split(&"x".repeat(CHUNK * MAX_PARTS + 1)).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn stores_reads_and_deletes_in_credential_manager() {
        let name = format!("unit-test-{}", std::process::id());
        let long = "jwt.".repeat(1500);
        imp::store(&name, &long).unwrap();
        assert_eq!(imp::read(&name).unwrap().as_deref(), Some(long.as_str()));
        imp::store(&name, "short").unwrap();
        assert_eq!(imp::read(&name).unwrap().as_deref(), Some("short"));
        imp::delete(&name).unwrap();
        assert_eq!(imp::read(&name).unwrap(), None);
        assert!(imp::read("../other").is_err());
    }
}
