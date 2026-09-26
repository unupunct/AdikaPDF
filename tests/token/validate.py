"""Independent validation of token-signed PDFs with pyHanko, trusting the test CA.
Usage: python validate.py <ca.der> <file.pdf>..."""
import sys
from asn1crypto import x509
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

ca = x509.Certificate.load(open(sys.argv[1], 'rb').read())
ok = True
for path in sys.argv[2:]:
    with open(path, 'rb') as f:
        sigs = PdfFileReader(f, strict=False).embedded_signatures
        for s in sigs:
            st = validate_pdf_signature(s, ValidationContext(trust_roots=[ca]))
            print(f"== {path.split(chr(92))[-1]} · field {s.field_name}")
            print(f"   signer: {st.signing_cert.subject.human_friendly}")
            print(f"   mechanism: {st.md_algorithm} / {st.pkcs7_signature_mechanism}")
            print(f"   intact={st.intact} valid={st.valid} trusted={st.trusted} coverage={st.coverage.name}")
            print(f"   bottom line: {st.bottom_line}")
            ok = ok and st.bottom_line
sys.exit(0 if ok else 1)
