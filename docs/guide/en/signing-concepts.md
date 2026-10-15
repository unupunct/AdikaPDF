# Signatures explained

This page explains the words you meet when signing PDFs, without the technical detail. The legal framework in the EU is the **eIDAS** regulation; in Romania, Law 214/2024 applies it.

## Three kinds of electronic signature

**Simple electronic signature.** Any signature in electronic form: a picture of your handwritten signature, your typed name, a scanned signature. It shows intent but proves little: anyone can copy a picture. Good for internal documents and forms that do not need more.

**Advanced electronic signature (AdES).** A digital signature made with a **certificate** that belongs to you. It identifies you and shows any change made to the document after signing. A certificate in a .pfx file, or a company certificate, gives an advanced signature.

**Qualified electronic signature (QES).** An advanced signature made with a **qualified certificate** kept on a **qualified signature device** (a USB token, a smart card, or a provider's secure server for cloud signatures). In law it has the same effect as a handwritten signature everywhere in the EU. Romanian public institutions, contracts and many official forms ask for it. Qualified certificates are sold by trust service providers (certSIGN, DigiSign, Trans Sped, AlfaSign and others in Romania).

## Simple electronic signature (Fill & Sign)

**Sign → Sign** (also **Home → Fill & Sign**) opens **Fill & Sign**: draw your signature with the mouse or a pen, type it, or load a picture of it, then place it on the page. It is stored only on this computer and can be reused from **Saved**. This is a simple electronic signature: a picture on the page, with no certificate.

You can combine both: place your handwritten signature first, select it, then sign with a certificate and choose **On the selected ink signature**. The page shows your handwriting; the certificate makes it a real digital signature.

## The words you will see

**Certificate.** An electronic identity card issued by a certification authority: it says who you are and comes with a private key that only you can use. A certificate has an **issuer** and an **expiry date**.

**.pfx / .p12 file.** A certificate with its private key in a file, protected by a password.

**Token / smart card.** A USB stick or card that holds your qualified certificate. The private key never leaves it; you unlock it with a **PIN**. After a few wrong PINs it locks.

**Cloud signature (remote signature).** Your qualified certificate stays on your provider's secure server. You sign in through the browser and confirm each signature with a PIN or a one-time code (SMS or app).

**Trusted timestamp.** A signed note from a timestamp server saying "this signature existed at this time". Without it, the signing time comes from your computer's clock. With it, the signature can be checked even after your certificate expires.

**Long-term validation (LTV).** The certificate chain and the answers from the issuer's revocation servers (OCSP / CRL) are stored inside the PDF, so the signature can be verified years later, offline, even after the issuer's servers are gone.

**Archive timestamp.** A timestamp over the whole file, including the validation data. Repeated every few years, it keeps the signatures verifiable for a very long time.

## PAdES levels

PAdES is the European format for signatures in PDF files. Tick **EU format: PAdES baseline (eIDAS)** in the signing dialog (it is on by default). The dialog shows the resulting level:

| Level | What it contains | You get it with |
| --- | --- | --- |
| **B-B** | The signature and the certificate | PAdES ticked, nothing else |
| **B-T** | + a trusted timestamp | **Add a trusted timestamp** |
| **B-LT** | + validation data for long-term checks | Timestamp + **Add long-term validation data** |
| **B-LTA** | + an archive timestamp | Timestamp + LTV + **Add an archive timestamp…** |

Without PAdES, Adika makes a **Classic PDF signature (adbe.pkcs7.detached)**, which older programs expect.

**Which level?** B-B for everyday documents verified soon after signing. **B-T** whenever the date matters (contracts, offers, documents for authorities). **B-LT** or **B-LTA** for documents kept for many years (archives, public procurement). The timestamp and LTV need internet at the moment of signing.

## Approval and certification signatures

**Approval signature** (the usual one): "I approve this document". Others can sign after you; each signature stays valid.

**Certification** (only the **first** signature can certify): the author fixes what may still change. In **Certify this document** choose:

- **Certify: no changes allowed**: nothing may change; even another signature would break it.
- **Certify: filling in forms and signing allowed**: others may fill in the form and sign.
- **Certify: forms, signing and comments allowed**: also comments.

Use certification for forms you send out to be filled in and signed, or for final documents that must not change. For a contract signed by several people, use approval signatures.

## Which method should I use?

| Situation | Method |
| --- | --- |
| Internal note, a form for a colleague | **Fill & Sign** (simple) |
| Documents for ANAF, courts, public institutions, contracts | Qualified certificate: **Token / smart card**, **Windows certificate** or **Cloud signature** |
| You received a .pfx file from your company | **Certificate ID** |
| Testing, or proving the document was not changed, without identity | **Certificate ID → Create self-signed ID** |
| Many documents at once | **Sign many files** |

Next: [Sign a document](signing-sign.md)
