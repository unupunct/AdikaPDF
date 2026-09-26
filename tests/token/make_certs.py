"""Creates a test CA plus RSA-2048 and ECDSA P-256 signing certificates for
the SoftHSM token test (keys as PKCS#8 PEM, certificates as DER)."""
import datetime, sys, pathlib
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
now = datetime.datetime.now(datetime.timezone.utc)

def name(cn, org="Adika Test PKI"):
    return x509.Name([x509.NameAttribute(NameOID.COUNTRY_NAME, "RO"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
                      x509.NameAttribute(NameOID.COMMON_NAME, cn)])

ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
ca = (x509.CertificateBuilder().subject_name(name("Adika Test Root CA")).issuer_name(name("Adika Test Root CA"))
      .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
      .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=3650))
      .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
      .add_extension(x509.KeyUsage(digital_signature=False, content_commitment=False, key_encipherment=False, data_encipherment=False,
                                   key_agreement=False, key_cert_sign=True, crl_sign=True, encipher_only=False, decipher_only=False), critical=True)
      .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
      .sign(ca_key, hashes.SHA256()))
(out / "ca.der").write_bytes(ca.public_bytes(serialization.Encoding.DER))

def leaf(tag, key, cn):
    cert = (x509.CertificateBuilder().subject_name(name(cn)).issuer_name(ca.subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - datetime.timedelta(days=1)).not_valid_after(now + datetime.timedelta(days=730))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=True, key_encipherment=False, data_encipherment=False,
                                         key_agreement=False, key_cert_sign=False, crl_sign=False, encipher_only=False, decipher_only=False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.EMAIL_PROTECTION]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    (out / f"{tag}.der").write_bytes(cert.public_bytes(serialization.Encoding.DER))
    (out / f"{tag}.key.pem").write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))

leaf("rsa", rsa.generate_private_key(public_exponent=65537, key_size=2048), "Ana Tokenescu (RSA)")
leaf("ec", ec.generate_private_key(ec.SECP256R1()), "Ana Tokenescu (ECDSA)")
print("certificates written to", out)
