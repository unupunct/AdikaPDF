//! Signing with certificates from the Windows certificate store (the
//! "Personal" store of the current user): qualified certificates installed by
//! a card or token driver, or imported .pfx files. Windows asks for the PIN
//! itself (smart cards) and the key never leaves its provider.

use base64::Engine;
use sha2::{Digest, Sha256};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCertificate {
    /// SHA-1 thumbprint (hex), as Windows shows it.
    thumbprint: String,
    der_base64: String,
    /// A private key is associated with the certificate.
    has_private_key: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreSignature {
    signature_base64: String,
    /// "cng" or "capi".
    provider: String,
}

#[cfg(windows)]
mod win {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::*;

    pub struct Store(pub HCERTSTORE);
    impl Drop for Store {
        fn drop(&mut self) {
            unsafe { CertCloseStore(self.0, 0) };
        }
    }

    pub fn open_my() -> Result<Store, String> {
        let name: Vec<u16> = "MY".encode_utf16().chain(Some(0)).collect();
        let h = unsafe {
            CertOpenStore(
                CERT_STORE_PROV_SYSTEM_W,
                0,
                0,
                CERT_SYSTEM_STORE_CURRENT_USER | CERT_STORE_READONLY_FLAG | CERT_STORE_OPEN_EXISTING_FLAG,
                name.as_ptr() as *const _,
            )
        };
        if h.is_null() {
            return Err(format!("Could not open the Windows certificate store: {}", std::io::Error::last_os_error()));
        }
        Ok(Store(h))
    }

    /// The Personal store, plus (end-to-end tests only) an in-memory store
    /// imported from `ADIKA_WINSTORE_TEST_PFX` whose key is never persisted.
    pub fn stores() -> Result<Vec<Store>, String> {
        let mut out = vec![open_my()?];
        let e2e = std::env::var("ADIKA_E2E").map(|v| v == "1").unwrap_or(false);
        if let (true, Some(path)) = (e2e, std::env::var_os("ADIKA_WINSTORE_TEST_PFX")) {
            let pfx = std::fs::read(path).map_err(|e| e.to_string())?;
            let pass: Vec<u16> = std::env::var("ADIKA_WINSTORE_TEST_PASSWORD").unwrap_or_default().encode_utf16().chain(Some(0)).collect();
            let blob = CRYPT_INTEGER_BLOB { cbData: pfx.len() as u32, pbData: pfx.as_ptr() as *mut u8 };
            let h = unsafe { PFXImportCertStore(&blob, pass.as_ptr(), PKCS12_NO_PERSIST_KEY | PKCS12_ALWAYS_CNG_KSP) };
            if h.is_null() {
                return Err(format!("Could not import the test certificate: {}", std::io::Error::last_os_error()));
            }
            out.push(Store(h));
        }
        Ok(out)
    }

    pub fn property(cert: *const CERT_CONTEXT, prop: u32) -> Option<Vec<u8>> {
        unsafe {
            let mut len = 0u32;
            if CertGetCertificateContextProperty(cert, prop, ptr::null_mut(), &mut len) == 0 {
                return None;
            }
            let mut buf = vec![0u8; len as usize];
            if CertGetCertificateContextProperty(cert, prop, buf.as_mut_ptr() as *mut _, &mut len) == 0 {
                return None;
            }
            buf.truncate(len as usize);
            Some(buf)
        }
    }

    pub fn der(cert: *const CERT_CONTEXT) -> Vec<u8> {
        unsafe { std::slice::from_raw_parts((*cert).pbCertEncoded, (*cert).cbCertEncoded as usize).to_vec() }
    }
}

/// Certificates of the current user's "Personal" store.
#[tauri::command]
pub fn winstore_list() -> Result<Vec<StoreCertificate>, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::*;
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut out = Vec::new();
        for store in win::stores()? {
            let mut cur: *const CERT_CONTEXT = std::ptr::null();
            loop {
                cur = unsafe { CertEnumCertificatesInStore(store.0, cur) };
                if cur.is_null() {
                    break;
                }
                let thumbprint = win::property(cur, CERT_SHA1_HASH_PROP_ID).map(hex::encode).unwrap_or_default();
                // Only the key properties are read: acquiring the key could prompt for a card.
                let has_private_key = [CERT_KEY_PROV_INFO_PROP_ID, CERT_KEY_CONTEXT_PROP_ID, CERT_NCRYPT_KEY_HANDLE_PROP_ID].iter().any(|&p| win::property(cur, p).is_some());
                out.push(StoreCertificate { thumbprint, der_base64: b64.encode(win::der(cur)), has_private_key });
            }
        }
        Ok(out)
    }
    #[cfg(not(windows))]
    {
        Ok(Vec::new())
    }
}

/// Signs SHA-256(`data`) with the private key of the certificate `thumbprint`:
/// PKCS#1 v1.5 for RSA, raw r||s for ECDSA.
#[tauri::command]
pub async fn winstore_sign(thumbprint: String, data_base64: String) -> Result<StoreSignature, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let data = b64.decode(data_base64).map_err(|e| e.to_string())?;
    let digest: Vec<u8> = Sha256::digest(&data).to_vec();
    tauri::async_runtime::spawn_blocking(move || sign_blocking(&thumbprint, &digest))
        .await
        .map_err(|e| e.to_string())?
        .map(|(sig, provider)| StoreSignature { signature_base64: b64.encode(sig), provider: provider.into() })
}

/// Opens the private key of the certificate `thumbprint` (Windows may ask for
/// the PIN) and hands it to `f`: (key handle, is CNG, key spec).
#[cfg(windows)]
fn with_private_key<R>(
    thumbprint: &str,
    f: impl FnOnce(windows_sys::Win32::Security::Cryptography::HCRYPTPROV_OR_NCRYPT_KEY_HANDLE, bool, windows_sys::Win32::Security::Cryptography::CERT_KEY_SPEC) -> Result<R, String>,
) -> Result<R, String> {
    use std::ptr;
    use windows_sys::Win32::Foundation::FALSE;
    use windows_sys::Win32::Security::Cryptography::*;

    let want = hex::decode(thumbprint).map_err(|_| "Invalid certificate thumbprint.".to_string())?;
    let stores = win::stores()?;
    let blob = CRYPT_INTEGER_BLOB { cbData: want.len() as u32, pbData: want.as_ptr() as *mut u8 };
    let cert = stores
        .iter()
        .map(|s| unsafe { CertFindCertificateInStore(s.0, X509_ASN_ENCODING | PKCS_7_ASN_ENCODING, 0, CERT_FIND_SHA1_HASH, &blob as *const _ as *const _, ptr::null()) })
        .find(|c| !c.is_null())
        .unwrap_or(ptr::null_mut());
    if cert.is_null() {
        return Err("The certificate is no longer in the Windows certificate store.".into());
    }
    struct Cert(*const CERT_CONTEXT);
    impl Drop for Cert {
        fn drop(&mut self) {
            unsafe { CertFreeCertificateContext(self.0) };
        }
    }
    let cert = Cert(cert);

    let mut key: HCRYPTPROV_OR_NCRYPT_KEY_HANDLE = 0;
    let mut spec: CERT_KEY_SPEC = 0;
    let mut must_free = FALSE;
    let ok = unsafe { CryptAcquireCertificatePrivateKey(cert.0, CRYPT_ACQUIRE_PREFER_NCRYPT_KEY_FLAG, ptr::null(), &mut key, &mut spec, &mut must_free) };
    if ok == 0 {
        let err = std::io::Error::last_os_error();
        // A key that is not persisted (imported in memory) hangs on the certificate itself.
        match win::property(cert.0, CERT_NCRYPT_KEY_HANDLE_PROP_ID) {
            Some(v) if v.len() == std::mem::size_of::<usize>() => {
                key = usize::from_ne_bytes(v.try_into().unwrap());
                spec = CERT_NCRYPT_KEY_SPEC;
                must_free = FALSE; // owned by the certificate
            }
            _ => return Err(format!("Could not open the private key of this certificate: {err}")),
        }
    }
    let is_ncrypt = spec == CERT_NCRYPT_KEY_SPEC;
    struct Key(HCRYPTPROV_OR_NCRYPT_KEY_HANDLE, bool, bool);
    impl Drop for Key {
        fn drop(&mut self) {
            if self.2 {
                unsafe {
                    if self.1 {
                        NCryptFreeObject(self.0);
                    } else {
                        CryptReleaseContext(self.0, 0);
                    }
                }
            }
        }
    }
    let key = Key(key, is_ncrypt, must_free != FALSE);
    let out = f(key.0, is_ncrypt, spec);
    drop(key);
    drop(cert);
    out
}

#[cfg(windows)]
fn sign_blocking(thumbprint: &str, digest: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::*;
    with_private_key(thumbprint, |key, is_ncrypt, spec| {
        if is_ncrypt {
            // RSA or ECDSA? Ask the key.
            let mut alg = [0u16; 64];
            let mut got = 0u32;
            let name: Vec<u16> = "Algorithm Group".encode_utf16().chain(Some(0)).collect();
            let st = unsafe { NCryptGetProperty(key, name.as_ptr(), alg.as_mut_ptr() as *mut u8, (alg.len() * 2) as u32, &mut got, 0) };
            let group = if st == 0 { String::from_utf16_lossy(&alg[..(got as usize / 2)]).trim_end_matches('\0').to_string() } else { String::new() };
            let is_rsa = group == "RSA";
            let sha256: Vec<u16> = "SHA256".encode_utf16().chain(Some(0)).collect();
            let pad = BCRYPT_PKCS1_PADDING_INFO { pszAlgId: sha256.as_ptr() };
            let (pinfo, flags) = if is_rsa { (&pad as *const _ as *const core::ffi::c_void, BCRYPT_PAD_PKCS1) } else { (ptr::null(), 0) };
            let mut len = 0u32;
            let st = unsafe { NCryptSignHash(key, pinfo, digest.as_ptr(), digest.len() as u32, ptr::null_mut(), 0, &mut len, flags) };
            if st != 0 {
                return Err(format!("Signing failed (NCrypt 0x{:08X}).", st as u32));
            }
            let mut sig = vec![0u8; len as usize];
            let st = unsafe { NCryptSignHash(key, pinfo, digest.as_ptr(), digest.len() as u32, sig.as_mut_ptr(), len, &mut len, flags) };
            if st != 0 {
                return Err(if st as u32 == 0x8010_006E { "Signing was cancelled.".into() } else { format!("Signing failed (NCrypt 0x{:08X}).", st as u32) });
            }
            sig.truncate(len as usize);
            return Ok((sig, "cng"));
        }

        // Legacy CryptoAPI provider (RSA only). SHA-256 needs an AES-capable provider.
        let mut hash: usize = 0;
        if unsafe { CryptCreateHash(key, CALG_SHA_256, 0, 0, &mut hash) } == 0 {
            return Err(format!("This certificate's key provider does not support SHA-256: {}", std::io::Error::last_os_error()));
        }
        struct Hash(usize);
        impl Drop for Hash {
            fn drop(&mut self) {
                unsafe { CryptDestroyHash(self.0) };
            }
        }
        let hash = Hash(hash);
        if unsafe { CryptSetHashParam(hash.0, HP_HASHVAL, digest.as_ptr(), 0) } == 0 {
            return Err(format!("Signing failed: {}", std::io::Error::last_os_error()));
        }
        let mut len = 0u32;
        if unsafe { CryptSignHashW(hash.0, spec, ptr::null(), 0, ptr::null_mut(), &mut len) } == 0 {
            return Err(format!("Signing failed: {}", std::io::Error::last_os_error()));
        }
        let mut sig = vec![0u8; len as usize];
        if unsafe { CryptSignHashW(hash.0, spec, ptr::null(), 0, sig.as_mut_ptr(), &mut len) } == 0 {
            return Err(format!("Signing failed: {}", std::io::Error::last_os_error()));
        }
        sig.truncate(len as usize);
        sig.reverse(); // CryptoAPI returns little-endian
        Ok((sig, "capi"))
    })
}

#[cfg(not(windows))]
fn sign_blocking(_thumbprint: &str, _digest: &[u8]) -> Result<(Vec<u8>, &'static str), String> {
    Err("The Windows certificate store is only available on Windows.".into())
}

/// Decrypts an RSA-encrypted key (PKCS#1 v1.5) with the certificate's private
/// key: opening documents encrypted for this certificate.
#[tauri::command]
pub async fn winstore_decrypt(thumbprint: String, data_base64: String) -> Result<String, String> {
    let b64 = base64::engine::general_purpose::STANDARD;
    let data = b64.decode(data_base64).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || decrypt_blocking(&thumbprint, &data))
        .await
        .map_err(|e| e.to_string())?
        .map(|plain| b64.encode(plain))
}

#[cfg(windows)]
fn decrypt_blocking(thumbprint: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    use std::ptr;
    use windows_sys::Win32::Security::Cryptography::*;
    with_private_key(thumbprint, |key, is_ncrypt, _spec| {
        if is_ncrypt {
            let mut len = 0u32;
            let st = unsafe { NCryptDecrypt(key, data.as_ptr(), data.len() as u32, ptr::null(), ptr::null_mut(), 0, &mut len, NCRYPT_PAD_PKCS1_FLAG) };
            if st != 0 {
                return Err(format!("Decryption failed (NCrypt 0x{:08X}).", st as u32));
            }
            let mut out = vec![0u8; len as usize];
            let st = unsafe { NCryptDecrypt(key, data.as_ptr(), data.len() as u32, ptr::null(), out.as_mut_ptr(), len, &mut len, NCRYPT_PAD_PKCS1_FLAG) };
            if st != 0 {
                return Err(if st as u32 == 0x8010_006E { "Opening was cancelled.".into() } else { format!("Decryption failed (NCrypt 0x{:08X}).", st as u32) });
            }
            out.truncate(len as usize);
            return Ok(out);
        }
        // Legacy CryptoAPI: the key in little-endian, decrypted in place.
        let mut user_key: usize = 0;
        if unsafe { CryptGetUserKey(key, AT_KEYEXCHANGE, &mut user_key) } == 0 {
            return Err(format!("Could not open the decryption key: {}", std::io::Error::last_os_error()));
        }
        struct UserKey(usize);
        impl Drop for UserKey {
            fn drop(&mut self) {
                unsafe { CryptDestroyKey(self.0) };
            }
        }
        let user_key = UserKey(user_key);
        let mut buf: Vec<u8> = data.iter().rev().cloned().collect();
        let mut len = buf.len() as u32;
        if unsafe { CryptDecrypt(user_key.0, 0, 1, 0, buf.as_mut_ptr(), &mut len) } == 0 {
            return Err(format!("Decryption failed: {}", std::io::Error::last_os_error()));
        }
        buf.truncate(len as usize);
        Ok(buf)
    })
}

#[cfg(not(windows))]
fn decrypt_blocking(_thumbprint: &str, _data: &[u8]) -> Result<Vec<u8>, String> {
    Err("The Windows certificate store is only available on Windows.".into())
}
