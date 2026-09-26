//! Test helper: stores an X.509 certificate on a PKCS#11 token next to the
//! private key with the same CKA_ID (softhsm2-util can only import keys).
//! Usage: token_import_cert <module> <token-label> <user-pin> <id-hex> <label> <cert.der>
use cryptoki::context::{CInitializeArgs, CInitializeFlags, Pkcs11};
use cryptoki::object::{Attribute, CertificateType, ObjectClass};
use cryptoki::session::UserType;
use cryptoki::types::AuthPin;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let a: Vec<String> = std::env::args().collect();
    if a.len() != 7 {
        return Err("usage: token_import_cert <module> <token-label> <pin> <id-hex> <label> <cert.der>".into());
    }
    let der = std::fs::read(&a[6])?;
    // DER Subject is needed for CKA_SUBJECT: walk the TBSCertificate fields.
    let subject = x509_subject(&der).ok_or("could not parse certificate subject")?;
    let ctx = Pkcs11::new(&a[1])?;
    ctx.initialize(CInitializeArgs::new(CInitializeFlags::OS_LOCKING_OK))?;
    let slot = ctx
        .get_slots_with_token()?
        .into_iter()
        .find(|s| ctx.get_token_info(*s).map(|i| i.label().trim() == a[2]).unwrap_or(false))
        .ok_or("token not found")?;
    let session = ctx.open_rw_session(slot)?;
    session.login(UserType::User, Some(&AuthPin::from(a[3].clone())))?;
    session.create_object(&[
        Attribute::Class(ObjectClass::CERTIFICATE),
        Attribute::CertificateType(CertificateType::X_509),
        Attribute::Token(true),
        Attribute::Private(false),
        Attribute::Id(hex::decode(&a[4])?),
        Attribute::Label(a[5].as_bytes().to_vec()),
        Attribute::Subject(subject),
        Attribute::Value(der),
    ])?;
    println!("stored certificate '{}' (id {}) on '{}'", a[5], a[4], a[2]);
    Ok(())
}

/// Returns the DER of the subject Name inside a certificate.
fn x509_subject(der: &[u8]) -> Option<Vec<u8>> {
    fn tlv(b: &[u8]) -> Option<(usize, usize)> {
        // returns (header_len, content_len)
        let len0 = *b.get(1)? as usize;
        if len0 < 0x80 {
            return Some((2, len0));
        }
        let n = len0 & 0x7f;
        let mut len = 0usize;
        for i in 0..n {
            len = (len << 8) | *b.get(2 + i)? as usize;
        }
        Some((2 + n, len))
    }
    let (h, _) = tlv(der)?; // Certificate SEQUENCE
    let tbs = &der[h..];
    let (th, _) = tlv(tbs)?; // TBSCertificate SEQUENCE
    let mut p = &tbs[th..];
    if p.first() == Some(&0xa0) {
        let (vh, vl) = tlv(p)?; // [0] version
        p = &p[vh + vl..];
    }
    for _ in 0..4 {
        // serial, signature alg, issuer, validity
        let (eh, el) = tlv(p)?;
        p = &p[eh + el..];
    }
    let (sh, sl) = tlv(p)?;
    Some(p[..sh + sl].to_vec())
}
