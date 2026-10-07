//! Hardware token (smart card / USB dongle) signing over PKCS#11.
//!
//! The WebView builds the CMS structure; this module only ever receives the
//! DER-encoded signed attributes, hashes them and asks the token to sign the
//! hash. The private key never leaves the token, and the PIN is used for a
//! single login and dropped (zeroised by `secrecy`) right after.

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
        match session.login(UserType::User, pin.as_ref()) {
            Ok(()) => {}
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::UserAlreadyLoggedIn, _)) => {}
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::PinIncorrect, _)) => {
                return Err("Incorrect PIN. Careful: tokens lock after a few wrong attempts.".into())
            }
            Err(cryptoki::error::Error::Pkcs11(cryptoki::error::RvError::PinLocked, _)) => {
                return Err("The token PIN is locked. Unlock it with your vendor's tool (PUK).".into())
            }
            Err(e) => return Err(format!("Login failed: {e}")),
        }
        drop(pin);

        let result = (|| {
            let (key, kt) = find_private_key(&session, &id)?
                .ok_or("No private key on the token matches this certificate.")?;
            let mechanisms = ctx.get_mechanism_list(slot).unwrap_or_default();
            let digest = Sha256::digest(&data);
            let (signature, mech) = if kt == KeyType::RSA {
                if mechanisms.contains(&MechanismType::SHA256_RSA_PKCS) {
                    (session.sign(&Mechanism::Sha256RsaPkcs, key, &data), "CKM_SHA256_RSA_PKCS")
                } else {
                    let mut info = SHA256_DIGEST_INFO.to_vec();
                    info.extend_from_slice(&digest);
                    (session.sign(&Mechanism::RsaPkcs, key, &info), "CKM_RSA_PKCS")
                }
            } else if kt == KeyType::EC {
                (session.sign(&Mechanism::Ecdsa, key, &digest).map(|raw| ecdsa_raw_to_der(&raw)), "CKM_ECDSA")
            } else {
                return Err("Unsupported key type on token (only RSA and EC keys can sign PDFs).".to_string());
            };
            let signature = signature.map_err(|e| format!("Token refused to sign: {e}"))?;
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
}
