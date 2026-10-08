//! Hardware token (smart card / USB dongle) signing over PKCS#11.
//!
//! The WebView builds the CMS structure; this module only ever receives the
//! DER-encoded signed attributes, hashes them and asks the token to sign the
//! hash. The private key never leaves the token, and the PIN is used for a
//! single login and dropped (zeroised by `secrecy`) right after. Batch
//! signing keeps one logged-in session open (`pkcs11_open_session` …
//! `pkcs11_close_session`); only keys that demand the PIN for every
//! signature make the session hold it until it is closed.

use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::mechanism::{Mechanism, MechanismType};
use cryptoki::object::{Attribute, AttributeType, CertificateType, KeyType, ObjectClass, ObjectHandle};
use cryptoki::session::{Session, UserType};
use cryptoki::slot::Slot;
use cryptoki::types::AuthPin;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Well-known PKCS#11 middleware DLLs on Windows (checked in System32 and
/// the vendors' Program Files folders).
const KNOWN_MODULES: &[(&str, &str)] = &[
    ("eTPKCS11.dll", "SafeNet / Thales eToken (certSIGN, DigiSign, ...)"),
    ("IDPrimePKCS11.dll", "Thales / Gemalto IDPrime"),
    ("gclib.dll", "Gemalto Classic Client"),
    ("aetpkss1.dll", "A.E.T. SafeSign"),
    ("asepkcs.dll", "Athena / NXP ASECard"),
    ("bit4xpki.dll", "Bit4id"),
    ("bit4ipki.dll", "Bit4id"),
    ("cmP11.dll", "Charismathics"),
    ("cvP11.dll", "Charismathics"),
    ("opensc-pkcs11.dll", "OpenSC"),
    ("libykcs11.dll", "YubiKey PIV"),
    ("ykcs11.dll", "YubiKey PIV"),
    ("siecap11.dll", "Atos CardOS"),
    ("cryptoide_pkcs11.dll", "Italian CNS"),
    ("beidpkcs11.dll", "Belgian eID"),
    ("dkck201.dll", "DataKey"),
    ("idprimepkcs1164.dll", "Thales IDPrime (x64)"),
    ("softhsm2-x64.dll", "SoftHSM 2 (testing)"),
    ("softhsm2.dll", "SoftHSM 2 (testing)"),
];

const SEARCH_DIRS: &[&str] = &[
    r"C:\Windows\System32",
    r"C:\Program Files\OpenSC Project\OpenSC\pkcs11",
    r"C:\Program Files\Yubico\Yubico PIV Tool\bin",
    r"C:\Program Files\SafeNet\Authentication\SAC\x64",
    r"C:\Program Files\Gemalto\IDGo 800 PKCS#11",
    r"C:\Program Files\Thales\IDPrime Middleware",
    r"C:\SoftHSM2\lib",
    r"C:\Program Files\SoftHSM2\lib",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleCandidate {
    path: String,
    vendor: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCertificate {
    /// CKA_ID, hex — pairs the certificate with its private key.
    id_hex: String,
    label: String,
    der_base64: String,
    has_private_key: bool,
    key_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenInfo {
    slot_id: u64,
    slot_description: String,
    label: String,
    manufacturer: String,
    model: String,
    serial: String,
    login_required: bool,
    /// PIN is entered on the reader's own keypad.
    protected_auth_path: bool,
    certificates: Vec<TokenCertificate>,
}

fn contexts() -> &'static Mutex<HashMap<String, &'static Pkcs11>> {
    static CTX: OnceLock<Mutex<HashMap<String, &'static Pkcs11>>> = OnceLock::new();
    CTX.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Loads and initialises a module once per process. Contexts are leaked on
/// purpose: many vendor DLLs misbehave if C_Finalize/C_Initialize cycle.
fn context(module: &str) -> Result<&'static Pkcs11, String> {
    let mut map = contexts().lock().map_err(|_| "PKCS#11 lock poisoned")?;
    if let Some(ctx) = map.get(module) {
        return Ok(ctx);
    }
    crate::pathguard::check_module(module)?;
    let ctx = Pkcs11::new(module).map_err(|e| format!("Could not load {module}: {e}"))?;
    match ctx.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK)) {
        Ok(()) => {}
        Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::CryptokiAlreadyInitialized, _)) => {}
        Err(e) => return Err(format!("C_Initialize failed for {module}: {e}")),
    }
    let leaked: &'static Pkcs11 = Box::leak(Box::new(ctx));
    map.insert(module.to_string(), leaked);
    Ok(leaked)
}

#[tauri::command]
pub fn pkcs11_detect_modules() -> Vec<ModuleCandidate> {
    let mut out = Vec::new();
    for dir in SEARCH_DIRS {
        for (file, vendor) in KNOWN_MODULES {
            let p = Path::new(dir).join(file);
            if p.is_file() && !out.iter().any(|c: &ModuleCandidate| c.path.eq_ignore_ascii_case(&p.to_string_lossy())) {
                out.push(ModuleCandidate { path: p.to_string_lossy().into_owned(), vendor: vendor.to_string() });
            }
        }
    }
    out
}

fn key_type_name(kt: KeyType) -> &'static str {
    if kt == KeyType::RSA {
        "rsa"
    } else if kt == KeyType::EC {
        "ecdsa"
    } else {
        "unsupported"
    }
}

fn find_private_key(session: &Session, id: &[u8]) -> Result<Option<(ObjectHandle, KeyType)>, String> {
    let keys = session
        .find_objects(&[Attribute::Class(ObjectClass::PRIVATE_KEY), Attribute::Id(id.to_vec())])
        .map_err(|e| format!("Key lookup failed: {e}"))?;
    let Some(&key) = keys.first() else { return Ok(None) };
    let attrs = session.get_attributes(key, &[AttributeType::KeyType]).map_err(|e| e.to_string())?;
    let kt = attrs
        .into_iter()
        .find_map(|a| if let Attribute::KeyType(k) = a { Some(k) } else { None })
        .unwrap_or(KeyType::RSA);
    Ok(Some((key, kt)))
}

fn list_certificates(session: &Session) -> Result<Vec<TokenCertificate>, String> {
    use base64::Engine;
    let handles = session
        .find_objects(&[
            Attribute::Class(ObjectClass::CERTIFICATE),
            Attribute::CertificateType(CertificateType::X_509),
        ])
        .map_err(|e| format!("Certificate lookup failed: {e}"))?;
    let mut out = Vec::new();
    for h in handles {
        let attrs = session
            .get_attributes(h, &[AttributeType::Value, AttributeType::Id, AttributeType::Label])
            .map_err(|e| e.to_string())?;
        let (mut der, mut id, mut label) = (Vec::new(), Vec::new(), String::new());
        for a in attrs {
            match a {
                Attribute::Value(v) => der = v,
                Attribute::Id(v) => id = v,
                Attribute::Label(v) => label = String::from_utf8_lossy(&v).trim().to_string(),
                _ => {}
            }
        }
        if der.is_empty() {
            continue;
        }
        // Private keys are usually only visible after login; the UI treats
        // `has_private_key: false` before login as "unknown", not "absent".
        let key = find_private_key(session, &id).unwrap_or(None);
        out.push(TokenCertificate {
            id_hex: hex::encode(&id),
            label,
            der_base64: base64::engine::general_purpose::STANDARD.encode(&der),
            has_private_key: key.is_some(),
            key_type: key.map(|(_, kt)| key_type_name(kt)).unwrap_or("unknown").to_string(),
        });
    }
    Ok(out)
}

fn slot_from_id(ctx: &Pkcs11, slot_id: u64) -> Result<Slot, String> {
    ctx.get_slots_with_token()
        .map_err(|e| format!("Slot enumeration failed: {e}"))?
        .into_iter()
        .find(|s| s.id() == slot_id)
        .ok_or_else(|| format!("Token in slot {slot_id} is no longer present — was it unplugged?"))
}

/// Lists tokens present on the module and the certificates they expose
/// without logging in.
#[tauri::command]
pub async fn pkcs11_list_tokens(module: String) -> Result<Vec<TokenInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ctx = context(&module)?;
        let slots = ctx.get_slots_with_token().map_err(|e| format!("Slot enumeration failed: {e}"))?;
        let mut out = Vec::new();
        let mut skipped = Vec::new();
        for slot in slots {
            // One unusable slot (empty reader, blank or unrecognised card,
            // SoftHSM's spare uninitialised slot) must not hide the others.
            let Ok(info) = ctx.get_token_info(slot) else { continue };
            if !info.token_initialized() {
                continue;
            }
            let slot_info = ctx.get_slot_info(slot).map_err(|e| e.to_string())?;
            let session = match ctx.open_ro_session(slot) {
                Ok(s) => s,
                Err(e) => {
                    skipped.push(format!("{}: {e}", info.label().trim()));
                    continue;
                }
            };
            let certificates = list_certificates(&session).unwrap_or_default();
            out.push(TokenInfo {
                slot_id: slot.id(),
                slot_description: slot_info.slot_description().trim().to_string(),
                label: info.label().trim().to_string(),
                manufacturer: info.manufacturer_id().trim().to_string(),
                model: info.model().trim().to_string(),
                serial: info.serial_number().trim().to_string(),
                login_required: info.login_required(),
                protected_auth_path: info.protected_authentication_path(),
                certificates,
            });
        }
        if out.is_empty() && !skipped.is_empty() {
            return Err(format!("A token is present but could not be opened ({}).", skipped.join("; ")));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// DER DigestInfo prefix for SHA-256 (RFC 8017 §9.2 note 1).
const SHA256_DIGEST_INFO: [u8; 19] =
    [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];

/// Raw ECDSA r||s (from PKCS#11) → DER Ecdsa-Sig-Value (what CMS expects).
fn ecdsa_raw_to_der(raw: &[u8]) -> Vec<u8> {
    fn int(bytes: &[u8]) -> Vec<u8> {
        let mut b: Vec<u8> = bytes.iter().copied().skip_while(|&x| x == 0).collect();
        if b.is_empty() {
            b.push(0);
        }
        if b[0] & 0x80 != 0 {
            b.insert(0, 0);
        }
        let mut out = vec![0x02];
        push_len(&mut out, b.len());
        out.extend(b);
        out
    }
    fn push_len(out: &mut Vec<u8>, len: usize) {
        if len < 0x80 {
            out.push(len as u8);
        } else if len < 0x100 {
            out.extend([0x81, len as u8]);
        } else {
            out.extend([0x82, (len >> 8) as u8, len as u8]);
        }
    }
    let (r, s) = raw.split_at(raw.len() / 2);
    let body: Vec<u8> = [int(r), int(s)].concat();
    let mut out = vec![0x30];
    push_len(&mut out, body.len());
    out.extend(body);
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSignature {
    signature_base64: String,
    key_type: String,
    mechanism: String,
}

fn login_user(session: &Session, pin: Option<&AuthPin>) -> Result<(), String> {
    match session.login(UserType::User, pin) {
        Ok(()) => Ok(()),
        Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::UserAlreadyLoggedIn, _)) => Ok(()),
        Err(e) => Err(login_error(e)),
    }
}

fn login_error(e: cryptoki::error::Error) -> String {
    match e {
        cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::PinIncorrect, _) => {
            "Incorrect PIN. Careful: tokens lock after a few wrong attempts.".into()
        }
        cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::PinLocked, _) => {
            "The token PIN is locked. Unlock it with your vendor's tool (PUK).".into()
        }
        e => format!("Login failed: {e}"),
    }
}

/// Signs `data` (DER signed attributes) with SHA-256. `context_pin` is set for
/// keys with CKA_ALWAYS_AUTHENTICATE: they need a context-specific login right
/// after C_SignInit, so the hash-and-sign mechanisms are used multi-part.
fn sign_data(
    session: &Session,
    mechanisms: &[MechanismType],
    key: ObjectHandle,
    kt: KeyType,
    data: &[u8],
    context_pin: Option<&AuthPin>,
) -> Result<(Vec<u8>, &'static str), String> {
    let refused = |e: cryptoki::error::Error| format!("Token refused to sign: {e}");
    let digest = Sha256::digest(data);
    let (mech, name, input, raw_ec): (Mechanism, &'static str, Vec<u8>, bool) = if kt == KeyType::RSA {
        if mechanisms.contains(&MechanismType::SHA256_RSA_PKCS) {
            (Mechanism::Sha256RsaPkcs, "CKM_SHA256_RSA_PKCS", data.to_vec(), false)
        } else {
            let mut info = SHA256_DIGEST_INFO.to_vec();
            info.extend_from_slice(&digest);
            (Mechanism::RsaPkcs, "CKM_RSA_PKCS", info, false)
        }
    } else if kt == KeyType::EC {
        if context_pin.is_some() && mechanisms.contains(&MechanismType::ECDSA_SHA256) {
            (Mechanism::EcdsaSha256, "CKM_ECDSA_SHA256", data.to_vec(), true)
        } else {
            (Mechanism::Ecdsa, "CKM_ECDSA", digest.to_vec(), true)
        }
    } else {
        return Err("Unsupported key type on token (only RSA and EC keys can sign PDFs).".to_string());
    };
    let signature = match context_pin {
        None => session.sign(&mech, key, &input).map_err(refused)?,
        Some(pin) if name != "CKM_RSA_PKCS" && name != "CKM_ECDSA" => {
            session.sign_init(&mech, key).map_err(refused)?;
            session.login(UserType::ContextSpecific, Some(pin)).map_err(login_error)?;
            session.sign_update(&input).map_err(refused)?;
            session.sign_final().map_err(refused)?
        }
        Some(pin) => {
            // Single-part mechanisms only: log in for the key first (accepted by most modules).
            session.login(UserType::ContextSpecific, Some(pin)).map_err(login_error)?;
            session.sign(&mech, key, &input).map_err(refused)?
        }
    };
    Ok((if raw_ec { ecdsa_raw_to_der(&signature) } else { signature }, name))
}

/// Signs `data_base64` (the DER signed attributes) with the key paired to
/// certificate `cert_id_hex`. `pin: None` uses the reader's PIN pad.
#[tauri::command]
pub async fn pkcs11_sign(
    module: String,
    slot_id: u64,
    cert_id_hex: String,
    pin: Option<String>,
    data_base64: String,
) -> Result<TokenSignature, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let data = b64.decode(data_base64).map_err(|e| format!("Bad data: {e}"))?;
        let id = hex::decode(&cert_id_hex).map_err(|e| format!("Bad certificate id: {e}"))?;
        let ctx = context(&module)?;
        let slot = slot_from_id(ctx, slot_id)?;
        let session = ctx.open_ro_session(slot).map_err(|e| format!("Could not open session: {e}"))?;

        let pin = pin.map(AuthPin::from);
        login_user(&session, pin.as_ref())?;
        drop(pin);

        let result = (|| {
            let (key, kt) = find_private_key(&session, &id)?
                .ok_or("No private key on the token matches this certificate.")?;
            let mechanisms = ctx.get_mechanism_list(slot).unwrap_or_default();
            let (signature, mech) = sign_data(&session, &mechanisms, key, kt, &data, None)?;
            Ok(TokenSignature {
                signature_base64: b64.encode(signature),
                key_type: key_type_name(kt).to_string(),
                mechanism: mech.to_string(),
            })
        })();
        let _ = session.logout();
        result
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------- batch sessions

/// A logged-in session kept for signing many files with one PIN entry.
struct BatchSession {
    session: Session,
    key: ObjectHandle,
    kt: KeyType,
    mechanisms: Vec<MechanismType>,
    /// Only for CKA_ALWAYS_AUTHENTICATE keys: the PIN for each signature's
    /// context-specific login, zeroised when the session is closed.
    context_pin: Option<AuthPin>,
}

impl Drop for BatchSession {
    fn drop(&mut self) {
        let _ = self.session.logout();
    }
}

fn batch_sessions() -> &'static Mutex<HashMap<u32, BatchSession>> {
    static S: OnceLock<Mutex<HashMap<u32, BatchSession>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_handle() -> u32 {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

fn insert_session(s: BatchSession) -> u32 {
    let h = next_handle();
    if let Ok(mut map) = batch_sessions().lock() {
        map.insert(h, s);
    }
    h
}

/// Logs out and forgets the session (the PIN is dropped with it); false when unknown.
fn remove_session(handle: u32) -> bool {
    let s = batch_sessions().lock().ok().and_then(|mut m| m.remove(&handle));
    s.is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    handle: u32,
    key_type: String,
    /// The key asks for the PIN for every signature (CKA_ALWAYS_AUTHENTICATE).
    always_authenticate: bool,
}

/// Opens a session and logs in once for a batch of signatures with the key of
/// `cert_id_hex`. Close it with pkcs11_close_session (also after errors).
#[tauri::command]
pub async fn pkcs11_open_session(module: String, slot_id: u64, cert_id_hex: String, pin: Option<String>) -> Result<OpenedSession, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let id = hex::decode(&cert_id_hex).map_err(|e| format!("Bad certificate id: {e}"))?;
        let ctx = context(&module)?;
        let slot = slot_from_id(ctx, slot_id)?;
        let session = ctx.open_ro_session(slot).map_err(|e| format!("Could not open session: {e}"))?;
        let pin = pin.map(AuthPin::from);
        login_user(&session, pin.as_ref())?;
        let found = find_private_key(&session, &id);
        let (key, kt) = match found {
            Ok(Some(k)) => k,
            Ok(None) => {
                let _ = session.logout();
                return Err("No private key on the token matches this certificate.".into());
            }
            Err(e) => {
                let _ = session.logout();
                return Err(e);
            }
        };
        let always = session
            .get_attributes(key, &[AttributeType::AlwaysAuthenticate])
            .ok()
            .and_then(|a| a.into_iter().find_map(|x| if let Attribute::AlwaysAuthenticate(b) = x { Some(b) } else { None }))
            .unwrap_or(false);
        let mechanisms = ctx.get_mechanism_list(slot).unwrap_or_default();
        let key_type = key_type_name(kt).to_string();
        // PIN pad readers (pin None) ask on the device for each signature.
        let context_pin = if always { pin } else { None };
        let handle = insert_session(BatchSession { session, key, kt, mechanisms, context_pin });
        Ok(OpenedSession { handle, key_type, always_authenticate: always })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Signs with an open batch session (see pkcs11_sign for `data_base64`).
#[tauri::command]
pub async fn pkcs11_session_sign(handle: u32, data_base64: String) -> Result<TokenSignature, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let b64 = base64::engine::general_purpose::STANDARD;
        let data = b64.decode(data_base64).map_err(|e| format!("Bad data: {e}"))?;
        let map = batch_sessions().lock().map_err(|_| "PKCS#11 lock poisoned")?;
        let s = map.get(&handle).ok_or("The token session has ended. Start the signing again.")?;
        let (signature, mech) = sign_data(&s.session, &s.mechanisms, s.key, s.kt, &data, s.context_pin.as_ref())?;
        Ok(TokenSignature {
            signature_base64: b64.encode(signature),
            key_type: key_type_name(s.kt).to_string(),
            mechanism: mech.to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Logs out and closes a batch session; the PIN it held is zeroised.
#[tauri::command]
pub async fn pkcs11_close_session(handle: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_session(handle);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ecdsa_der_encoding_pads_high_bit() {
        let mut raw = vec![0x80; 32];
        raw.extend(vec![0x01; 32]);
        let der = ecdsa_raw_to_der(&raw);
        assert_eq!(der[0], 0x30);
        assert_eq!(der[2], 0x02);
        assert_eq!(der[3], 33); // r gets a leading 0x00
        assert_eq!(der[4], 0x00);
    }

    #[test]
    fn batch_session_handles_are_unique_and_unknown_ones_fail() {
        let a = next_handle();
        let b = next_handle();
        assert_ne!(a, b);
        assert!(!remove_session(u32::MAX));
        let err = tauri::async_runtime::block_on(pkcs11_session_sign(u32::MAX, String::new())).err().unwrap_or_default();
        assert!(err.contains("session has ended"), "{err}");
        // Closing twice (or an unknown handle) is harmless.
        assert!(tauri::async_runtime::block_on(pkcs11_close_session(u32::MAX)).is_ok());
    }

    #[test]
    fn pin_errors_are_explained() {
        use cryptoki::error::{Error, RvError};
        assert!(login_error(Error::Pkcs11(RvError::PinIncorrect, cryptoki::context::Function::Login)).contains("Incorrect PIN"));
        assert!(login_error(Error::Pkcs11(RvError::PinLocked, cryptoki::context::Function::Login)).contains("locked"));
    }
}
